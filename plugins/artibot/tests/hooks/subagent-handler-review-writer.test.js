import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readSpawns } from '../../lib/learning/ledger/spawn-ledger.js';
import { ledgerFilePath } from '../../lib/runtime/ledger.js';
import { sessionFallbackMissionId } from '../../lib/mission/mission-id.js';
import { missionMutator, openMissionStore } from '../../lib/runtime/middleware/tasks.js';
import { resolveGitCommonDir } from '../../lib/project-state/git-common-dir.js';
import { parseReviewMd, reviewArtifactPath } from '../../lib/review/review-artifact.js';

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
 *     UNMEASURED. The transcript fallback exists for that case; section 9 now
 *     drives it with a transcript LARGER than the 8 MB read window, but no real
 *     subagent transcript of that size has been measured — the size is the
 *     fixture's, not an observed one.
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

  // -------------------------------------------------------------------------
  // 9. the bounded tail — the branch that only a transcript over the window
  //    size can reach
  // -------------------------------------------------------------------------
  //
  // Every fixture above is a few kilobytes, so until this section existed the
  // `size > TRANSCRIPT_TAIL_BYTES` arm of `readLastAssistantEntry` had NEVER
  // RUN in any test: the offset arithmetic, the partial-line drop, and the
  // backwards scan over a window were all covered only by the `start === 0`
  // path. A fixture smaller than the cap cannot exercise a cap (rules §9).

  /**
   * `TRANSCRIPT_TAIL_BYTES` restated, not imported.
   *
   * The constant is module-private in `scripts/hooks/_review-stop-record.js`,
   * and a test that read its value out of the code under test could never
   * disagree with it. Restating it means a change to the production window
   * makes the alignment assertion below fail LOUDLY instead of the boundary
   * case quietly degrading into a fixture that no longer straddles anything.
   */
  const TAIL_BYTES = 8 * 1024 * 1024;

  /** One filler transcript line carrying `n` bytes of payload text. */
  const fillerLine = (n) => JSON.stringify({
    type: 'user', message: { role: 'user', content: 'x'.repeat(n) },
  });

  /** An assistant transcript line whose answer carries `id` as its verification id. */
  const assistantLine = (id) => JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: answer({ verdict: { verification_id: id } }) }],
      model: MODEL,
    },
  });

  it('reads a transcript larger than the window from its tail and still records the last answer', () => {
    const lines = [
      ...Array.from({ length: 9 }, () => fillerLine(1024 * 1024)),
      assistantLine('v-tail'),
      JSON.stringify({ type: 'summary', summary: 'done' }),
    ];
    writeFileSync(transcript, `${lines.join('\n')}\n`, 'utf-8');
    // Below the cap this test would silently exercise the ordinary path.
    expect(statSync(transcript).size).toBeGreaterThan(TAIL_BYTES);

    const res = runHook(stopPayload({ last_assistant_message: undefined }), home);
    expect(res.status).toBe(0);

    expect(eventsOf()).toEqual(['review.completed', 'review.claim_audit']);
    // Only the transcript copy carries this id, so the tail read is what fed it.
    expect(lineOf('review.completed').data.verification_id).toBe('v-tail');
  }, 60000);

  it('discards the window\'s truncated first line even when that fragment parses as an assistant entry', () => {
    // Laid out so the window's FIRST BYTE is the `{` that opens a decoy
    // assistant object sitting at the end of a longer line: everything after
    // the pad totals exactly one window. The decoy is then the only assistant
    // entry in the window, so dropping it is the difference between "no answer"
    // and a verdict line invented out of a half-read line.
    const PAD = 1024;
    const decoy = assistantLine('v-decoy');
    const summary = JSON.stringify({ type: 'summary', summary: 'done' });
    const fixed = decoy.length + 1 + fillerLine(0).length + 1 + summary.length + 1;
    const filler = fillerLine(TAIL_BYTES - fixed);
    writeFileSync(transcript, `${'P'.repeat(PAD)}${decoy}\n${filler}\n${summary}\n`, 'utf-8');

    // --- the fixture checks itself, because a misaligned one would pass -----
    const raw = readFileSync(transcript);
    expect(raw.length).toBe(PAD + TAIL_BYTES);
    expect(raw.toString('utf8', PAD, PAD + 1)).toBe('{');
    // The fragment the reader must throw away is, on its own, a WELL-FORMED
    // assistant entry with a model and a valid v2 document. That is what makes
    // the green below non-vacuous: without the partial-line drop this same
    // fixture writes `review.completed` with `v-decoy`.
    const fragment = raw.toString('utf8', PAD).split('\n')[0];
    expect(JSON.parse(fragment).type).toBe('assistant');
    // -----------------------------------------------------------------------

    const res = runHook(stopPayload({ last_assistant_message: undefined }), home);
    expect(res.status).toBe(0);
    expect(existsSync(ledgerFilePath(repo))).toBe(false);
    expect(reviewLedger()).toBe('review=skipped:no-text,audit=skipped:no-text');
  }, 60000);
});

