/**
 * `lib/mission/controller.js` — the OB-10 Mission Controller record (Observe).
 *
 * This suite pins an OBSERVER, not a lock. Three properties carry the weight:
 *
 *   1. **A foreign controller is never overwritten.** `held` and `expired` both
 *      return the CALLER'S OWN object by reference, and this suite asserts both
 *      identity (`toBe`) and bytes (`JSON.stringify`). Reclaiming an expired
 *      lease is CA-14's decision, and an Observe-stage module that quietly took
 *      the slot would make the later decision unobservable — the evidence of
 *      who held it would already be gone.
 *   2. **An unreadable controller is passed through, never thrown on.** The
 *      call site is `lib/runtime/middleware/tasks.js#recordMissionState`, which
 *      is fail-open: a throw inside the mutator loses the WHOLE state write,
 *      not just the controller field. So a controller with no lease, or an
 *      `expires_at` that will not parse, is reported as `held` and left alone.
 *   3. **Argument faults still fail fast.** A missing session id or a NaN clock
 *      is not a damaged record on disk — it is a caller defect, and the same
 *      contract `lib/project-state/lease.js#createLease` already enforces.
 *      Those throw `TypeError` at the call, and for the composed mutator at
 *      COMPOSITION time, before any state write is attempted.
 *
 * The census follows the empty-denominator rule this directory already uses
 * (`lib/mission/outcome-gate-census.js`): a ratio over zero observations is
 * `null`, never 0, because 0 reads as a measurement that found nothing.
 */

import { describe, expect, it } from 'vitest';

import {
  buildControllerRecord,
  composeControllerMutator,
  CONTROLLER_OBSERVATIONS,
  DEFAULT_CONTROLLER_TTL_MS,
  foldControllerCensus,
  observeController,
  recommendControllerTransition,
} from '../../lib/mission/controller.js';
import { observeController as observeViaBarrel } from '../../lib/mission/index.js';
import { isLeaseExpired } from '../../lib/project-state/lease.js';
import { validateController } from '../../lib/project-state/validate.js';

const MISSION_ID = 'M-20260921-001';
const T0 = Date.parse('2026-09-21T00:00:00.000Z');
const MINUTE = 60_000;

/** A controller held by `sessionId`, acquired at `at`. */
function controllerAt(sessionId, at, ttlMs = DEFAULT_CONTROLLER_TTL_MS) {
  return buildControllerRecord({ sessionId, now: at, ttlMs });
}

describe('CONTROLLER_OBSERVATIONS', () => {
  it('names the four observations and is frozen', () => {
    expect(CONTROLLER_OBSERVATIONS).toEqual(['acquired', 'renewed', 'held', 'expired']);
    expect(Object.isFrozen(CONTROLLER_OBSERVATIONS)).toBe(true);
  });

  it('defaults the ttl to the shared stale window', () => {
    expect(DEFAULT_CONTROLLER_TTL_MS).toBe(30 * MINUTE);
  });
});

describe('buildControllerRecord', () => {
  it('builds a record whose lease owner and session id are the session', () => {
    const record = buildControllerRecord({ sessionId: 's1', now: T0 });

    expect(record.session_id).toBe('s1');
    expect(record.lease.owner).toBe('s1');
    expect(record.lease.session_id).toBe('s1');
    expect(record.lease.acquired_at).toBe('2026-09-21T00:00:00.000Z');
    expect(record.lease.heartbeat_at).toBe('2026-09-21T00:00:00.000Z');
    expect(record.lease.expires_at).toBe('2026-09-21T00:30:00.000Z');
  });

  it('accepts a Date as the instant', () => {
    const record = buildControllerRecord({ sessionId: 's1', now: new Date(T0) });

    expect(record.lease.acquired_at).toBe('2026-09-21T00:00:00.000Z');
  });

  it('honours an explicit ttl', () => {
    const record = buildControllerRecord({ sessionId: 's1', now: T0, ttlMs: MINUTE });

    expect(record.lease.expires_at).toBe('2026-09-21T00:01:00.000Z');
  });

  it('produces a record the state validator accepts', () => {
    expect(validateController(buildControllerRecord({ sessionId: 's1', now: T0 }), MISSION_ID))
      .toEqual([]);
  });
});

