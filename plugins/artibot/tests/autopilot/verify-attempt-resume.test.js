/**
 * VERIFY durable attempt — the real hand-off → crash → resume order (AP-N1).
 *
 * The defect: `runPhase4Verify` wrote `phase-end` at delegation time, so a
 * process that died between "VERIFY queued" and the verify result left a log
 * whose pairing looked clean, and resume walked on to IMPROVE → … → COMPLETED
 * with `verifyResult: null`. EXECUTE already had the durable-attempt contract;
 * this suite pins the same contract for VERIFY.
 *
 * Every case drives the engine the way a driver does — `startAutopilot`, then
 * `resumeAutopilot` phase by phase, with a reload from disk standing in for the
 * crash — rather than calling the phase-attempt helpers alone, because the
 * helpers were never the broken part: the engine simply never opened an
 * attempt for VERIFY.
 *
 * Isolation: the autopilot store is sandboxed by `tests/setup/state-dir.js`;
 * PRD/report artifacts are redirected with `options.projectRoot` below.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  abortAutopilot,
  buildRecoveryNote,
  detectInterruptedPhase,
  resumeAutopilot,
  runPhase4Verify,
  startAutopilot,
} from '../../lib/autopilot/index.js';
import { recordPhaseResult } from '../../lib/autopilot/engine-state.js';
import {
  findUnterminatedPhases,
  renderTimelineTable,
  summarizeEvents,
  summarizeSession,
} from '../../lib/autopilot/replay.js';
import { deleteSessionArtifacts, loadSession } from '../../lib/autopilot/session-store.js';
import { readEvents } from '../../lib/autopilot/telemetry.js';

// ARTIFACT ISOLATION CONTRACT: startAutopilot writes docs/PRD/ and
// abortAutopilot writes reports/AUTOPILOT/ under <projectRoot>/.
let artifactRoot = '';
beforeAll(() => {
  artifactRoot = mkdtempSync(path.join(os.tmpdir(), 'artibot-verify-attempt-artifacts-'));
});
afterAll(() => {
  try { rmSync(artifactRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

const sessionsToClean = new Set();
afterEach(async () => {
  for (const id of sessionsToClean) {
    try { await abortAutopilot(id, { graceful: true }); } catch { /* ignore */ }
    try { deleteSessionArtifacts(id); } catch { /* ignore */ }
  }
  sessionsToClean.clear();
});

let counter = 0;
function uniqueId(label) {
  counter += 1;
  return `ap-verify-attempt-${label}-${process.pid}-${Date.now()}-${counter}`;
}

/**
 * Start a session and resume it phase by phase until VERIFY has been handed
 * out. EXECUTE is acknowledged on the way, as a healthy driver would.
 * @param {string} label
 * @param {object} [options]
 * @returns {Promise<{sessionId: string, verify: object}>}
 */
async function driveToVerifyHandOff(label, options = {}) {
  const r = await startAutopilot({
    task: `verify attempt ${label}`,
    mode: 'default',
    options: { cpuCount: 2, ...options, projectRoot: artifactRoot },
    sessionId: uniqueId(label),
  });
  sessionsToClean.add(r.sessionId);
  expect((await resumeAutopilot(r.sessionId)).phase).toBe('PLAN');
  expect((await resumeAutopilot(r.sessionId)).phase).toBe('EXECUTE');
  recordPhaseResult(loadSession(r.sessionId), { phase: 'EXECUTE', status: 'done' });
  expect((await resumeAutopilot(r.sessionId)).phase).toBe('CROSS_CHECK');
  const verify = await resumeAutopilot(r.sessionId);
  expect(verify.phase).toBe('VERIFY');
  expect(verify.instruction.type).toBe('verify');
  return { sessionId: r.sessionId, verify };
}

const rowsOf = (state, event, phase = 'VERIFY') =>
  (state.attemptJournal || []).filter((row) => row.event === event && row.phase === phase);
const openPhases = (sessionId) => findUnterminatedPhases(readEvents(sessionId)).map((w) => w.phase);
const queuedCount = (state, name) =>
  (state.phases || []).filter((p) => p.name === name && p.status === 'queued').length;