/**
 * C2b — the same stop also renders `review.md`, and renders it NOWHERE ELSE.
 *
 * WHY A SECOND FILE-LEVEL GATE. The block above proves a verdict reaches the
 * LEDGER; a ledger line is a measurement nobody reads. `review.md` is that
 * measurement put where a human and a later mission both look. The two are
 * asserted to AGREE here, because two renderings of one verdict that can drift
 * are worse than one rendering.
 *
 * THE WRITE IS AN UNAWAITED ASYNC TAIL (`_review-stop-record.js#planReviewArtifact`
 * starts it and returns). It is observable from outside only because the child
 * process cannot exit before its event loop drains, so every case below reads
 * the filesystem AFTER `spawnSync` returned. If that invariant ever breaks,
 * these go red rather than silently measuring nothing.
 *
 * THE GATE IS HELD OPEN ON PURPOSE in the write-through cases. 4.61.0 ships
 * `runtime.artifactLifecycle.enabled: false` and zero live `review.md` is the
 * CORRECT production state; measuring the writer therefore requires supplying
 * an open gate through the documented `CLAUDE_PLUGIN_ROOT` override (the same
 * technique as `tests/hooks/intent-observe-pre.test.js`). The shipped value is
 * pinned below so flipping it in the repo turns this red.
 *
 * WHAT GREEN HERE DOES NOT PROVE (rules §9):
 *   - THAT A SECOND REVIEW OF ONE MISSION IS HANDLED. It is not: section c
 *     MEASURES that a superseding verdict is dropped at ALREADY_EXISTS,
 *     because no caller anywhere bumps a review revision. That is a recorded
 *     gap, not a covered behaviour.
 *   - HOOK LATENCY. Measured out-of-band on 2026-09-14 and reported to the
 *     leader; no wall-clock assertion is made here, because a timing threshold
 *     on shared CI hardware is a flake, not a gate.
 *   - THAT A DYNAMIC IMPORT FAILURE IS SURVIVED. The tail's `import()` calls
 *     cannot be made to fail from outside the process, so that branch is
 *     UNMEASURED — it is guarded by the same `catch` as everything else.
 */