describe('observeController', () => {
  it('acquires when no controller is recorded yet', () => {
    for (const current of [undefined, null]) {
      const { observation, controller } = observeController({ current, sessionId: 's1', now: T0 });

      expect(observation).toBe('acquired');
      expect(controller).toEqual(buildControllerRecord({ sessionId: 's1', now: T0 }));
      expect(validateController(controller, MISSION_ID)).toEqual([]);
    }
  });

  it('renews when the same session observes again', () => {
    const current = controllerAt('s1', T0);
    const { observation, controller } = observeController({
      current, sessionId: 's1', now: T0 + 10 * MINUTE,
    });

    expect(observation).toBe('renewed');
    expect(controller.session_id).toBe('s1');
    expect(controller.lease.acquired_at).toBe(current.lease.acquired_at);
    expect(controller.lease.heartbeat_at).toBe('2026-09-21T00:10:00.000Z');
    expect(controller.lease.expires_at).toBe('2026-09-21T00:40:00.000Z');
    expect(validateController(controller, MISSION_ID)).toEqual([]);
  });

  it('does not mutate the record it renews', () => {
    const current = controllerAt('s1', T0);
    const before = JSON.stringify(current);

    observeController({ current, sessionId: 's1', now: T0 + MINUTE });

    expect(JSON.stringify(current)).toBe(before);
  });

  it('keeps the original ttl span when renewing without one', () => {
    const current = controllerAt('s1', T0, MINUTE);
    const { controller } = observeController({ current, sessionId: 's1', now: T0 + 10 * MINUTE });

    expect(controller.lease.expires_at).toBe('2026-09-21T00:11:00.000Z');
  });

  it('reports held for a live lease owned by another session, byte-identical', () => {
    const current = controllerAt('s1', T0);
    const before = JSON.stringify(current);
    const { observation, controller } = observeController({
      current, sessionId: 's2', now: T0 + 10 * MINUTE,
    });

    expect(observation).toBe('held');
    expect(controller).toBe(current);
    expect(JSON.stringify(controller)).toBe(before);
  });

  it('reports expired for a stale lease owned by another session, byte-identical', () => {
    const current = controllerAt('s1', T0);
    const before = JSON.stringify(current);
    const now = T0 + 31 * MINUTE;

    expect(isLeaseExpired(current.lease, now)).toBe(true);

    const { observation, controller } = observeController({ current, sessionId: 's2', now });

    expect(observation).toBe('expired');
    expect(controller).toBe(current);
    expect(JSON.stringify(controller)).toBe(before);
  });

  it.each([
    ['no lease', { session_id: 's1' }],
    ['unparseable expires_at', { session_id: 's1', lease: { owner: 's1', expires_at: 'not-a-date' } }],
    ['lease is a string', { session_id: 's1', lease: 'yesterday' }],
    ['controller is a string', 'session-one'],
    ['controller is an array', [{ session_id: 's1' }]],
  ])('passes an unreadable controller through as held (%s)', (_label, current) => {
    const { observation, controller } = observeController({ current, sessionId: 's2', now: T0 });

    expect(observation).toBe('held');
    expect(controller).toBe(current);
  });

  it('holds rather than renews when the same session left an unreadable record', () => {
    const current = { session_id: 's1', lease: { owner: 's1' } };
    const { observation, controller } = observeController({ current, sessionId: 's1', now: T0 });

    expect(observation).toBe('held');
    expect(controller).toBe(current);
  });

  it.each([
    ['empty session id', { sessionId: '', now: T0 }],
    ['non-string session id', { sessionId: 42, now: T0 }],
    ['missing session id', { now: T0 }],
    ['NaN clock', { sessionId: 's1', now: Number.NaN }],
    ['Infinite clock', { sessionId: 's1', now: Number.POSITIVE_INFINITY }],
    ['string clock', { sessionId: 's1', now: '2026-09-21T00:00:00.000Z' }],
    ['missing clock', { sessionId: 's1' }],
  ])('throws TypeError for %s', (_label, args) => {
    expect(() => observeController({ current: undefined, ...args })).toThrow(TypeError);
  });

  it('is reachable through the mission barrel', () => {
    expect(observeViaBarrel({ current: null, sessionId: 's1', now: T0 }).observation)
      .toBe('acquired');
  });
});

