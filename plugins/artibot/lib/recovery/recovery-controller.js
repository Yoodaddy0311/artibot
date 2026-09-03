/**
 * Recovery controller — turns a failure class into a RECOMMENDED action.
 *
 * Observe stage (design §2.5): `decide()` returns a recommendation and writes
 * nothing. No caller in `lib/autopilot/engine.js` reads it, and this task does
 * not add one — replacing the fixed `nextPhase: 'IMPROVE'` at engine.js:497 is
 * Canary work. Until then the value of this module is that a judgement exists
 * and can be recorded, so the eventual switch has a measured denominator
 * instead of a guess.
 *
 * ── The ladder (ADDENDUM-HARDENING §35) ───────────────────────────────────
 *
 *     implementation failure                        -> repair
 *     repeated same-class failure                   -> replan
 *     multiple replans / architecture contradiction -> ultraplan
 *     ultraplan still ambiguous                     -> human decision
 *
 * §35 closes with "Retry count만이 아니라 failure class를 본다" — the class
 * picks the starting rung, the counters can only push it upward. That is
 * modelled literally here: {@link RUNG_BY_CLASS} gives the entry rung and each
 * exhaustion check bumps by one. Bumps cascade, so an implementation failure
 * that has already been replanned twice lands on `propose_ultraplan` in one
 * call rather than needing three round trips.
 *
 * ── Two rules that are not negotiable by counters ─────────────────────────
 *  - `unknown` always goes to a person. A classifier that could not separate
 *    the evidence must not have its non-answer converted into a machine action
 *    by a threshold (lane 4 §2.3; the §8 instruction principle).
 *  - `framing` produces `propose_ultraplan`, never a fired ultraplan. Design 01
 *    §7 states an ultraplan is not the default retry instrument, so the ladder
 *    proposes and a human decides.
 *
 * ── Consuming the existing onFailure payload ──────────────────────────────
 * `runPhase4Verify` already emits `onFailure: { agent, retryLimit: 3,
 * escalateTo: 'pause' }` (engine.js:503-507) and lane 4 §1.6 measured that no
 * code reads it. This module is that reader: `retryLimit` caps repairs and
 * `escalateTo` names the terminal action. The payload is read-only here — the
 * engine is not modified, and `onFailure.agent` is not consulted because
 * choosing the worker is routing, not recovery.
 *
 * @module lib/recovery/recovery-controller
 */

/**
 * The five recommendable actions.
 *
 * `pause` and `ask_human` are not synonyms. Lane 4 §1.6 records the existing
 * defect precisely: `goal-loop.js` only ever pauses, and "PAUSE 는 멈춤이지
 * 질문이 아니다". `ask_human` is a question that expects an answer; `pause` is
 * a stop with no question attached, and it is only reachable when the caller
 * explicitly asks for it through `onFailure.escalateTo`.
 * @type {readonly string[]}
 */
export const RECOVERY_ACTIONS = Object.freeze([
  'repair',
  'replan',
  'propose_ultraplan',
  'ask_human',
  'pause',
]);

/** Ladder rungs, low to high. Index into {@link RUNGS}. */
const RUNGS = Object.freeze(['repair', 'replan', 'propose_ultraplan', 'human']);

/**
 * Entry rung per failure class (§35, read top to bottom).
 * `human-value` and `unknown` start at the top: neither has a machine rung
 * below it to try first.
 */
const RUNG_BY_CLASS = Object.freeze({
  implementation: 0,
  plan: 1,
  framing: 2,
  'human-value': 3,
  unknown: 3,
});

/** Which noun each action operates on. Derived, not configurable. */
const TARGET_BY_ACTION = Object.freeze({
  repair: 'implementation',
  replan: 'plan',
  propose_ultraplan: 'mission',
  ask_human: 'human',
  pause: 'human',
});

/**
 * Repair budget when `onFailure.retryLimit` is absent. 3 mirrors the value the
 * engine already emits (engine.js:505) so the default is the observed payload,
 * not a new number.
 */
