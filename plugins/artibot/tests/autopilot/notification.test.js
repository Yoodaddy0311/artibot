/**
 * Tests for lib/autopilot/notification.js (Track A — Task A4).
 *
 * Covers:
 *   - notifyDanger fires in night-mode and --no-notify (safety-exempt)
 *   - notifyPhaseProgress / notifyIteration are suppressed in night mode
 *   - 5-min throttle gate applies to phase-progress + iteration
 *   - notifyDanger is throttle-exempt (every call fires)
 *   - queuedQuestions always records the payload (audit trail)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetThrottleForTests,
  notifyCompletion,
  notifyDanger,
  notifyIteration,
  notifyPause,
  notifyPhaseProgress,
  THROTTLE_WINDOW_MS,
} from '../../lib/autopilot/notification.js';
import {
  deleteSessionArtifacts,
  loadSession,
  newSessionId,
  saveSession,
} from '../../lib/autopilot/session-store.js';

const sessions = new Set();

/**
 * Helper: create+persist a minimal session with the given options.
 * Returns the new sessionId.
 */
function makeSession({ mode = 'default', options = {} } = {}) {
  const sessionId = newSessionId();
  saveSession({
    sessionId,
    mode,
    options,
    queuedQuestions: [],
    phase: 'EXECUTE',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    task: 'notification test session',
  });
  sessions.add(sessionId);
  return sessionId;
}

beforeEach(() => {
  _resetThrottleForTests();
});

afterEach(() => {
  for (const id of sessions) {
    try { deleteSessionArtifacts(id); } catch { /* ignore */ }
  }
  sessions.clear();
  _resetThrottleForTests();
});

describe('THROTTLE_WINDOW_MS', () => {
  it('is exported as a finite positive number (default 5 minutes)', () => {
    expect(THROTTLE_WINDOW_MS).toBe(5 * 60 * 1000);
  });
});

describe('notifyDanger', () => {
  it('returns tool=PushNotification even when mode=night', () => {
    const sessionId = makeSession({ mode: 'night' });
    const r = notifyDanger(sessionId, { riskType: 'git-force-push', detail: 'git push -f origin main' });
    expect(r.tool).toBe('PushNotification');
    expect(r.suppressed).toBe(false);
    expect(r.params).toMatchObject({ sessionId, urgency: 'high' });
    expect(r.queued.type).toBe('danger');
    expect(r.queued.riskType).toBe('git-force-push');
  });

  it('returns tool=PushNotification even when options.noNotify=true', () => {
    const sessionId = makeSession({ options: { noNotify: true } });
    const r = notifyDanger(sessionId, { riskType: 'secret-leak' });
    expect(r.tool).toBe('PushNotification');
    expect(r.suppressed).toBe(false);
  });

  it('is throttle-exempt: 5 rapid calls all fire (no throttled flag)', () => {
    const sessionId = makeSession();
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(notifyDanger(sessionId, { riskType: 'secret-leak', detail: `hit ${i}` }));
    }
    for (const r of results) {
      expect(r.tool).toBe('PushNotification');
      expect(r.suppressed).toBe(false);
      expect(r.throttled).toBeUndefined();
    }
  });

  it('appends every danger payload to queuedQuestions (audit trail)', () => {
    const sessionId = makeSession();
    notifyDanger(sessionId, { riskType: 'r1' });
    notifyDanger(sessionId, { riskType: 'r2' });
    const state = loadSession(sessionId);
    const dangers = state.queuedQuestions.filter((q) => q.type === 'danger');
    expect(dangers).toHaveLength(2);
    expect(dangers[0].riskType).toBe('r1');
    expect(dangers[1].riskType).toBe('r2');
    expect(typeof dangers[0].ts).toBe('string');
  });

  it('handles missing/invalid riskType gracefully (uses unknown-risk)', () => {
    const sessionId = makeSession();
    const r = notifyDanger(sessionId, {});
    expect(r.tool).toBe('PushNotification');
    expect(r.queued.riskType).toBe('unknown-risk');
  });
});

