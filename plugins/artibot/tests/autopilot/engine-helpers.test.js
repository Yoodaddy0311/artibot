/**
 * Unit tests for lib/autopilot/_engine-helpers.js — preflight integration.
 *
 * Covers buildPreflightInstruction (ok/warn/error branches),
 * renderPreflightSummary (GFM table form), and makeInitialState's Wave 11
 * data-only auto-wire observation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPreflightInstruction,
  buildRecoveryNote,
  makeInitialState,
  renderPreflightSummary,
} from '../../lib/autopilot/_engine-helpers.js';
import { recordPhaseResult } from '../../lib/autopilot/engine-state.js';
import { ATTEMPT_STATUS } from '../../lib/autopilot/phase-attempt.js';
import { gateReportOnVerify } from '../../lib/autopilot/report-verify-gate.js';
import { deleteSessionArtifacts } from '../../lib/autopilot/session-store.js';
import { readEvents as readSessionEvents } from '../../lib/autopilot/telemetry.js';

// The driver path (`engine-state.js#recordPhaseResult`) reads the REPORT gate's
// switch through `loadReportVerifyGateConfig`, a named import a spy cannot
// reach. Same injection as report-verify-gate.test.js; OFF unless a test opts in.
const gateMode = vi.hoisted(() => ({ config: { enforce: false } }));

vi.mock('../../lib/autopilot/report-verify-gate.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadReportVerifyGateConfig: () => gateMode.config,
}));

const noHistoryDeps = {
  listSessions: vi.fn(() => []),
  readEvents: vi.fn(() => []),
};

// makeInitialState now writes one telemetry event per call, so every call in
// this file creates a real runtime/autopilot/<id>.events.ndjson. Pin the id so
// afterEach can delete it — an unpinned id is unrecoverable and leaks a file.
const helperIds = new Set();

/**
 * makeInitialState with a pinned, tracked sessionId and injected empty
 * session history (so the observation never reads the operator's real store).
 * @param {object} args - same shape as makeInitialState
 * @returns {object} initial state
 */
function makeTracked(args) {
  const sessionId = args.sessionId || `ap-helpers-${process.pid}-${helperIds.size + 1}`;
  helperIds.add(sessionId);
  return makeInitialState({ autoWireDeps: noHistoryDeps, ...args, sessionId });
}

afterEach(() => {
  gateMode.config = { enforce: false };
  for (const id of helperIds) {
    try { deleteSessionArtifacts(id); } catch { /* best-effort cleanup */ }
  }
  helperIds.clear();
});

describe('makeInitialState', () => {
  it('normalizes the fast request to a canonical boolean in persisted options', () => {
    expect(makeTracked({ task: 'fast true', options: { fast: true } }).options.fast).toBe(true);
    expect(makeTracked({ task: 'fast string', options: { fast: 'true' } }).options.fast).toBe(false);
    expect(makeTracked({ task: 'fast absent' }).options.fast).toBe(false);
  });

  it('records a data-only pre-intake observation that is never applied', () => {
    const state = makeTracked({ task: 'wire pre-intake data only' });
    expect(state.autoWire.preIntake.applied).toBe(false);
    expect('instruction' in state.autoWire.preIntake).toBe(false);
    expect('sessionId' in state.autoWire.preIntake).toBe(false);
  });

  it('emits exactly one auto-wire-pre-intake event at the INTAKE phase', () => {
    const state = makeTracked({ task: 'pre-intake telemetry' });
    const observed = readSessionEvents(state.sessionId)
      .filter((e) => e.type === 'auto-wire-pre-intake');
    expect(observed).toHaveLength(1);
    expect(observed[0].phase).toBe('INTAKE');
    expect(observed[0].data.applied).toBe(false);
  });

  it('keeps the DI seam out of the persisted options block', () => {
    const state = makeTracked({ task: 'deps are not persisted' });
    expect('autoWireDeps' in state.options).toBe(false);
  });
});

describe('buildPreflightInstruction', () => {
  it('returns null when result is ok with no warnings', () => {
    const r = buildPreflightInstruction({ ok: true, errors: [], warnings: [], checks: [] });
    expect(r).toBeNull();
  });

  it('returns null when input is undefined or malformed', () => {
    expect(buildPreflightInstruction(undefined)).toBeNull();
    expect(buildPreflightInstruction(null)).toBeNull();
    expect(buildPreflightInstruction('not-an-object')).toBeNull();
  });

  it('returns blocking PushNotification when errors exist', () => {
    const result = {
      ok: false,
      errors: [
        { check: 'lockFree', severity: 'error', message: 'held by pid=99' },
        { check: 'diskSpace', severity: 'error', message: '100MB free' },
      ],
      warnings: [],
      checks: [],
    };
    const r = buildPreflightInstruction(result);
    expect(r.tool).toBe('PushNotification');
    expect(r.abort).toBe(true);
    expect(r.suppress).toBe(false);
    expect(r.params.title).toMatch(/pre-flight/i);
    expect(r.params.message).toMatch(/lockFree/);
    expect(r.params.message).toMatch(/diskSpace/);
    expect(r.summary).toMatch(/2 hard fail/);
  });

  it('returns suppressed notice when only warnings exist', () => {
    const result = {
      ok: true,
      errors: [],
      warnings: [{ check: 'gitClean', severity: 'warn', message: '3 dirty paths' }],
      checks: [],
    };
    const r = buildPreflightInstruction(result);
    expect(r.tool).toBeNull();
    expect(r.suppress).toBe(true);
    expect(r.abort).toBe(false);
    expect(r.summary).toMatch(/1 warning/);
    expect(r.summary).toMatch(/gitClean/);
  });

  it('tolerates missing arrays', () => {
    const r = buildPreflightInstruction({ ok: false });
    // No errors array → falls through to warnings-only path with empty checks list.
    // But ok=false AND no errors AND no warnings → first branch returns null only when ok=true.
    // Since ok=false, errors=[] (defaulted), warnings=[] (defaulted): error branch is skipped,
    // and we enter warnings-only path producing an empty-checks notice.
    expect(r).not.toBeNull();
    expect(r.tool).toBeNull();
    expect(r.suppress).toBe(true);
  });
});

