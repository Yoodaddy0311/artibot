/**
 * Mission controller record — OB-10, Observe stage.
 *
 * ONE QUESTION: "who is the single logical writer of this mission right now,
 * and is that claim still alive?" `project-state.schema.json` gives the slot
 * (`active_missions.<M>.controller = {session_id, lease}`, both required
 * because "a controller entry without a lease would be a claim nobody can time
 * out"). This module produces that record and, for a mission that already has
 * one, produces a JUDGEMENT about it. It does not enforce anything.
 *
 * ── WHY THIS OBSERVES AND DOES NOT ARBITRATE ───────────────────────────────
 * An expired lease is reclaimable, not reclaimed. Taking the slot here would
 * be cheap and wrong: the record of WHO held it is the only evidence that a
 * second writer ever existed, and overwriting it erases the finding at the
 * exact moment it becomes interesting. Reclaim is CA-09's decision — decision 7
 * shrank CA-14 and moved it there — with its own contention handling. So
 * `held` and `expired` are different WORDS for the
 * same ACTION — return the caller's own object, by reference, untouched.
 * `tests/mission/controller.test.js` pins both the reference and the bytes.
 *
 * ── WHY A DAMAGED RECORD IS `held` AND NOT A THROW ─────────────────────────
 * The composed mutator runs inside
 * `lib/runtime/middleware/tasks.js#recordMissionState`, which is fail-open: a
 * throw there does not lose the controller field, it loses the ENTIRE state
 * write for that mission — title, status, intent, plan. A controller with no
 * lease, or an `expires_at` that will not parse, is therefore reported as
 * `held` and left exactly as found. `held` is the conservative reading: it
 * says "someone else's claim is here and I did not touch it", which is true of
 * a record we cannot read. The alternative, calling it `expired`, would invite
 * a future reclaim to overwrite a record on the strength of a judgement that
 * was never actually made.
 *
 * Argument faults are the opposite case and still throw. A missing session id
 * or a NaN clock is not damaged state on disk, it is a caller defect that
 * would otherwise write a lease nobody can match — the same contract
 * `createLease` already enforces, kept rather than softened.
 *
 * ── WHAT THIS MODULE CANNOT SEE ────────────────────────────────────────────
 *  - **Liveness of the holder.** A lease says a session claimed the mission
 *    and when the claim lapses. A session that crashed one second after
 *    acquiring still reads as `held` for the full TTL. Only the clock retires
 *    a claim here; nothing probes the process.
 *  - **Sessions that never recorded anything.** `observeController` sees the
 *    slot, not the population. A second writer that never reached
 *    `recordMissionState` leaves no trace, so `held` never means "exactly one
 *    other writer" — it means "one other writer wrote last".
 *  - **The census denominator is the snapshot's reach**, not the repository's
 *    truth: `foldControllerCensus` counts `active_missions` as handed to it.
 *    A mission absent from the snapshot is indistinguishable from one that
 *    does not exist.
 *  - **Nothing here reads a file or a clock.** Both the instant and the state
 *    arrive as arguments, per the purity contract in this directory's barrel.
 *
 * @module lib/mission/controller
 */

import { createLease, DEFAULT_STALE_MS, isLeaseExpired, renewLease } from '../project-state/lease.js';

/**
 * The four judgements `observeController` can return.
 *
 * `held` and `expired` differ only in what a LATER stage may do; both leave the
 * observed record untouched.
 */
export const CONTROLLER_OBSERVATIONS = Object.freeze(['acquired', 'renewed', 'held', 'expired']);

/** Controller lease lifetime, shared with the landing lock's stale window. */
export const DEFAULT_CONTROLLER_TTL_MS = DEFAULT_STALE_MS;

/** The census shape returned for a snapshot with nothing to count. */
const EMPTY_CENSUS = Object.freeze({
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

/**
 * Reject a session id that could not be matched against later.
 *
 * @param {unknown} sessionId - Candidate session id.
 * @returns {string} The session id.
 * @throws {TypeError} When it is not a non-empty string.
 */
function assertSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new TypeError(
      `mission controller: sessionId must be a non-empty string, got ${String(sessionId)}`,
    );
  }
  return sessionId;
}

/**
 * Normalise an instant to epoch milliseconds.
 *
 * @param {Date|number} now - The instant to judge at.
 * @returns {number} Epoch milliseconds.
 * @throws {TypeError} When it is neither a Date nor a finite epoch-ms number.
 */
function assertInstant(now) {
  const ms = now instanceof Date ? now.getTime() : now;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw new TypeError(
      `mission controller: now must be a Date or finite epoch-ms number, got ${String(now)}`,
    );
  }
  return ms;
}

