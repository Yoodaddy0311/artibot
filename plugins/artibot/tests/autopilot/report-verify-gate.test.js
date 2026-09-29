/**
 * REPORT verify-evidence gate (CA-13 / AP-N1 residual).
 *
 * Three layers:
 *   1. The evidence rule itself — `evaluateReportVerifyEvidence` over
 *      hand-built journals, one case per code plus the supersede/stale traps.
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
 *      re-run VERIFY is what lets REPORT through.
 *
 * The engine layer swaps the gate through `vi.mock` rather than `vi.spyOn`: the
 * engine holds a named import, which a spy on the module namespace never sees.
 * `gateMode.bypass` stands in for "the call line is not there" and
 * `gateMode.config` injects the switch without touching artibot.config.json.
 *
 * Isolation: the autopilot store (session JSON + events.ndjson) is sandboxed by
 * `tests/setup/state-dir.js` (ARTIBOT_AUTOPILOT_STORE_DIR); PRD and report
 * files go to a mkdtemp directory through `options.projectRoot` below.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const gateMode = vi.hoisted(() => ({ bypass: false, config: { enforce: false }, loads: 0 }));

vi.mock('../../lib/autopilot/report-verify-gate.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    gateReportOnVerify: (state, config) => (gateMode.bypass
      ? null
      : real.gateReportOnVerify(state, config ?? gateMode.config)),
    // A caller that reads the switch itself (the driver path, section 4) sees
    // the injected value instead of the plugin root's artibot.config.json.
    loadReportVerifyGateConfig: () => {
      gateMode.loads += 1;
      return gateMode.config;
    },
  };
});

const {
  REPORT_VERIFY_CODES,
  REPORT_VERIFY_GATE_ENFORCE_CONFIG_PATH,
  evaluateReportVerifyEvidence,
  loadReportVerifyGateConfig,
  readReportVerifyGateEnforce,
} = await vi.importActual('../../lib/autopilot/report-verify-gate.js');
const { gateReportOnVerify } = await import('../../lib/autopilot/report-verify-gate.js');
const {
  abortAutopilot,
  resumeAutopilot,
  runPhase6Report,
  startAutopilot,
} = await import('../../lib/autopilot/index.js');
const { recordPhaseResult } = await import('../../lib/autopilot/engine-state.js');
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
      'NO_VERIFY_ATTEMPT', 'STALE_BEFORE_EXECUTE', 'VERIFY_NOT_ACKED', 'VERIFY_NOT_DONE', 'ok',
    ]);
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
 * one run's events, minus its clock-time and duration columns:
 * [phase, events, warn, error, retry, bottleneck]. Read from the renderer, not
 * the report file: the dev report template carries no Phase Timeline at all.
 * @param {object[]} events
 * @returns {string[]}
 */
function reportTimelineRow(events) {
  const table = renderTimelineTable(summarizeEvents('run', events));
  const line = table.split('\n').find((l) => l.startsWith('| REPORT |'));
  const cells = line.split('|').slice(1, -1).map((c) => c.trim());
  return [cells[0], ...cells.slice(3)];
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

  });

  it('should write nothing and return null on a direct call for every failing code', () => {
    const cases = [
      stateOf([]),
      stateOf([started('v1', 'VERIFY')]),
      stateOf([started('v1', 'VERIFY'), acked('v1', 'VERIFY', 'failed')]),
      stateOf([started('v1', 'VERIFY'), acked('v1', 'VERIFY'), started('e2', 'EXECUTE')]),
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

const EVIDENCE = [
  started('e1', 'EXECUTE'), acked('e1', 'EXECUTE'),
  started('v1', 'VERIFY'), acked('v1', 'VERIFY'),
];

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
});

/** Put a started session where a driver would stand just before REPORT. */
function enterStateAt(state, phase) {
  state.phase = phase;
  state.pendingPhase = null;
  saveSession(state);
}