describe('notifyPhaseProgress', () => {
  it('fires actively in default mode and queues entry', () => {
    const sessionId = makeSession();
    const r = notifyPhaseProgress(sessionId, { fromPhase: 'INTAKE', toPhase: 'PLAN', durationMs: 1234 });
    expect(r.tool).toBe('PushNotification');
    expect(r.suppressed).toBe(false);
    expect(r.queued).toMatchObject({ type: 'phase-progress', fromPhase: 'INTAKE', toPhase: 'PLAN', durationMs: 1234 });
  });

  it('returns tool=null, suppressed=true in mode=night (still queues)', () => {
    const sessionId = makeSession({ mode: 'night' });
    const r = notifyPhaseProgress(sessionId, { fromPhase: 'PLAN', toPhase: 'EXECUTE' });
    expect(r.tool).toBeNull();
    expect(r.suppressed).toBe(true);
    const state = loadSession(sessionId);
    expect(state.queuedQuestions.some((q) => q.type === 'phase-progress')).toBe(true);
  });

  it('returns tool=null, suppressed=true when options.noNotify=true', () => {
    const sessionId = makeSession({ options: { noNotify: true } });
    const r = notifyPhaseProgress(sessionId, { fromPhase: 'A', toPhase: 'B' });
    expect(r.tool).toBeNull();
    expect(r.suppressed).toBe(true);
  });

  it('throttle: second call within window returns throttled=true, queued still appended', () => {
    const sessionId = makeSession();
    const first = notifyPhaseProgress(sessionId, { fromPhase: 'A', toPhase: 'B' });
    const second = notifyPhaseProgress(sessionId, { fromPhase: 'B', toPhase: 'C' });
    expect(first.tool).toBe('PushNotification');
    expect(first.throttled).toBeUndefined();
    expect(second.tool).toBeNull();
    expect(second.suppressed).toBe(true);
    expect(second.throttled).toBe(true);
    const state = loadSession(sessionId);
    const phaseEvents = state.queuedQuestions.filter((q) => q.type === 'phase-progress');
    expect(phaseEvents).toHaveLength(2);
  });
});

describe('notifyIteration', () => {
  it('fires actively in default mode with iteration metadata', () => {
    const sessionId = makeSession();
    const r = notifyIteration(sessionId, {
      iteration: 2,
      maxIterations: 5,
      met: false,
      lastValidation: { reason: 'tests failed', exitCode: 1 },
    });
    expect(r.tool).toBe('PushNotification');
    expect(r.queued).toMatchObject({
      type: 'iteration',
      iteration: 2,
      maxIterations: 5,
      met: false,
    });
    expect(r.queued.lastValidation.reason).toBe('tests failed');
  });

  it('suppressed in night mode but still queues', () => {
    const sessionId = makeSession({ mode: 'night' });
    const r = notifyIteration(sessionId, { iteration: 1, maxIterations: 3, met: false });
    expect(r.tool).toBeNull();
    expect(r.suppressed).toBe(true);
    const state = loadSession(sessionId);
    expect(state.queuedQuestions.some((q) => q.type === 'iteration')).toBe(true);
  });

  it('throttle: second call within window suppressed with throttled=true', () => {
    const sessionId = makeSession();
    const first = notifyIteration(sessionId, { iteration: 1, maxIterations: 3, met: false });
    const second = notifyIteration(sessionId, { iteration: 2, maxIterations: 3, met: false });
    expect(first.tool).toBe('PushNotification');
    expect(second.tool).toBeNull();
    expect(second.throttled).toBe(true);
  });
});

describe('queueOnSession integrity (regression for existing notifiers)', () => {
  it('notifyCompletion still appends queued entry with ts + type', () => {
    const sessionId = makeSession();
    const r = notifyCompletion(sessionId, 'COMPLETED');
    expect(r.queued.type).toBe('completion');
    const state = loadSession(sessionId);
    const entry = state.queuedQuestions.find((q) => q.type === 'completion');
    expect(entry).toBeDefined();
    expect(typeof entry.ts).toBe('string');
  });

  it('notifyPause still appends queued entry and respects night-mode', () => {
    const sessionId = makeSession({ mode: 'night' });
    const r = notifyPause(sessionId, 'context-window-exceeded');
    expect(r.tool).toBeNull();
    expect(r.suppressed).toBe(true);
    expect(r.queued.type).toBe('pause');
  });
});
