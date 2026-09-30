/**
 * REPORT verify-evidence gate (CA-13 / AP-N1 residual).
 *
 * Layers:
 *   1. The evidence rule itself — `evaluateReportVerifyEvidence` over
 *      hand-built journals, one case per code plus the supersede/stale traps.
 *      1b. Rule 6, the driver's own `state.verifyResult`: which shapes read as
 *      a FAIL, which blind spots pass on purpose, the precedence over the other
 *      codes, and parity with `recovery-record.js#foldVerify`.
 *   2. The kill switch — `readReportVerifyGateEnforce` accepts only the literal
 *      `true`, and the shipped config reads OFF.
 *   3. The engine — `runPhase6Report` with the switch OFF must match a run with
 *      the gate removed in every field, every event and the report's Phase
 *      Timeline row; with it ON, missing evidence closes the REPORT window and
 *      pauses back to VERIFY, resume goes there, and real evidence completes
 *      REPORT.
 *   4. The driver path — `engine-state.js#recordPhaseResult` recording REPORT
 *      with the switch OFF, pinned as literal strings (state, disk, return,
 *      events) so any byte the gate adds there turns the pin red.
 *   5. The driver path with the switch ON — a REPORT without evidence is
 *      refused and pauses back to VERIFY, a pause of any kind is kept, and a
 *      re-run VERIFY is what lets REPORT through; `refuseRecordedReport`'s
 *      `livePhases` argument only counts when it is a real array.
 *   5b. The attempt scope of `state.verifyResult` (W2-7): a VERIFY hand-out seals the
 *      previous result (archived, not deleted) and stamps the new attempt, switch ON
 *      only; the gate itself never dismisses a result by its stamp (fail closed);
 *      driven through `resumeAutopilot` so the engine call is what is measured.
 *   5c. The seal has two switches (W3-7): `reportVerifyGate.enforce` OR
 *      `recovery.transitionFromVerdict`, each only as the literal `true`. Both false is
 *      pinned byte for byte against a hand-out with the seal call removed, and CA-03
 *      alone never switches the REPORT gate on.
 *   6. Sessions with no VERIFY row in their journal (stored before the journal,
 *      run before VERIFY was armed, or hand-driven), switch ON: pinned as today's
 *      behaviour, one pause and one VERIFY re-run.
 *   6b. The read-only census of how many stored sessions that pause would reach.
 *   7. The shipped switch driven with NOTHING injected, plus controls that turn
 *      the same harness ON through a temp plugin root.
 *   8. `loadReportVerifyGateConfig` against real files, including the silent OFF
 *      of an unreadable config.
 *   8b. The seal's two switches read from real config files (W3-7).
 *
 * The engine layer swaps the gate through `vi.mock` rather than `vi.spyOn`: the
 * engine holds a named import, which a spy on the module namespace never sees.
 * `gateMode.bypass` stands in for "the call line is not there" (and `gateMode.sealBypass`
 * for the same on the VERIFY hand-out's seal), `gateMode.config` injects the switch
 * without touching artibot.config.json, and `gateMode.shipped` removes that injection
 * so the real reader runs.
 *
 * Isolation: the autopilot store (session JSON + events.ndjson) is sandboxed by
 * `tests/setup/state-dir.js` (ARTIBOT_AUTOPILOT_STORE_DIR); PRD and report
 * files go to a mkdtemp directory through `options.projectRoot` below.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const gateMode = vi.hoisted(() => ({
  bypass: false, config: { enforce: false }, loads: 0, sealBypass: false, shipped: false,
}));

vi.mock('../../lib/autopilot/report-verify-gate.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    // `shipped` injects nothing: the real reader runs against whatever
    // artibot.config.json the plugin root holds (section 7).
    gateReportOnVerify: (state, config) => (gateMode.bypass
      ? null
      : real.gateReportOnVerify(state, gateMode.shipped ? config : (config ?? gateMode.config))),
    // The VERIFY hand-out (engine.js#runPhase4Verify) reads its switches through
    // this export, so it takes the same injection as the REPORT gate. `sealBypass`
    // stands in for "the seal call line is not there" (section 5c).
    scopeVerifyResultToAttempt: (state, attempt, config) => (gateMode.sealBypass
      ? false
      : real.scopeVerifyResultToAttempt(state, attempt, gateMode.shipped ? config : (config ?? gateMode.config))),
    // A caller that reads the switch itself (the driver path, section 4) sees
    // the injected value instead of the plugin root's artibot.config.json.
    loadReportVerifyGateConfig: () => {
      gateMode.loads += 1;
      return gateMode.shipped ? real.loadReportVerifyGateConfig() : gateMode.config;
    },
  };
});

const {
  REPORT_VERIFY_CODES,
  REPORT_VERIFY_GATE_ENFORCE_CONFIG_PATH,
  censusReportVerifyEvidence,
  evaluateReportVerifyEvidence,
  loadReportVerifyGateConfig,
  readReportVerifyGateEnforce,
  refuseRecordedReport,
  scopeVerifyResultToAttempt,
} = await vi.importActual('../../lib/autopilot/report-verify-gate.js');
const { gateReportOnVerify } = await import('../../lib/autopilot/report-verify-gate.js');
const {
  abortAutopilot,
  resumeAutopilot,
  runPhase6Report,
  startAutopilot,
} = await import('../../lib/autopilot/index.js');
const { PHASES, nextTarget, recordPhaseResult } = await import('../../lib/autopilot/engine-state.js');
const { foldVerify } = await import('../../lib/autopilot/recovery-record.js');
const {
  deleteSessionArtifacts, getSessionPath, loadSession, saveSession,
} = await import('../../lib/autopilot/session-store.js');
const { readEvents } = await import('../../lib/autopilot/telemetry.js');
const { findUnterminatedPhases, renderTimelineTable, summarizeEvents } = await import('../../lib/autopilot/replay.js');

// ARTIFACT ISOLATION CONTRACT: startAutopilot writes docs/PRD/ and
// runPhase6Report writes reports/AUTOPILOT/ under <projectRoot>/.
let artifactRoot = '';
beforeAll(() => {
  artifactRoot = mkdtempSync(path.join(os.tmpdir(), 'artibot-report-verify-gate-'));
});
afterAll(() => {
  try { rmSync(artifactRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

const sessionsToClean = new Set();
afterEach(async () => {
  gateMode.bypass = false;
  gateMode.config = { enforce: false };
  gateMode.sealBypass = false;
  gateMode.shipped = false;
  for (const id of sessionsToClean) {
    try { await abortAutopilot(id, { graceful: false }); } catch { /* ignore */ }
    try { deleteSessionArtifacts(id); } catch { /* ignore */ }
  }
  sessionsToClean.clear();
});

let counter = 0;
function uniqueId(label) {
  counter += 1;
  return `ap-report-verify-${label}-${process.pid}-${Date.now()}-${counter}`;
}

async function start(label) {
  const r = await startAutopilot({
    task: `report verify gate ${label}`,
    mode: 'default',
    options: { cpuCount: 2, projectRoot: artifactRoot },
    sessionId: uniqueId(label),
  });
  sessionsToClean.add(r.sessionId);
  return r.sessionId;
}

// ---------------------------------------------------------------------------
// 1. Evidence rule
// ---------------------------------------------------------------------------

const row = (attemptId, phase, event, reason = null) => ({
  attemptId, phase, event, from: null, to: null, reason, at: '2026-09-28T00:00:00.000Z',
});
const started = (id, phase) => row(id, phase, 'started');
const acked = (id, phase, reason = 'done') => row(id, phase, 'acknowledged', reason);
const stateOf = (attemptJournal, activePhaseAttempt = null) => ({ attemptJournal, activePhaseAttempt });
/** A journal that passes rule B: an EXECUTE, then a VERIFY acknowledged `done`. */
const EVIDENCE = [
  started('e1', 'EXECUTE'), acked('e1', 'EXECUTE'),
  started('v1', 'VERIFY'), acked('v1', 'VERIFY'),
];