describe('renderPreflightSummary', () => {
  it('renders a GFM pipe table with 3 columns', () => {
    const out = renderPreflightSummary({
      checks: [
        { name: 'gitClean', status: 'pass' },
        { name: 'lockFree', status: 'fail', detail: 'held by pid=12' },
      ],
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe('| Check | Status | Detail |');
    expect(lines[1]).toBe('| --- | --- | --- |');
    expect(lines[2]).toBe('| gitClean | pass |  |');
    expect(lines[3]).toBe('| lockFree | fail | held by pid=12 |');
  });

  it('renders a placeholder row when checks array is empty', () => {
    const out = renderPreflightSummary({ checks: [] });
    expect(out).toMatch(/no checks/);
  });

  it('escapes pipe characters in detail strings', () => {
    const out = renderPreflightSummary({
      checks: [{ name: 'gitClean', status: 'warn', detail: 'a|b|c' }],
    });
    expect(out).toContain('a\\|b\\|c');
  });

  it('handles malformed input gracefully', () => {
    const out = renderPreflightSummary({});
    expect(out).toMatch(/no checks/);
    const out2 = renderPreflightSummary(null);
    expect(out2).toMatch(/no checks/);
  });
});

/**
 * The REPORT verify-evidence gate pauses a session back to VERIFY
 * (`report-verify-gate.js#pauseForVerify`): PAUSED, lastPhase REPORT,
 * pendingPhase VERIFY, and the REPORT window closed with a phase-end. Resume
 * then runs VERIFY (`engine-state.js#nextTarget`). Before this banner branch the
 * driver's pre-resume note was null for that pause — or, with an older window
 * still open in the log, named a phase resume would not run.
 *
 * The pause is produced by the real gate, not hand-built, so a change to the
 * gate's pause shape turns these red instead of leaving a stale fixture green.
 */
describe('buildRecoveryNote — REPORT verify-gate pause', () => {
  /** A fresh session paused by the enforced gate (no VERIFY attempt at all). */
  function gatePaused() {
    const state = makeTracked({ task: 'report gate pause banner' });
    const pause = gateReportOnVerify(state, { enforce: true });
    expect(pause?.type).toBe('pause');
    return state;
  }

  it('announces VERIFY re-entry for a gate pause', () => {
    const state = gatePaused();
    expect(state).toMatchObject({ phase: 'PAUSED', lastPhase: 'REPORT', pendingPhase: 'VERIFY' });

    const note = buildRecoveryNote(state);

    expect(note).toBeTypeOf('string');
    expect(note).toContain('VERIFY 재진입');
    expect(note).toContain(state.pausedReason);
    expect(note).not.toContain('REPORT 재진입');
  });

  it('announces VERIFY re-entry after the driver path refuses a REPORT record', () => {
    // A driver recording REPORT itself never enters runPhase6Report; the
    // refusal happens inside recordPhaseResult and must leave the same shape.
    gateMode.config = { enforce: true };
    const state = makeTracked({ task: 'driver-path report refusal banner' });
    expect(state.phase).not.toBe('PAUSED');

    recordPhaseResult(state, { phase: 'REPORT', status: 'done' });
    expect(state).toMatchObject({ phase: 'PAUSED', lastPhase: 'REPORT', pendingPhase: 'VERIFY' });
    expect(state.pausedReason).toMatch(/^report-verify-evidence-missing:/);

    const note = buildRecoveryNote(state);

    expect(note).toContain('VERIFY 재진입');
    expect(note).toContain(state.pausedReason);
  });

  it('names VERIFY, not an older open window, because VERIFY is what resume runs', () => {
    const state = gatePaused();
    const events = [{ type: 'phase-start', phase: 'EXECUTE', ts: '2026-09-28T00:00:00Z' }];

    const note = buildRecoveryNote(state, { events });

    expect(note).toContain('VERIFY 재진입');
    expect(note).not.toContain('EXECUTE 재진입');
  });

  it('lets an outstanding attempt outrank the gate pause (ADR-005 order kept)', () => {
    const state = gatePaused();
    state.activePhaseAttempt = {
      attemptId: 'b3c1f0de-0000-4000-8000-000000000001',
      phase: 'EXECUTE',
      runner: 'team-create',
      status: ATTEMPT_STATUS.STARTED,
      checkpointSha: null,
      startedAt: '2026-09-28T00:00:00Z',
    };

    const note = buildRecoveryNote(state);

    expect(note).toContain('자동 재실행하지 않습니다');
    expect(note).not.toContain('VERIFY 재진입');
  });

  it('leaves a non-gate pause on VERIFY to the existing banner', () => {
    // Negative control: a recovery pause re-targets VERIFY with lastPhase
    // VERIFY. It is not the gate's shape, so nothing here changes for it.
    const state = {
      sessionId: 'ap-helpers-non-gate',
      phase: 'PAUSED',
      lastPhase: 'VERIFY',
      pendingPhase: 'VERIFY',
      pausedReason: 'recovery:pause',
    };

    expect(buildRecoveryNote(state, { events: [] })).toBeNull();
  });
});