/**
 * Judge whether a recorded controller can be reasoned about at all.
 *
 * Deliberately total: it answers false instead of throwing, so an unreadable
 * record reaches the `held` branch rather than the caller's error path.
 *
 * @param {unknown} current - A recorded `controller` value.
 * @returns {boolean} True when it has a lease with a parseable `expires_at`.
 */
function isReadableController(current) {
  if (current === null || typeof current !== 'object' || Array.isArray(current)) return false;
  const { lease } = current;
  if (lease === null || typeof lease !== 'object' || Array.isArray(lease)) return false;
  return typeof lease.expires_at === 'string' && !Number.isNaN(Date.parse(lease.expires_at));
}

/**
 * Build a fresh controller record for a session.
 *
 * @param {object} params - Record parameters.
 * @param {string} params.sessionId - The claiming session; becomes the lease owner.
 * @param {Date|number} params.now - Acquisition instant.
 * @param {number} [params.ttlMs=DEFAULT_CONTROLLER_TTL_MS] - Lease lifetime.
 * @returns {{session_id: string, lease: object}} A schema-shaped controller.
 * @throws {TypeError} When the session id or the instant is unusable.
 * @example
 * buildControllerRecord({ sessionId: 's1', now: 0 }).lease.owner; // 's1'
 */
export function buildControllerRecord({ sessionId, now, ttlMs = DEFAULT_CONTROLLER_TTL_MS } = {}) {
  const owner = assertSessionId(sessionId);
  const at = assertInstant(now);
  return {
    session_id: owner,
    lease: createLease({ owner, now: at, ttlMs, sessionId: owner }),
  };
}

/**
 * Observe the controller slot of one mission without arbitrating it.
 *
 * | `current`                          | observation | returned controller     |
 * |------------------------------------|-------------|-------------------------|
 * | absent                             | `acquired`  | a fresh record          |
 * | held by `sessionId`                | `renewed`   | a renewed copy          |
 * | live, held by another session      | `held`      | `current`, by reference |
 * | expired, held by another session   | `expired`   | `current`, by reference |
 * | present but unreadable             | `held`      | `current`, by reference |
 *
 * @param {object} params - Observation parameters.
 * @param {unknown} params.current - The recorded `controller`, or `undefined`.
 * @param {string} params.sessionId - The observing session.
 * @param {Date|number} params.now - The instant to judge at.
 * @param {number} [params.ttlMs] - Lease lifetime; on renew, defaults to the
 *   lease's own span so a renewal never silently changes the window.
 * @returns {{observation: string, controller: object}} The judgement and the
 *   controller to record. Never throws for a damaged `current`.
 * @throws {TypeError} When `sessionId` or `now` is unusable.
 */
export function observeController({ current, sessionId, now, ttlMs } = {}) {
  const owner = assertSessionId(sessionId);
  const at = assertInstant(now);

  if (current === undefined || current === null) {
    return { observation: 'acquired', controller: buildControllerRecord({ sessionId: owner, now: at, ttlMs }) };
  }
  if (!isReadableController(current)) {
    return { observation: 'held', controller: current };
  }
  if (current.session_id === owner) {
    return {
      observation: 'renewed',
      controller: { ...current, session_id: owner, lease: renewLease(current.lease, { now: at, ttlMs }) },
    };
  }
  return {
    observation: isLeaseExpired(current.lease, at) ? 'expired' : 'held',
    controller: current,
  };
}

/**
 * Wrap a mission mutator so it also records the controller observation.
 *
 * The controller is read from the CURRENT row rather than from `base`'s result,
 * because `base` is a projection of the incoming update and does not carry the
 * stored lease. A `base` that returns `null` (mission removal) passes through
 * untouched: attaching a controller to a deletion would resurrect the row.
 *
 * @param {Function} base - The existing `(current) => next` mutator.
 * @param {object} params - Observation parameters.
 * @param {string} params.sessionId - The observing session.
 * @param {Date|number} params.now - The instant to judge at.
 * @param {number} [params.ttlMs] - Lease lifetime.
 * @returns {Function} A mutator with the same signature as `base`, carrying an
 *   `observation` property: `null` until it runs, then the last judgement it
 *   made — always one of {@link CONTROLLER_OBSERVATIONS}.
 * @throws {TypeError} At COMPOSITION time when `base`, `sessionId` or `now` is
 *   unusable — before any state write is attempted.
 */