const DEFAULT_RETRY_LIMIT = 3;

/**
 * Replans tolerated before the ultraplan rung. §35 says "multiple replans"
 * without fixing a count, and no config key exists for it yet, so 2 is used as
 * the smallest integer that satisfies "multiple". Callers override it with
 * `attemptState.replanLimit`. UNMEASURED against real runs — see the task
 * report; nothing has produced a replan yet to calibrate against.
 */
const DEFAULT_REPLAN_LIMIT = 2;

/**
 * Same-class occurrences (this one included) that make a failure "repeated"
 * for §35 rung 2. 2 is the definition of repeated, not a tuning knob, so it is
 * a constant rather than an option.
 */
const REPEATED_AT = 2;

function normalizeClass(classification) {
  if (typeof classification === 'string') return classification;
  if (classification !== null && typeof classification === 'object') {
    if (typeof classification.class === 'string') return classification.class;
    if (typeof classification.classification === 'string') return classification.classification;
  }
  return null;
}

/**
 * Zero is a meaningful budget, not a missing one: `retryLimit: 0` means "do
 * not repair at all" and `replanLimit: 0` means "go straight to the ultraplan
 * rung". So the guard is `>= 0`, and only a non-integer falls back to the
 * default. Reading 0 as absent would silently restore a budget the caller
 * explicitly removed.
 */
