/**
 * CA-03 wiring tests — `engine-state.js#recordPhaseResult` handing a journalled
 * VERIFY failure to `recovery-transition.js#applyRecoveryTransition`.
 *
 * The load-bearing case is the OFF one: with `autopilot.recovery.transitionFromVerdict`
 * false (the shipped default) the state and the event stream must be
 * byte-identical to what the Observe stage alone wrote. That is asserted by
 * comparing two serialised runs rather than by spot-checking fields, so a field
 * this file does not know about cannot drift in unnoticed.
 *
 * The ON cases are driven through `recordPhaseResult` with real inputs — the
 * recommendation is computed by `recovery-record.js#recordRecoveryDecision`, not
 * injected — so what is pinned here is the path an engine actually takes.
 */

import { readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { nextTarget, recordPhaseResult } from '../../lib/autopilot/engine-state.js';
import {
  deleteSessionArtifacts, getSessionPath, getStoreDir, saveSession,
} from '../../lib/autopilot/session-store.js';
import { readEvents } from '../../lib/autopilot/telemetry.js';
import { getPluginRoot } from '../../lib/core/platform.js';

const sessions = [];

function makeState(overrides = {}) {
  const sessionId = `test-ca03-${Math.random().toString(36).slice(2)}`;
  sessions.push(sessionId);
  return {
    sessionId, phase: 'VERIFY', pendingPhase: null, phases: [], ...overrides,
  };
}

afterEach(() => {
  while (sessions.length) {
    try {
      deleteSessionArtifacts(sessions.pop());
    } catch { /* best-effort */ }
  }
});

/** A VERIFY the driver reported as failed, with a reviewer `fail` token. */
const FAILED_VERIFY = Object.freeze({ phase: 'VERIFY', status: 'failed' });

/** Fields that differ between two otherwise-identical runs (clock + identity). */
const VOLATILE = new Set(['at', 'ts', 'updatedAt', 'sessionId', 'startedAt', 'finishedAt']);

/** Serialise with the volatile fields flattened, so two runs compare literally. */
function stable(value) {
  return JSON.stringify(value, (key, v) => (VOLATILE.has(key) ? '<normalised>' : v));
}

function eventTypes(sessionId) {
  return readEvents(sessionId).map((e) => e.type);
}

function findEvent(sessionId, type) {
  return readEvents(sessionId).find((e) => e.type === type) ?? null;
}

function failingState(overrides = {}) {
  return makeState({
    verifyResult: { ok: false },
    crossCheck: { verdict: 'fail' },
    counters: { buildFailures: 0, testFailures: 0 },
    ...overrides,
  });
}

describe('recordPhaseResult — CA-03 gate OFF (default)', () => {
  it('leaves state and events identical whether the gate is loaded or injected false', () => {
    const s1 = failingState();
    const s2 = failingState();

    recordPhaseResult(s1, { ...FAILED_VERIFY });
    recordPhaseResult(s2, { ...FAILED_VERIFY }, { transitionFromVerdict: false });

    expect(stable(s2)).toBe(stable(s1));
    expect(stable(readEvents(s2.sessionId))).toBe(stable(readEvents(s1.sessionId)));

    for (const state of [s1, s2]) {
      expect(state.recoveryJournal).toHaveLength(1);
      expect(state.recoveryJournal[0].divergent).toBe(true);
      expect(state.recoveryJournal[0].appliedNext).toBeUndefined();
      expect(state.recoveryJournal[0].appliedBy).toBeUndefined();
      expect(state.phase).toBe('VERIFY');
      expect(state.pendingPhase).toBeNull();
      expect(nextTarget(state)).toBe('IMPROVE');
      expect(eventTypes(state.sessionId)).toContain('recovery-decided');
      expect(eventTypes(state.sessionId)).not.toContain('recovery-applied');
    }
  });

  it.each([
    ['a string "true" is not a boolean true', { transitionFromVerdict: 'true' }],
    ['an empty config object', {}],
    ['1 is not a boolean true', { transitionFromVerdict: 1 }],
  ])('treats %s as OFF', (_label, config) => {
    const state = failingState();

    recordPhaseResult(state, { ...FAILED_VERIFY }, config);

    expect(nextTarget(state)).toBe('IMPROVE');
    expect(state.recoveryJournal[0].divergent).toBe(true);
    expect(state.recoveryJournal[0].appliedNext).toBeUndefined();
    expect(eventTypes(state.sessionId)).not.toContain('recovery-applied');
  });
});

describe('recordPhaseResult — CA-03 gate ON', () => {
  const ON = Object.freeze({ transitionFromVerdict: true });

  it('applies nothing to a clean VERIFY, because no row is recorded', () => {
    const state = makeState({ verifyResult: { status: 'PASS' }, crossCheck: { verdict: 'pass' } });

    recordPhaseResult(state, { phase: 'VERIFY', status: 'done' }, ON);

    expect(state.recoveryJournal).toBeUndefined();
    expect(nextTarget(state)).toBe('IMPROVE');
    expect(eventTypes(state.sessionId)).not.toContain('recovery-applied');
  });

  it('sends a first implementation failure back to EXECUTE (repair)', () => {
    const state = failingState();

    recordPhaseResult(state, { ...FAILED_VERIFY }, ON);

    const row = state.recoveryJournal[0];
    expect(row.class).toBe('implementation');
    expect(row.action).toBe('repair');
    expect(row).toMatchObject({ divergent: false, appliedNext: 'EXECUTE', appliedBy: 'recovery-transition' });
    expect(state.phase).toBe('VERIFY');
    expect(state.pendingPhase).toBe('EXECUTE');
    expect(nextTarget(state)).toBe('EXECUTE');
    expect(findEvent(state.sessionId, 'recovery-applied')).toMatchObject({
      data: { action: 'repair', from: 'IMPROVE', to: 'EXECUTE', pausedReason: null, divergent: false },
    });
  });

  it('sends a spent repair budget to PLAN (replan)', () => {
    const state = failingState({ counters: { buildFailures: 3, testFailures: 0 } });

    recordPhaseResult(state, { ...FAILED_VERIFY }, ON);

    const row = state.recoveryJournal[0];
    expect(row.action).toBe('replan');
    expect(row).toMatchObject({ divergent: false, appliedNext: 'PLAN' });
    expect(state.phase).toBe('VERIFY');
    expect(nextTarget(state)).toBe('PLAN');
    expect(findEvent(state.sessionId, 'recovery-applied').data.to).toBe('PLAN');
  });

  it('sends a repeat of the same class to PLAN even with the budget unspent', () => {
    // One prior implementation row makes this the second sighting, which is the
    // definition of "repeated" for the ladder (recovery-controller.js#REPEATED_AT).
    const state = failingState({ recoveryJournal: [{ class: 'implementation', action: 'repair' }] });

    recordPhaseResult(state, { ...FAILED_VERIFY }, ON);

    const row = state.recoveryJournal[1];
    expect(row.sameClassAttempts).toBe(2);
    expect(row.action).toBe('replan');
    expect(nextTarget(state)).toBe('PLAN');
  });

  it('pauses an UNMEASURED verification and resumes into VERIFY (ask_human)', () => {
    const state = makeState({ verifyResult: { status: 'UNMEASURED' } });

    recordPhaseResult(state, { phase: 'VERIFY', status: 'done' }, ON);

    const row = state.recoveryJournal[0];
    expect(row.class).toBe('unknown');
    expect(row.action).toBe('ask_human');
    expect(row).toMatchObject({ divergent: false, appliedNext: 'PAUSED' });
    expect(state.phase).toBe('PAUSED');
    expect(state.lastPhase).toBe('VERIFY');
    expect(state.pendingPhase).toBe('VERIFY');
    expect(state.pausedReason).toBe('recovery:ask_human');
    expect(nextTarget(state)).toBe('VERIFY');
    expect(findEvent(state.sessionId, 'recovery-applied').data).toMatchObject({
      action: 'ask_human', to: 'PAUSED', pausedReason: 'recovery:ask_human',
    });
  });

  it('pauses a human-value verdict rather than escalating it to pause', () => {
    // `escalateTo: 'pause'` is fixed in VERIFY_ON_FAILURE, but
    // recovery-controller.js#renderHumanRung refuses to convert a value decision
    // into a silent stop, so the action stays ask_human. Both land on PAUSED.
    const state = makeState({ verifyResult: { ok: false }, crossCheck: { verdict: 'REJECT' } });

    recordPhaseResult(state, { ...FAILED_VERIFY }, ON);

    const row = state.recoveryJournal[0];
    expect(row.class).toBe('human-value');
    expect(row.action).toBe('ask_human');
    expect(state.phase).toBe('PAUSED');
    expect(state.pausedReason).toBe('recovery:ask_human');
  });

  // B1: a recovery-driven pause announces itself like every other pause. Run
  // against the real telemetry/notification stack — no featureKey is set on
  // these states, so the lesson archive is not touched (and not polluted).
  it('emits a warn-level pause event next to recovery-applied when it pauses', () => {
    const state = makeState({ verifyResult: { status: 'UNMEASURED' } });

    recordPhaseResult(state, { phase: 'VERIFY', status: 'done' }, ON);

    const types = eventTypes(state.sessionId);
    expect(types).toContain('recovery-applied');
    expect(types.filter((t) => t === 'pause')).toHaveLength(1);
    expect(findEvent(state.sessionId, 'pause')).toMatchObject({
      phase: 'VERIFY', level: 'warn', data: { reason: 'recovery:ask_human' },
    });
    // recovery-applied is written first; the pause event follows the commit.
    expect(types.indexOf('recovery-applied')).toBeLessThan(types.indexOf('pause'));
  });

  it('emits no pause event when the verdict only advances the phase', () => {
    const state = failingState();

    recordPhaseResult(state, { ...FAILED_VERIFY }, ON);

    expect(eventTypes(state.sessionId)).not.toContain('pause');
  });

  it('leaves every non-VERIFY phase alone', () => {
    const state = makeState({ phase: 'EXECUTE', verifyResult: { ok: false } });

    recordPhaseResult(state, { phase: 'EXECUTE', status: 'failed' }, ON);

    expect(state.recoveryJournal).toBeUndefined();
    expect(eventTypes(state.sessionId)).not.toContain('recovery-applied');
  });
});

/**
 * CA-03 B2 — the pause notification has to survive `recordPhaseResult`'s persist.
 *
 * `notification.js#queueOnSession` writes its entry onto the session **on disk**,
 * and it runs while `applyRecoveryTransition` is still inside the ACK, i.e.
 * BEFORE `recordPhaseResult` persists the whole in-memory state. A whole-state
 * write of a state that never learned about the entry erases it, and when no
 * session file exists yet `queueOnSession` cannot write at all. So the only
 * assertion that means anything here is one that reads the JSON file back: an
 * `exit 0`, a truthy return, or the in-memory object alone would all have been
 * green throughout the window in which the operator was never told.
 *
 * The real store is used deliberately — `notification.js` and `session-store.js`
 * are NOT mocked, because the bug lives precisely in the ordering between their
 * two writes. The store directory is redirected to a temp dir through
 * `ARTIBOT_AUTOPILOT_STORE_DIR` (+ the `_ROOT` pairing `getStoreDir()` requires,
 * without which the override is discarded and the writes land in the real
 * store). `tests/setup/state-dir.js` already redirects the store for the whole
 * suite; this block pins its own so the file-level assertions do not depend on
 * that default staying in place.
 */
describe('recordPhaseResult — a recovery pause reaches the persisted queue', () => {
  const ON = Object.freeze({ transitionFromVerdict: true });
  const VAR = 'ARTIBOT_AUTOPILOT_STORE_DIR';
  const PAIR = 'ARTIBOT_AUTOPILOT_STORE_DIR_ROOT';
  const ownDir = path.join(os.tmpdir(), `artibot-ca03-queue-${process.pid}`);
  /** @type {{dir: string|undefined, root: string|undefined}} */
  let saved;

  const restore = (name, value) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  beforeAll(() => {
    saved = { dir: process.env[VAR], root: process.env[PAIR] };
    process.env[VAR] = ownDir;
    process.env[PAIR] = getPluginRoot();
  });

  // Removal comes BEFORE the env restore, and that order is load-bearing twice
  // over: the file-level `afterEach` has already run `deleteSessionArtifacts`
  // with `ownDir` still in force (an inner `afterAll` fires after the last
  // test's `afterEach`), and restoring first would leave this block deleting a
  // directory it no longer owns the pointer to. Without the removal each run
  // minted a new `artibot-ca03-queue-<pid>` and left it behind — measured at 6
  // strays before this was added.
  afterAll(() => {
    try {
      rmSync(ownDir, { recursive: true, force: true });
    } catch { /* best-effort — a locked handle must not fail the suite */ }
    restore(VAR, saved.dir);
    restore(PAIR, saved.root);
  });

  /** Read the queue off the JSON file, never off the live object. */
  function persistedPauses(sessionId) {
    const onDisk = JSON.parse(readFileSync(getSessionPath(sessionId), 'utf8'));
    const queue = Array.isArray(onDisk.queuedQuestions) ? onDisk.queuedQuestions : [];
    return queue.filter((entry) => entry?.type === 'pause');
  }

  it('redirects the store, so these assertions read a sandbox file', () => {
    expect(getStoreDir()).toBe(path.resolve(ownDir));
  });

  it('persists the queued pause when no session file existed yet', () => {
    const state = makeState({ verifyResult: { status: 'UNMEASURED' } });

    recordPhaseResult(state, { phase: 'VERIFY', status: 'done' }, ON);

    expect(state.phase).toBe('PAUSED');
    const pauses = persistedPauses(state.sessionId);
    expect(pauses).toHaveLength(1);
    expect(pauses[0]).toMatchObject({ type: 'pause', reason: 'recovery:ask_human' });
    expect(typeof pauses[0].ts).toBe('string');
    expect(typeof pauses[0].body).toBe('string');
  });

  it('persists exactly one queued pause when the session file already existed', () => {
    // The duplicate risk: `queueOnSession` writes the entry to the file, and the
    // merge adds it to the in-memory state that is persisted over that file.
    const state = makeState({ verifyResult: { status: 'UNMEASURED' } });
    saveSession(state);

    recordPhaseResult(state, { phase: 'VERIFY', status: 'done' }, ON);

    expect(persistedPauses(state.sessionId)).toHaveLength(1);
  });

  it('keeps the in-memory queue and the persisted queue in agreement', () => {
    const state = makeState({ verifyResult: { status: 'UNMEASURED' } });

    recordPhaseResult(state, { phase: 'VERIFY', status: 'done' }, ON);

    expect(state.queuedQuestions).toHaveLength(1);
    expect(stable(state.queuedQuestions)).toBe(stable(
      JSON.parse(readFileSync(getSessionPath(state.sessionId), 'utf8')).queuedQuestions,
    ));
  });

  it('survives a second persist of the same in-memory state', () => {
    // Announcing after the persist instead of merging would pass the first two
    // assertions and lose the entry here, because the entry would exist only on
    // disk and the next whole-state write would overwrite it again.
    const state = makeState({ verifyResult: { status: 'UNMEASURED' } });

    recordPhaseResult(state, { phase: 'VERIFY', status: 'done' }, ON);
    recordPhaseResult(state, { phase: 'IMPROVE', status: 'done' }, ON);

    expect(persistedPauses(state.sessionId)).toHaveLength(1);
  });

  it('adds no queue entry when the verdict only advances the phase', () => {
    const state = failingState();

    recordPhaseResult(state, { ...FAILED_VERIFY }, ON);

    expect(state.pendingPhase).toBe('EXECUTE');
    expect(persistedPauses(state.sessionId)).toHaveLength(0);
    expect(state.queuedQuestions).toBeUndefined();
  });

  it('adds no queue entry with the gate OFF', () => {
    const state = makeState({ verifyResult: { status: 'UNMEASURED' } });

    recordPhaseResult(state, { phase: 'VERIFY', status: 'done' }, { transitionFromVerdict: false });

    expect(persistedPauses(state.sessionId)).toHaveLength(0);
    expect(state.queuedQuestions).toBeUndefined();
  });
});
