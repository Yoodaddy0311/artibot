import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readSpawns } from '../../lib/learning/ledger/spawn-ledger.js';
import { ledgerFilePath } from '../../lib/runtime/ledger.js';

/**
 * C2 — the SubagentStop hook RECORDS a reviewer's answer as `review.completed`
 * and `review.claim_audit`, and records nothing else.
 *
 * WHY THIS FILE EXISTS. `lib/review/verdict-writer.js` has been green since it
 * was written, and its own header says so plainly: "No production caller wires
 * these functions yet." A writer with no caller measures nothing. This file is
 * the caller's gate — it drives the REAL hook as a child process against a
 * temporary git repo and reads the lines off disk, because "a reviewer's
 * verdict reached the ledger" is an on-disk fact and nothing weaker proves it.
 *
 * THE HOOK'S DECISION SURFACE MUST NOT MOVE. SubagentStop's stdout is a
 * contract (`{"message":"[team] Agent deregistered: <id>"}`) and the recorder
 * is invisible to it: the same bytes in every condition, including an
 * unwritable ledger and a missing transcript. That invariance is asserted
 * directly rather than assumed, because a recorder that can change what the
 * hook SAYS is a recorder that can block a teammate's deregistration.
 *
 * WHAT GREEN HERE DOES NOT PROVE (rules §9 — the gate's blind spots live next
 * to the gate):
 *   - THAT ANY REAL REVIEWER EMITS EITHER BLOCK. Every answer below is a
 *     fixture this file wrote. `commands/team.md` Phase 4.5 now asks inspectors
 *     for a v2 document, but compliance is a prompt-following property and is
 *     UNMEASURED.
 *   - THAT `last_assistant_message` CARRIES A WHOLE REPORT. The C1 probe
 *     measured it as a string on 2/2 live runs with a 2-character answer
 *     ("ok"); the host's truncation limit for a long review document is
 *     UNMEASURED. The transcript fallback exists for that case and is exercised
 *     here only with a fixture the same size as the direct field.
 *   - HOOK LATENCY. The stop path now reads a bounded transcript tail and the
 *     ledger. The dispatcher slot allows 5000 ms
 *     (`hooks/dispatch-table.json`); no profile has been taken.
 *   - THAT THE NON-REVIEWER PATH READS NOTHING. Absence of a read is not
 *     observable from outside the process. What is asserted instead is that a
 *     pre-seeded ledger comes back byte-identical and no line is added, which
 *     is the consequence a reader would care about.
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'subagent-handler.js');

/** Twelve alphanumerics, so `sessionFallbackMissionId` yields a valid id. */
const SID = 'sess-review-c2';
const AGENT_ID = 'agent-review-c2';
const MODEL = 'claude-fable-5-1';
/** The `mission_id` INSIDE the fixture document — unrelated to the envelope's. */
const DOC_MISSION = 'M-20260912-001';

/**
 * Run the hook the way the dispatcher does: fresh node process, JSON on stdin,
 * sub-command as argv. HOME/USERPROFILE point into the sandbox so the state
 * file never lands in the developer's home.
 *
 * @param {object} payload hook payload written to stdin
 * @param {string} home sandbox HOME
 * @param {string} [action] 'start' or 'stop'
 * @returns {{status: number|null, stdout: string, stderr: string}} process result
 */
function runHook(payload, home, action = 'stop') {
  const res = spawnSync(process.execPath, [HOOK, action], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
    windowsHide: true,
  });
  return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

/**
 * A valid `reviewOutputV2` document. Same shape the writer's own suite uses
 * (`tests/review/verdict-writer.test.js#v2Doc`), duplicated rather than
 * imported: this file must keep passing if that one is rewritten, and a shared
 * fixture would let a change there silently redefine what the hook is tested
 * against.
 *
 * @param {object} [over] field overrides; `undefined` deletes the key
 * @returns {object} the document
 */
function v2Doc(over = {}) {
  const base = {
    schema_version: 2,
    verdict: 'PASS',
    findings: [],
    evidence: [{ kind: 'file', file: 'scripts/hooks/subagent-handler.js', line: 1 }],
    recommended_action: 'proceed',
    mission_id: DOC_MISSION,
    intent_revision: 1,
    plan_revision: 1,
    diff_ref: 'HEAD~1..HEAD',
    test_evidence: [{ kind: 'command', command: 'npx vitest run tests/hooks', output: 'ok' }],
    regression_evidence: [{ kind: 'command', command: 'npx vitest run tests/hooks', output: 'ok' }],
    verification_id: 'v-direct',
    next_steps: [],
    ...over,
  };
  for (const [k, v] of Object.entries(over)) if (v === undefined) delete base[k];
  return base;
}

