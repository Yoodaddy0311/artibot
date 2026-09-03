/**
 * Unit contract for the ledger's read projections.
 *
 * The append path is the writer's and is tested in event-writer.test.js; this
 * suite is about what a READER gets back: dedupe on the four-field key,
 * tolerance of a torn tail, the v1.0 run-ledger fold, and the deferred
 * three-valued acceptance judgment.
 *
 * ── WHAT THIS SUITE CANNOT SEE (rules §9) ───────────────────────────────────
 *   - WHETHER THE FOLD MATCHES A REAL MISSION. Every event here was written by
 *     this file. Phase 0 has zero live writers, so fold output is checked
 *     against the shape the v1.0 schema declares, never against a real run.
 *   - ACCEPTANCE CORRECTNESS. `outcome.accepted` is read back exactly as it was
 *     written. Whether `accepted:true` was the right judgment is §2.6's
 *     deferred rule and is not decidable here.
 *   - THE THREE FIELDS THE FOLD CANNOT FILL. `execution.files`, `route.effort`,
 *     and the v1.0 three-value verdict enum have no Phase 0 source; the tests
 *     below pin them as EMPTY on purpose, so a later commit that starts
 *     guessing them breaks a test instead of shipping a guess.
 *
 * @module tests/runtime/ledger
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resetSeq } from '../../lib/runtime/event-writer.js';
import {
  appendLedgerEvent,
  currentMission,
  dedupeEvents,
  dedupeKey,
  foldMissions,
  ledgerFilePath,
  readAllEvents,
} from '../../lib/runtime/ledger.js';

/** @type {string} */
let root;

const SID = 'sess-abcdefgh-0002';
const MISSION = 'M-20260902-042';

/**
 * Append one event with the shared session, returning the writer's result.
 * @param {object} fields
 * @returns {object}
 */
function put(fields) {
  return appendLedgerEvent(root, { session_id: SID, source: 'hook', ...fields });
}

/**
 * Seed one mission's worth of events, one of each kind the fold reads.
 * @returns {void}
 */
function seedMission() {
  put({ event: 'mission.created', mission_id: MISSION, data: { title: 'T', intent_revision: 1 } });
  put({
    event: 'topology.selected', source: 'scheduler', mission_id: MISSION, data: { mode: 'team' },
  });
  put({
    event: 'model.switched',
    source: 'scheduler',
    mission_id: MISSION,
    data: { from: 'claude-sonnet-5', to: 'claude-opus-5', reason: 'escalate' },
  });
  put({
    event: 'tool.used',
    mission_id: MISSION,
    data: { tool: 'Bash', ok: true, duration_ms: 2 },
  });
  put({
    event: 'retry.scheduled',
    source: 'supervisor',
    mission_id: MISSION,
    data: { attempt: 1, reason: 'flake' },
  });
  put({
    event: 'review.completed',
    source: 'reviewer',
    mission_id: MISSION,
    model: 'claude-fable-5-1',
    data: { verdict: 'PASS', findings_ref: 'review://1' },
  });
  put({
    event: 'verify.completed',
    source: 'gate',
    mission_id: MISSION,
    data: { result: 'pass', evidence: ['vitest 35/35'] },
  });
  put({
    event: 'usage.receipt',
    source: 'worker',
    mission_id: MISSION,
    model: 'claude-opus-5',
    data: attemptReceipt(),
  });
}

/**
 * A receipt that actually satisfies schemas/attempt-receipt.schema.json.
 *
 * Written out in full rather than sketched: the writer validates the whole
 * `data` object against that schema, so a hand-waved fixture would be rejected
 * and the economics assertions below would be testing the rejection path
 * without saying so.
 *
 * @returns {object}
 */
function attemptReceipt() {
  return {
    schema_version: 1,
    run_id: 'run-1',
    mission_id: MISSION,
    model_identity: {
      provider: 'anthropic',
      family: 'claude',
      tier: 'opus',
      model_id: 'claude-opus-5',
      version: '2026-09-01',
      catalog_version: '1',
    },
    usage: {
      source: 'transcript',
      fresh_input_tokens: 100,
      cached_input_tokens: 40,
      cache_creation_tokens: 0,
      output_tokens: 20,
      thinking_tokens: 5,
    },
    timing: {
      started_at: '2026-09-02T00:00:00.000Z',
      completed_at: '2026-09-02T00:00:10.000Z',
      latency_ms: 10000,
    },
    outcome: { status: 'ok', accepted: null },
    cost: { total: 1.25, pricing_version: 'v1' },
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'artibot-ledger-read-'));
  resetSeq();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('appendLedgerEvent', () => {
  it('delegates to the writer and lands under the injected root', () => {
    const res = put({ event: 'tool.used', data: { tool: 'B', ok: true, duration_ms: 1 } });
    expect(res.ok).toBe(true);
    expect(res.path).toBe(path.join(root, '.artibot', 'runtime', 'ledger.jsonl'));
  });

  it('carries the writer refusal through unchanged', () => {
    const res = put({ event: 'not.registered', data: {} });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unregistered-event');
  });

  it('inherits the never-throws contract from the writer', () => {
    // appendLedgerEvent is a delegation, so the guarantee has to survive the
    // hop. Before the writer's guards it did not: this threw RangeError.
    const cyc = { tool: 'Bash', ok: true, duration_ms: 1 };
    cyc.self = cyc;
    let res;
    expect(() => { res = put({ event: 'tool.used', mission_id: MISSION, data: cyc }); })
      .not.toThrow();
    expect(res.ok).toBe(true);
    expect(readAllEvents(root)[0].data.self).toBe('[circular]');
  });

  it('returns a result rather than throwing on an exploding payload', () => {
    const hostile = {
      tool: 'Bash',
      ok: true,
      duration_ms: 1,
      get boom() { throw new RangeError('deliberate'); },
    };
    let res;
    expect(() => { res = put({ event: 'tool.used', mission_id: MISSION, data: hostile }); })
      .not.toThrow();
    expect(res).toEqual({ ok: false, reason: 'writer-exception:RangeError' });
  });
});

