import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readSpawns } from '../../lib/learning/ledger/spawn-ledger.js';
import { ledgerFilePath } from '../../lib/runtime/ledger.js';

/**
 * SH-05 / CA-17 / SH-02 — the REAL hook path for a NAMED reviewer teammate.
 *
 * WHY THIS FILE EXISTS. `_review-stop-record.test.js` and
 * `tests/review/stop-identity.test.js` prove the resolver and the gate. They do
 * not prove the handler PASSES the gate its context: `isReviewerStop` is called
 * from `subagent-handler.js#handleStop`, and before this fix that call carried
 * the type string alone (`review-f1`), which no allowlist can match. A wiring
 * nobody drives through the handler is a wiring nobody has proved, so every case
 * here runs the three real hooks as child processes against a temporary git
 * repository, in the order the host runs them:
 *
 *   route-observe-pre.js  (PreToolUse, Agent)   -> `route.selected` receipt
 *   subagent-handler.js start  (SubagentStart)  -> `route.bound` + tracked entry
 *   subagent-handler.js stop   (SubagentStop)   -> the gate under test
 *
 * and reads what reached the ledger and the spawn ledger off disk.
 *
 * THE PAYLOADS follow the measured live shapes: a team spawn reports
 * `agent_type === <its NAME>` on both SubagentStart and SubagentStop, its
 * `agent_id` is `a<name>-<16 hex>`, and the payload carries no `agent_name`
 * (0 of 1,383 live start rows and 0 of 6,692 stop rows did, ledger copy
 * 2026-09-30). The definition type exists only in the PreToolUse `tool_input`.
 *
 * WHAT GREEN HERE DOES NOT PROVE:
 *  - THAT A REAL REVIEWER EMITS A VERDICT BLOCK. Every answer below is a fixture.
 *    The 4 live stop rows that ever reached the review path were all
 *    `verdict-not-admissible`: that is the producer side and is out of scope.
 *  - THAT THE HOST'S REAL `route.selected` ROW IS IN THE TAIL WINDOW at stop
 *    time. The rows here are seconds apart; real reviewers run minutes.
 *  - HOOK LATENCY. No timing is asserted; see the lane report for the numbers.
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'subagent-handler.js');
const PRE_HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'route-observe-pre.js');

/** Twelve alphanumerics, so `sessionFallbackMissionId` yields a valid id. */
const SID = 'sess-identity-e2e';
const PROMPT = 'pid-identity-e2e';
const MODEL = 'claude-opus-5-5';
const DOC_MISSION = 'M-20260930-001';
const HEX = '0123456789abcdef';

/** Run a hook the way the dispatcher does: fresh node process, JSON on stdin. */
function run(script, args, payload, home) {
  const res = spawnSync(process.execPath, [script, ...args], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
    windowsHide: true,
  });
  return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

/** A valid `reviewOutputV2` document (duplicated from the sibling suites on purpose). */
function v2Doc() {
  return {
    schema_version: 2,
    verdict: 'PASS',
    findings: [],
    evidence: [{ kind: 'file', file: 'scripts/hooks/_review-stop-record.js', line: 1 }],
    recommended_action: 'proceed',
    mission_id: DOC_MISSION,
    intent_revision: 1,
    plan_revision: 1,
    diff_ref: 'HEAD~1..HEAD',
    test_evidence: [{ kind: 'command', command: 'npx vitest run tests/hooks', output: 'ok' }],
    regression_evidence: [{ kind: 'command', command: 'npx vitest run tests/hooks', output: 'ok' }],
    verification_id: 'v-identity-e2e',
    next_steps: [],
  };
}

/** The reviewer's final answer: the verdict document and a claim_audit block. */
function answer() {
  return [
    'INSPECTION REPORT', '',
    '```json', JSON.stringify(v2Doc(), null, 2), '```', '',
    '```json', JSON.stringify({
      claim_audit: {
        subject_agent_type: 'tdd-guide', nature: 'process', claims_total: 5, claims_refuted: 1,
        evidence_refs: ['scripts/hooks/_review-stop-record.js:1'],
      },
    }, null, 2), '```', '',
  ].join('\n');
}