function nonNegativeInt(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * How many times this class has now been seen, current attempt included.
 * Taken from `attemptState.sameClassAttempts` when the caller tracks it;
 * otherwise bridged from the classifier's own `signals.priorSameClass`, which
 * counts only the prior ones. Defaults to 1 — the first sighting.
 */
function sameClassAttempts(classification, attemptState) {
  const explicit = attemptState.sameClassAttempts;
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const prior = classification !== null && typeof classification === 'object'
    ? classification.signals?.priorSameClass
    : undefined;
  return Number.isInteger(prior) && prior >= 0 ? prior + 1 : 1;
}

/**
 * Render the top rung. `human-value` and `unknown` are always a question,
 * whatever `escalateTo` says: silently pausing on a value decision is the
 * behaviour lane 4 §1.6 flagged as the existing gap, and the brief for this
 * module states unknown goes to a person. `escalateTo` therefore governs only
 * the rung reached by exhausting the machine ladder, where the caller has
 * already declared how it wants to end.
 */
function renderHumanRung(failureClass, escalateTo, reason) {
  if (failureClass === 'unknown' || failureClass === 'human-value') {
    return { action: 'ask_human', reason };
  }
  if (escalateTo === 'pause') {
    return {
      action: 'pause',
      reason: `${reason} onFailure.escalateTo is "pause", so the run stops here instead of asking; nothing further is attempted automatically.`,
    };
  }
  return { action: 'ask_human', reason };
}

/**
 * Recommend a recovery action for one classified failure.
 *
 * Pure: no I/O, no clock, no mutation of either argument.
 *
 * @param {string|{class?: string, signals?: {priorSameClass?: number}}} classification
 *   A {@link module:lib/recovery/failure-classifier.classify} result, or a bare
 *   class string. An unrecognized value is treated as `unknown` — which routes
 *   to a person, so a malformed input cannot silently become a machine action.
 * @param {object} [attemptState]
 * @param {number} [attemptState.sameClassAttempts] Occurrences of this class
 *   including the current one. Falls back to the classifier signal.
 * @param {number} [attemptState.repairAttempts=0] Repairs already spent.
 * @param {number} [attemptState.replanAttempts=0] Replans already spent.
 * @param {number} [attemptState.replanLimit=2] See {@link DEFAULT_REPLAN_LIMIT}.
 * @param {boolean} [attemptState.ultraplanProposed=false] Whether an ultraplan
 *   was already proposed for this mission. True means §35's last line applies:
 *   the ultraplan did not resolve it, so a person decides.
 * @param {{retryLimit?: number, escalateTo?: string}} [attemptState.onFailure]
 *   The verify-phase payload from `engine.js:503`. Read only.
 * @returns {{action: string, target: string, reason: string}}
 */
export function decide(classification, attemptState = {}) {
  const state = attemptState === null || typeof attemptState !== 'object' ? {} : attemptState;
  const named = normalizeClass(classification);
  const failureClass = Object.hasOwn(RUNG_BY_CLASS, named) ? named : 'unknown';

  const onFailure = state.onFailure !== null && typeof state.onFailure === 'object'
    ? state.onFailure
    : {};
  const retryLimit = nonNegativeInt(onFailure.retryLimit, DEFAULT_RETRY_LIMIT);
  const escalateTo = typeof onFailure.escalateTo === 'string' ? onFailure.escalateTo : null;
  const replanLimit = nonNegativeInt(state.replanLimit, DEFAULT_REPLAN_LIMIT);
  const repairAttempts = nonNegativeInt(state.repairAttempts, 0);
  const replanAttempts = nonNegativeInt(state.replanAttempts, 0);
  const seen = sameClassAttempts(classification, state);
  const ultraplanProposed = state.ultraplanProposed === true;

  const entryRung = RUNG_BY_CLASS[failureClass];
  let rung = entryRung;
  const trace = [];

  if (named !== failureClass) {
    trace.push(
      `Classification ${JSON.stringify(named)} is not one of the five failure classes, so it is handled as unknown.`,
    );
  }

  // Rung 0 -> 1: §35 "repeated same-class failure -> replan", plus the repair
  // budget the engine payload already declares.
  if (rung === 0) {
    if (seen >= REPEATED_AT) {
      rung = 1;
      trace.push(
        `Same class seen ${seen} times, so it is a repeated failure and repairing the same plan again is not the answer (§35 rung 2).`,
      );
    } else if (repairAttempts >= retryLimit) {
      rung = 1;
      trace.push(
        `Repair budget spent (${repairAttempts}/${retryLimit} from onFailure.retryLimit), so the plan is revised instead of repairing again.`,
      );
    } else {
      trace.push(
        `First sighting of this class and ${repairAttempts}/${retryLimit} repairs used, so the implementation is repaired against the standing plan (§35 rung 1).`,
      );
    }
  }

  // Rung 1 -> 2: §35 "multiple replans -> ultraplan".
  if (rung === 1) {
    if (replanAttempts >= replanLimit) {
      rung = 2;
      trace.push(
        `Already replanned ${replanAttempts} time(s) against a limit of ${replanLimit}, which is the "multiple replans" condition of §35 rung 3.`,
      );
    } else {
      trace.push(`Replan ${replanAttempts + 1} of ${replanLimit} before the ultraplan rung is reached.`);
    }
  }

  // Rung 2 -> 3: §35 "ultraplan still ambiguous -> human decision".
  if (rung === 2) {
    if (ultraplanProposed) {
      rung = 3;
      trace.push('An ultraplan was already proposed and the failure persists, so the decision is a person (§35 rung 4).');
    } else {
      trace.push(
        'An ultraplan is PROPOSED, not started. Design 01 §7 rules out the ultraplan as a default retry instrument, so a human opens it or does not.',
      );
    }
  }

  // Entered at the top rung rather than climbing to it: say why the ladder was
  // skipped, not just that it was. Keyed on the entry rung so a malformed
  // classification (which already pushed a note) still gets its explanation.
  if (entryRung === 3) {
    trace.push(
      failureClass === 'unknown'
        ? 'The failure could not be classified. An unclassified failure is never converted into a machine action by a counter.'
        : 'This is a value decision, and no machine rung sits below it.',
    );
  }

  const reason = trace.join(' ');
  if (rung < 3) {
    const action = RUNGS[rung];
    return Object.freeze({ action, target: TARGET_BY_ACTION[action], reason });
  }

  const rendered = renderHumanRung(failureClass, escalateTo, reason);
  return Object.freeze({
    action: rendered.action,
    target: TARGET_BY_ACTION[rendered.action],
    reason: rendered.reason,
  });
}