describe('VERIFY hand-off opens a durable attempt', () => {
  it('should persist a started VERIFY attempt and withhold phase-end until the result', async () => {
    const { sessionId } = await driveToVerifyHandOff('handoff');

    // Reload = the only thing a restarted process has.
    const handed = loadSession(sessionId);
    expect(handed.activePhaseAttempt).toMatchObject({ phase: 'VERIFY', status: 'started' });
    expect(rowsOf(handed, 'started')).toHaveLength(1);

    const events = readEvents(sessionId).filter((e) => e.phase === 'VERIFY');
    expect(events.some((e) => e.type === 'phase-end')).toBe(false);
    expect(events.filter((e) => e.type === 'attempt-started')).toHaveLength(1);
    expect(openPhases(sessionId).at(-1)).toBe('VERIFY');
  });

  it('should tell the driver that the result report is what closes VERIFY', async () => {
    // The ACK is the only thing that clears the attempt; a driver that skips it
    // gets one re-run and then a pause, so the instruction has to say so.
    const { verify } = await driveToVerifyHandOff('instruction');
    const text = verify.instruction.instructions.join('\n');

    expect(text).toContain("recordPhaseResult(state, { phase: 'VERIFY'");
    expect(text).toContain('pause');
  });

  it('should open the attempt on the mcpVerify path too', async () => {
    const { sessionId, verify } = await driveToVerifyHandOff('mcp', { mcpVerify: true });

    expect(verify.instruction.mcp?.enabled).toBe(true);
    const handed = loadSession(sessionId);
    expect(handed.activePhaseAttempt).toMatchObject({ phase: 'VERIFY', status: 'started' });
    expect(handed.verifyResult?.mcp).toBeTruthy();
  });
});