export function composeControllerMutator(base, { sessionId, now, ttlMs } = {}) {
  if (typeof base !== 'function') {
    throw new TypeError(`mission controller: base must be a function, got ${typeof base}`);
  }
  const owner = assertSessionId(sessionId);
  const at = assertInstant(now);

  // THE JUDGEMENT RIDES THE MUTATOR, not the row it returns. `updateMission`
  // owns that row and re-runs this function on a CAS conflict, so the caller
  // needs the reading belonging to the run that actually committed — always the
  // LAST one. A sink handed back at composition time would have to be reconciled
  // across both runs; a property is simply "what it last saw".
  //
  // It is a REPORT, never an instruction. `held` and `expired` still return the
  // caller's own record by reference, untouched, exactly as before — naming the
  // observation is the whole change.
  const mutator = (current) => {
    const next = base(current);
    // A removal makes no observation, so the previous report stands rather than
    // being overwritten with a judgement nobody made.
    if (next === null || next === undefined) return next;
    const { observation, controller } = observeController({
      current: current?.controller, sessionId: owner, now: at, ttlMs,
    });
    mutator.observation = observation;
    return { ...next, controller };
  };
  mutator.observation = null;
  return mutator;
}

/**
 * Say what a LATER stage could do about an observation. Recommends nothing
 * unless the caller opts in, and applies nothing in either case.
 *
 * OFF BY DEFAULT, and `null` rather than a "no action" record, because the two
 * are different claims: `null` says nobody asked, while `{reclaimable: false}`
 * says the question was put and the answer was no. Reclaim itself belongs to
 * CA-09, so nothing here writes a status, touches a lease or reads a clock —
 * the arguments are the whole input and a frozen record is the whole output.
 *
 * @param {unknown} observation - One of {@link CONTROLLER_OBSERVATIONS}.
 * @param {object} [options] - Caller opt-in.
 * @param {boolean} [options.enabled=false] - Literal `true` to get an answer. A
 *   merely truthy value is not enough: a gate that opens on `'no'` or `1` is a
 *   gate that opens by accident.
 * @returns {{observation: string, reclaimable: boolean}|null} A frozen
 *   recommendation, or `null` when switched off or handed an unknown word.
 * @example
 * recommendControllerTransition('expired'); // null — nobody asked
 * recommendControllerTransition('expired', { enabled: true }).reclaimable; // true
 */
export function recommendControllerTransition(observation, { enabled = false } = {}) {
  if (enabled !== true) return null;
  if (!CONTROLLER_OBSERVATIONS.includes(observation)) return null;
  // Only a lapsed claim is reclaimable. `held` deliberately is not: a live lease
  // is the one case where taking the slot would destroy live evidence.
  return Object.freeze({ observation, reclaimable: observation === 'expired' });
}

/**
 * Count controller coverage across a project-state snapshot.
 *
 * Ratios over an empty denominator are `null`, never 0 — the same rule as
 * `lib/mission/outcome-gate-census.js`, for the same reason: 0 reads as a
 * measurement that found nothing, `null` reads as nothing measured.
 *
 * @param {unknown} snapshot - A `project-state.json` snapshot.
 * @param {Date|number} now - The instant to judge expiry at.
 * @returns {{missions: number, with_controller: number, without_controller: number,
 *   live: number, expired: number, unreadable: number, distinct_sessions: number,
 *   controller_ratio: (number|null), expired_ratio: (number|null)}} The census.
 * @throws {TypeError} When `now` is unusable. The snapshot itself is never a
 *   fault: an unreadable one yields an empty census.
 */
export function foldControllerCensus(snapshot, now) {
  const at = assertInstant(now);
  const missionsMap = snapshot === null || typeof snapshot !== 'object'
    ? null
    : snapshot.active_missions;
  if (missionsMap === null || typeof missionsMap !== 'object') return { ...EMPTY_CENSUS };

  const ids = Object.keys(missionsMap);
  const sessions = new Set();
  let withController = 0;
  let live = 0;
  let expired = 0;
  let unreadable = 0;

  for (const id of ids) {
    const mission = missionsMap[id];
    if (mission === null || typeof mission !== 'object') continue;
    const { controller } = mission;
    if (controller === undefined || controller === null) continue;
    withController += 1;
    if (typeof controller === 'object' && typeof controller.session_id === 'string' && controller.session_id !== '') {
      sessions.add(controller.session_id);
    }
    if (!isReadableController(controller)) unreadable += 1;
    else if (isLeaseExpired(controller.lease, at)) expired += 1;
    else live += 1;
  }

  return {
    missions: ids.length,
    with_controller: withController,
    without_controller: ids.length - withController,
    live,
    expired,
    unreadable,
    distinct_sessions: sessions.size,
    controller_ratio: ids.length === 0 ? null : withController / ids.length,
    expired_ratio: withController === 0 ? null : expired / withController,
  };
}