describe('readAllEvents', () => {
  it('returns [] for a project with no ledger', () => {
    expect(readAllEvents(root)).toEqual([]);
    expect(readAllEvents('')).toEqual([]);
  });

  it('excludes ledger.rejected unless asked for it', () => {
    put({ event: 'tool.used', data: { tool: 'B', ok: true, duration_ms: 1 } });
    put({ event: 'not.registered', data: {} });
    expect(readAllEvents(root).map((e) => e.event)).toEqual(['tool.used']);
    const all = readAllEvents(root, { includeRejected: true }).map((e) => e.event);
    expect(all).toEqual(['tool.used', 'ledger.rejected']);
  });

  it('skips a torn tail instead of failing the whole read', () => {
    put({ event: 'tool.used', data: { tool: 'B', ok: true, duration_ms: 1 } });
    appendFileSync(ledgerFilePath(root), '{"v":1,"event":"tool.us', 'utf-8');
    expect(readAllEvents(root)).toHaveLength(1);
  });

  it('filters by mission, session, event, and time', () => {
    seedMission();
    put({ event: 'tool.used', mission_id: 'M-20260902-099', data: { tool: 'X', ok: true, duration_ms: 1 } });
    expect(readAllEvents(root, { mission_id: MISSION })).toHaveLength(8);
    expect(readAllEvents(root, { event: 'tool.used' })).toHaveLength(2);
    expect(readAllEvents(root, { session_id: 'nobody' })).toHaveLength(0);
    expect(readAllEvents(root, { since: '2099-01-01T00:00:00.000Z' })).toHaveLength(0);
  });

  it('drops duplicate lines on (session_id, source, pid, seq)', () => {
    put({ event: 'tool.used', data: { tool: 'B', ok: true, duration_ms: 1 } });
    // Replay the same line, which is what a duplicated append would look like.
    const file = ledgerFilePath(root);
    const [first] = readAllEvents(root);
    appendFileSync(file, `${JSON.stringify(first)}\n`, 'utf-8');
    expect(readAllEvents(root)).toHaveLength(1);
  });

  it('dedupeEvents keeps the first occurrence and is pure', () => {
    const a = { session_id: SID, source: 'hook', pid: 1, seq: 0, event: 'first' };
    const b = { session_id: SID, source: 'hook', pid: 1, seq: 0, event: 'second' };
    const other = { session_id: SID, source: 'hook', pid: 2, seq: 0, event: 'other' };
    const input = [a, b, other];
    const out = dedupeEvents(input);
    expect(out.map((e) => e.event)).toEqual(['first', 'other']);
    expect(input).toHaveLength(3);
  });

  it('keeps two lines that share source, pid and seq but not the session', () => {
    // `seq` restarts at 0 in every process and the ledger outlives all of
    // them, so the OS reusing a pid across sessions or a reboot produces
    // exactly this collision. Without session_id in the key the SECOND line is
    // dropped as a duplicate and nothing reports the loss.
    const first = { session_id: 'sess-monday', source: 'hook', pid: 4242, seq: 0, event: 'first' };
    const second = { session_id: 'sess-friday', source: 'hook', pid: 4242, seq: 0, event: 'second' };
    const out = dedupeEvents([first, second]);
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.event)).toEqual(['first', 'second']);
  });

  it('survives a pid reuse across sessions on the real file, end to end', () => {
    const shared = { source: 'hook', pid: 4242, seq: 0 };
    const line = (sessionId) => JSON.stringify({
      v: 1,
      ts: '2026-09-02T00:00:00.000Z',
      event: 'tool.used',
      mission_id: MISSION,
      session_id: sessionId,
      ...shared,
      data: { tool: 'Bash', ok: true, duration_ms: 1 },
    });
    put({ event: 'tool.used', mission_id: MISSION, data: { tool: 'B', ok: true, duration_ms: 1 } });
    appendFileSync(ledgerFilePath(root), `${line('sess-monday')}\n${line('sess-friday')}\n`, 'utf-8');
    expect(readAllEvents(root)).toHaveLength(3);
  });

  it('separates key fields with a byte that cannot appear inside one', () => {
    // A space or a colon would let ('a b', 'c') and ('a', 'b c') collide.
    // Written with \u0000 rather than \0: a '\0' followed by a digit is a
    // legacy octal escape and is a parse error under strict mode.
    expect(dedupeKey({ session_id: 'a', source: 'b', pid: 1, seq: 2 }))
      .toBe('a\u0000b\u00001\u00002');
    expect(dedupeKey({ session_id: 'a b', source: 'c', pid: 1, seq: 2 }))
      .not.toBe(dedupeKey({ session_id: 'a', source: 'b c', pid: 1, seq: 2 }));
  });
});