describe('evaluateReportVerifyEvidence — rule B', () => {
  it('should pass when the last VERIFY after the last EXECUTE was acknowledged done', () => {
    const s = stateOf([started('e1', 'EXECUTE'), acked('e1', 'EXECUTE'), started('v1', 'VERIFY'), acked('v1', 'VERIFY')]);
    expect(evaluateReportVerifyEvidence(s)).toEqual({ ok: true, code: 'ok', attemptId: 'v1', checkpointSha: null });
  });

  it.each([
    ['an empty journal', stateOf([])],
    ['a missing journal', { activePhaseAttempt: null }],
    ['a non-array journal', { attemptJournal: 'nope' }],
    ['a null state', null],
    ['a journal with only EXECUTE rows', stateOf([started('e1', 'EXECUTE'), acked('e1', 'EXECUTE')])],
  ])('should return NO_VERIFY_ATTEMPT for %s', (_label, s) => {
    expect(evaluateReportVerifyEvidence(s)).toMatchObject({ ok: false, code: 'NO_VERIFY_ATTEMPT', attemptId: null });
  });

  it('should return VERIFY_NOT_ACKED when the last VERIFY was never acknowledged', () => {
    const s = stateOf([started('v1', 'VERIFY')]);
    expect(evaluateReportVerifyEvidence(s)).toMatchObject({ ok: false, code: 'VERIFY_NOT_ACKED', attemptId: 'v1' });
  });

  it('should not let an older acknowledged VERIFY stand in for a newer unacknowledged one', () => {
    const s = stateOf([started('v1', 'VERIFY'), acked('v1', 'VERIFY'), started('v2', 'VERIFY')]);
    expect(evaluateReportVerifyEvidence(s)).toMatchObject({ ok: false, code: 'VERIFY_NOT_ACKED', attemptId: 'v2' });
  });

  it('should not count an acknowledgement that belongs to a different attempt', () => {
    const s = stateOf([started('v1', 'VERIFY'), acked('x9', 'VERIFY')]);
    expect(evaluateReportVerifyEvidence(s).code).toBe('VERIFY_NOT_ACKED');
  });

  it('should not match an id-less VERIFY to an id-less acknowledgement', () => {
    const s = stateOf([started(null, 'VERIFY'), acked(null, 'VERIFY')]);
    expect(evaluateReportVerifyEvidence(s).code).toBe('VERIFY_NOT_ACKED');
  });

  it.each([
    ['failed'],
    ['DONE'],
    ['acknowledged-on-resume'],
    [null],
    [''],
  ])('should return VERIFY_NOT_DONE when the result status is %j', (reason) => {
    const s = stateOf([started('v1', 'VERIFY'), acked('v1', 'VERIFY', reason)]);
    expect(evaluateReportVerifyEvidence(s)).toMatchObject({ ok: false, code: 'VERIFY_NOT_DONE', attemptId: 'v1' });
  });

  it('should return STALE_BEFORE_EXECUTE when an EXECUTE started after the verified one', () => {
    const s = stateOf([
      started('e1', 'EXECUTE'), acked('e1', 'EXECUTE'),
      started('v1', 'VERIFY'), acked('v1', 'VERIFY'),
      started('e2', 'EXECUTE'), acked('e2', 'EXECUTE'),
    ]);
    expect(evaluateReportVerifyEvidence(s)).toMatchObject({ ok: false, code: 'STALE_BEFORE_EXECUTE', attemptId: 'v1' });
  });

  it('should judge order by array position, not by the at timestamp', () => {
    // The stale EXECUTE carries an EARLIER timestamp than the VERIFY; array
    // order still puts it last, so it is still stale.
    const late = { ...started('v1', 'VERIFY'), at: '2026-09-28T09:00:00.000Z' };
    const early = { ...started('e2', 'EXECUTE'), at: '2026-09-28T01:00:00.000Z' };
    const s = stateOf([late, acked('v1', 'VERIFY'), early]);
    expect(evaluateReportVerifyEvidence(s).code).toBe('STALE_BEFORE_EXECUTE');
  });

  it('should not treat IMPROVE after VERIFY as staleness', () => {
    const s = stateOf([started('v1', 'VERIFY'), acked('v1', 'VERIFY'), started('i1', 'IMPROVE'), acked('i1', 'IMPROVE')]);
    expect(evaluateReportVerifyEvidence(s).ok).toBe(true);
  });

  it('should return VERIFY_NOT_ACKED while a VERIFY slot is still open, and surface its checkpoint', () => {
    const slot = { attemptId: 'v2', phase: 'VERIFY', status: 'started', checkpointSha: 'abc1234' };
    const s = stateOf([started('v1', 'VERIFY'), acked('v1', 'VERIFY')], slot);
    expect(evaluateReportVerifyEvidence(s)).toEqual({
      ok: false, code: 'VERIFY_NOT_ACKED', attemptId: 'v1', checkpointSha: 'abc1234',
    });
  });

  it('should ignore an open slot of another phase', () => {
    const slot = { attemptId: 'p1', phase: 'CROSS_CHECK', status: 'started', checkpointSha: null };
    const s = stateOf([started('v1', 'VERIFY'), acked('v1', 'VERIFY')], slot);
    expect(evaluateReportVerifyEvidence(s).ok).toBe(true);
  });

  it('should not mutate the state it reads', () => {
    const s = stateOf([started('v1', 'VERIFY')]);
    const before = JSON.stringify(s);
    evaluateReportVerifyEvidence(s);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('should only ever answer from the closed, frozen code vocabulary', () => {
    expect(Object.isFrozen(REPORT_VERIFY_CODES)).toBe(true);
    expect(Object.values(REPORT_VERIFY_CODES).sort()).toEqual([
      'NO_VERIFY_ATTEMPT', 'STALE_BEFORE_EXECUTE', 'VERIFY_NOT_ACKED', 'VERIFY_NOT_DONE',
      'VERIFY_RESULT_FAILED', 'ok',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 1b. Evidence rule — the driver's own `state.verifyResult` (W29 #15)
// ---------------------------------------------------------------------------

/** Rule B's evidence, with the driver-written result object beside it. */
const withResult = (verifyResult, journal = EVIDENCE, slot = null) => ({ ...stateOf(journal, slot), verifyResult });

describe('evaluateReportVerifyEvidence — an explicit FAIL in state.verifyResult', () => {
  it.each([
    ['status FAIL', { status: 'FAIL' }],
    ['ok false', { ok: false }],
    ['passed false', { passed: false }],
    ['all three shapes FAIL', { status: 'FAIL', ok: false, passed: false }],
    // foldVerify reads these three as UNMEASURED (a contradiction is not a
    // measurement). A gate still cannot let a FAIL through because a PASS sits
    // beside it in the same object, e.g. `{...old, ok: false}` over a stale PASS.
    ['a FAIL beside a PASS status', { status: 'PASS', ok: false }],
    ['a FAIL status beside ok true', { status: 'FAIL', ok: true }],
    ['a FAIL beside UNMEASURED', { status: 'UNMEASURED', passed: false }],
  ])('should return VERIFY_RESULT_FAILED for a done acknowledgement beside %s', (_label, verifyResult) => {
    expect(evaluateReportVerifyEvidence(withResult(verifyResult))).toEqual({
      ok: false, code: 'VERIFY_RESULT_FAILED', attemptId: 'v1', checkpointSha: null,
    });
  });

  // The blind spots, pinned so widening one is a decision and not a drift. The
  // gate refuses only the explicit shapes autopilot.md tells a driver to write.
  it.each([
    ['absent', undefined],
    ['null', null],
    ['status PASS', { status: 'PASS' }],
    ['ok true', { ok: true }],
    ['passed true', { passed: true }],
    ['status UNMEASURED', { status: 'UNMEASURED' }],
    ['an empty object', {}],
    ['free-form prose', { lint: 'ok', test: '3 failed' }],
    ['a lowercase status', { status: 'fail' }],
    ['ok spelled as a string', { ok: 'false' }],
    ['a nested layer result', { mcp: { ok: false, violations: ['x'] } }],
    ['a bare string', 'FAIL'],
    ['an array', [{ status: 'FAIL' }]],
  ])('should not read %s as a FAIL', (_label, verifyResult) => {
    expect(evaluateReportVerifyEvidence(withResult(verifyResult))).toMatchObject({ ok: true, code: 'ok' });
  });

  it.each([
    ['NO_VERIFY_ATTEMPT', 'an empty journal', stateOf([])],
    ['VERIFY_NOT_ACKED', 'an unacknowledged VERIFY', stateOf([started('v1', 'VERIFY')])],
    ['VERIFY_NOT_DONE', 'a failed acknowledgement', stateOf([started('v1', 'VERIFY'), acked('v1', 'VERIFY', 'failed')])],
    ['STALE_BEFORE_EXECUTE', 'a VERIFY older than the last EXECUTE', stateOf([...EVIDENCE, started('e2', 'EXECUTE')])],
    ['VERIFY_NOT_ACKED', 'an open VERIFY slot', stateOf(EVIDENCE, { attemptId: 'v2', phase: 'VERIFY', status: 'started', checkpointSha: null })],
  ])('should still answer %s for %s when the result object is a FAIL too', (code, _label, s) => {
    expect(evaluateReportVerifyEvidence({ ...s, verifyResult: { status: 'FAIL' } }).code).toBe(code);
  });

  it('should agree with foldVerify on every shape where the fold is not a contradiction', () => {
    const shapes = [
      undefined, null, 'FAIL', [], {}, { status: 'PASS' }, { status: 'FAIL' }, { status: 'UNMEASURED' },
      { ok: true }, { ok: false }, { passed: true }, { passed: false }, { status: 'fail' }, { ok: 'false' },
      { lint: 'x' }, { mcp: { ok: false } }, { status: 'FAIL', ok: false }, { ok: true, passed: true },
    ];
    for (const shape of shapes) {
      const refused = evaluateReportVerifyEvidence(withResult(shape)).code === 'VERIFY_RESULT_FAILED';
      expect(refused, JSON.stringify(shape)).toBe(foldVerify(shape) === 'FAIL');
    }
  });

  it('should refuse the contradictions that foldVerify reads as UNMEASURED (the one deliberate difference)', () => {
    for (const shape of [{ status: 'PASS', ok: false }, { status: 'FAIL', ok: true }, { status: 'UNMEASURED', passed: false }]) {
      expect(foldVerify(shape), 'precondition: the fold calls a contradiction UNMEASURED').toBe('UNMEASURED');
      expect(evaluateReportVerifyEvidence(withResult(shape)).code).toBe('VERIFY_RESULT_FAILED');
    }
  });

  it('should read the state without changing it', () => {
    const s = withResult({ status: 'FAIL' });
    const before = JSON.stringify(s);
    evaluateReportVerifyEvidence(s);
    expect(JSON.stringify(s)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 2. Kill switch
// ---------------------------------------------------------------------------

describe('kill switch reader', () => {
  const at = (value) => ({ autopilot: { reportVerifyGate: { enforce: value } } });

  it('should read ON only for the literal boolean true', () => {
    expect(readReportVerifyGateEnforce(at(true))).toBe(true);
    for (const v of ['true', 1, 'yes', false, null, undefined, {}]) {
      expect(readReportVerifyGateEnforce(at(v))).toBe(false);
    }
  });

  it('should read OFF for a config without the key or a non-object config', () => {
    for (const cfg of [{}, { autopilot: {} }, null, undefined, 'x', 42]) {
      expect(readReportVerifyGateEnforce(cfg)).toBe(false);
    }
  });

  it('should read the shipped config as OFF', () => {
    expect(REPORT_VERIFY_GATE_ENFORCE_CONFIG_PATH).toBe('autopilot.reportVerifyGate.enforce');
    expect(loadReportVerifyGateConfig()).toEqual({ enforce: false });
  });
});

// ---------------------------------------------------------------------------
// 3. Engine — runPhase6Report
// ---------------------------------------------------------------------------

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const scrub = (value) => JSON.parse(JSON.stringify(value).replace(ISO, '<ts>'));
const gateTicks = (sessionId) => readEvents(sessionId).filter((e) => e.type === 'report-verify-gate');

/**
 * The Phase Timeline REPORT row that `replay.js#renderTimelineTable` prints for
 * one run's events, minus every column derived from the wall clock:
 * [phase, events, warn, error, retry]. Dropped: start time and duration, and the
 * bottleneck mark, which `summarizeEvents` sets on the longest phase — two runs
 * of the same events can differ there by timing alone (batch 20 CI, Node 24:
 * '⚠' vs '-'). The event count, the column a leaked OFF tick would move, stays.
 * Read from the renderer, not the report file: the dev report template carries
 * no Phase Timeline at all.
 * @param {object[]} events
 * @returns {string[]}
 */
function reportTimelineRow(events) {
  const table = renderTimelineTable(summarizeEvents('run', events));
  const line = table.split('\n').find((l) => l.startsWith('| REPORT |'));
  const cells = line.split('|').slice(1, -1).map((c) => c.trim());
  return [cells[0], ...cells.slice(3, -1)];
}

/**
 * Run runPhase6Report on a fresh copy of the same persisted session, and put the
 * session file back afterwards, so two runs start from identical bytes.
 */
function runReportFrom(sessionId, snapshot) {
  const before = readEvents(sessionId).length;
  const state = JSON.parse(snapshot);
  const result = runPhase6Report(state);
  const events = readEvents(sessionId).slice(before);
  const timelineRow = reportTimelineRow(events);
  writeFileSync(getSessionPath(sessionId), snapshot);
  return { state, result, events, timelineRow };
}

describe('runPhase6Report — switch OFF (shipped)', () => {
  it('should be byte-identical to a gate-less run: state, return, events and the timeline row', async () => {
    const sessionId = await start('off-baseline');
    const snapshot = readFileSync(getSessionPath(sessionId), 'utf8');

    gateMode.bypass = true;
    const baseline = runReportFrom(sessionId, snapshot);
    gateMode.bypass = false;
    gateMode.config = { enforce: false };
    const gated = runReportFrom(sessionId, snapshot);

    expect(scrub(gated.state)).toEqual(scrub(baseline.state));
    expect(scrub(gated.result)).toEqual(scrub(baseline.result));
    expect(gated.result.type).toBe('phase-result');
    expect(gated.state.phase).toBe('COMPLETED');

    // events.ndjson grows by exactly what the gate-less run added: zero from the gate.
    // Soft: each pin reports on its own, so a regression shows every surface it moved.
    expect.soft(gated.events.length).toBe(baseline.events.length);
    expect.soft(scrub(gated.events)).toEqual(scrub(baseline.events));
    // The Phase Timeline REPORT row — the '이벤트' column above all.
    expect.soft(gated.timelineRow).toEqual(baseline.timelineRow);
    expect(baseline.timelineRow[0]).toBe('REPORT');
    // Five cells or the slice above silently dropped the event count.
    expect(baseline.timelineRow).toHaveLength(5);

  });

  it('should write nothing and return null on a direct call for every failing code', () => {
    const cases = [
      stateOf([]),
      stateOf([started('v1', 'VERIFY')]),
      stateOf([started('v1', 'VERIFY'), acked('v1', 'VERIFY', 'failed')]),
      stateOf([started('v1', 'VERIFY'), acked('v1', 'VERIFY'), started('e2', 'EXECUTE')]),
      withResult({ status: 'FAIL' }),
    ];
    for (const s of cases) {
      const state = { ...s, sessionId: uniqueId('off-direct'), phase: 'REPORT' };
      sessionsToClean.add(state.sessionId);
      const before = JSON.stringify(state);
      expect(gateReportOnVerify(state, { enforce: false })).toBeNull();
      expect(JSON.stringify(state)).toBe(before);
      expect(readEvents(state.sessionId)).toEqual([]);
      expect(loadSession(state.sessionId)).toBeNull();
    }
  });
});

describe('runPhase6Report — switch ON', () => {
  it('should pause back to VERIFY when there is no VERIFY evidence, and resume should go there', async () => {
    const sessionId = await start('on-pause');
    gateMode.config = { enforce: true };

    const result = runPhase6Report(loadSession(sessionId));

    expect(result).toMatchObject({
      type: 'pause',
      sessionId,
      reason: 'report-verify-evidence-missing:NO_VERIFY_ATTEMPT',
      code: 'NO_VERIFY_ATTEMPT',
    });
    const paused = loadSession(sessionId);
    expect(paused).toMatchObject({
      phase: 'PAUSED',
      lastPhase: 'REPORT',
      pendingPhase: 'VERIFY',
      pausedReason: 'report-verify-evidence-missing:NO_VERIFY_ATTEMPT',
    });
    expect(paused.completedAt ?? null).toBeNull();
    expect(paused.reportPath ?? null).toBeNull();
    const pauseTicks = readEvents(sessionId).filter((e) => e.phase === 'REPORT' && e.type === 'pause');
    expect(pauseTicks).toHaveLength(1);
    expect(pauseTicks[0]).toMatchObject({ level: 'warn', data: { code: 'NO_VERIFY_ATTEMPT', attemptId: null } });
    expect(gateTicks(sessionId)).toHaveLength(0);

    // The REPORT window is closed before the pause: resume goes to VERIFY, so
    // an open REPORT window would read as a crash inside REPORT.
    const events = readEvents(sessionId);
    expect(findUnterminatedPhases(events)).toEqual([]);
    const reportEnds = events.filter((e) => e.phase === 'REPORT' && e.type === 'phase-end');
    expect(reportEnds).toHaveLength(1);
    expect(reportEnds[0].data).toMatchObject({ resultStatus: 'paused', code: 'NO_VERIFY_ATTEMPT' });
    const endAt = events.findIndex((e) => e.phase === 'REPORT' && e.type === 'phase-end');
    const pauseAt = events.findIndex((e) => e.phase === 'REPORT' && e.type === 'pause');
    expect(endAt).toBeGreaterThan(-1);
    expect(endAt).toBeLessThan(pauseAt);

    const resumed = await resumeAutopilot(sessionId);
    expect(resumed.phase).toBe('VERIFY');
    expect(resumed.instruction.type).toBe('verify');
    expect(loadSession(sessionId).activePhaseAttempt).toMatchObject({ phase: 'VERIFY', status: 'started' });
  });

  it('should not let a bare VERIFY result lift the pause without a new attempt', async () => {
    // lastPhase stays REPORT: a VERIFY result with no open attempt must not
    // unpause the session, or the next REPORT meets the same missing evidence.
    const sessionId = await start('on-no-loop');
    gateMode.config = { enforce: true };
    runPhase6Report(loadSession(sessionId));

    recordPhaseResult(loadSession(sessionId), { phase: 'VERIFY', status: 'done' });
    const after = loadSession(sessionId);
    expect(after.phase).toBe('PAUSED');
    expect(after.pendingPhase).toBe('VERIFY');
  });

  it('should complete REPORT once VERIFY is re-run and acknowledged done', async () => {
    const sessionId = await start('on-complete');
    gateMode.config = { enforce: true };
    runPhase6Report(loadSession(sessionId));
    await resumeAutopilot(sessionId); // → VERIFY, opens an attempt
    recordPhaseResult(loadSession(sessionId), { phase: 'VERIFY', status: 'done' });

    const result = runPhase6Report(loadSession(sessionId));

    expect(result.type).toBe('phase-result');
    expect(typeof result.reportPath).toBe('string');
    expect(loadSession(sessionId).phase).toBe('COMPLETED');
    const ticks = gateTicks(sessionId);
    expect(ticks).toHaveLength(1);
    expect(ticks[0].data).toMatchObject({ code: 'ok', enforced: true });
    expect(typeof ticks[0].data.attemptId).toBe('string');
  });

  it('should pause on a VERIFY that predates the latest EXECUTE', async () => {
    const sessionId = await start('on-stale');
    gateMode.config = { enforce: true };
    const state = loadSession(sessionId);
    state.attemptJournal = [
      started('v1', 'VERIFY'), acked('v1', 'VERIFY'),
      started('e2', 'EXECUTE'), acked('e2', 'EXECUTE'),
    ];

    const result = runPhase6Report(state);

    expect(result).toMatchObject({ type: 'pause', code: 'STALE_BEFORE_EXECUTE', attemptId: 'v1' });
    expect(loadSession(sessionId)).toMatchObject({ phase: 'PAUSED', pendingPhase: 'VERIFY' });
  });

  it('should pause when the VERIFY was only acknowledged by the operator on resume', async () => {
    const sessionId = await start('on-operator-ack');
    gateMode.config = { enforce: true };
    const state = loadSession(sessionId);
    state.attemptJournal = [started('v1', 'VERIFY'), acked('v1', 'VERIFY', 'acknowledged-on-resume')];

    expect(runPhase6Report(state)).toMatchObject({ type: 'pause', code: 'VERIFY_NOT_DONE' });
  });

  it('should pause when the VERIFY was acknowledged done but its verifyResult is an explicit FAIL', async () => {
    const sessionId = await start('on-result-failed');
    gateMode.config = { enforce: true };
    const state = loadSession(sessionId);
    state.attemptJournal = [...EVIDENCE];
    state.verifyResult = { status: 'FAIL' };

    const result = runPhase6Report(state);

    expect(result).toMatchObject({
      type: 'pause',
      reason: 'report-verify-evidence-missing:VERIFY_RESULT_FAILED',
      code: 'VERIFY_RESULT_FAILED',
      attemptId: 'v1',
    });
    expect(loadSession(sessionId)).toMatchObject({
      phase: 'PAUSED', lastPhase: 'REPORT', pendingPhase: 'VERIFY',
      pausedReason: 'report-verify-evidence-missing:VERIFY_RESULT_FAILED',
    });
    expect(gateTicks(sessionId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Driver path — recordPhaseResult(REPORT), switch OFF
// ---------------------------------------------------------------------------

/**
 * One string per observable surface, so a pin names the surface it moved.
 * Masked: every ISO-8601 instant (`phases[].ts`, `updatedAt`) becomes `<ts>`,
 * and the session id — unique per test, it carries pid and clock — becomes
 * `<sid>`. Nothing else is masked.
 * @param {unknown} value
 * @param {string} sessionId
 * @returns {string}
 */
const pin = (value, sessionId) => JSON.stringify(value).replaceAll(sessionId, '<sid>').replace(ISO, '<ts>');

/**
 * Record REPORT the way a driver does when it bypasses runPhase6Report (the
 * path the gate module header's "What this gate cannot see" names), with the
 * switch injected OFF. The one place the injection is spelled.
 * @returns {{returned: object, state: string, disk: string, events: string, same: boolean}}
 */
function recordReportOff(state, payload) {
  gateMode.config = { enforce: false };
  sessionsToClean.add(state.sessionId);
  const before = readEvents(state.sessionId).length;
  const returned = recordPhaseResult(state, payload);
  return {
    returned,
    state: pin(state, state.sessionId),
    disk: pin(loadSession(state.sessionId), state.sessionId),
    events: pin(readEvents(state.sessionId).slice(before), state.sessionId),
    same: returned === state,
  };
}

describe('recordPhaseResult(REPORT) — switch OFF, driver path (characterization)', () => {
  it('(a) no VERIFY evidence: records REPORT and nothing else', () => {
    const state = {
      sessionId: uniqueId('drv-off-none'), phase: 'REPORT', lastPhase: 'EVALUATE', pendingPhase: null,
      phases: [], attemptJournal: [], activePhaseAttempt: null,
    };

    const r = recordReportOff(state, { phase: 'REPORT', status: 'done' });

    const expected = '{"sessionId":"<sid>","phase":"REPORT","lastPhase":"EVALUATE","pendingPhase":null,'
      + '"phases":[{"ts":"<ts>","name":"REPORT","status":"done"}],"attemptJournal":[],'
      + '"activePhaseAttempt":null,"updatedAt":"<ts>","schemaVersion":3}';
    expect.soft(r.state).toBe(expected);
    expect.soft(r.disk).toBe(expected);
    expect.soft(r.events).toBe('[]');
    expect(r.same).toBe(true);
  });

  it('(b) VERIFY evidence and a verifyResult present: the same REPORT record, the evidence untouched', () => {
    const state = {
      sessionId: uniqueId('drv-off-evidence'), phase: 'REPORT', lastPhase: 'EVALUATE', pendingPhase: null,
      phases: [], attemptJournal: [...EVIDENCE], activePhaseAttempt: null,
      verifyResult: { status: 'PASS' }, crossCheck: { verdict: 'pass' },
    };

    const r = recordReportOff(state, { phase: 'REPORT', status: 'done' });

    const journal = JSON.stringify(EVIDENCE).replace(ISO, '<ts>');
    const expected = '{"sessionId":"<sid>","phase":"REPORT","lastPhase":"EVALUATE","pendingPhase":null,'
      + `"phases":[{"ts":"<ts>","name":"REPORT","status":"done"}],"attemptJournal":${journal},`
      + '"activePhaseAttempt":null,"verifyResult":{"status":"PASS"},"crossCheck":{"verdict":"pass"},'
      + '"updatedAt":"<ts>","schemaVersion":3}';
    expect.soft(r.state).toBe(expected);
    expect.soft(r.disk).toBe(expected);
    expect.soft(r.events).toBe('[]');
    expect(r.same).toBe(true);
  });

  it('(c) OFF only: a REPORT result lifts a gate pause (PAUSED + lastPhase REPORT) and keeps pausedReason', () => {
    // Today's behaviour, pinned under OFF alone: the PAUSED + lastPhase branch of
    // recordPhaseResult lifts the pause for a REPORT result. The switch-ON
    // behaviour for the same input is a separate test, not a change to this one.
    const state = {
      sessionId: uniqueId('drv-off-paused'), phase: 'PAUSED', lastPhase: 'REPORT', pendingPhase: 'VERIFY',
      pausedReason: 'report-verify-evidence-missing:NO_VERIFY_ATTEMPT',
      phases: [], attemptJournal: [], activePhaseAttempt: null,
    };

    const r = recordReportOff(state, { phase: 'REPORT', status: 'done' });

    const expected = '{"sessionId":"<sid>","phase":"REPORT","lastPhase":"REPORT","pendingPhase":null,'
      + '"pausedReason":"report-verify-evidence-missing:NO_VERIFY_ATTEMPT",'
      + '"phases":[{"ts":"<ts>","name":"REPORT","status":"done"}],"attemptJournal":[],'
      + '"activePhaseAttempt":null,"updatedAt":"<ts>","schemaVersion":3}';
    expect.soft(r.state).toBe(expected);
    expect.soft(r.disk).toBe(expected);
    expect.soft(r.events).toBe('[]');
    expect(r.same).toBe(true);
  });

  it('(d) an explicit FAIL verifyResult beside done evidence: still the same REPORT record, no tick', () => {
    // The FAIL rule lives behind the switch. OFF, the result object is not read.
    const state = {
      sessionId: uniqueId('drv-off-failed'), phase: 'REPORT', lastPhase: 'EVALUATE', pendingPhase: null,
      phases: [], attemptJournal: [...EVIDENCE], activePhaseAttempt: null,
      verifyResult: { status: 'FAIL' },
    };

    const r = recordReportOff(state, { phase: 'REPORT', status: 'done' });

    const journal = JSON.stringify(EVIDENCE).replace(ISO, '<ts>');
    const expected = '{"sessionId":"<sid>","phase":"REPORT","lastPhase":"EVALUATE","pendingPhase":null,'
      + `"phases":[{"ts":"<ts>","name":"REPORT","status":"done"}],"attemptJournal":${journal},`
      + '"activePhaseAttempt":null,"verifyResult":{"status":"FAIL"},"updatedAt":"<ts>","schemaVersion":3}';
    expect.soft(r.state).toBe(expected);
    expect.soft(r.disk).toBe(expected);
    expect.soft(r.events).toBe('[]');
    expect(r.same).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Driver path — recordPhaseResult(REPORT), switch ON
// ---------------------------------------------------------------------------

const GATE_REASON = 'report-verify-evidence-missing:NO_VERIFY_ATTEMPT';

/**
 * A driver-path session already on disk, so the pause notifier's file queue has
 * something to write into — the case where a later persist would erase it.
 * @param {string} label
 * @param {object} fields
 * @returns {object}
 */
function seeded(label, fields) {
  const state = {
    sessionId: uniqueId(label), phase: 'REPORT', lastPhase: 'EVALUATE', pendingPhase: null,
    phases: [], attemptJournal: [], activePhaseAttempt: null, ...fields,
  };
  sessionsToClean.add(state.sessionId);
  saveSession(state);
  return state;
}

/** Record REPORT with the switch injected; returns the events it added. */
function recordReport(state, enforce, status = 'done') {
  gateMode.config = { enforce };
  const before = readEvents(state.sessionId).length;
  const returned = recordPhaseResult(state, { phase: 'REPORT', status });
  return { returned, events: readEvents(state.sessionId).slice(before) };
}

/**
 * "The driver writes nothing into `state.verifyResult` during a VERIFY re-run".
 * A sentinel, not `undefined`: assigning `undefined` is a write, and would erase a
 * stale FAIL the engine had left in place, hiding exactly the defect under test.
 */
const NO_WRITE = Symbol('no verifyResult write');

describe('recordPhaseResult(REPORT) — switch OFF evaluates nothing', () => {
  /**
   * Count reads of `attemptJournal`, the evidence the rule walks. The getter is
   * non-enumerable so the persist's JSON.stringify never counts as a read.
   */
  function countingState(label) {
    const state = seeded(label, {});
    const probe = { reads: 0 };
    Object.defineProperty(state, 'attemptJournal', {
      enumerable: false, configurable: true, get: () => { probe.reads += 1; return []; },
    });
    return { state, probe };
  }

  it('should never read the evidence with the switch OFF', () => {
    const { state, probe } = countingState('drv-off-count');
    recordReport(state, false);
    expect(probe.reads).toBe(0);
  });

  it('control: the same probe does see the evaluation with the switch ON', () => {
    const { state, probe } = countingState('drv-on-count');
    recordReport(state, true);
    expect(probe.reads).toBeGreaterThan(0);
  });
});

describe('recordPhaseResult(REPORT) — switch ON, driver path', () => {
  it('(ii) should refuse a REPORT without evidence and pause back to VERIFY', () => {
    const state = seeded('drv-on-refuse', {});

    const { returned, events } = recordReport(state, true);

    expect(returned).toBe(state);
    const expectedPause = {
      phase: 'PAUSED', lastPhase: 'REPORT', pendingPhase: 'VERIFY', pausedReason: GATE_REASON,
    };
    expect(state).toMatchObject(expectedPause);
    expect(state.phases).toEqual([]);
    const disk = loadSession(state.sessionId);
    expect(disk).toMatchObject(expectedPause);
    expect(disk.phases).toEqual([]);
    // The notifier queued onto the file; the persist after it kept the entry.
    expect(disk.queuedQuestions).toHaveLength(1);
    expect(disk.queuedQuestions[0]).toMatchObject({ type: 'pause', reason: GATE_REASON });

    expect(events.filter((e) => e.type === 'pause')).toHaveLength(1);
    expect(events.find((e) => e.type === 'pause')).toMatchObject({
      phase: 'REPORT', level: 'warn',
      data: { code: 'NO_VERIFY_ATTEMPT', attemptId: null, claimedStatus: 'done' },
    });
    // No REPORT phase-start exists on this path, so no phase-end either.
    expect(events.filter((e) => e.type === 'phase-end')).toEqual([]);
    expect(findUnterminatedPhases(readEvents(state.sessionId))).toEqual([]);
  });

  it.each(['COMPLETED', 'ABORTED', 'NOT_A_PHASE'])('(F1) should not revive a %s session: fields kept, one kept tick', (phase) => {
    const state = seeded(`drv-on-terminal-${phase}`, { phase, lastPhase: 'REPORT' });
    const before = JSON.stringify(state);
    const diskBefore = readFileSync(getSessionPath(state.sessionId), 'utf8');

    const { returned, events } = recordReport(state, true);

    expect(returned).toBe(state);
    expect(JSON.stringify(state)).toBe(before);
    expect(readFileSync(getSessionPath(state.sessionId), 'utf8')).toBe(diskBefore);
    expect(events.map((e) => [e.type, e.level, e.data?.kept])).toEqual([['report-verify-gate', 'warn', true]]);
  });

  it.each([
    ['an open VERIFY slot', {
      attemptJournal: [...EVIDENCE],
      activePhaseAttempt: { attemptId: 'v2', phase: 'VERIFY', status: 'started', checkpointSha: null },
    }, 'VERIFY_NOT_ACKED'],
    ['an operator-only acknowledgement', {
      attemptJournal: [started('v1', 'VERIFY'), acked('v1', 'VERIFY', 'acknowledged-on-resume')],
    }, 'VERIFY_NOT_DONE'],
    ['a VERIFY older than the last EXECUTE', {
      attemptJournal: [...EVIDENCE, started('e2', 'EXECUTE'), acked('e2', 'EXECUTE')],
    }, 'STALE_BEFORE_EXECUTE'],
    ['a done acknowledgement beside an explicit FAIL verifyResult', {
      attemptJournal: [...EVIDENCE], verifyResult: { status: 'FAIL' },
    }, 'VERIFY_RESULT_FAILED'],
  ])('(R5) should refuse on %s under its own code', (_label, fields, code) => {
    const state = seeded('drv-on-code', fields);

    const { events } = recordReport(state, true);

    expect(state).toMatchObject({
      phase: 'PAUSED', lastPhase: 'REPORT', pendingPhase: 'VERIFY', pausedReason: `report-verify-evidence-missing:${code}`,
    });
    expect(state.phases).toEqual([]);
    expect(events.find((e) => e.type === 'pause')?.data?.code).toBe(code);
  });

  it.each(['VERIFY', 'EXECUTE', 'PLAN'])('(R6) should not read the switch when recording %s', (phase) => {
    const state = seeded(`drv-noread-${phase}`, { phase });
    const before = gateMode.loads;

    recordPhaseResult(state, { phase, status: 'done' }, { transitionFromVerdict: false });

    expect(gateMode.loads).toBe(before);
  });

  it('(R6) control: recording REPORT reads the switch exactly once', () => {
    const state = seeded('drv-read-report', {});
    const before = gateMode.loads;
    recordReport(state, false);
    expect(gateMode.loads).toBe(before + 1);
  });

  it('(R7) should lift a gate pause once its open VERIFY attempt is acknowledged done', () => {
    const state = seeded('drv-on-verify-ack', {
      phase: 'PAUSED', lastPhase: 'REPORT', pendingPhase: 'VERIFY', pausedReason: GATE_REASON,
      activePhaseAttempt: { attemptId: 'v9', phase: 'VERIFY', status: 'started', checkpointSha: null },
    });
    gateMode.config = { enforce: true };

    recordPhaseResult(state, { phase: 'VERIFY', status: 'done' }, { transitionFromVerdict: false });

    expect(state).toMatchObject({ phase: 'VERIFY', pendingPhase: 'IMPROVE', activePhaseAttempt: null });
  });

  it('(iii) should record a REPORT with evidence exactly as OFF does, plus one gate tick', () => {
    const fields = { attemptJournal: [...EVIDENCE], verifyResult: { status: 'PASS' } };
    const off = seeded('drv-on-pass-off', fields);
    const on = seeded('drv-on-pass-on', fields);

    const offRun = recordReport(off, false);
    const onRun = recordReport(on, true);

    expect(pin(on, on.sessionId)).toBe(pin(off, off.sessionId));
    expect(pin(loadSession(on.sessionId), on.sessionId)).toBe(pin(loadSession(off.sessionId), off.sessionId));
    expect(offRun.events).toEqual([]);
    expect(onRun.events).toHaveLength(1);
    expect(onRun.events[0]).toMatchObject({
      phase: 'REPORT', type: 'report-verify-gate', level: 'info',
      data: { code: 'ok', attemptId: 'v1', enforced: true, via: 'recordPhaseResult' },
    });
  });

  it('(iv) should keep a gate pause: no field changes, one kept tick', () => {
    const state = seeded('drv-on-keep-gate', {
      phase: 'PAUSED', lastPhase: 'REPORT', pendingPhase: 'VERIFY', pausedReason: GATE_REASON,
    });
    const before = JSON.stringify(state);
    const diskBefore = readFileSync(getSessionPath(state.sessionId), 'utf8');

    const { returned, events } = recordReport(state, true);

    expect(returned).toBe(state);
    expect(JSON.stringify(state)).toBe(before);
    expect(readFileSync(getSessionPath(state.sessionId), 'utf8')).toBe(diskBefore);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      phase: 'REPORT', type: 'report-verify-gate', level: 'warn', data: { code: 'NO_VERIFY_ATTEMPT', kept: true },
    });
  });

  // R3: the maybePause shape (lastPhase === pendingPhase) with a non-gate reason.
  describe('(v) a pause for another reason', () => {
    const otherPause = { phase: 'PAUSED', lastPhase: 'REPORT', pendingPhase: 'REPORT', pausedReason: 'budget-danger' };

    it('should be kept, fields untouched, when there is no evidence', () => {
      const state = seeded('drv-on-keep-other', otherPause);
      const before = JSON.stringify(state);

      const { events } = recordReport(state, true);

      expect(JSON.stringify(state)).toBe(before);
      expect(state).toMatchObject({ phase: 'PAUSED', pausedReason: 'budget-danger' });
      expect(events.map((e) => [e.type, e.data?.kept])).toEqual([['report-verify-gate', true]]);
    });

    it('should lift exactly as before when the evidence is there', () => {
      const state = seeded('drv-on-lift-other', { ...otherPause, attemptJournal: [...EVIDENCE] });

      const { events } = recordReport(state, true);

      expect(state).toMatchObject({ phase: 'REPORT', pendingPhase: null, pausedReason: 'budget-danger' });
      expect(state.phases).toMatchObject([{ name: 'REPORT', status: 'done' }]);
      expect(events.map((e) => [e.type, e.data?.code])).toEqual([['report-verify-gate', 'ok']]);
    });

    it('should lift exactly as before with the switch OFF, evidence or not', () => {
      const state = seeded('drv-off-lift-other', otherPause);

      const { events } = recordReport(state, false);

      expect(state).toMatchObject({ phase: 'REPORT', pendingPhase: null, pausedReason: 'budget-danger' });
      expect(events).toEqual([]);
    });
  });

  it('(vi) should let REPORT through only after a re-run VERIFY is acknowledged done', async () => {
    const sessionId = await start('drv-on-verify-lift');
    const state = loadSession(sessionId);
    enterStateAt(state, 'EVALUATE');
    recordReport(state, true);
    expect(loadSession(sessionId)).toMatchObject({ phase: 'PAUSED', lastPhase: 'REPORT', pendingPhase: 'VERIFY' });

    // A second REPORT claim does not get past the pause either.
    recordReport(loadSession(sessionId), true);
    expect(loadSession(sessionId).phase).toBe('PAUSED');

    const resumed = await resumeAutopilot(sessionId);
    expect(resumed.phase).toBe('VERIFY');
    expect(resumed.instruction.type).toBe('verify');
    expect(loadSession(sessionId).activePhaseAttempt).toMatchObject({ phase: 'VERIFY', status: 'started' });
    gateMode.config = { enforce: true };
    recordPhaseResult(loadSession(sessionId), { phase: 'VERIFY', status: 'done' });
    expect(loadSession(sessionId)).toMatchObject({ phase: 'VERIFY', pendingPhase: 'IMPROVE' });

    const after = loadSession(sessionId);
    const { events } = recordReport(after, true);
    expect(after.phases.at(-1)).toMatchObject({ name: 'REPORT', status: 'done' });
    expect(events.map((e) => [e.type, e.data?.code])).toEqual([['report-verify-gate', 'ok']]);
  });

  /**
   * A session that reached REPORT with VERIFY acknowledged done beside an explicit
   * FAIL result, refused once; then VERIFY is re-run and acknowledged done.
   * `verifyResultAfterRerun` is what the driver writes into `state.verifyResult`
   * during the re-run; {@link NO_WRITE} is a driver that writes nothing at all.
   */
  async function refusedThenRerun(label, verifyResultAfterRerun) {
    const sessionId = await start(label);
    const seeded0 = loadSession(sessionId);
    seeded0.attemptJournal = [...EVIDENCE];
    seeded0.verifyResult = { status: 'FAIL' };
    enterStateAt(seeded0, 'EVALUATE');
    recordReport(loadSession(sessionId), true);
    expect(loadSession(sessionId)).toMatchObject({
      phase: 'PAUSED', lastPhase: 'REPORT', pendingPhase: 'VERIFY',
      pausedReason: 'report-verify-evidence-missing:VERIFY_RESULT_FAILED',
    });

    expect((await resumeAutopilot(sessionId)).phase).toBe('VERIFY');
    const rerun = loadSession(sessionId);
    if (verifyResultAfterRerun !== NO_WRITE) rerun.verifyResult = verifyResultAfterRerun;
    gateMode.config = { enforce: true };
    recordPhaseResult(rerun, { phase: 'VERIFY', status: 'done' });
    return sessionId;
  }

  it('(vii) should let REPORT through once the re-run VERIFY overwrites the FAIL result', async () => {
    const sessionId = await refusedThenRerun('drv-on-failed-lift', { status: 'PASS' });

    const after = loadSession(sessionId);
    const { events } = recordReport(after, true);

    expect(after.phases.at(-1)).toMatchObject({ name: 'REPORT', status: 'done' });
    expect(events.map((e) => [e.type, e.data?.code])).toEqual([['report-verify-gate', 'ok']]);
  });

  it('(viii) should refuse again when the re-run VERIFY itself leaves a FAIL in verifyResult', async () => {
    // A FAIL the driver writes AFTER the re-run was handed out belongs to the
    // re-run attempt: the hand-out emptied the slot first (W2-7), so nothing in it
    // can be a leftover. This is the fail-closed side of the attempt scope.
    const sessionId = await refusedThenRerun('drv-on-failed-stays', { status: 'FAIL' });

    const after = loadSession(sessionId);
    recordReport(after, true);

    expect(after.phases.map((p) => p.name)).not.toContain('REPORT');
    expect(loadSession(sessionId)).toMatchObject({
      phase: 'PAUSED', pausedReason: 'report-verify-evidence-missing:VERIFY_RESULT_FAILED',
    });
  });

  it('(ix) should let REPORT through when the re-run is acknowledged done and the driver writes no new result', async () => {
    // The stale-FAIL defect (W2-7): the previous attempt's FAIL used to stay in the
    // one slot, so a done re-run that did not overwrite it was refused with the
    // same code forever. The hand-out now seals it (archived, not deleted), so the
    // slot holds only what this attempt wrote: here, nothing.
    const sessionId = await refusedThenRerun('drv-on-stale-fail', NO_WRITE);

    const after = loadSession(sessionId);
    expect(after.verifyResult ?? null).toBeNull();
    const { events } = recordReport(after, true);

    expect(after.phases.at(-1)).toMatchObject({ name: 'REPORT', status: 'done' });
    expect(events.map((e) => [e.type, e.data?.code])).toEqual([['report-verify-gate', 'ok']]);
  });

  it('(ix-b) should let the engine path complete in the same situation', async () => {
    const sessionId = await refusedThenRerun('eng-on-stale-fail', NO_WRITE);

    const result = runPhase6Report(loadSession(sessionId));

    expect(result.type).toBe('phase-result');
    expect(loadSession(sessionId).phase).toBe('COMPLETED');
    expect(gateTicks(sessionId).map((e) => e.data.code)).toEqual(['ok']);
  });

  it('(x) should keep the sealed FAIL as evidence: archived under the hand-out that superseded it', async () => {
    const sessionId = await refusedThenRerun('drv-on-archive', NO_WRITE);

    const after = loadSession(sessionId);
    const verifyAcks = after.attemptJournal.filter((r) => r.phase === 'VERIFY' && r.event === 'acknowledged');
    const rerunId = verifyAcks.at(-1).attemptId;
    expect(rerunId).not.toBe('v1');
    expect(after.verifyResultScope).toEqual({ attemptId: rerunId });
    expect(after.verifyResultHistory).toEqual([
      { attemptId: null, verifyResult: { status: 'FAIL' }, supersededBy: rerunId },
    ]);
  });
});

describe('refuseRecordedReport — the livePhases argument', () => {
  const fresh = (label) => {
    const state = {
      sessionId: uniqueId(label), phase: 'REPORT', lastPhase: 'EVALUATE', pendingPhase: null,
      phases: [], attemptJournal: [], activePhaseAttempt: null,
    };
    sessionsToClean.add(state.sessionId);
    return state;
  };

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'REPORT'],
    ['a number', 42],
    ['a plain object', { REPORT: true }],
    ['a Set', new Set(['REPORT'])],
  ])('should refuse without pausing, and without throwing, when livePhases is %s', (_label, live) => {
    const state = fresh('live-bad');
    const before = JSON.stringify(state);
    let refused;

    expect(() => { refused = refuseRecordedReport(state, { status: 'done' }, { enforce: true }, live); }).not.toThrow();

    expect(refused).toBe(true);
    expect(JSON.stringify(state)).toBe(before);
    expect(readEvents(state.sessionId).map((e) => [e.type, e.level, e.data?.kept])).toEqual([
      ['report-verify-gate', 'warn', true],
    ]);
  });

  it('should treat an omitted livePhases the same way', () => {
    const state = fresh('live-omitted');
    expect(refuseRecordedReport(state, { status: 'done' }, { enforce: true })).toBe(true);
    expect(state.phase).toBe('REPORT');
  });

  it('control: a real phase list is what turns the same refusal into a pause', () => {
    const state = fresh('live-real');
    expect(refuseRecordedReport(state, { status: 'done' }, { enforce: true }, PHASES)).toBe(true);
    expect(state).toMatchObject({ phase: 'PAUSED', lastPhase: 'REPORT', pendingPhase: 'VERIFY' });
  });
});

// ---------------------------------------------------------------------------
// 5b. Attempt scope of state.verifyResult (W2-7 / CA-13 flip item 1)
// ---------------------------------------------------------------------------

/** The attempt object `openPhaseAttempt` hands the engine, reduced to what the seal reads. */
const attemptOf = (attemptId) => ({ attemptId, phase: 'VERIFY', status: 'started' });
const ON = { enforce: true };
const OFF = { enforce: false };
/** CA-03 (`recovery.transitionFromVerdict`) ON with the REPORT gate OFF: the W3-7 case. */
const CA03_ONLY = { enforce: false, transitionFromVerdict: true };
/** Both seal switches spelled out as OFF: the characterization case, nothing may change. */
const BOTH_OFF = { enforce: false, transitionFromVerdict: false };

describe('scopeVerifyResultToAttempt — a VERIFY hand-out seals the previous result', () => {
  it('should archive the previous result, empty the slot and stamp the new attempt', () => {
    const state = { verifyResult: { status: 'FAIL', lint: 'x' } };

    expect(scopeVerifyResultToAttempt(state, attemptOf('v2'), ON)).toBe(true);

    expect(state.verifyResult).toBeNull();
    expect(state.verifyResultScope).toEqual({ attemptId: 'v2' });
    expect(state.verifyResultHistory).toEqual([
      { attemptId: null, verifyResult: { status: 'FAIL', lint: 'x' }, supersededBy: 'v2' },
    ]);
  });

  it('should name the attempt that owned the slot, and keep every sealed result in order', () => {
    const state = { verifyResult: null };
    scopeVerifyResultToAttempt(state, attemptOf('v1'), ON);
    state.verifyResult = { status: 'FAIL' }; // what the driver wrote for v1
    scopeVerifyResultToAttempt(state, attemptOf('v2'), ON);
    state.verifyResult = { status: 'PASS' }; // what it wrote for v2
    scopeVerifyResultToAttempt(state, attemptOf('v3'), ON);

    expect(state.verifyResultHistory).toEqual([
      { attemptId: 'v1', verifyResult: { status: 'FAIL' }, supersededBy: 'v2' },
      { attemptId: 'v2', verifyResult: { status: 'PASS' }, supersededBy: 'v3' },
    ]);
    expect(state.verifyResultScope).toEqual({ attemptId: 'v3' });
    expect(state.verifyResult).toBeNull();
  });

  it.each([
    ['absent', undefined],
    ['null', null],
  ])('should only stamp when the slot is %s: there is nothing to archive', (_label, slot) => {
    const state = slot === undefined ? {} : { verifyResult: slot };

    expect(scopeVerifyResultToAttempt(state, attemptOf('v1'), ON)).toBe(true);

    expect(state.verifyResultScope).toEqual({ attemptId: 'v1' });
    expect('verifyResultHistory' in state).toBe(false);
  });

  it('should not archive a result the SAME attempt wrote when it is called twice for that attempt', () => {
    const state = { verifyResult: { status: 'FAIL' } };
    scopeVerifyResultToAttempt(state, attemptOf('v2'), ON);
    state.verifyResult = { status: 'PASS' }; // written for v2, after its hand-out

    scopeVerifyResultToAttempt(state, attemptOf('v2'), ON);

    expect(state.verifyResult).toEqual({ status: 'PASS' });
    expect(state.verifyResultHistory).toHaveLength(1);
  });

  it.each([
    ['the literal false', OFF],
    ['the string "true"', { enforce: 'true' }],
    ['the number 1', { enforce: 1 }],
    ['a config without the key', {}],
  ])('should touch nothing when the switch is %s', (_label, config) => {
    const state = { verifyResult: { status: 'FAIL' }, verifyResultScope: { attemptId: 'v1' } };
    const before = JSON.stringify(state);

    expect(scopeVerifyResultToAttempt(state, attemptOf('v2'), config)).toBe(false);

    expect(JSON.stringify(state)).toBe(before);
  });

  it('should read the shipped switch (OFF) when no config is passed', () => {
    const state = { verifyResult: { status: 'FAIL' } };
    const before = JSON.stringify(state);

    expect(scopeVerifyResultToAttempt(state, attemptOf('v2'))).toBe(false);

    expect(JSON.stringify(state)).toBe(before);
  });

  it.each([
    ['no attempt', undefined],
    ['a null attempt', null],
    ['an attempt without an id', {}],
    ['an empty id', { attemptId: '' }],
    ['a numeric id', { attemptId: 7 }],
  ])('should keep the slot when it cannot bind it to an attempt: %s (fail closed)', (_label, attempt) => {
    const state = { verifyResult: { status: 'FAIL' } };
    const before = JSON.stringify(state);

    expect(scopeVerifyResultToAttempt(state, attempt, ON)).toBe(false);

    expect(JSON.stringify(state)).toBe(before);
  });

  it.each([[null], [undefined], ['x'], [42]])('should not throw on a non-object state (%j)', (state) => {
    expect(scopeVerifyResultToAttempt(state, attemptOf('v1'), ON)).toBe(false);
  });

  it.each([
    ['a string', 'nope'],
    ['an object', { a: 1 }],
    ['null', null],
  ])('should replace a malformed history (%s) rather than throw', (_label, junk) => {
    const state = { verifyResult: { status: 'FAIL' }, verifyResultHistory: junk };

    expect(() => scopeVerifyResultToAttempt(state, attemptOf('v2'), ON)).not.toThrow();

    expect(state.verifyResultHistory).toEqual([
      { attemptId: null, verifyResult: { status: 'FAIL' }, supersededBy: 'v2' },
    ]);
  });

  it('should not modify the object it archives', () => {
    const prior = Object.freeze({ status: 'FAIL', nested: Object.freeze({ a: 1 }) });
    const state = { verifyResult: prior };

    expect(() => scopeVerifyResultToAttempt(state, attemptOf('v2'), ON)).not.toThrow();

    expect(state.verifyResultHistory[0].verifyResult).toEqual({ status: 'FAIL', nested: { a: 1 } });
  });
});

// ---------------------------------------------------------------------------
// 5c. The seal has two switches (W3-7): enforce OR recovery.transitionFromVerdict
// ---------------------------------------------------------------------------

describe('scopeVerifyResultToAttempt — either switch arms the seal (W3-7)', () => {
  // `state.verifyResult` has two readers: the REPORT gate (rule 6) and the SH-06
  // recorder, whose verdict CA-03 turns into a transition. The seal serves both, so
  // it obeys `reportVerifyGate.enforce` OR `recovery.transitionFromVerdict`, each
  // one only as the literal `true`. The REPORT gate itself stays `enforce`'s alone.
  it.each([
    ['enforce alone', ON],
    ['CA-03 alone', CA03_ONLY],
    ['CA-03 alone, with no enforce key at all', { transitionFromVerdict: true }],
    ['both', { enforce: true, transitionFromVerdict: true }],
  ])('should seal exactly as it does for enforce when %s is on', (_label, config) => {
    const state = { verifyResult: { status: 'FAIL', lint: 'x' } };

    expect(scopeVerifyResultToAttempt(state, attemptOf('v2'), config)).toBe(true);

    expect(state.verifyResult).toBeNull();
    expect(state.verifyResultScope).toEqual({ attemptId: 'v2' });
    expect(state.verifyResultHistory).toEqual([
      { attemptId: null, verifyResult: { status: 'FAIL', lint: 'x' }, supersededBy: 'v2' },
    ]);
  });

  it.each([
    ['both are the literal false', BOTH_OFF],
    ['both keys are absent', {}],
    ['both are the string "true"', { enforce: 'true', transitionFromVerdict: 'true' }],
    ['both are the number 1', { enforce: 1, transitionFromVerdict: 1 }],
    ['CA-03 is the string "true" and enforce is false', { enforce: false, transitionFromVerdict: 'true' }],
    ['CA-03 is the number 1 and enforce is false', { enforce: false, transitionFromVerdict: 1 }],
    ['CA-03 is an object', { enforce: false, transitionFromVerdict: {} }],
    ['CA-03 is null', { enforce: false, transitionFromVerdict: null }],
    ['CA-03 is undefined', { enforce: false, transitionFromVerdict: undefined }],
    ['the config is a string', 'x'],
    ['the config is a number', 42],
  ])('should touch nothing when %s (an allowlist: only a literal true arms it)', (_label, config) => {
    const state = { verifyResult: { status: 'FAIL' }, verifyResultScope: { attemptId: 'v1' } };
    const before = JSON.stringify(state);

    expect(scopeVerifyResultToAttempt(state, attemptOf('v2'), config)).toBe(false);

    expect(JSON.stringify(state)).toBe(before);
  });

  it('should not archive again when it is asked twice for one attempt under CA-03 alone', () => {
    const state = { verifyResult: { status: 'FAIL' } };
    scopeVerifyResultToAttempt(state, attemptOf('v2'), CA03_ONLY);
    state.verifyResult = { status: 'PASS' }; // written for v2, after its hand-out

    scopeVerifyResultToAttempt(state, attemptOf('v2'), CA03_ONLY);

    expect(state.verifyResult).toEqual({ status: 'PASS' });
    expect(state.verifyResultHistory).toHaveLength(1);
  });

  it.each([
    ['no attempt', undefined],
    ['a null attempt', null],
    ['an attempt without an id', {}],
    ['an empty id', { attemptId: '' }],
    ['a numeric id', { attemptId: 7 }],
  ])('should keep the slot when it cannot bind it to an attempt under CA-03 alone: %s (fail closed)', (_label, attempt) => {
    const state = { verifyResult: { status: 'FAIL' } };
    const before = JSON.stringify(state);

    expect(scopeVerifyResultToAttempt(state, attempt, CA03_ONLY)).toBe(false);

    expect(JSON.stringify(state)).toBe(before);
  });

  it.each([[null], [undefined], ['x'], [42]])('should not throw on a non-object state under CA-03 alone (%j)', (state) => {
    expect(scopeVerifyResultToAttempt(state, attemptOf('v1'), CA03_ONLY)).toBe(false);
  });

  it('should leave the REPORT gate to enforce alone: CA-03 ON never switches it on', () => {
    // The seal empties a slot; the gate refuses a REPORT. Only the second is an
    // enforcement, and only `enforce` may arm it.
    const noEvidence = { sessionId: uniqueId('ca03-gate'), phase: 'REPORT', attemptJournal: [], activePhaseAttempt: null };
    sessionsToClean.add(noEvidence.sessionId);
    const before = JSON.stringify(noEvidence);

    expect(gateReportOnVerify(noEvidence, CA03_ONLY)).toBeNull();
    expect(refuseRecordedReport(noEvidence, { status: 'done' }, CA03_ONLY, PHASES)).toBe(false);

    expect(JSON.stringify(noEvidence)).toBe(before);
    expect(readEvents(noEvidence.sessionId)).toEqual([]);
  });
});

describe('evaluateReportVerifyEvidence — the scope stamp never dismisses a result (fail closed)', () => {
  // The stamp is provenance, not an input to the verdict. A label cannot prove a
  // result stale: a stale in-memory copy saved back over the hand-out, or a
  // hand-out made by a build that does not scope, leaves a label naming the wrong
  // attempt beside a result that may well be current. Only the seal emptying the
  // slot can. So a slot that still holds an explicit FAIL is refused whatever the
  // label says about who owns it.
  it.each([
    ['no stamp (unbound: a legacy or hand-driven session)', undefined],
    ['a stamp naming the latest attempt', { attemptId: 'v1' }],
    ['a stamp naming an earlier attempt', { attemptId: 'v0' }],
    ['a stamp naming an attempt that is not in the journal', { attemptId: 'zzz' }],
    ['a stamp that is a bare string', 'v1'],
    ['an empty stamp', {}],
    ['a null stamp', null],
    ['a stamp with a numeric id', { attemptId: 1 }],
  ])('should still refuse an explicit FAIL under %s', (_label, scope) => {
    const state = { ...withResult({ status: 'FAIL' }), ...(scope === undefined ? {} : { verifyResultScope: scope }) };

    expect(evaluateReportVerifyEvidence(state)).toEqual({
      ok: false, code: 'VERIFY_RESULT_FAILED', attemptId: 'v1', checkpointSha: null,
    });
  });

  it('should never read the sealed history: a FAIL archived there is not this attempt\'s result', () => {
    const history = [{ attemptId: 'v0', verifyResult: { status: 'FAIL' }, supersededBy: 'v1' }];
    for (const slot of [null, undefined, { status: 'PASS' }, {}]) {
      const state = { ...withResult(slot), verifyResultScope: { attemptId: 'v1' }, verifyResultHistory: history };

      expect(evaluateReportVerifyEvidence(state), JSON.stringify(slot)).toMatchObject({ ok: true, code: 'ok' });
    }
  });

  it('should refuse a FAIL written for the latest attempt after its seal (scoped and current)', () => {
    const state = { ...withResult({ status: 'FAIL' }), verifyResultScope: { attemptId: 'v1' }, verifyResultHistory: [] };

    expect(evaluateReportVerifyEvidence(state).code).toBe('VERIFY_RESULT_FAILED');
  });

  it('should read the state without changing it, stamp and history included', () => {
    const s = {
      ...withResult({ status: 'FAIL' }),
      verifyResultScope: { attemptId: 'v1' },
      verifyResultHistory: [{ attemptId: null, verifyResult: { status: 'FAIL' }, supersededBy: 'v1' }],
    };
    const before = JSON.stringify(s);

    evaluateReportVerifyEvidence(s);

    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('a VERIFY hand-out through the engine (resumeAutopilot → runPhase4Verify)', () => {
  /**
   * A stored session that resumes into VERIFY (its phase is CROSS_CHECK, so the
   * engine's next target is VERIFY), carrying `fields`.
   * @param {string} label
   * @param {object} [fields]
   * @param {object} [options] - extra `startAutopilot` options
   * @returns {Promise<string>} session id
   */
  async function readyForVerify(label, fields = {}, options = {}) {
    const r = await startAutopilot({
      task: `report verify gate ${label}`,
      mode: 'default',
      options: { cpuCount: 2, projectRoot: artifactRoot, ...options },
      sessionId: uniqueId(label),
    });
    sessionsToClean.add(r.sessionId);
    saveSession({ ...loadSession(r.sessionId), phase: 'CROSS_CHECK', pendingPhase: null, ...fields });
    return r.sessionId;
  }

  it('should seal a stale FAIL, stamp the attempt it opened, and keep the FAIL in the history (switch ON)', async () => {
    gateMode.config = ON;
    const sessionId = await readyForVerify('scope-on', { verifyResult: { status: 'FAIL', lint: 'red' } });

    const resumed = await resumeAutopilot(sessionId);

    expect(resumed).toMatchObject({ phase: 'VERIFY', status: 'ok' });
    expect(resumed.instruction.type).toBe('verify');
    const after = loadSession(sessionId);
    const { attemptId } = after.activePhaseAttempt;
    expect(after.verifyResult).toBeNull();
    expect(after.verifyResultScope).toEqual({ attemptId });
    expect(after.verifyResultHistory).toEqual([
      { attemptId: null, verifyResult: { status: 'FAIL', lint: 'red' }, supersededBy: attemptId },
    ]);
  });

  it('should touch nothing with the switch OFF: the stale FAIL stays, no stamp, no history', async () => {
    gateMode.config = OFF;
    const stale = { status: 'FAIL', lint: 'red' };
    const sessionId = await readyForVerify('scope-off', { verifyResult: stale });

    await resumeAutopilot(sessionId);

    const after = loadSession(sessionId);
    expect(after.verifyResult).toEqual(stale);
    expect('verifyResultScope' in after).toBe(false);
    expect('verifyResultHistory' in after).toBe(false);
  });

  it('should touch nothing with the shipped switch and nothing injected', async () => {
    gateMode.shipped = true; // the real reader, against the artibot.config.json this checkout ships (OFF)
    const sessionId = await readyForVerify('scope-shipped', { verifyResult: { status: 'FAIL' } });

    await resumeAutopilot(sessionId);

    const after = loadSession(sessionId);
    expect(after.verifyResult).toEqual({ status: 'FAIL' });
    expect('verifyResultScope' in after).toBe(false);
    expect('verifyResultHistory' in after).toBe(false);
  });

  it('should seal at the crash re-run too, archiving the first hand-out\'s result under that hand-out', async () => {
    gateMode.config = ON;
    const sessionId = await readyForVerify('scope-rerun');
    await resumeAutopilot(sessionId); // v1 handed out, slot empty
    const first = loadSession(sessionId);
    const v1 = first.activePhaseAttempt.attemptId;
    first.verifyResult = { status: 'FAIL' }; // written for v1, never acknowledged
    saveSession(first);

    const resumed = await resumeAutopilot(sessionId); // crash: the engine re-runs VERIFY

    expect(resumed.phase).toBe('VERIFY');
    const after = loadSession(sessionId);
    const v2 = after.activePhaseAttempt.attemptId;
    expect(v2).not.toBe(v1);
    expect(after.verifyResult).toBeNull();
    expect(after.verifyResultScope).toEqual({ attemptId: v2 });
    expect(after.verifyResultHistory).toEqual([
      { attemptId: v1, verifyResult: { status: 'FAIL' }, supersededBy: v2 },
    ]);
  });

  it('should build the mcp slot AFTER the seal: fresh, never the previous attempt\'s layer result', async () => {
    gateMode.config = ON;
    const old = { status: 'FAIL', mcp: { ok: false, violations: ['old'] } };
    const sessionId = await readyForVerify('scope-mcp', { verifyResult: old }, { mcpVerify: true });

    const resumed = await resumeAutopilot(sessionId);

    expect(resumed.instruction.mcp?.enabled).toBe(true);
    const after = loadSession(sessionId);
    expect(after.verifyResult).toEqual({ mcp: { ok: null, violations: [] } });
    expect(after.verifyResultHistory[0].verifyResult).toEqual(old);
  });

  it('control: with the switch OFF the mcp slot keeps the previous attempt\'s layer result', async () => {
    gateMode.config = OFF;
    const old = { status: 'FAIL', mcp: { ok: false, violations: ['old'] } };
    const sessionId = await readyForVerify('scope-mcp-off', { verifyResult: old }, { mcpVerify: true });

    await resumeAutopilot(sessionId);

    expect(loadSession(sessionId).verifyResult).toEqual(old);
  });

  // W3-7: the seal serves two readers of the slot (the REPORT gate and the SH-06
  // recorder CA-03 acts on), so CA-03 ON arms it with the REPORT gate OFF.
  it('should seal when only CA-03 is ON: the stale FAIL moves to the history and the slot is stamped', async () => {
    gateMode.config = CA03_ONLY;
    const sessionId = await readyForVerify('scope-ca03', { verifyResult: { status: 'FAIL', lint: 'red' } });

    const resumed = await resumeAutopilot(sessionId);

    expect(resumed).toMatchObject({ phase: 'VERIFY', status: 'ok' });
    const after = loadSession(sessionId);
    const { attemptId } = after.activePhaseAttempt;
    expect(after.verifyResult).toBeNull();
    expect(after.verifyResultScope).toEqual({ attemptId });
    expect(after.verifyResultHistory).toEqual([
      { attemptId: null, verifyResult: { status: 'FAIL', lint: 'red' }, supersededBy: attemptId },
    ]);
  });

  it('should build the mcp slot AFTER the seal under CA-03 alone too', async () => {
    gateMode.config = CA03_ONLY;
    const old = { status: 'FAIL', mcp: { ok: false, violations: ['old'] } };
    const sessionId = await readyForVerify('scope-mcp-ca03', { verifyResult: old }, { mcpVerify: true });

    await resumeAutopilot(sessionId);

    const after = loadSession(sessionId);
    expect(after.verifyResult).toEqual({ mcp: { ok: null, violations: [] } });
    expect(after.verifyResultHistory[0].verifyResult).toEqual(old);
  });

  it('should touch nothing with both switches spelled out as OFF: the stale FAIL stays, no stamp, no history', async () => {
    gateMode.config = BOTH_OFF;
    const stale = { status: 'FAIL', lint: 'red' };
    const sessionId = await readyForVerify('scope-both-off', { verifyResult: stale });

    await resumeAutopilot(sessionId);

    const after = loadSession(sessionId);
    expect(after.verifyResult).toEqual(stale);
    expect('verifyResultScope' in after).toBe(false);
    expect('verifyResultHistory' in after).toBe(false);
  });

  it('should be byte-identical to a hand-out with no seal call when both switches are OFF: return, state and events', async () => {
    // The characterization pin for "both false = byte for byte as before": the same
    // stored session is handed out twice from the same bytes, once with the call
    // line removed (`sealBypass`) and once through the real seal reading BOTH_OFF.
    gateMode.config = BOTH_OFF;
    const sessionId = await readyForVerify('scope-bytes', { verifyResult: { status: 'FAIL', lint: 'red' } });
    const snapshot = readFileSync(getSessionPath(sessionId), 'utf8');
    const attemptIds = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
    const scrubRun = (value) => JSON.parse(JSON.stringify(value)
      .replace(ISO, '<ts>').replace(attemptIds, '<attempt>').replaceAll(sessionId, '<sid>'));
    const handOut = async (sealBypass) => {
      gateMode.sealBypass = sealBypass;
      const before = readEvents(sessionId).length;
      const returned = await resumeAutopilot(sessionId);
      const run = {
        returned: scrubRun(returned),
        state: scrubRun(loadSession(sessionId)),
        events: scrubRun(readEvents(sessionId).slice(before)),
      };
      writeFileSync(getSessionPath(sessionId), snapshot);
      return run;
    };

    const withoutSeal = await handOut(true);
    const bothOff = await handOut(false);

    expect.soft(bothOff.state).toEqual(withoutSeal.state);
    expect.soft(bothOff.events).toEqual(withoutSeal.events);
    expect.soft(bothOff.returned).toEqual(withoutSeal.returned);
    // Not vacuous: the hand-out ran, and the stale FAIL is the one it left in the slot.
    expect(bothOff.state.verifyResult).toEqual({ status: 'FAIL', lint: 'red' });
    expect(bothOff.events.map((e) => e.type)).toContain('attempt-started');
  });

  it('should leave the engine REPORT gate silent when only CA-03 is ON', async () => {
    gateMode.config = CA03_ONLY;
    const sessionId = await start('ca03-report');

    const result = runPhase6Report(loadSession(sessionId));

    expect(result.type).toBe('phase-result');
    expect(loadSession(sessionId).phase).toBe('COMPLETED');
    expect(gateTicks(sessionId)).toEqual([]);
    expect(readEvents(sessionId).filter((e) => e.type === 'pause')).toEqual([]);
  });

  it('should leave the driver-path REPORT record alone when only CA-03 is ON', () => {
    const state = seeded('ca03-drv', {});
    gateMode.config = CA03_ONLY;
    const before = readEvents(state.sessionId).length;

    recordPhaseResult(state, { phase: 'REPORT', status: 'done' });

    expect(state).toMatchObject({ phase: 'REPORT', pendingPhase: null });
    expect(state.phases.at(-1)).toMatchObject({ name: 'REPORT', status: 'done' });
    expect(readEvents(state.sessionId).slice(before)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. A session with no VERIFY row in its attempt journal, switch ON
// ---------------------------------------------------------------------------

/**
 * Sessions stored before the attempt journal existed (session v3, e0565e46) have
 * no `attemptJournal`; sessions whose VERIFY ran before VERIFY was armed (AP-N1,
 * e1e97dfa) have a journal with no VERIFY row. Rule B has nothing to read in
 * either, and the gate does not fall back to the `state.phases` rows those
 * sessions do carry. This pins today's behaviour so it is documented and
 * deliberate: switching the gate ON costs each such session one VERIFY re-run.
 */
async function legacySession(label) {
  const sessionId = await start(label);
  const stored = loadSession(sessionId);
  const legacy = {
    ...stored,
    schemaVersion: 2,
    phase: 'IMPROVE',
    phases: [...(stored.phases ?? []), { ts: '2026-08-10T00:00:00.000Z', name: 'VERIFY', status: 'DONE' }],
  };
  for (const key of ['attemptJournal', 'activePhaseAttempt', 'pendingPhase', 'subCheckpoints']) delete legacy[key];
  writeFileSync(getSessionPath(sessionId), JSON.stringify(legacy));
  return sessionId;
}

describe('a session with no VERIFY row in its attempt journal — switch ON', () => {
  it.each(['done', 'DONE'])('should not take a state.phases VERIFY row (%s) as evidence', (status) => {
    const phases = [{ name: 'EXECUTE', status: 'done' }, { name: 'VERIFY', status }];
    for (const legacy of [
      { schemaVersion: 2, phase: 'IMPROVE', phases },
      { schemaVersion: 3, phase: 'IMPROVE', phases, attemptJournal: [] },
      { schemaVersion: 3, phase: 'IMPROVE', phases, attemptJournal: [started('e1', 'EXECUTE'), acked('e1', 'EXECUTE')] },
    ]) {
      expect(evaluateReportVerifyEvidence(legacy)).toMatchObject({ ok: false, code: 'NO_VERIFY_ATTEMPT', attemptId: null });
    }
  });

  it('should load with an empty journal and pause once with NO_VERIFY_ATTEMPT', async () => {
    const sessionId = await legacySession('legacy-on');
    const loaded = loadSession(sessionId);
    expect(loaded).toMatchObject({ schemaVersion: 3, attemptJournal: [] }); // the migration's backfill
    gateMode.config = { enforce: true };

    expect(runPhase6Report(loaded)).toMatchObject({ type: 'pause', code: 'NO_VERIFY_ATTEMPT', attemptId: null });
    expect(loadSession(sessionId)).toMatchObject({ phase: 'PAUSED', lastPhase: 'REPORT', pendingPhase: 'VERIFY' });
  });

  it('should cost such a session one VERIFY re-run: resume into VERIFY, acknowledge done, then REPORT', async () => {
    const sessionId = await legacySession('legacy-rerun');
    gateMode.config = { enforce: true };
    runPhase6Report(loadSession(sessionId));

    expect((await resumeAutopilot(sessionId)).phase).toBe('VERIFY');
    recordPhaseResult(loadSession(sessionId), { phase: 'VERIFY', status: 'done' });
    const result = runPhase6Report(loadSession(sessionId));

    expect(result.type).toBe('phase-result');
    expect(loadSession(sessionId).phase).toBe('COMPLETED');
    expect(gateTicks(sessionId).map((e) => e.data.code)).toEqual(['ok']);
  });

  it('should refuse the same session on the driver path with the same code', async () => {
    const sessionId = await legacySession('legacy-drv');

    const { events } = recordReport(loadSession(sessionId), true);

    expect(loadSession(sessionId)).toMatchObject({
      phase: 'PAUSED', pendingPhase: 'VERIFY', pausedReason: 'report-verify-evidence-missing:NO_VERIFY_ATTEMPT',
    });
    expect(events.find((e) => e.type === 'pause')?.data?.code).toBe('NO_VERIFY_ATTEMPT');
  });

  it('should complete untouched with the switch OFF', async () => {
    const sessionId = await legacySession('legacy-off');
    gateMode.config = { enforce: false };

    expect(runPhase6Report(loadSession(sessionId)).type).toBe('phase-result');
    expect(gateTicks(sessionId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6b. Census: how many stored sessions the gate would refuse (R2-9, read-only)
// ---------------------------------------------------------------------------

/** A stored session as the pre-journal era wrote it: no attemptJournal, so rule B has nothing to read. */
const preJournal = (phase, extra = {}) => ({ sessionId: `pre-${phase}`, schemaVersion: 2, phase, ...extra });
/** A session with rule-B evidence: an EXECUTE, then a VERIFY acknowledged `done`. */
const evidenced = (phase, extra = {}) => ({
  sessionId: `ev-${phase}`, schemaVersion: 3, phase, attemptJournal: [...EVIDENCE], activePhaseAttempt: null, ...extra,
});
/** The two things the census cannot import (engine-state.js imports the gate): passed in, as `livePhases` is. */
const SEAMS = { nextTarget, phases: PHASES };
const ZERO_CODES = Object.fromEntries(Object.values(REPORT_VERIFY_CODES).map((code) => [code, 0]));
const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object') Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};

describe('censusReportVerifyEvidence', () => {
  /** Twelve pre-journal sessions and one evidenced one, placed at every kind of position. */
  const store = () => [
    preJournal('COMPLETED'), preJournal('ABORTED'), // terminal: resume is a no-op, the gate cannot fire
    preJournal('INTAKE'), preJournal('PLAN'), preJournal('EXECUTE'), preJournal('CROSS_CHECK'), // VERIFY still ahead
    preJournal('PAUSED', { lastPhase: 'REPORT', pendingPhase: 'VERIFY' }), // a gate pause: resume runs VERIFY
    preJournal('VERIFY'), preJournal('IMPROVE'), preJournal('EVALUATE'), preJournal('REPORT'), // past the hand-out
    preJournal('PAUSED', { sessionId: 'pre-PAUSED-improve', lastPhase: 'IMPROVE', pendingPhase: 'IMPROVE' }),
    evidenced('IMPROVE'),
  ];

  it('should zero every code of the closed vocabulary on an empty store, and measure pauseAtReport as 0', () => {
    expect(censusReportVerifyEvidence([], SEAMS)).toEqual({
      total: 0, unreadable: 0, byCode: ZERO_CODES, terminal: 0, live: 0, liveWithoutEvidence: 0, pauseAtReport: 0,
    });
  });

  it('should split a store by code, by terminal/live, and by who would really be paused at REPORT', () => {
    const c = censusReportVerifyEvidence(store(), SEAMS);

    expect(c).toEqual({
      total: 13,
      unreadable: 0,
      byCode: { ...ZERO_CODES, NO_VERIFY_ATTEMPT: 12, ok: 1 },
      terminal: 2, // COMPLETED, ABORTED
      live: 11,
      liveWithoutEvidence: 10, // the 11 live sessions minus the evidenced one
      // VERIFY, IMPROVE, EVALUATE, REPORT and the pause routed to IMPROVE reach REPORT
      // without another hand-out. The four sessions before VERIFY and the gate pause
      // pending VERIFY will be handed a VERIFY attempt by the engine first.
      pauseAtReport: 5,
    });
  });

  it('should keep the partitions exhaustive: codes and terminal/live each sum to the total', () => {
    const c = censusReportVerifyEvidence(store(), SEAMS);

    expect(Object.values(c.byCode).reduce((a, b) => a + b, 0)).toBe(c.total);
    expect(c.terminal + c.live).toBe(c.total);
    expect(c.liveWithoutEvidence).toBeLessThanOrEqual(c.live);
    expect(c.pauseAtReport).toBeLessThanOrEqual(c.liveWithoutEvidence);
  });

  it('should report pauseAtReport as null, not a guess, when the seams are not given', () => {
    const withoutSeams = censusReportVerifyEvidence(store());
    expect(withoutSeams.pauseAtReport).toBeNull();
    expect(withoutSeams).toMatchObject({ total: 13, terminal: 2, live: 11, liveWithoutEvidence: 10 });

    expect(censusReportVerifyEvidence(store(), { nextTarget }).pauseAtReport).toBeNull();
    expect(censusReportVerifyEvidence(store(), { phases: PHASES }).pauseAtReport).toBeNull();
  });

  it.each([
    ['a phase name the list does not know', () => 'NOT_A_PHASE'],
    ['null', () => null],
    ['a non-string', () => 42],
    ['a throw', () => { throw new Error('boom'); }],
  ])('should count a live session whose resume target is unknown (%s): toward the warning, not away', (_label, target) => {
    const c = censusReportVerifyEvidence([preJournal('INTAKE')], { nextTarget: target, phases: PHASES });

    expect(c.pauseAtReport).toBe(1);
  });

  it('should count every non-ok code in byCode, not only NO_VERIFY_ATTEMPT', () => {
    const c = censusReportVerifyEvidence([
      evidenced('REPORT'),
      { phase: 'REPORT', attemptJournal: [started('v1', 'VERIFY')], activePhaseAttempt: null },
      { phase: 'REPORT', attemptJournal: [started('v1', 'VERIFY'), acked('v1', 'VERIFY', 'failed')] },
      { phase: 'REPORT', attemptJournal: [...EVIDENCE, started('e2', 'EXECUTE')] },
      { phase: 'REPORT', attemptJournal: [...EVIDENCE], verifyResult: { status: 'FAIL' } },
    ], SEAMS);

    expect(c.byCode).toEqual({
      ok: 1, NO_VERIFY_ATTEMPT: 0, VERIFY_NOT_ACKED: 1, VERIFY_NOT_DONE: 1, STALE_BEFORE_EXECUTE: 1, VERIFY_RESULT_FAILED: 1,
    });
    expect(c.pauseAtReport).toBe(4);
  });

  it('should exempt no pre-journal shape: every phase and every phases[] VERIFY spelling is counted (R2-9)', () => {
    const shapes = [];
    for (const phase of [...PHASES, 'PAUSED', 'COMPLETED', 'ABORTED']) {
      for (const status of [undefined, 'done', 'DONE']) {
        const phases = status ? [{ name: 'VERIFY', status }] : [];
        shapes.push(preJournal(phase, { phases }));
        shapes.push({ ...preJournal(phase, { phases }), schemaVersion: 3, attemptJournal: [] });
      }
    }

    const c = censusReportVerifyEvidence(shapes, SEAMS);

    expect(c.total).toBe(shapes.length);
    expect(c.byCode.ok).toBe(0);
    expect(c.byCode.NO_VERIFY_ATTEMPT).toBe(shapes.length);
  });

  it('should count entries that are not session objects as unreadable, and never as a session', () => {
    const c = censusReportVerifyEvidence([null, undefined, 'x', 7, [], preJournal('INTAKE')], SEAMS);

    expect(c).toMatchObject({ total: 1, unreadable: 5 });
    expect(c.byCode.NO_VERIFY_ATTEMPT).toBe(1);
  });

  it.each([[null], [undefined], [{}], [42], ['abc']])('should throw on input that is not an iterable of sessions (%j)', (input) => {
    expect(() => censusReportVerifyEvidence(input, SEAMS)).toThrow(TypeError);
  });

  it('should accept any iterable of sessions: a Set, a Map\'s values, a generator', () => {
    const list = store();
    const expected = censusReportVerifyEvidence(list, SEAMS);

    expect(censusReportVerifyEvidence(new Set(list), SEAMS)).toEqual(expected);
    expect(censusReportVerifyEvidence(new Map(list.map((s) => [s.sessionId, s])).values(), SEAMS)).toEqual(expected);
    expect(censusReportVerifyEvidence((function* gen() { yield* list; })(), SEAMS)).toEqual(expected);
  });

  it('should be read-only: deep-frozen sessions go through untouched', () => {
    const frozen = deepFreeze(store());

    expect(() => censusReportVerifyEvidence(frozen, SEAMS)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 7. The shipped switch, driven with nothing injected (W29 #15)
// ---------------------------------------------------------------------------

const SHIPPED_CONFIG = JSON.parse(readFileSync(new URL('../../artibot.config.json', import.meta.url), 'utf8'));

/**
 * Run `fn` with `CLAUDE_PLUGIN_ROOT` pointing at a temp directory whose
 * artibot.config.json is `configText` (omitted: no file at all). The reader
 * resolves the file from the plugin root on every call, so this is the only
 * seam a test has to make the REAL reader see a different config. The session
 * store follows the root too, so create every session inside `fn`.
 * @param {string|undefined} configText
 * @param {(root: string) => any} fn
 */
function withPluginRoot(configText, fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'artibot-report-verify-root-'));
  if (configText !== undefined) writeFileSync(path.join(root, 'artibot.config.json'), configText);
  const previous = process.env.CLAUDE_PLUGIN_ROOT;
  process.env.CLAUDE_PLUGIN_ROOT = root;
  try {
    return fn(root);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = previous;
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** The shipped config with only the CA-13 switch set to `enforce`. */
const shippedWith = (enforce) => JSON.stringify({
  ...SHIPPED_CONFIG,
  autopilot: {
    ...SHIPPED_CONFIG.autopilot,
    reportVerifyGate: { ...SHIPPED_CONFIG.autopilot.reportVerifyGate, enforce },
  },
});

describe('the shipped switch, with nothing injected', () => {
  // Sections 3-5 inject the switch, so none of them runs what a user actually
  // gets: the engine's own default argument plus the reader against the config
  // this checkout ships. `gateMode.shipped` removes the injection.
  const failed = { attemptJournal: [...EVIDENCE], verifyResult: { status: 'FAIL' } };

  it('should read OFF from the config this checkout ships', () => {
    expect(SHIPPED_CONFIG.autopilot.reportVerifyGate.enforce).toBe(false);
    expect(loadReportVerifyGateConfig()).toEqual({ enforce: false });
  });

  it.each([
    ['no evidence', {}],
    ['an explicit FAIL result', failed],
  ])('engine path: runPhase6Report completes with %s, and the gate leaves no trace', async (_label, fields) => {
    const sessionId = await start('shipped-engine');
    const state = { ...loadSession(sessionId), ...fields };
    saveSession(state);
    gateMode.shipped = true;

    const result = runPhase6Report(loadSession(sessionId));

    expect(result.type).toBe('phase-result');
    expect(loadSession(sessionId).phase).toBe('COMPLETED');
    expect(gateTicks(sessionId)).toEqual([]);
    expect(readEvents(sessionId).filter((e) => e.type === 'pause')).toEqual([]);
  });

  it.each([
    ['no evidence', {}],
    ['an explicit FAIL result', failed],
  ])('driver path: recordPhaseResult(REPORT) records it with %s and emits nothing', (_label, fields) => {
    const state = seeded('shipped-drv', fields);
    gateMode.shipped = true;
    const before = readEvents(state.sessionId).length;

    recordPhaseResult(state, { phase: 'REPORT', status: 'done' });

    expect(state).toMatchObject({ phase: 'REPORT', pendingPhase: null });
    expect(state.phases.at(-1)).toMatchObject({ name: 'REPORT', status: 'done' });
    expect(readEvents(state.sessionId).slice(before)).toEqual([]);
  });

  // Without these the two blocks above could pass for the wrong reason (an
  // injected OFF that never reaches the real reader). Same calls, same
  // harness, a plugin root whose config is ON: both must now refuse.
  it('control: gateReportOnVerify pauses when the plugin root config is ON', () => {
    withPluginRoot(shippedWith(true), () => {
      gateMode.shipped = true;
      const state = { sessionId: uniqueId('shipped-on-gate'), phase: 'REPORT', attemptJournal: [], activePhaseAttempt: null };

      expect(gateReportOnVerify(state)).toMatchObject({ type: 'pause', code: 'NO_VERIFY_ATTEMPT' });
    });
  });

  it('control: recordPhaseResult(REPORT) refuses when the plugin root config is ON', () => {
    withPluginRoot(shippedWith(true), () => {
      gateMode.shipped = true;
      const state = seeded('shipped-on-drv', {});

      recordPhaseResult(state, { phase: 'REPORT', status: 'done' });

      expect(state).toMatchObject({ phase: 'PAUSED', pendingPhase: 'VERIFY' });
      expect(state.phases).toEqual([]);
    });
  });

  it('control: the VERIFY hand-out seal takes the switch from the plugin root config too', () => {
    // The engine passes the seal no config, so the real reader is the only source.
    // ON here, OFF in 'should read the shipped switch (OFF) when no config is passed'.
    withPluginRoot(shippedWith(true), () => {
      const state = { verifyResult: { status: 'FAIL' } };

      expect(scopeVerifyResultToAttempt(state, attemptOf('v2'))).toBe(true);

      expect(state.verifyResult).toBeNull();
      expect(state.verifyResultHistory).toHaveLength(1);
    });
  });

  it('control: the ON copy differs from the shipped config in that one key only', () => {
    const on = JSON.parse(shippedWith(true));
    on.autopilot.reportVerifyGate.enforce = false;
    expect(on).toEqual(SHIPPED_CONFIG);
  });
});

// ---------------------------------------------------------------------------
// 8. The reader against real files
// ---------------------------------------------------------------------------

describe('loadReportVerifyGateConfig — the config file at the plugin root', () => {
  it.each([
    ['the literal true', { autopilot: { reportVerifyGate: { enforce: true } } }, true],
    ['the string "true"', { autopilot: { reportVerifyGate: { enforce: 'true' } } }, false],
    ['the key under the wrong parent', { reportVerifyGate: { enforce: true } }, false],
    ['a config without the key', { autopilot: {} }, false],
  ])('should read %s', (_label, cfg, expected) => {
    withPluginRoot(JSON.stringify(cfg), () => {
      expect(loadReportVerifyGateConfig()).toEqual({ enforce: expected });
    });
  });

  // The other half of "never throws": OFF is what a broken file reads as, with no
  // tick and no warning. A corrupted artibot.config.json silently disables the gate.
  it('should read OFF, without a trace, from a config that does not parse', () => {
    withPluginRoot('{ "autopilot": ', () => {
      expect(loadReportVerifyGateConfig()).toEqual({ enforce: false });
    });
  });

  it('should read OFF when the plugin root holds no config at all', () => {
    withPluginRoot(undefined, () => {
      expect(loadReportVerifyGateConfig()).toEqual({ enforce: false });
    });
  });
});

// ---------------------------------------------------------------------------
// 8b. The seal's two switches against real files (W3-7)
// ---------------------------------------------------------------------------

describe('scopeVerifyResultToAttempt — the two switches at the plugin root config', () => {
  // Nothing injected: the seal reads `autopilot.reportVerifyGate.enforce` and
  // `autopilot.recovery.transitionFromVerdict` itself, each strictly `=== true`.
  const sealConfig = (enforce, transitionFromVerdict) => JSON.stringify({
    autopilot: { reportVerifyGate: { enforce }, recovery: { transitionFromVerdict } },
  });

  it.each([
    ['both true', sealConfig(true, true), true],
    ['enforce alone', sealConfig(true, false), true],
    ['CA-03 alone', sealConfig(false, true), true],
    ['both false', sealConfig(false, false), false],
    ['the string "true" in both', sealConfig('true', 'true'), false],
    ['the number 1 for CA-03 with enforce false', sealConfig(false, 1), false],
    ['CA-03 true under the wrong parent', JSON.stringify({ recovery: { transitionFromVerdict: true } }), false],
    ['CA-03 true under reportVerifyGate', JSON.stringify({ autopilot: { reportVerifyGate: { transitionFromVerdict: true } } }), false],
    ['neither key', JSON.stringify({ autopilot: {} }), false],
  ])('should read %s', (_label, text, sealed) => {
    withPluginRoot(text, () => {
      const state = { verifyResult: { status: 'FAIL' } };

      expect(scopeVerifyResultToAttempt(state, attemptOf('v2'))).toBe(sealed);

      expect(state.verifyResult).toEqual(sealed ? null : { status: 'FAIL' });
    });
  });

  it('should read OFF, without a trace, from a config that does not parse', () => {
    withPluginRoot('{ "autopilot": ', () => {
      const state = { verifyResult: { status: 'FAIL' } };

      expect(() => scopeVerifyResultToAttempt(state, attemptOf('v2'))).not.toThrow();

      expect(state).toEqual({ verifyResult: { status: 'FAIL' } });
    });
  });

  it('should read OFF when the plugin root holds no config at all', () => {
    withPluginRoot(undefined, () => {
      const state = { verifyResult: { status: 'FAIL' } };

      expect(scopeVerifyResultToAttempt(state, attemptOf('v2'))).toBe(false);

      expect(state).toEqual({ verifyResult: { status: 'FAIL' } });
    });
  });
});

/** Put a started session where a driver would stand just before REPORT. */
function enterStateAt(state, phase) {
  state.phase = phase;
  state.pendingPhase = null;
  saveSession(state);
}
