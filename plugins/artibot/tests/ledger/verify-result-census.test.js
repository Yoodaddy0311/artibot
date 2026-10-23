/**
 * Real-process contract for `scripts/ledger/verify-result-census.mjs` — the
 * read-only CLI behind 05 D-04 stage 1: over the autopilot session store, how
 * the sessions that reached REPORT fold under `recovery-record.js#foldVerify`
 * (PASS / FAIL / UNMEASURED), what `report-verify-gate.js#evaluateReportVerifyEvidence`
 * says of each under evidenceMode 'ack' and under 'explicit-pass', and how many
 * sessions the flip to 'explicit-pass' would ADD to the pauses. That last number
 * is the denominator the flip waits on.
 *
 * WHY THESE CASES SPAWN A PROCESS. The counting rule lives in this script only;
 * the gate evaluates one state, the store lists files. Only a spawn shows the
 * store-directory resolution, the exit codes, the stdout/stderr split and the
 * one property that matters most here.
 *
 * READ-ONLY IS ASSERTED, NOT DECLARED — the `tests/ledger/recovery-journal-census.test.js`
 * set. The import set of the source is checked as an ALLOWLIST (six specifiers,
 * nothing else), the writer-token scan is given a fabricated source so a scanner
 * that cannot show a red does not get to be green, and the store's bytes, sizes,
 * mtimes and listing are captured around a real spawn.
 *
 * WHAT THE IMPORT SCAN CANNOT SEE (rules §9): the gate module this reader imports
 * for its pure evaluator reaches `lib/autopilot/session-store.js` TRANSITIVELY
 * (through `_engine-helpers.js`), so "no writer import" is true of this FILE only.
 * The behavioural snapshot below, not the import list, is the evidence that a run
 * writes nothing to the store it measures.
 *
 * THE FIXTURES ARE NOT THE LIVE STORE (rules §9). Every session below was written
 * by this file; a green run says the arithmetic is right and nothing about what
 * the live denominator is (unmeasured in this checkout — no store ships with it).
 *
 * @module tests/ledger/verify-result-census
 */

import { spawnSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// This file spawns child processes. The budget buys headroom for load; nothing
// here waits on a timer.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'verify-result-census.mjs');

/** The exact key set and order the module header promises a caller can parse blind. */
const STDOUT_KEYS = [
  'ok', 'reason', 'inputPath', 'files', 'parseFailures', 'sessions', 'reportReached',
  'byFold', 'underAck', 'underExplicitPass', 'wouldPauseUnderExplicitPass', 'measured_at',
  'status', 'census',
];

/** Every code of the gate's closed vocabulary, zero-filled — what an empty byCode looks like. */
const ZERO_CODES = {
  ok: 0, NO_VERIFY_ATTEMPT: 0, VERIFY_NOT_ACKED: 0, VERIFY_NOT_DONE: 0,
  STALE_BEFORE_EXECUTE: 0, VERIFY_RESULT_FAILED: 0, VERIFY_RESULT_UNMEASURED: 0,
  // Rule 7 codes of evidenceMode 'deterministic' (2026-10-23). The census never
  // runs that mode (it reads stored sessions, not the live tree), so always 0.
  VERIFY_EVIDENCE_MISSING: 0, VERIFY_EVIDENCE_STALE: 0, VERIFY_EVIDENCE_FAILED: 0,
};

/** @type {string} */
let tmp;
let seq = 0;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'vrc-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeStore(name) {
  const dir = path.join(tmp, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSession(dir, state, id) {
  seq += 1;
  const sessionId = id ?? `ap-2026102${seq}-aaaaaa-${seq}`;
  writeFileSync(path.join(dir, `${sessionId}.json`), `${JSON.stringify(state)}\n`, 'utf-8');
  return sessionId;
}

function run(argv, env = {}) {
  const out = spawnSync(process.execPath, [CLI, ...argv], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
  let json = null;
  try { json = JSON.parse(out.stdout); } catch { /* left null; the caller asserts */ }
  return { status: out.status, stdout: out.stdout, stderr: out.stderr, json };
}

function snapshot(dir) {
  const snap = {};
  for (const name of readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const st = statSync(file);
    snap[name] = { size: st.size, mtimeMs: st.mtimeMs, bytes: readFileSync(file, 'utf-8') };
  }
  return snap;
}

// ---------------------------------------------------------------------------
// Journals, the same rows the gate tests build
// ---------------------------------------------------------------------------

const row = (attemptId, phase, event, reason = null) => ({
  attemptId, phase, event, from: null, to: null, reason, at: '2026-10-23T00:00:00.000Z',
});
const started = (id, phase) => row(id, phase, 'started');
const acked = (id, phase, reason = 'done') => row(id, phase, 'acknowledged', reason);
/** Rule-B evidence: an EXECUTE, then a VERIFY acknowledged `done`. */
const EVIDENCE = [started('e1', 'EXECUTE'), acked('e1', 'EXECUTE'), started('v1', 'VERIFY'), acked('v1', 'VERIFY')];
/** A REPORT row in `state.phases`, the way `_engine-helpers.js#recordPhase` writes one. */
const REPORT_ROW = { ts: '2026-10-23T00:00:01.000Z', name: 'REPORT', status: 'queued' };

/**
 * The store 05 D-04 stage 1 is about, one session per situation:
 *   unmeasured — reached REPORT, evidence, empty result slot (passes 'ack', pauses 'explicit-pass')
 *   passed     — reached REPORT (lastPhase), evidence, explicit PASS
 *   failed     — COMPLETED, evidence, explicit FAIL (refused under both modes)
 *   noattempt  — REPORT row, no VERIFY attempt at all (refused under both modes)
 *   early      — still in EXECUTE, never reached REPORT (counted as a session, not in the denominators)
 *   prose      — reached REPORT, evidence, free-form result (passes 'ack', pauses 'explicit-pass')
 */
function writeTypicalStore(dir) {
  writeSession(dir, { sessionId: 'unmeasured', phase: 'REPORT', phases: [REPORT_ROW], attemptJournal: [...EVIDENCE], verifyResult: null }, 'unmeasured');
  writeSession(dir, { sessionId: 'passed', phase: 'PAUSED', lastPhase: 'REPORT', attemptJournal: [...EVIDENCE], verifyResult: { status: 'PASS' } }, 'passed');
  writeSession(dir, { sessionId: 'failed', phase: 'COMPLETED', attemptJournal: [...EVIDENCE], verifyResult: { status: 'FAIL' } }, 'failed');
  writeSession(dir, { sessionId: 'noattempt', phase: 'REPORT', phases: [REPORT_ROW], attemptJournal: [] }, 'noattempt');
  writeSession(dir, { sessionId: 'early', phase: 'EXECUTE', phases: [{ ts: 'x', name: 'EXECUTE', status: 'queued' }], attemptJournal: [started('e1', 'EXECUTE')] }, 'early');
  writeSession(dir, { sessionId: 'prose', phase: 'REPORT', phases: [REPORT_ROW], attemptJournal: [...EVIDENCE], verifyResult: { lint: 'ok', test: '3 failed' } }, 'prose');
}

// ---------------------------------------------------------------------------

/** The six specifiers the reader is allowed to import, and nothing else. */
const ALLOWED_SPECIFIERS = [
  'node:fs',
  'node:path',
  '../../lib/autopilot/report-verify-gate.js',
  '../../lib/autopilot/recovery-record.js',
  './recovery-journal-census.mjs',
  '../hooks/_main-entry.js',
];

/** Spellings that would make this reader a writer. */
const WRITER_TOKENS = /writeFileSync|appendFileSync|mkdirSync|unlinkSync|rmSync|renameSync|saveSession/;

function importSpecifiers(source) {
  const pattern = /(?:^|\n)\s*import\s*(?:[^;'"]*?from\s*)?['"]([^'"]+)['"]/g;
  return [...source.matchAll(pattern)].map((m) => m[1]);
}

function readOnlyFindings(source) {
  const findings = [];
  for (const spec of importSpecifiers(source)) {
    if (!ALLOWED_SPECIFIERS.includes(spec)) findings.push(`unlisted import: ${spec}`);
  }
  const writer = WRITER_TOKENS.exec(source);
  if (writer !== null) findings.push(`writer token: ${writer[0]}`);
  return findings;
}

describe('verify-result-census CLI: it imports no writer', () => {
  const source = readFileSync(CLI, 'utf-8');

  it('imports exactly the six allowlisted specifiers and no writer token', () => {
    expect(importSpecifiers(source).sort()).toEqual([...ALLOWED_SPECIFIERS].sort());
    expect(readOnlyFindings(source)).toEqual([]);
  });

  it('takes only read verbs from node:fs', () => {
    const named = /import\s+\{([^}]*)\}\s+from\s+'node:fs'/.exec(source);
    expect(named).not.toBe(null);
    expect(named[1].split(',').map((n) => n.trim()).filter((n) => n !== ''))
      .toEqual(['existsSync', 'readdirSync', 'readFileSync', 'statSync']);
  });

  it('does not import the session store itself, which is the writer', () => {
    expect(importSpecifiers(source).filter((s) => s.includes('session-store'))).toEqual([]);
  });

  it('SELF-TEST: the same scanner reds on a fabricated source that writes', () => {
    const fake = "import { writeFileSync } from 'node:fs';\n"
      + "import { saveSession } from '../../lib/autopilot/session-store.js';\n";
    const findings = readOnlyFindings(fake);
    expect(findings).toContain('unlisted import: ../../lib/autopilot/session-store.js');
    expect(findings).toContain('writer token: writeFileSync');
  });

  it('leaves every store file byte-identical and creates no sibling', () => {
    const dir = makeStore('RO');
    writeTypicalStore(dir);
    const before = snapshot(dir);

    const out = run(['--dir', dir]);
    expect(out.status).toBe(0);
    expect(out.json.sessions).toBe(6);

    expect(snapshot(dir)).toEqual(before);
    expect(readdirSync(dir).sort()).toEqual(Object.keys(before).sort());
  });

  it('creates nothing when the store directory does not exist', () => {
    const missing = path.join(tmp, 'never-made');
    const out = run(['--dir', missing]);
    expect(out.status).toBe(0);
    expect(out.json.ok).toBe(false);
    expect(out.json.reason).toContain('no session store at');
    expect(() => statSync(missing)).toThrow();
  });
});

describe('verify-result-census CLI: a zero denominator is null', () => {
  it('reports null everywhere when there is no store at all', () => {
    const r = run(['--dir', path.join(tmp, 'absent')]).json;
    expect(r.sessions).toBe(0);
    expect(r.reportReached).toBe(0);
    expect(r.byFold).toBe(null);
    expect(r.underAck).toBe(null);
    expect(r.underExplicitPass).toBe(null);
    expect(r.wouldPauseUnderExplicitPass).toBe(null);
    expect(r.status).toBe('unmeasured:no-store');
  });

  it('separates "no store" from "store alive, no session reached REPORT"', () => {
    const dir = makeStore('alive');
    writeSession(dir, { sessionId: 'x', phase: 'VERIFY', attemptJournal: [] });
    const r = run(['--dir', dir]).json;
    expect(r.ok).toBe(true);
    expect(r.sessions).toBe(1);
    expect(r.reportReached).toBe(0);
    expect(r.byFold).toBe(null);
    expect(r.wouldPauseUnderExplicitPass).toBe(null);
    expect(r.status).toBe('unmeasured:no-report-reached');
    expect(JSON.stringify(r)).not.toContain('NaN');
  });
});

describe('verify-result-census CLI: the fold and the two modes', () => {
  it('counts the typical store: fold, both modes, and the pauses the flip would add', () => {
    const dir = makeStore('typical');
    writeTypicalStore(dir);

    const r = run(['--dir', dir]).json;

    expect(r.ok).toBe(true);
    expect(r.files).toBe(6);
    expect(r.parseFailures).toBe(0);
    expect(r.sessions).toBe(6);
    expect(r.reportReached).toBe(5); // all but `early`
    expect(r.byFold).toEqual({ PASS: 1, FAIL: 1, UNMEASURED: 3 });
    expect(r.underAck).toEqual({
      ok: 3,
      byCode: { ...ZERO_CODES, ok: 3, NO_VERIFY_ATTEMPT: 1, VERIFY_RESULT_FAILED: 1 },
    });
    expect(r.underExplicitPass).toEqual({
      ok: 1,
      byCode: { ...ZERO_CODES, ok: 1, NO_VERIFY_ATTEMPT: 1, VERIFY_RESULT_FAILED: 1, VERIFY_RESULT_UNMEASURED: 2 },
    });
    // `unmeasured` and `prose` pass today and would pause: the flip's marginal cost.
    expect(r.wouldPauseUnderExplicitPass).toBe(2);
    expect(r.status).toBe('measured');
  });

  it('keeps every partition exhaustive: byCode sums and the fold sum equal reportReached', () => {
    const dir = makeStore('sums');
    writeTypicalStore(dir);
    const r = run(['--dir', dir]).json;
    const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
    expect(sum(r.underAck.byCode)).toBe(r.reportReached);
    expect(sum(r.underExplicitPass.byCode)).toBe(r.reportReached);
    expect(sum(r.byFold)).toBe(r.reportReached);
    expect(r.wouldPauseUnderExplicitPass).toBe(r.underAck.ok - r.underExplicitPass.ok);
  });

  it('reads REPORT reached from any of the three signs: a REPORT row, COMPLETED, or lastPhase REPORT', () => {
    const dir = makeStore('reached');
    writeSession(dir, { sessionId: 'a', phase: 'IMPROVE', phases: [REPORT_ROW], attemptJournal: [] }, 'a');
    writeSession(dir, { sessionId: 'b', phase: 'COMPLETED', attemptJournal: [] }, 'b');
    writeSession(dir, { sessionId: 'c', phase: 'PAUSED', lastPhase: 'REPORT', attemptJournal: [] }, 'c');
    writeSession(dir, { sessionId: 'd', phase: 'REPORT', attemptJournal: [] }, 'd'); // at REPORT, no row yet: not reached
    writeSession(dir, { sessionId: 'e', phase: 'VERIFY', phases: [{ name: 'VERIFY' }], attemptJournal: [] }, 'e');
    const r = run(['--dir', dir]).json;
    expect(r.sessions).toBe(5);
    expect(r.reportReached).toBe(3);
    expect(r.census.perSession.filter((s) => s.reportReached).map((s) => s.sessionId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('counts an unparsable or non-object file apart, never as a session', () => {
    const dir = makeStore('unparsable');
    writeFileSync(path.join(dir, 'broken.json'), '{ not json', 'utf-8');
    writeFileSync(path.join(dir, 'list.json'), '[1,2]', 'utf-8');
    writeSession(dir, { sessionId: 'ok', phase: 'COMPLETED', attemptJournal: [...EVIDENCE], verifyResult: { ok: true } }, 'ok');
    const r = run(['--dir', dir]).json;
    expect(r.files).toBe(3);
    expect(r.parseFailures).toBe(2);
    expect(r.sessions).toBe(1);
    expect(r.reportReached).toBe(1);
    expect(r.byFold).toEqual({ PASS: 1, FAIL: 0, UNMEASURED: 0 });
  });

  it('ignores the .events.ndjson siblings the store keeps beside each session', () => {
    const dir = makeStore('ndjson');
    writeSession(dir, { sessionId: 'a', phase: 'COMPLETED', attemptJournal: [] }, 'a');
    writeFileSync(path.join(dir, 'a.events.ndjson'), '{"event":"x"}\n', 'utf-8');
    const r = run(['--dir', dir]).json;
    expect(r.files).toBe(1);
    expect(r.sessions).toBe(1);
  });

  it('reads the fold the way recovery-record.js does: a contradiction is UNMEASURED, a nested mcp result is UNMEASURED', () => {
    const dir = makeStore('fold');
    writeSession(dir, { sessionId: 'a', phase: 'COMPLETED', attemptJournal: [...EVIDENCE], verifyResult: { status: 'PASS', ok: false } }, 'a');
    writeSession(dir, { sessionId: 'b', phase: 'COMPLETED', attemptJournal: [...EVIDENCE], verifyResult: { mcp: { ok: true } } }, 'b');
    writeSession(dir, { sessionId: 'c', phase: 'COMPLETED', attemptJournal: [...EVIDENCE], verifyResult: { passed: true } }, 'c');
    const r = run(['--dir', dir]).json;
    expect(r.byFold).toEqual({ PASS: 1, FAIL: 0, UNMEASURED: 2 });
    // The contradiction is an explicit FAIL to the gate (rule 6) under both modes.
    expect(r.underAck.byCode.VERIFY_RESULT_FAILED).toBe(1);
    expect(r.underExplicitPass.byCode.VERIFY_RESULT_FAILED).toBe(1);
    expect(r.underExplicitPass.byCode.VERIFY_RESULT_UNMEASURED).toBe(1);
    expect(r.wouldPauseUnderExplicitPass).toBe(1);
  });
});

describe('verify-result-census CLI: the report carries its provenance', () => {
  it('prints the fixed key set, in order', () => {
    const dir = makeStore('keys');
    writeTypicalStore(dir);
    expect(Object.keys(run(['--dir', dir]).json)).toEqual(STDOUT_KEYS);
  });

  it('stamps measured_at as a parsable ISO instant and inputPath as the store', () => {
    const dir = makeStore('stamp');
    writeTypicalStore(dir);
    const before = Date.now();
    const r = run(['--dir', dir]).json;
    expect(Number.isFinite(Date.parse(r.measured_at))).toBe(true);
    expect(Date.parse(r.measured_at)).toBeGreaterThanOrEqual(before - 1000);
    expect(path.resolve(r.inputPath)).toBe(path.resolve(dir));
  });

  it('writes ONE line of JSON to stdout and the human line to stderr', () => {
    const dir = makeStore('streams');
    writeTypicalStore(dir);
    const out = run(['--dir', dir]);
    expect(out.stdout.split('\n').filter((l) => l.trim() !== '')).toHaveLength(1);
    expect(() => JSON.parse(out.stdout)).not.toThrow();
    expect(out.stderr).toContain('verify result: 5 of 6 session(s) reached REPORT');
    expect(out.stderr).toContain('would pause under explicit-pass 2');
    expect(out.stderr).toContain('measured ');
    expect(out.stderr.split('\n').filter((l) => l.trim() !== '')).toHaveLength(1);
  });

  it('says "null" in the human line for a zero denominator rather than a percentage', () => {
    const dir = makeStore('human-zero');
    writeSession(dir, { sessionId: 'x', phase: 'PLAN', attemptJournal: [] });
    const out = run(['--dir', dir]);
    expect(out.stderr).toContain('0 of 1 session(s) reached REPORT — null');
    expect(out.stderr).toContain('unmeasured:no-report-reached');
    expect(out.stderr).not.toContain('%');
  });

  it('breaks the count down per session with the same three verdicts', () => {
    const dir = makeStore('per-session');
    writeTypicalStore(dir);
    const r = run(['--dir', dir]).json;
    const unmeasured = r.census.perSession.find((s) => s.sessionId === 'unmeasured');
    expect(unmeasured).toEqual({ sessionId: 'unmeasured', reportReached: true, fold: 'UNMEASURED', ack: 'ok', explicitPass: 'VERIFY_RESULT_UNMEASURED' });
    const early = r.census.perSession.find((s) => s.sessionId === 'early');
    expect(early).toEqual({ sessionId: 'early', reportReached: false, fold: 'UNMEASURED', ack: 'NO_VERIFY_ATTEMPT', explicitPass: 'NO_VERIFY_ATTEMPT' });
    expect(r.census.perSession).toHaveLength(6);
  });
});

describe('verify-result-census CLI: --session narrows the store', () => {
  it('counts only the named session file', () => {
    const dir = makeStore('narrow');
    writeTypicalStore(dir);
    const only = run(['--dir', dir, '--session', 'passed']).json;
    expect(only.files).toBe(1);
    expect(only.sessions).toBe(1);
    expect(only.reportReached).toBe(1);
    expect(only.byFold).toEqual({ PASS: 1, FAIL: 0, UNMEASURED: 0 });
    expect(only.census.sessionFilter).toBe('passed');
  });

  it('an unknown session is "no store", not a measured zero', () => {
    const dir = makeStore('unknown');
    writeTypicalStore(dir);
    const r = run(['--dir', dir, '--session', 'nope']).json;
    expect(r.ok).toBe(false);
    expect(r.sessions).toBe(0);
    expect(r.byFold).toBe(null);
    expect(r.status).toBe('unmeasured:no-store');
  });
});

describe('verify-result-census CLI: usage errors', () => {
  it.each([
    [['--bogus']],
    [['--dir']],
    [['--dir', '']],
    [['--session', 'a/b']],
    [['--dir', 'x', 'stray']],
  ])('exits 2 with an empty stdout for %j', (argv) => {
    const out = run(argv);
    expect(out.status).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('verify-result-census:');
    expect(out.stderr).toContain('usage:');
  });
});