describe('composeControllerMutator', () => {
  const base = (current) => ({
    ...current,
    title: 'ship the census',
    status: 'in_progress',
    intent: 'observe',
    plan: { steps: 2 },
  });

  it('preserves the base fields and adds a controller', () => {
    const next = composeControllerMutator(base, { sessionId: 's1', now: T0 })(null);

    expect(next.title).toBe('ship the census');
    expect(next.status).toBe('in_progress');
    expect(next.intent).toBe('observe');
    expect(next.plan).toEqual({ steps: 2 });
    expect(next.controller).toEqual(buildControllerRecord({ sessionId: 's1', now: T0 }));
  });

  it('passes a null base result through without a controller', () => {
    expect(composeControllerMutator(() => null, { sessionId: 's1', now: T0 })({})).toBeNull();
  });

  it('reads the controller from the CURRENT row, not the base result', () => {
    const current = { title: 'old', controller: controllerAt('s1', T0) };
    const next = composeControllerMutator(base, { sessionId: 's1', now: T0 + MINUTE })(current);

    expect(next.controller.lease.heartbeat_at).toBe('2026-09-21T00:01:00.000Z');
    expect(next.controller.lease.acquired_at).toBe(current.controller.lease.acquired_at);
  });

  it('leaves a live foreign controller byte-identical across two sessions', () => {
    const acquired = composeControllerMutator(base, { sessionId: 'A', now: T0 })(null);
    const beforeBytes = JSON.stringify(acquired.controller);

    const foreign = composeControllerMutator(base, { sessionId: 'B', now: T0 + MINUTE })(acquired);
    expect(foreign.controller).toBe(acquired.controller);
    expect(JSON.stringify(foreign.controller)).toBe(beforeBytes);

    const renewed = composeControllerMutator(base, { sessionId: 'A', now: T0 + 2 * MINUTE })(foreign);
    expect(renewed.controller.lease.heartbeat_at).toBe('2026-09-21T00:02:00.000Z');
    expect(renewed.controller.lease.acquired_at).toBe('2026-09-21T00:00:00.000Z');
    expect(validateController(renewed.controller, MISSION_ID)).toEqual([]);
  });

  it.each([
    ['base is not a function', [null, { sessionId: 's1', now: T0 }]],
    ['base is an object', [{}, { sessionId: 's1', now: T0 }]],
    ['session id is empty', [(c) => c, { sessionId: '', now: T0 }]],
    ['clock is NaN', [(c) => c, { sessionId: 's1', now: Number.NaN }]],
  ])('throws TypeError at composition time when %s', (_label, [fn, opts]) => {
    expect(() => composeControllerMutator(fn, opts)).toThrow(TypeError);
  });
});