describe('VERIFY queued → crash → resume', () => {
  it('should re-run VERIFY instead of walking on to IMPROVE', async () => {
    const { sessionId } = await driveToVerifyHandOff('crash');
    // Optional chaining so an unarmed VERIFY fails on the resume assertions
    // below (the behaviour), not on a TypeError here.
    const firstId = loadSession(sessionId).activePhaseAttempt?.attemptId;

    // Crash: no recordPhaseResult. The next process resumes from the file.
    const resumed = await resumeAutopilot(sessionId);

    expect(resumed.status).toBe('ok');
    expect(resumed.phase).toBe('VERIFY');
    expect(resumed.instruction.type).toBe('verify');
    expect(resumed.instruction.phase).not.toBe('IMPROVE');

    const after = loadSession(sessionId);
    expect(after.phase).toBe('VERIFY');
    expect(rowsOf(after, 'rerun')).toHaveLength(1);
    expect(rowsOf(after, 'rerun')[0].attemptId).toBe(firstId);
    // The re-run owns a fresh attempt, still unacknowledged.
    expect(rowsOf(after, 'started')).toHaveLength(2);
    expect(after.activePhaseAttempt).toMatchObject({ phase: 'VERIFY', status: 'started' });
    expect(after.activePhaseAttempt.attemptId).not.toBe(firstId);
    expect(queuedCount(after, 'IMPROVE')).toBe(0);
    expect(after.verifyResult ?? null).toBeNull();
    expect(readEvents(sessionId).filter((e) => e.type === 'attempt-rerun' && e.phase === 'VERIFY'))
      .toHaveLength(1);
    // Still unterminated: the re-run's window is open until its result lands.
    expect(openPhases(sessionId).at(-1)).toBe('VERIFY');
  });

  it('should advance to IMPROVE exactly once after the re-run is acknowledged', async () => {
    const { sessionId } = await driveToVerifyHandOff('ack-after-rerun');
    await resumeAutopilot(sessionId); // crash → re-run
    const rerunId = loadSession(sessionId).activePhaseAttempt?.attemptId;

    recordPhaseResult(loadSession(sessionId), { phase: 'VERIFY', status: 'done' });
    const acked = loadSession(sessionId);
    const journalAfterAck = JSON.stringify(acked.attemptJournal);
    expect(acked.activePhaseAttempt).toBeNull();
    expect(acked.pendingPhase).toBe('IMPROVE');
    expect(acked.attemptJournal.filter((r) => r.event === 'acknowledged' && r.attemptId === rerunId))
      .toHaveLength(1);
    // Every VERIFY window — the abandoned one and the re-run — is now closed.
    expect(openPhases(sessionId)).not.toContain('VERIFY');

    // Duplicate result before the next resume: a no-op on the attempt record.
    recordPhaseResult(loadSession(sessionId), { phase: 'VERIFY', status: 'done' });
    expect(JSON.stringify(loadSession(sessionId).attemptJournal)).toBe(journalAfterAck);

    const improve = await resumeAutopilot(sessionId);
    expect(improve.phase).toBe('IMPROVE');
    expect(improve.instruction.phase).toBe('IMPROVE');

    // A late duplicate result, then another resume: must move past IMPROVE,
    // never hand IMPROVE out twice and never re-run VERIFY again.
    recordPhaseResult(loadSession(sessionId), { phase: 'VERIFY', status: 'done' });
    const next = await resumeAutopilot(sessionId);
    expect(next.phase).not.toBe('IMPROVE');
    expect(next.phase).not.toBe('VERIFY');

    const final = loadSession(sessionId);
    expect(queuedCount(final, 'IMPROVE')).toBe(1);
    expect(rowsOf(final, 'rerun')).toHaveLength(1);
    expect(JSON.stringify(final.attemptJournal)).toBe(journalAfterAck);
  });

  it('should raise no recovery banner after the re-run is acknowledged', async () => {
    // The re-run leaves the crashed hand-off's `phase-start` behind; only the
    // re-run's window is closed by the ACK. If the abandoned one stayed open,
    // every later resume would be announced as "VERIFY 재진입" while the engine
    // actually moves on — the banner/engine contradiction of ADR-005 2단.
    const { sessionId } = await driveToVerifyHandOff('banner');
    await resumeAutopilot(sessionId); // crash → re-run
    recordPhaseResult(loadSession(sessionId), { phase: 'VERIFY', status: 'done' });

    expect(buildRecoveryNote(loadSession(sessionId))).toBeNull();
    expect(detectInterruptedPhase(loadSession(sessionId))).toEqual({ interrupted: false });

    // Still true once the session has moved on past VERIFY.
    expect((await resumeAutopilot(sessionId)).phase).toBe('IMPROVE');
    expect(buildRecoveryNote(loadSession(sessionId))).toBeNull();
  });

  it('should show no in-progress VERIFY row in the timeline after the re-run is acknowledged', async () => {
    const { sessionId } = await driveToVerifyHandOff('timeline');
    await resumeAutopilot(sessionId); // crash → re-run
    recordPhaseResult(loadSession(sessionId), { phase: 'VERIFY', status: 'done' });

    const verifyRows = summarizeSession(sessionId).phases.filter((p) => p.phase === 'VERIFY');
    expect(verifyRows.filter((p) => p.unterminated)).toHaveLength(0);
    // The abandoned window's end is the re-run, not the work finishing: its
    // span includes the downtime, so it is not reported as a measured duration.
    expect(verifyRows[0].durationMs).toBeNull();
    expect(renderTimelineTable(summarizeSession(sessionId))).not.toContain('진행중');
    // Whichever phase ranks top, the footer must quote a measured row, never
    // the unmeasured abandoned one ("(-, 0% of total)").
    expect(renderTimelineTable(summarizeSession(sessionId))).not.toMatch(/Top bottleneck: .*\(-,/);
  });

  it('should advance to IMPROVE with zero re-runs when the result arrives before any crash', async () => {
    // Negative control: a healthy session must not pay for the guard.
    const { sessionId } = await driveToVerifyHandOff('healthy');
    recordPhaseResult(loadSession(sessionId), { phase: 'VERIFY', status: 'done' });

    expect(readEvents(sessionId).filter((e) => e.phase === 'VERIFY' && e.type === 'phase-end'))
      .toHaveLength(1);
    expect(openPhases(sessionId)).not.toContain('VERIFY');

    const resumed = await resumeAutopilot(sessionId);
    expect(resumed.phase).toBe('IMPROVE');
    expect(resumed.recoveryNote).toBeUndefined();
    const after = loadSession(sessionId);
    expect(rowsOf(after, 'rerun')).toHaveLength(0);
    expect(queuedCount(after, 'IMPROVE')).toBe(1);
  });
});

describe('VERIFY re-run cap — a second unacknowledged crash pauses', () => {
  /** Hand-off → crash → re-run → crash again, never acknowledged. */
  async function crashTwice(label) {
    const { sessionId } = await driveToVerifyHandOff(label);
    expect((await resumeAutopilot(sessionId)).phase).toBe('VERIFY'); // re-run 1
    return sessionId;
  }

  it('should pause instead of re-running VERIFY a second time', async () => {
    const sessionId = await crashTwice('cap');
    const resumed = await resumeAutopilot(sessionId);

    expect(resumed.status).toBe('paused');
    expect(resumed.phase).toBe('VERIFY');
    expect(resumed.instruction).toMatchObject({ type: 'pause', reason: 'unacknowledged-attempt' });
    expect(resumed.recoveryNote).toContain('자동 재실행하지 않습니다');
    const paused = loadSession(sessionId);
    expect(paused).toMatchObject({ phase: 'PAUSED', lastPhase: 'VERIFY' });
    expect(rowsOf(paused, 'paused')).toHaveLength(1);
    expect(rowsOf(paused, 'rerun')).toHaveLength(1);
    expect(paused.activePhaseAttempt).toMatchObject({ phase: 'VERIFY', status: 'started' });
  });

  it('should resume into IMPROVE exactly once after the operator acknowledges the pause', async () => {
    const sessionId = await crashTwice('cap-op-ack');
    await resumeAutopilot(sessionId); // paused

    const resumed = await resumeAutopilot(sessionId, { ackOutstandingAttempt: true });
    expect(resumed.phase).toBe('IMPROVE');
    expect(resumed.instruction.phase).toBe('IMPROVE');
    expect(loadSession(sessionId).activePhaseAttempt).toBeNull();

    const next = await resumeAutopilot(sessionId);
    expect(next.phase).not.toBe('IMPROVE');
    const final = loadSession(sessionId);
    expect(queuedCount(final, 'IMPROVE')).toBe(1);
    expect(rowsOf(final, 'rerun')).toHaveLength(1);
  });

  it('should resume into IMPROVE exactly once after a late result lifts the pause', async () => {
    const sessionId = await crashTwice('cap-result');
    await resumeAutopilot(sessionId); // paused

    recordPhaseResult(loadSession(sessionId), { phase: 'VERIFY', status: 'done' });
    const resumed = await resumeAutopilot(sessionId);
    expect(resumed.phase).toBe('IMPROVE');
    expect(resumed.instruction.phase).toBe('IMPROVE');

    const next = await resumeAutopilot(sessionId);
    expect(next.phase).not.toBe('IMPROVE');
    expect(queuedCount(loadSession(sessionId), 'IMPROVE')).toBe(1);
  });
});

describe('findUnterminatedPhases — a re-run supersedes the abandoned window', () => {
  const abandoned = [
    { type: 'phase-start', phase: 'VERIFY', ts: '2026-09-28T00:00:00Z' },
    { type: 'attempt-rerun', phase: 'VERIFY', ts: '2026-09-28T00:05:00Z' },
    { type: 'phase-start', phase: 'VERIFY', ts: '2026-09-28T00:05:01Z' },
  ];

  it('should keep only the re-run window open before its result', () => {
    expect(findUnterminatedPhases(abandoned)).toEqual([
      { phase: 'VERIFY', startedAt: '2026-09-28T00:05:01Z' },
    ]);
  });

  it('should report nothing open once the re-run is acknowledged', () => {
    const acked = [...abandoned, { type: 'phase-end', phase: 'VERIFY', ts: '2026-09-28T00:06:00Z' }];
    expect(findUnterminatedPhases(acked)).toEqual([]);
  });

  it('should close the abandoned window in the timeline summary without measuring it', () => {
    const acked = [...abandoned, { type: 'phase-end', phase: 'VERIFY', ts: '2026-09-28T00:06:00Z' }];
    const rows = summarizeEvents('ap-unit', acked).phases;

    expect(rows.map((p) => p.unterminated)).toEqual([false, false]);
    expect(rows.map((p) => p.durationMs)).toEqual([null, 59_000]);
  });

  it('should quote the measured re-run row, not the abandoned one, in the bottleneck footer', () => {
    // Deterministic form of the reviewer's probe: VERIFY ranks top (60s vs
    // CROSS_CHECK's 10s) while its first same-named row is the abandoned one.
    const events = [
      { type: 'phase-start', phase: 'CROSS_CHECK', ts: '2026-09-28T00:00:00Z' },
      { type: 'phase-end', phase: 'CROSS_CHECK', ts: '2026-09-28T00:00:10Z' },
      { type: 'phase-start', phase: 'VERIFY', ts: '2026-09-28T00:00:10Z' },
      { type: 'attempt-started', phase: 'VERIFY', ts: '2026-09-28T00:00:11Z' },
      { type: 'attempt-rerun', phase: 'VERIFY', ts: '2026-09-28T00:05:00Z' },
      { type: 'phase-start', phase: 'VERIFY', ts: '2026-09-28T00:05:01Z' },
      { type: 'phase-end', phase: 'VERIFY', ts: '2026-09-28T00:06:01Z' },
    ];
    const summary = summarizeEvents('ap-unit', events);

    expect(summary.topBottleneck).toBe('VERIFY');
    expect(renderTimelineTable(summary)).toContain('Top bottleneck: **VERIFY** (1m 00s, 17% of total)');
  });

  it('should not let a re-run of one phase close another phase', () => {
    const events = [
      { type: 'phase-start', phase: 'EXECUTE', ts: '2026-09-28T00:00:00Z' },
      { type: 'attempt-rerun', phase: 'VERIFY', ts: '2026-09-28T00:01:00Z' },
    ];
    expect(findUnterminatedPhases(events).map((w) => w.phase)).toEqual(['EXECUTE']);
  });
});

describe('runPhase4Verify on a loaded state', () => {
  it('should leave the attempt slot for the result to clear, not the hand-off', async () => {
    const r = await startAutopilot({
      task: 'verify attempt direct',
      mode: 'default',
      options: { cpuCount: 2, projectRoot: artifactRoot },
      sessionId: uniqueId('direct'),
    });
    sessionsToClean.add(r.sessionId);
    runPhase4Verify(loadSession(r.sessionId));

    expect(loadSession(r.sessionId).activePhaseAttempt).toMatchObject({ phase: 'VERIFY' });
  });
});