/**
 * A well-formed `claim_audit` block.
 *
 * @param {object} [over] field overrides
 * @returns {object} the block
 */
function auditBlock(over = {}) {
  return {
    subject_agent_type: 'tdd-guide',
    nature: 'process',
    claims_total: 9,
    claims_refuted: 2,
    evidence_refs: ['scripts/hooks/subagent-handler.js:725'],
    ...over,
  };
}

/**
 * One reviewer answer: the verdict document and the audit block as two fenced
 * JSON blocks, verdict first — the order a Phase 4.5 answer uses.
 *
 * @param {object} [parts] `{verdict, audit}`; `audit:null` omits the block
 * @returns {string} markdown
 */
function answer({ verdict = {}, audit = {} } = {}) {
  const out = ['INSPECTION REPORT', ''];
  if (verdict !== null) {
    out.push('```json', JSON.stringify(v2Doc(verdict), null, 2), '```', '');
  }
  if (audit !== null) {
    out.push('```json', JSON.stringify({ claim_audit: auditBlock(audit) }, null, 2), '```', '');
  }
  return out.join('\n');
}

describe('subagent-handler review-ledger writer (child process)', () => {
  let tmp;
  let home;
  let repo;
  let transcript;

  /**
   * Write a subagent transcript whose LAST assistant line carries the given
   * text and model. A preceding user line and a trailing non-assistant line
   * are included so "last assistant", not "last line", is what gets read.
   *
   * `model: null` OMITS the key — a sentinel rather than `undefined`, because a
   * default parameter cannot tell an explicit `undefined` from an absent one.
   *
   * @param {{text?: string, model?: string|null}} [opts] line contents
   * @returns {string} absolute transcript path
   */
  function writeTranscript({ text = answer(), model = MODEL } = {}) {
    const message = { role: 'assistant', content: [{ type: 'text', text }] };
    if (model !== null) message.model = model;
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } }),
      JSON.stringify({ type: 'assistant', message }),
      JSON.stringify({ type: 'summary', summary: 'done' }),
    ];
    writeFileSync(transcript, `${lines.join('\n')}\n`, 'utf-8');
    return transcript;
  }

  /**
   * A SubagentStop payload restricted to the key set measured live on host
   * 2.1.269 (C1, 2026-09-12, 2/2 runs). There is NO `model` key — the model of
   * a reviewer is read from its transcript or not at all.
   *
   * @param {object} [over] overrides; `undefined` deletes the key
   * @returns {object} the payload
   */
  function stopPayload(over = {}) {
    const base = {
      agent_id: AGENT_ID,
      agent_transcript_path: transcript,
      agent_type: 'code-reviewer',
      cwd: repo,
      hook_event_name: 'SubagentStop',
      last_assistant_message: answer(),
      permission_mode: 'acceptEdits',
      prompt_id: 'pid-review-c2',
      session_id: SID,
      stop_hook_active: false,
      transcript_path: path.join(tmp, 'main.jsonl'),
      ...over,
    };
    for (const [k, v] of Object.entries(over)) if (v === undefined) delete base[k];
    return base;
  }

  /** @returns {object[]} every parsed line of the raw ledger, rejections included */
  function rawLedger() {
    const file = ledgerFilePath(repo);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  const eventsOf = () => rawLedger().map((l) => l.event);
  const lineOf = (event) => rawLedger().find((l) => l.event === event);

  /** @returns {string|undefined} the `review_ledger` column of the last stop record */
  function reviewLedger() {
    const recs = readSpawns(repo, { sessionId: SID }).filter((r) => r.event === 'stop');
    return recs[recs.length - 1]?.review_ledger;
  }

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-c2-review-')));
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'repo');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    mkdirSync(repo, { recursive: true });
    mkdirSync(path.join(tmp, 'subagents'), { recursive: true });
    transcript = path.join(tmp, 'subagents', `${AGENT_ID}.jsonl`);
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  // -------------------------------------------------------------------------
  // 1. the happy path
  // -------------------------------------------------------------------------

  it('records both review lines for a reviewer stop carrying a v2 verdict and an audit', () => {
    writeTranscript({ text: answer({ verdict: { verification_id: 'v-transcript' } }) });
    expect(runHook(stopPayload(), home).status).toBe(0);

    expect(eventsOf()).toEqual(['review.completed', 'review.claim_audit']);

    const review = lineOf('review.completed');
    // The model is the TRANSCRIPT's `message.model` — the only source. The
    // payload carries no model key and policy is never substituted.
    expect(review.model).toBe(MODEL);
    expect(review.source).toBe('reviewer');
    expect(review.session_id).toBe(SID);
    expect(review.data.verdict).toBe('PASS');
    // `last_assistant_message` WINS over the transcript: 'v-direct', not
    // 'v-transcript'. The fallback is a fallback, not a second opinion.
    expect(review.data.verification_id).toBe('v-direct');
    // Non-PII by leader decision: the agent id, never the transcript PATH.
    expect(review.data.findings_ref).toBe(`transcript:${AGENT_ID}`);
    expect(JSON.stringify(review)).not.toContain(transcript);

    const audit = lineOf('review.claim_audit');
    expect(audit.data).toMatchObject({
      subject_agent_type: 'tdd-guide', claims_total: 9, claims_refuted: 2, nature: 'process',
    });

    // Nothing was refused: a rejected line would mean the allowlist and the
    // writer disagree, which is a silent zero in the measurement.
    expect(rawLedger().filter((l) => l.event === 'ledger.rejected')).toHaveLength(0);
    expect(reviewLedger()).toBe('review=appended,audit=appended');
  });

  // -------------------------------------------------------------------------
  // 2. idempotence
  // -------------------------------------------------------------------------

  it('dedupes a stop delivered twice instead of writing the verdict again', () => {
    writeTranscript();
    expect(runHook(stopPayload(), home).status).toBe(0);
    expect(runHook(stopPayload(), home).status).toBe(0);

    expect(eventsOf()).toEqual(['review.completed', 'review.claim_audit']);
    expect(reviewLedger()).toBe('review=deduped,audit=deduped');
  });

  // -------------------------------------------------------------------------
  // 3. a legacy verdict is measured, never recorded
  // -------------------------------------------------------------------------

  it('writes no line for a legacy APPROVE and reports the fold instead', () => {
    writeTranscript({ text: 'APPROVE' });
    expect(runHook(stopPayload({ last_assistant_message: 'APPROVE' }), home).status).toBe(0);

    // Not "zero lines because the file is empty" — the file was never created,
    // because nothing admissible was built and no port was touched.
    expect(existsSync(ledgerFilePath(repo))).toBe(false);
    const column = reviewLedger();
    expect(column).toContain('review=skipped');
    expect(column).toContain('audit=skipped');
    // The fold is kept as an OBSERVATION: countable, and not a verdict.
    expect(column).toContain('verdict=PASS');
  });

  // -------------------------------------------------------------------------
  // 4. no model ⇒ no verdict line, audit unaffected
  // -------------------------------------------------------------------------

  it('skips review.completed when the transcript names no model, keeping the audit', () => {
    writeTranscript({ model: null });
    expect(runHook(stopPayload(), home).status).toBe(0);

    // The allowlist declares `model` a required envelope field for
    // `review.completed`, so a line without it would be REJECTED, not stored.
    // Skipping is the honest outcome; inventing the reviewer's tier is not.
    expect(eventsOf()).toEqual(['review.claim_audit']);
    expect(lineOf('review.claim_audit').model).toBeUndefined();
    const column = reviewLedger();
    expect(column).toContain('review=skipped');
    expect(column).toContain('audit=appended');
  });

  // -------------------------------------------------------------------------
  // 5. the transcript fallback
  // -------------------------------------------------------------------------

  it('falls back to the transcript text when last_assistant_message is absent', () => {
    writeTranscript({ text: answer({ verdict: { verification_id: 'v-transcript' } }) });
    const res = runHook(stopPayload({ last_assistant_message: undefined }), home);
    expect(res.status).toBe(0);

    expect(eventsOf()).toEqual(['review.completed', 'review.claim_audit']);
    // Proof it was the TRANSCRIPT that was read: only that copy carries this id.
    expect(lineOf('review.completed').data.verification_id).toBe('v-transcript');
  });

  it('skips entirely when neither the payload nor the transcript holds an answer', () => {
    const res = runHook(
      stopPayload({ last_assistant_message: undefined, agent_transcript_path: undefined }),
      home,
    );
    expect(res.status).toBe(0);
    expect(existsSync(ledgerFilePath(repo))).toBe(false);
    expect(reviewLedger()).toBe('review=skipped:no-text,audit=skipped:no-text');
  });

  // -------------------------------------------------------------------------
  // 6. the allowlist — a non-reviewer never enters the path
  // -------------------------------------------------------------------------

  it('records nothing for a non-reviewer agent type carrying the same answer', () => {
    writeTranscript();
    const res = runHook(stopPayload({ agent_type: 'tdd-guide' }), home);
    expect(res.status).toBe(0);

    expect(existsSync(ledgerFilePath(repo))).toBe(false);
    const recs = readSpawns(repo, { sessionId: SID });
    expect(recs).toHaveLength(1);
    expect(recs[0]).not.toHaveProperty('review_ledger');
  });

  it('leaves a pre-seeded ledger untouched for a non-reviewer stop', () => {
    writeTranscript();
    const file = ledgerFilePath(repo);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ event: 'seed.line' })}\n`, 'utf-8');
    const before = readFileSync(file, 'utf-8');

    expect(runHook(stopPayload({ agent_type: 'tdd-guide' }), home).status).toBe(0);
    expect(readFileSync(file, 'utf-8')).toBe(before);
  });

  it('treats a team inspector name as a reviewer', () => {
    writeTranscript();
    expect(runHook(stopPayload({ agent_type: 'team-abc123-inspector' }), home).status).toBe(0);
    expect(eventsOf()).toEqual(['review.completed', 'review.claim_audit']);
  });

  it('normalizes the artibot: prefix before matching the allowlist', () => {
    writeTranscript();
    expect(runHook(stopPayload({ agent_type: 'artibot:quality-reviewer' }), home).status).toBe(0);
    expect(eventsOf()).toEqual(['review.completed', 'review.claim_audit']);
  });

  // -------------------------------------------------------------------------
  // 7. the decision surface does not move
  // -------------------------------------------------------------------------

  it('emits byte-identical stdout whether the recording succeeds, fails, or is skipped', () => {
    writeTranscript();
    // (a) the recorder succeeds.
    const ok = runHook(stopPayload(), home);

    // (b) the ledger FILE is blocked (a directory where the file must go), so
    // the append fails while the directory holding `spawns.ndjson` stays
    // writable — the distinction that keeps the spawn half measurable.
    const repo2 = path.join(tmp, 'repo2');
    mkdirSync(repo2, { recursive: true });
    execFileSync('git', ['init'], { cwd: repo2, stdio: 'ignore', windowsHide: true });
    mkdirSync(ledgerFilePath(repo2), { recursive: true });
    const blocked = runHook(stopPayload({ cwd: repo2 }), home);

    // (c) the transcript is gone.
    const missing = runHook(
      stopPayload({ agent_transcript_path: path.join(tmp, 'subagents', 'nope.jsonl') }),
      home,
    );

    // (d) a non-reviewer never enters the path at all.
    const other = runHook(stopPayload({ agent_type: 'tdd-guide' }), home);

    // No trailing newline: `lib/core/io.js:58#writeJSON` writes the JSON and
    // nothing else, which is why the pin in
    // `tests/hooks/subagent-handler-routing-fields.test.js:585-592` trims. Here
    // the RAW bytes are compared, so the literal must not add one.
    const expected = JSON.stringify({ message: `[team] Agent deregistered: ${AGENT_ID}` });
    for (const res of [ok, blocked, missing, other]) {
      expect(res.status).toBe(0);
      expect(res.stdout).toBe(expected);
    }
    expect(Object.keys(JSON.parse(ok.stdout.trim()))).toEqual(['message']);
  });

  // -------------------------------------------------------------------------
  // 8. a failing append is recorded, not raised
  // -------------------------------------------------------------------------

  it('records a refusal and exits normally when the ledger cannot be appended', () => {
    writeTranscript();
    const repo2 = path.join(tmp, 'repo2');
    mkdirSync(repo2, { recursive: true });
    execFileSync('git', ['init'], { cwd: repo2, stdio: 'ignore', windowsHide: true });
    mkdirSync(ledgerFilePath(repo2), { recursive: true });

    const res = runHook(stopPayload({ cwd: repo2 }), home);
    expect(res.status).toBe(0);

    const recs = readSpawns(repo2, { sessionId: SID }).filter((r) => r.event === 'stop');
    const column = recs[recs.length - 1].review_ledger;
    expect(column).toMatch(/^review=rejected/);
    // The teammate still deregistered: the record exists and names the agent.
    expect(recs[recs.length - 1].agentId).toBe(AGENT_ID);
  });

  it('survives a corrupt transcript without recording or failing', () => {
    writeFileSync(transcript, 'not json at all\n{"type":"assistant"\n', 'utf-8');
    const res = runHook(stopPayload({ last_assistant_message: undefined }), home);
    expect(res.status).toBe(0);
    expect(existsSync(ledgerFilePath(repo))).toBe(false);
    expect(reviewLedger()).toBe('review=skipped:no-text,audit=skipped:no-text');
  });
});