describe('subagent-handler review.md artifact (child process)', () => {
  let tmp;
  let home;
  let repo;
  let transcript;
  let pluginRoot;
  let missionId;

  /** @returns {string} the transcript path, with `text` as the last assistant turn */
  function writeTranscript(text = answer()) {
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: MODEL, content: [{ type: 'text', text }] } }),
    ];
    writeFileSync(transcript, `${lines.join('\n')}\n`, 'utf-8');
    return transcript;
  }

  /** @param {object} [over] overrides; `undefined` deletes the key @returns {object} payload */
  function stopPayload(over = {}) {
    const base = {
      agent_id: AGENT_ID,
      agent_transcript_path: transcript,
      agent_type: 'code-reviewer',
      cwd: repo,
      hook_event_name: 'SubagentStop',
      last_assistant_message: answer(),
      session_id: SID,
      stop_hook_active: false,
      transcript_path: path.join(tmp, 'main.jsonl'),
      ...over,
    };
    for (const [k, v] of Object.entries(over)) if (v === undefined) delete base[k];
    return base;
  }

  /**
   * Run the stop hook with an explicit plugin root. Always explicit: inheriting
   * whatever `CLAUDE_PLUGIN_ROOT` the developer's shell happens to carry would
   * decide the gate for the test.
   *
   * @param {object} payload stdin
   * @param {string} root value for `CLAUDE_PLUGIN_ROOT`
   * @returns {{status: number|null, stdout: string, stderr: string}} result
   */
  function runStop(payload, root) {
    const res = spawnSync(process.execPath, [HOOK, 'stop'], {
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_ROOT: root },
      windowsHide: true,
    });
    return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
  }

  /** Give the mission a StateStore row — the tail refuses to write without one. */
  function seedMissionRow() {
    openMissionStore(repo, SID, Date.now(), { resolveGitCommonDir })
      .updateMission(missionId, missionMutator(missionId, 'seed', 1), { reason: 'test-seed' });
  }

  /** @returns {string[]} every file under `.artibot/missions`, recursively */
  function missionFiles(dir = path.join(repo, '.artibot', 'missions')) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
      ? missionFiles(path.join(dir, e.name))
      : [path.join(dir, e.name)]));
  }

  /** @returns {object[]} parsed ledger lines */
  function rawLedger() {
    const file = ledgerFilePath(repo);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  /** @param {string} event @returns {object|undefined} the first line of that event */
  const lineOf = (event) => rawLedger().find((l) => l.event === event);

  /** @returns {string|undefined} `review_ledger` of the last stop record */
  function reviewLedger() {
    const recs = readSpawns(repo, { sessionId: SID }).filter((r) => r.event === 'stop');
    return recs[recs.length - 1]?.review_ledger;
  }

  const artifact = () => reviewArtifactPath(repo, missionId);

  /** The stdout contract this whole path is forbidden to move. */
  const EXPECTED_STDOUT = `[team] Agent deregistered: ${AGENT_ID}`;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-c2-md-')));
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'repo');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    mkdirSync(repo, { recursive: true });
    mkdirSync(path.join(tmp, 'subagents'), { recursive: true });
    transcript = path.join(tmp, 'subagents', `${AGENT_ID}.jsonl`);
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });

    // Same id the hook derives: `subagent-handler.js#resolveMissionId` falls
    // back to this function when the payload declares no `mission_id`.
    // MIDNIGHT: both readings are `Date.now()` milliseconds apart, so a run
    // spanning UTC midnight could disagree. Not defended against — the window
    // is microseconds wide and a guard would be untestable.
    missionId = sessionFallbackMissionId({ sessionId: SID, nowMs: Date.now() });

    // The live configuration with one key flipped — not a stub. Everything the
    // hook reads other than the kill switch is exactly what ships.
    pluginRoot = path.join(tmp, 'plugin-root');
    mkdirSync(pluginRoot, { recursive: true });
    const live = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'artibot.config.json'), 'utf-8'));
    // Pin the shipped value: this suite's "gate closed" cases point at the real
    // plugin root and would go green for the wrong reason if it were ever true.
    expect(live.runtime.artifactLifecycle.enabled).toBe(false);
    live.runtime.artifactLifecycle.enabled = true;
    writeFileSync(path.join(pluginRoot, 'artibot.config.json'), JSON.stringify(live, null, 2), 'utf-8');
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  // -------------------------------------------------------------------------
  // a. the file exists, parses, and says the same thing as the ledger
  // -------------------------------------------------------------------------

  it('writes review.md at the mission artifact path when the gate is open and the row exists', () => {
    seedMissionRow();
    writeTranscript();
    expect(runStop(stopPayload(), pluginRoot).status).toBe(0);

    expect(existsSync(artifact())).toBe(true);
    // Exactly one artifact, and it is that one — a writer that also produced an
    // intent.md or a stray temp file would pass a bare `existsSync`.
    expect(missionFiles()).toEqual([artifact()]);
  }, 60000);

  it('round-trips the written review.md through parseReviewMd', () => {
    seedMissionRow();
    writeTranscript();
    runStop(stopPayload(), pluginRoot);

    const parsed = parseReviewMd(readFileSync(artifact(), 'utf-8'));
    expect(parsed.errors).toEqual([]);
    expect(parsed.ok).toBe(true);
  }, 60000);

  it('renders the same verdict the review.completed ledger line recorded', () => {
    seedMissionRow();
    writeTranscript(answer({ verdict: { verification_id: 'v-agree' } }));
    runStop(stopPayload({ last_assistant_message: undefined }), pluginRoot);

    const { review } = parseReviewMd(readFileSync(artifact(), 'utf-8'));
    const ledger = lineOf('review.completed');
    // The envelope's mission id, NOT the `mission_id` written inside the
    // reviewer's own document — those are different facts and the artifact
    // must carry the one the pipeline keys on.
    expect(review.missionId).toBe(missionId);
    expect(review.verdict).toBe(ledger.data.verdict);
    expect(review.findingsRef).toBe(`transcript:${AGENT_ID}`);
    expect(review.findingsRef).toBe(ledger.data.findings_ref);
    expect(review.verificationId).toBe(ledger.data.verification_id);
    expect(review.basedOn.intentRevision).toBe(1);
  }, 60000);

  // -------------------------------------------------------------------------
  // b. every closed gate produces ZERO files
  // -------------------------------------------------------------------------

  it('writes no file on the shipped configuration, where the kill switch is false', () => {
    seedMissionRow();
    writeTranscript();
    // The REAL plugin root — the gate the release ships.
    expect(runStop(stopPayload(), PLUGIN_ROOT).status).toBe(0);

    expect(missionFiles()).toEqual([]);
    // ...and the ledger half still happened, so this is the gate refusing the
    // FILE, not the whole review path failing.
    expect(lineOf('review.completed')).toBeTruthy();
  }, 60000);

  it('writes no file when the payload carries no cwd, even with the gate open', () => {
    seedMissionRow();
    writeTranscript();
    expect(runStop(stopPayload({ cwd: undefined }), pluginRoot).status).toBe(0);

    expect(missionFiles()).toEqual([]);
    // No cwd means no project root, so the hook records nothing INTO the repo:
    // no review line, no spawn record, no artifact. `recordReviewFromStop`
    // refuses at `no-cwd` and the pre-flight never runs. (A ledger FILE does
    // exist here — `seedMissionRow` above wrote `state.updated` into it. That
    // is the fixture's line, which is exactly why this counts events by name
    // instead of asserting the file away.)
    expect(rawLedger().filter((l) => String(l.event).startsWith('review.'))).toEqual([]);
    expect(reviewLedger()).toBeUndefined();
  }, 60000);

  it('writes no file when the mission has no StateStore row, even with the gate open', () => {
    writeTranscript();
    expect(runStop(stopPayload(), pluginRoot).status).toBe(0);

    // FAIL-CLOSED. The row is the only source of `based_on`, and a review.md
    // claiming to review revision 1 of an intent nobody recorded is a lie the
    // file format cannot express as "unknown".
    expect(missionFiles()).toEqual([]);
    expect(lineOf('review.completed')).toBeTruthy();
  }, 60000);

  // -------------------------------------------------------------------------
  // c. a second review of one mission — MEASURED, not fixed
  // -------------------------------------------------------------------------

  it('leaves the file untouched when the identical stop is redelivered', () => {
    seedMissionRow();
    writeTranscript();
    runStop(stopPayload(), pluginRoot);
    const first = { bytes: readFileSync(artifact()), mtime: statSync(artifact()).mtimeMs };

    runStop(stopPayload(), pluginRoot);

    expect(missionFiles()).toEqual([artifact()]);
    expect(readFileSync(artifact())).toEqual(first.bytes);
    // Untouched, not rewritten-identically: the pre-flight latches on
    // `review-not-appended` (the ledger half dedupes) before any file access.
    expect(statSync(artifact()).mtimeMs).toBe(first.mtime);
  }, 60000);

  it('KEEPS THE FIRST VERDICT when a superseding review lands — a recorded gap', () => {
    seedMissionRow();
    writeTranscript(answer({ verdict: { verification_id: 'v-first' } }));
    runStop(stopPayload({ last_assistant_message: undefined }), pluginRoot);
    expect(parseReviewMd(readFileSync(artifact(), 'utf-8')).review.verdict).toBe('PASS');

    writeTranscript(answer({
      verdict: { verdict: 'REPAIR_REQUIRED', verification_id: 'v-second' },
    }));
    runStop(stopPayload({ last_assistant_message: undefined }), pluginRoot);

    // The SECOND verdict reached the ledger and did NOT reach the file.
    expect(rawLedger().filter((l) => l.event === 'review.completed')).toHaveLength(2);
    const kept = parseReviewMd(readFileSync(artifact(), 'utf-8')).review;
    expect(kept.verdict).toBe('PASS');
    expect(kept.verificationId).toBe('v-first');
    // WHY: nothing in the pipeline bumps a review revision, so the tail always
    // renders revision 1 and `apply()` stops at ALREADY_EXISTS. Superseding is
    // NOT IMPLEMENTED. This test pins the current behaviour so that the day it
    // is implemented, this line is what has to change on purpose.
    expect(kept.revision).toBe(1);
  }, 60000);

  // -------------------------------------------------------------------------
  // d. the hook's answer never moves
  // -------------------------------------------------------------------------

  it('emits byte-identical stdout whether the write succeeds, is gated off, or fails', () => {
    seedMissionRow();
    writeTranscript();
    const ok = runStop(stopPayload(), pluginRoot);
    expect(existsSync(artifact())).toBe(true);

    rmSync(path.join(repo, '.artibot'), { recursive: true, force: true });
    seedMissionRow();
    const gated = runStop(stopPayload({ session_id: `${SID}b` }), PLUGIN_ROOT);

    // A FILE where the mission DIRECTORY has to go, so `ensureDirSync` throws
    // and `writeOneArtifact` returns WRITE_FAILED. Chosen over an unwritable
    // directory because file permissions are not portable to Windows.
    rmSync(path.join(repo, '.artibot'), { recursive: true, force: true });
    seedMissionRow();
    mkdirSync(path.join(repo, '.artibot', 'missions'), { recursive: true });
    writeFileSync(path.join(repo, '.artibot', 'missions', missionId), 'not a directory', 'utf-8');
    const failed = runStop(stopPayload({ session_id: `${SID}c` }), pluginRoot);
    expect(existsSync(artifact())).toBe(false);

    for (const res of [ok, gated, failed]) {
      expect(res.status).toBe(0);
      expect(JSON.parse(res.stdout)).toEqual({ message: EXPECTED_STDOUT });
    }
    expect(gated.stdout).toBe(ok.stdout);
    expect(failed.stdout).toBe(ok.stdout);
  }, 60000);

  // -------------------------------------------------------------------------
  // e. the ledger the block above measures is unchanged
  // -------------------------------------------------------------------------

  it('adds no ledger line and no spawn-column grammar of its own', () => {
    seedMissionRow();
    writeTranscript();
    runStop(stopPayload(), pluginRoot);
    expect(existsSync(artifact())).toBe(true);

    // Exactly the two review lines the pre-artifact writer produced, in order.
    expect(rawLedger().map((l) => l.event).filter((e) => e.startsWith('review.')))
      .toEqual(['review.completed', 'review.claim_audit']);
    // The spawn column keeps the `review=<status>,audit=<status>` grammar: the
    // artifact label is deliberately NOT carried into it, because that string
    // is pinned by the ledger-vocabulary firewall.
    expect(reviewLedger()).toBe('review=appended,audit=appended');
  }, 60000);

  // -------------------------------------------------------------------------
  // f. plan()'s input contract, in-process — the two ways this caller could
  //    have got it wrong, pinned as throw/refuse rather than assumed.
  // -------------------------------------------------------------------------

  it('refuses to plan a review write without a missionState or a revision', async () => {
    const { plan } = await import('../../lib/runtime/artifact-lifecycle.js');
    const events = [{
      event: 'review.completed',
      mission_id: missionId,
      seq: 0,
      data: { verdict: 'PASS', findings_ref: `transcript:${AGENT_ID}`, verification_id: 'v-x' },
    }];

    // No `missionState` at all: a CALLER BUG, so it throws rather than refusing.
    expect(() => plan({ events, projectRoot: repo }))
      .toThrow(/requires missionState\.missionId/);

    // A missionState with no review revision: BAD DATA, so it refuses per line.
    // This is why the tail always passes `reviewRevision: FIRST_REVIEW_REVISION`.
    const refused = plan({ events, missionState: { missionId }, projectRoot: repo });
    expect(refused.writes).toEqual([]);
    expect(refused.refused[0].code).toBe('MISSING_REQUIRED_DATA');
  });
});