describe('foldMissions', () => {
  it('reconstructs the v1.0 run-ledger shape from the event stream', () => {
    seedMission();
    const [run] = foldMissions(root, { mission_id: MISSION });
    expect(run.mission_id).toBe(MISSION);
    expect(run.route.model).toBe('claude-opus-5');
    expect(run.route.reason).toEqual(['escalate']);
    expect(run.topology.mode).toBe('team');
    expect(run.economics).toEqual({
      fresh_input: 100, cached_input: 40, output: 20, thinking: 5, total_cost: 1.25,
    });
    expect(run.execution.tools).toEqual(['Bash']);
    expect(run.execution.retries).toBe(1);
    expect(run.review).toEqual({
      model: 'claude-fable-5-1', verdict: 'PASS', findings: ['review://1'],
    });
    expect(run.verification).toEqual({ result: 'pass', evidence: ['vitest 35/35'] });
  });

  it('carries every top-level key the v1.0 schema requires', () => {
    seedMission();
    const [run] = foldMissions(root);
    for (const key of ['mission_id', 'route', 'execution', 'review', 'verification', 'outcome']) {
      expect(run).toHaveProperty(key);
    }
  });

  it('leaves the three unsourced fields empty rather than guessing them', () => {
    seedMission();
    const [run] = foldMissions(root);
    expect(run.execution.files).toEqual([]);
    expect(run.route.effort).toBeNull();
    // The canonical five-value verdict, not the superseded v1.0 three-value one.
    expect(run.review.verdict).toBe('PASS');
  });

  it('accumulates economics across multiple attempts', () => {
    seedMission();
    seedMission();
    const [run] = foldMissions(root, { mission_id: MISSION });
    expect(run.economics.total_cost).toBe(2.5);
    expect(run.economics.fresh_input).toBe(200);
    expect(run.execution.retries).toBe(2);
  });

  it('takes the last accepted value, so a deferred judgment overwrites null', () => {
    seedMission();
    put({ event: 'mission.completed', mission_id: MISSION, data: { accepted: null, evidence_refs: [] } });
    expect(foldMissions(root)[0].outcome.accepted).toBeNull();
    put({
      event: 'mission.completed',
      mission_id: MISSION,
      data: { accepted: true, evidence_refs: ['outcome.md'] },
    });
    expect(foldMissions(root)[0].outcome.accepted).toBe(true);
  });

  it('returns one record per mission, in first-appearance order', () => {
    seedMission();
    put({ event: 'mission.created', mission_id: 'M-20260902-043', data: { title: 'B', intent_revision: 1 } });
    const runs = foldMissions(root);
    expect(runs.map((r) => r.mission_id)).toEqual([MISSION, 'M-20260902-043']);
  });

  it('returns [] for an empty ledger', () => {
    expect(foldMissions(root)).toEqual([]);
  });

  it('ignores ledger.rejected lines', () => {
    put({ event: 'not.registered', data: {} });
    expect(foldMissions(root)).toEqual([]);
  });
});

describe('currentMission', () => {
  it('returns null when nothing has been written', () => {
    expect(currentMission(root)).toBeNull();
  });

  it('keeps a mission open while acceptance is still null', () => {
    seedMission();
    put({ event: 'mission.completed', mission_id: MISSION, data: { accepted: null, evidence_refs: [] } });
    expect(currentMission(root)).toBe(MISSION);
  });

  it('prefers an open mission over a closed one', () => {
    seedMission();
    put({
      event: 'mission.completed',
      mission_id: MISSION,
      data: { accepted: true, evidence_refs: ['o.md'] },
    });
    const open = 'M-20260902-044';
    put({ event: 'mission.created', mission_id: open, data: { title: 'C', intent_revision: 1 } });
    expect(currentMission(root)).toBe(open);
  });

  it('scopes to a session when asked', () => {
    seedMission();
    appendLedgerEvent(root, {
      session_id: 'other-session-1',
      source: 'hook',
      event: 'mission.created',
      mission_id: 'M-20260902-045',
      data: { title: 'D', intent_revision: 1 },
    });
    expect(currentMission(root, { session_id: 'other-session-1' })).toBe('M-20260902-045');
    expect(currentMission(root, { session_id: SID })).toBe(MISSION);
  });
});