describe('foldControllerCensus', () => {
  it.each([
    ['an empty snapshot', { active_missions: {} }],
    ['a snapshot with no active_missions', {}],
    ['a non-object', 'nope'],
    ['null', null],
  ])('returns null ratios for %s', (_label, snapshot) => {
    expect(foldControllerCensus(snapshot, T0)).toEqual({
      missions: 0,
      with_controller: 0,
      without_controller: 0,
      live: 0,
      expired: 0,
      unreadable: 0,
      distinct_sessions: 0,
      controller_ratio: null,
      expired_ratio: null,
    });
  });

  it('counts live, expired, unreadable and bare missions against one denominator', () => {
    const snapshot = {
      active_missions: {
        'M-1': { controller: controllerAt('s1', T0) },
        'M-2': { controller: controllerAt('s2', T0) },
        'M-3': { controller: controllerAt('s1', T0 - 60 * MINUTE) },
        'M-4': { controller: { session_id: 's3', lease: { owner: 's3' } } },
        'M-5': { title: 'no controller yet' },
      },
    };

    expect(foldControllerCensus(snapshot, T0 + MINUTE)).toEqual({
      missions: 5,
      with_controller: 4,
      without_controller: 1,
      live: 2,
      expired: 1,
      unreadable: 1,
      distinct_sessions: 3,
      controller_ratio: 0.8,
      expired_ratio: 0.25,
    });
  });

  it('reports expired_ratio null when no mission has a controller', () => {
    const census = foldControllerCensus({ active_missions: { 'M-1': {} } }, T0);

    expect(census.controller_ratio).toBe(0);
    expect(census.expired_ratio).toBeNull();
  });

  it('requires an instant rather than reaching for a clock', () => {
    const snapshot = { active_missions: { 'M-1': { controller: controllerAt('s1', T0) } } };

    expect(() => foldControllerCensus(snapshot)).toThrow(TypeError);
    expect(() => foldControllerCensus(snapshot, Number.NaN)).toThrow(TypeError);
  });

  it('ignores a mission entry that is not an object', () => {
    const snapshot = { active_missions: { 'M-1': 'broken', 'M-2': null } };
    const census = foldControllerCensus(snapshot, T0);

    expect(census.missions).toBe(2);
    expect(census.with_controller).toBe(0);
    expect(census.without_controller).toBe(2);
  });

  it('does not throw on a controller whose session id is not a string', () => {
    const snapshot = {
      active_missions: { 'M-1': { controller: { session_id: 7, lease: controllerAt('s1', T0).lease } } },
    };
    const census = foldControllerCensus(snapshot, T0);

    expect(census.with_controller).toBe(1);
    expect(census.live).toBe(1);
    expect(census.distinct_sessions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// OB-10 follow-up (a): the observation STOPS BEING DISCARDED.
//
// `composeControllerMutator` already computed all four judgements and then
// dropped three quarters of the answer on the floor — it destructured
// `{ controller }` and never told anyone WHICH of `acquired`/`renewed`/`held`/
// `expired` produced it. The caller could therefore see that a controller was
// recorded but not that it belonged to somebody else, which is the single most
// interesting thing this module knows.
//
// The report rides the MUTATOR, not the return value, because `updateMission`
// owns the return value and re-runs the mutator on a CAS conflict. A sink the
// composer hands back would have to be reconciled across those two runs; a
// property on the function is simply "what it last observed", which is exactly
// what the committed row reflects.
// ---------------------------------------------------------------------------

describe('composeControllerMutator — the observation it reports', () => {
  const base = (current) => ({ ...current, title: 'ship the census' });

  it('reports null until the mutator has actually run', () => {
    expect(composeControllerMutator(base, { sessionId: 's1', now: T0 }).observation).toBeNull();
  });

  it.each([
    ['acquired', null, 's1', T0],
    ['renewed', { controller: controllerAt('s1', T0) }, 's1', T0 + MINUTE],
    ['held', { controller: controllerAt('s1', T0) }, 's2', T0 + MINUTE],
    ['expired', { controller: controllerAt('s1', T0) }, 's2', T0 + 31 * MINUTE],
  ])('reports %s', (expected, current, sessionId, now) => {
    const mutator = composeControllerMutator(base, { sessionId, now });
    mutator(current);

    expect(mutator.observation).toBe(expected);
    // No new word may enter by this route: whatever is reported has to already
    // be one of the four the module publishes.
    expect(CONTROLLER_OBSERVATIONS).toContain(mutator.observation);
  });

  it('reports the LAST run, which is what a CAS retry re-runs', () => {
    const mutator = composeControllerMutator(base, { sessionId: 's2', now: T0 + MINUTE });

    mutator(null);
    expect(mutator.observation).toBe('acquired');

    // The retry sees the row the winner of the race wrote.
    mutator({ controller: controllerAt('s1', T0) });
    expect(mutator.observation).toBe('held');
  });

  it('leaves the report untouched when the base removes the row', () => {
    // A deletion makes no observation, so there is nothing to report and the
    // previous answer must not be overwritten with a guess.
    const mutator = composeControllerMutator(() => null, { sessionId: 's1', now: T0 });

    expect(mutator({})).toBeNull();
    expect(mutator.observation).toBeNull();
  });

  it('still leaves a foreign record byte-identical while reporting it', () => {
    // The whole point of the follow-up is that REPORTING is not TAKING.
    const current = { controller: controllerAt('s1', T0) };
    const before = JSON.stringify(current.controller);
    const mutator = composeControllerMutator(base, { sessionId: 's2', now: T0 + MINUTE });

    const next = mutator(current);

    expect(mutator.observation).toBe('held');
    expect(next.controller).toBe(current.controller);
    expect(JSON.stringify(next.controller)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// OB-10 follow-up (b): a RECOMMENDATION, and nothing else.
//
// Decision 7 shrank CA-14 and moved reclaim into CA-09, so this stage still may
// not act. What it may now do is say what a later stage COULD do — and only
// when the caller explicitly asks. The default answer is `null`, which is the
// difference between "nothing to reclaim" and "nobody asked".
// ---------------------------------------------------------------------------

describe('recommendControllerTransition', () => {
  it('is OFF by default: every observation recommends nothing', () => {
    for (const observation of CONTROLLER_OBSERVATIONS) {
      expect(recommendControllerTransition(observation)).toBeNull();
      expect(recommendControllerTransition(observation, {})).toBeNull();
      expect(recommendControllerTransition(observation, { enabled: false })).toBeNull();
    }
  });

  it('marks only an expired lease reclaimable, once the caller opts in', () => {
    expect(recommendControllerTransition('expired', { enabled: true }))
      .toEqual({ observation: 'expired', reclaimable: true });

    for (const observation of ['acquired', 'renewed', 'held']) {
      expect(recommendControllerTransition(observation, { enabled: true }))
        .toEqual({ observation, reclaimable: false });
    }
  });

  it('introduces no vocabulary of its own', () => {
    const reported = CONTROLLER_OBSERVATIONS
      .map((o) => recommendControllerTransition(o, { enabled: true }).observation);

    expect(reported).toEqual([...CONTROLLER_OBSERVATIONS]);
  });

  it.each([['reclaimed'], ['queued'], ['']])(
    'answers null for %s, which is not one of the four',
    (observation) => {
      expect(recommendControllerTransition(observation, { enabled: true })).toBeNull();
    },
  );

  it.each([[null], [undefined], [7], [{}]])(
    'answers null rather than throwing for a non-observation argument',
    (observation) => {
      expect(recommendControllerTransition(observation, { enabled: true })).toBeNull();
    },
  );

  it('is pure: frozen result, untouched arguments, same answer twice', () => {
    const opts = { enabled: true };
    const first = recommendControllerTransition('expired', opts);
    const second = recommendControllerTransition('expired', opts);

    expect(Object.isFrozen(first)).toBe(true);
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(opts).toEqual({ enabled: true });
  });

  it('only enables on a literal true, never on a truthy value', () => {
    // A gate that opens on `'no'` or `1` is a gate that opens by accident.
    for (const enabled of ['yes', 1, {}, []]) {
      expect(recommendControllerTransition('expired', { enabled })).toBeNull();
    }
  });
});