describe('SubagentStop -> isReviewerStop for a NAMED teammate (child processes)', () => {
  let tmp;
  let home;
  let repo;

  const agentIdOf = (name) => `a${name}-${HEX}`;
  /** SubagentStop's stdout contract, byte for byte, for every agent in every condition. */
  const deregistered = (name) => `{"message":"[team] Agent deregistered: ${agentIdOf(name)}"}`;

  /** The PreToolUse payload for an Agent spawn, carrying the DEFINITION type and the NAME. */
  function prePayload({ name, type, description, toolUseId }) {
    return {
      cwd: repo,
      hook_event_name: 'PreToolUse',
      prompt_id: PROMPT,
      session_id: SID,
      tool_name: 'Agent',
      tool_use_id: toolUseId,
      tool_input: { description, prompt: 'the full prompt body', run_in_background: true, subagent_type: type, name },
    };
  }

  /** Exactly the key set host 2.1.260 sends on SubagentStart. */
  function startPayload(name) {
    return {
      agent_id: agentIdOf(name),
      agent_type: name,
      cwd: repo,
      hook_event_name: 'SubagentStart',
      prompt_id: PROMPT,
      session_id: SID,
      transcript_path: path.join(tmp, 'main.jsonl'),
    };
  }

  /** The SubagentStop payload: same identity shape, plus the answer and the transcript. */
  function stopPayload(name, over = {}) {
    const transcript = path.join(tmp, 'subagents', `agent-${agentIdOf(name)}.jsonl`);
    mkdirSync(path.dirname(transcript), { recursive: true });
    const message = { role: 'assistant', model: MODEL, content: [{ type: 'text', text: answer() }] };
    writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message })}\n`, 'utf-8');
    return {
      agent_id: agentIdOf(name),
      agent_transcript_path: transcript,
      agent_type: name,
      cwd: repo,
      hook_event_name: 'SubagentStop',
      last_assistant_message: answer(),
      permission_mode: 'acceptEdits',
      prompt_id: PROMPT,
      session_id: SID,
      stop_hook_active: false,
      transcript_path: path.join(tmp, 'main.jsonl'),
      ...over,
    };
  }

  /** PreToolUse then SubagentStart for one spawn, asserting both really ran. */
  function spawn({ name, type, description, toolUseId }) {
    expect(run(PRE_HOOK, [], prePayload({ name, type, description, toolUseId }), home).status).toBe(0);
    expect(run(HOOK, ['start'], startPayload(name), home).status).toBe(0);
  }

  const ledger = () => {
    const file = ledgerFilePath(repo);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  };
  const events = () => ledger().map((l) => l.event);
  const stopRows = () => readSpawns(repo, { sessionId: SID }).filter((r) => r.event === 'stop');

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-identity-e2e-')));
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'repo');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });
  });
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  const REVIEW = {
    name: 'review-f1',
    type: 'artibot:code-reviewer',
    description: 'Review the SH-05 diff for correctness and report a verdict',
    toolUseId: 'toolu_identity_review',
  };
  const BUILDER = {
    name: 'builder-1',
    type: 'artibot:frontend-developer',
    description: 'Implement the settings panel component and add regression tests',
    toolUseId: 'toolu_identity_builder',
  };

  it('records the verdict of a named reviewer whose agent_type is its NAME (RED on base)', () => {
    spawn(REVIEW);
    // The premise, asserted so the case cannot pass vacuously: the receipt carries the NAME and
    // the DEFINITION type, and the bind joined them.
    const receipt = ledger().find((l) => l.event === 'route.selected');
    expect(receipt.worker).toBe('review-f1');
    expect(receipt.idempotency_key.endsWith(':artibot:code-reviewer')).toBe(true);
    const bound = ledger().find((l) => l.event === 'route.bound');
    expect(bound.data).toMatchObject({ agent_id: agentIdOf('review-f1'), agent_type: 'review-f1', confidence: 'exact' });

    const stop = run(HOOK, ['stop'], stopPayload('review-f1'), home);
    expect(stop.status).toBe(0);
    // THE HOOK'S DECISION SURFACE DID NOT MOVE: the exact bytes of every non-reviewer stop, and silence.
    expect(stop.stdout).toBe(deregistered('review-f1'));
    expect(stop.stderr).toBe('');

    expect(events()).toEqual(['route.selected', 'route.bound', 'review.completed', 'review.claim_audit']);
    const review = ledger().find((l) => l.event === 'review.completed');
    expect(review.worker).toBe('review-f1');
    expect(review.model).toBe(MODEL);
    expect(review.data.verdict).toBe('PASS');
    expect(ledger().filter((l) => l.event === 'ledger.rejected')).toHaveLength(0);
    // The EXISTING column vocabulary, no new grammar: `review=<status>,audit=<status>`.
    expect(stopRows().at(-1).review_ledger).toBe('review=appended,audit=appended');
  });

  it('dedupes a resumed reviewer\'s second stop instead of writing the verdict twice', () => {
    spawn(REVIEW);
    expect(run(HOOK, ['stop'], stopPayload('review-f1'), home).status).toBe(0);
    expect(run(HOOK, ['stop'], stopPayload('review-f1'), home).status).toBe(0);
    expect(events().filter((e) => e === 'review.completed')).toHaveLength(1);
    expect(stopRows().at(-1).review_ledger).toBe('review=deduped,audit=deduped');
  });

  it('leaves a named BUILDER alone: same answer, receipt type artibot:frontend-developer', () => {
    spawn(BUILDER);
    // The premise again: the bind DID resolve this spawn's type, to a non-reviewer.
    const bound = ledger().find((l) => l.event === 'route.bound');
    expect(bound.data).toMatchObject({ agent_type: 'builder-1', subagent_type: 'artibot:frontend-developer' });

    const stop = run(HOOK, ['stop'], stopPayload('builder-1'), home);
    expect(stop.status).toBe(0);
    // Same bytes as the recognised reviewer's stop: the decision surface is independent of the gate.
    expect(stop.stdout).toBe(deregistered('builder-1'));

    expect(events()).toEqual(['route.selected', 'route.bound']);
    expect(stopRows().at(-1)).not.toHaveProperty('review_ledger');
  });

  it('does NOT widen the allowlist: a named artibot:security-reviewer records nothing', () => {
    spawn({ ...REVIEW, name: 'rv-sec', type: 'artibot:security-reviewer', toolUseId: 'toolu_identity_sec' });
    expect(run(HOOK, ['stop'], stopPayload('rv-sec'), home).status).toBe(0);
    expect(events()).toEqual(['route.selected', 'route.bound']);
    expect(stopRows().at(-1)).not.toHaveProperty('review_ledger');
  });

  it('records nothing for a stop that was never registered at SubagentStart', () => {
    // The receipt exists and so does a bind-shaped trail, but no START ran for this id.
    expect(run(PRE_HOOK, [], prePayload(REVIEW), home).status).toBe(0);
    expect(run(HOOK, ['stop'], stopPayload('review-f1'), home).status).toBe(0);
    expect(events()).toEqual(['route.selected']);
    expect(stopRows().at(-1)).not.toHaveProperty('review_ledger');
  });

  it('records nothing when the spawn left no receipt at all (bind skipped:unbound)', () => {
    expect(run(HOOK, ['start'], startPayload('review-f1'), home).status).toBe(0);
    expect(events()).toEqual([]);
    expect(run(HOOK, ['stop'], stopPayload('review-f1'), home).status).toBe(0);
    expect(events()).toEqual([]);
    expect(stopRows().at(-1)).not.toHaveProperty('review_ledger');
  });

  it('an allowlisted type still takes the unchanged direct path (positive control, no START needed)', () => {
    const payload = stopPayload('code-reviewer', { agent_id: 'agent-direct', agent_type: 'artibot:code-reviewer' });
    expect(run(HOOK, ['stop'], payload, home).status).toBe(0);
    expect(events()).toEqual(['review.completed', 'review.claim_audit']);
  });
});
