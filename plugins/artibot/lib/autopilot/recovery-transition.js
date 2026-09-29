/**
 * Recovery TRANSITION applier — CA-03, the switch `recovery-record.js` was
 * built to enable. Config-gated and OFF by default.
 *
 * `recovery-record.js` writes a recommendation and deliberately leaves the
 * fixed `VERIFY -> IMPROVE` transition alone, so the switch could be made
 * against a measured denominator. This module is that switch: given a journal
 * row it decides which phase the recommendation actually wants, and — only when
 * `autopilot.recovery.transitionFromVerdict` is `true` — moves the session
 * there.
 *
 * ── What `divergent` means ────────────────────────────────────────────────
 * `divergent` on a journal row means "the transition that actually happened
 * differs from the recommendation". At Observe (gate OFF) it is always `true`
 * (fixed IMPROVE). With the gate ON it stays `true` until the recommendation
 * has really been carried out; only then does this module write `false`, next
 * to `appliedNext` (the actual target) and `appliedBy`. When that is — at once
 * for a pause, at hand-out for a routed phase — is the next section. The
 * `recovery-decided` event keeps `divergent: true` — it is emitted before this
 * module runs and means "relative to the fixed transition"; `recovery-applied`
 * is the separate event that says the transition took effect.
 *
 * ── Routed is not applied (AP-N4) ─────────────────────────────────────────
 * For a phase-advancing action (`repair`, `replan`) writing `state.pendingPhase`
 * is only a ROUTE. The phase runner has not been asked yet and it can still
 * refuse: `engine.js#maybePause`, the dispatch gate, pauses on the very
 * counters that make a replan likely — three build failures is both the
 * spent-repair-budget signal and `safety.js#shouldPause`'s build trigger. Before
 * AP-N4 the ACK stamped `appliedNext` anyway, so a PLAN that never went out
 * still counted as a spent replan in `recovery-record.js#ladderFromJournal`.
 *
 * So the ACK stamps a route row `applyStatus: 'routed'` (+ `routedNext`,
 * `phasesAtRoute`) and leaves `divergent: true` with no `appliedNext`;
 * {@link settleRecoveryTransitions} writes `appliedNext`, `appliedBy` and
 * `divergent: false` only once the engine has actually handed the routed phase
 * out. A pause needs no hand-out — the session is stopped once the state moved —
 * so it is applied at once. `row.applyStatus` is an allowlist
 * ({@link APPLY_STATUS}):
 *   routed                   the route is written, no hand-out seen yet
 *   applied                  the routed phase was handed out (a pause: at once)
 *   blocked-before-dispatch  the session is paused AT the routed phase and
 *                            nothing was handed out — the dispatch gate refused
 *   superseded               something else took the slot first: a newer
 *                            decision, or a different phase went out first
 * A row with no `applyStatus` is an Observe row (never routed) or a legacy row
 * written before AP-N4, whose `appliedNext` was stamped at the ACK. Neither is
 * touched here, and `ladderFromJournal` keeps reading `appliedNext` alone.
 *
 * The evidence of a hand-out is a `state.phases` record with `status: 'queued'`
 * at an index >= `row.phasesAtRoute`: every runner writes it right after its
 * dispatch gate passes, and nothing else writes that status. The FIRST such
 * record decides — the routed phase means applied, any other phase means
 * superseded — so one hand-out can never settle two rows. `engine-state.js` runs
 * the pass at every phase entry (`enterPhase`) and every phase result
 * (`recordPhaseResult`), which settles a row before the next VERIFY judgement
 * reads the ladder.
 *
 * ── What this cannot see (stated next to the mechanism) ───────────────────
 *  - A driver that never resumes the engine. If it performs the phases itself
 *    and only calls `recordPhaseResult`, no runner ever hands the routed phase
 *    out: the row stays `routed`, `divergent` stays `true`, and the ladder never
 *    climbs. That is the honest reading — the engine assigned nothing — and the
 *    reason `commands/autopilot.md` orders `resumeAutopilot` after every result.
 *  - `blocked-before-dispatch` is recorded only when a later `enterPhase` or
 *    `recordPhaseResult` still sees the pause. A session that stays paused with
 *    no further call reads `routed`; `state.phase`, `lastPhase` and
 *    `pausedReason` still say why.
 *  - A runner that hands a phase out without a `queued` record, or a change to
 *    that record's shape, reads as "never handed out": the row is never
 *    applied, so nothing false is claimed but the ladder stops climbing.
 *    The real-runner cases in
 *    `tests/autopilot/engine-state-recovery-transition.test.js` are what turn
 *    such a change red.
 *  - A stale copy of the state. Settlement reads the object it is given, so a
 *    copy loaded before the hand-out cannot see it.
 *
 * ── PAUSED is not a new concept ───────────────────────────────────────────
 * `PHASES` is unchanged. PAUSED is expressed exactly as
 * `engine-state.js#recordSecretLeak` and `engine.js#maybePause` express it, so
 * `nextTarget(state)` on a PAUSED state yields `lastPhase` (= VERIFY): a resume
 * re-enters VERIFY, the same re-check path every other pause in the engine
 * already uses.
 *
 * ── Two rules that are not judgement calls ────────────────────────────────
 *  1. **The action table is an ALLOWLIST.** Anything outside it — absent,
 *     misspelled, wrong case, non-string, a prototype key — pauses. A denylist
 *     would fail OPEN the day the ladder grows a sixth rung.
 *  2. **Never throw.** The caller is the phase ACK point (same reason
 *     `recovery-record.js#journalRecordFailure` exists). A hostile row degrades
 *     to `applied: false`.
 *
 * ── A pause has to announce itself ───────────────────────────────────────
 * Moving the phase fields is only half of a pause. `engine.js#maybePause` also
 * archives a lesson, emits a `pause` event and notifies, so this module does the
 * same three, in the same shapes. Each is guarded on its own: a notification
 * that throws must not un-pause a session the engine has already stopped.
 *
 * **The queue entry reaches the operator only because the caller merges it.**
 * This module does not persist, so the entry `notification.js#queueOnSession`
 * writes lands on the *pre-transition* session on disk, where a later
 * whole-state persist would erase it — and when no session file exists yet,
 * `queueOnSession` cannot write it at all. That is why the returned
 * `notification` is part of this function's contract rather than a courtesy:
 * `engine-state.js#recordPhaseResult` takes its `queued` payload into the live
 * state via `_engine-helpers.js#mergeQueuedNotification` before persisting, so
 * the queue entry is written from the same object as every other field and
 * survives each subsequent persist. A caller that discards the return value is
 * back to a pause that announces itself only through the `pause` event and the
 * lesson.
 *
 * Layer: L2. Imports `_engine-helpers.js`, `memory.js`, `notification.js` and
 * `../core/platform.js` only. It does NOT import `engine-state.js` — that module
 * imports this one — keeping the dependency one-directional. `appendLesson` is
 * therefore taken straight from `memory.js` rather than through
 * `engine-state.js#safeAppendLesson`, which would close that loop; the
 * featureKey guard below is the local equivalent.
 *
 * @module lib/autopilot/recovery-transition
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { tick } from './_engine-helpers.js';
import { appendLesson } from './memory.js';
import { notifyPause } from './notification.js';
import { getPluginRoot } from '../core/platform.js';

/**
 * Recommendation action -> phase the session should move to. The five keys are
 * exactly `lib/recovery/recovery-controller.js#RECOVERY_ACTIONS`; the three
 * human-facing rungs all land on PAUSED because none of them has a machine step
 * the engine can take unattended.
 */
export const TRANSITION_BY_ACTION = Object.freeze({
  repair: 'EXECUTE',
  replan: 'PLAN',
  propose_ultraplan: 'PAUSED',
  ask_human: 'PAUSED',
  pause: 'PAUSED',
});

/**
 * Lifecycle of a gate-ON journal row (`row.applyStatus`) — an ALLOWLIST, and the
 * only values this module ever writes or acts on. See "Routed is not applied" in
 * the module header for what each one claims and what it does not.
 */
export const APPLY_STATUS = Object.freeze({
  ROUTED: 'routed',
  APPLIED: 'applied',
  BLOCKED: 'blocked-before-dispatch',
  SUPERSEDED: 'superseded',
});

/** The two statuses a row can still leave; every other row is left exactly as it is. */
const OPEN_STATUSES = Object.freeze([APPLY_STATUS.ROUTED, APPLY_STATUS.BLOCKED]);

/**
 * Decide the phase a recovery row wants. Pure — reads `row.action` and nothing
 * else, and mutates nothing.
 *
 * @param {object} row - A `state.recoveryJournal` entry. Any shape tolerated.
 * @returns {{next: 'EXECUTE'|'PLAN'|'PAUSED', pausedReason: string|null, reason: string}}
 *   `pausedReason` is `recovery:<action>` on PAUSED rows and `null` otherwise.
 */
export function phaseForRecovery(row) {
  const action = row?.action;
  const known = typeof action === 'string' && Object.hasOwn(TRANSITION_BY_ACTION, action);
  if (!known) {
    return {
      next: 'PAUSED',
      pausedReason: 'recovery:unknown-action',
      reason: `action outside the allowlist (${typeof action}) — pausing fail-closed`,
    };
  }
  const next = TRANSITION_BY_ACTION[action];
  return {
    next,
    pausedReason: next === 'PAUSED' ? `recovery:${action}` : null,
    reason: `recovery action ${action} transitions to ${next}`,
  };
}

/**
 * Read the CA-03 gate straight off `<pluginRoot>/artibot.config.json`, the
 * `engine.js#loadRunnerConfig` precedent. Only a real boolean `true` opens the
 * gate: a missing file, broken JSON, the string `"true"` and `1` all read as
 * OFF. Never throws.
 *
 * @returns {{transitionFromVerdict: boolean}}
 */
export function loadRecoveryTransitionConfig() {
  try {
    const cfgPath = path.join(getPluginRoot(), 'artibot.config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    return { transitionFromVerdict: cfg?.autopilot?.recovery?.transitionFromVerdict === true };
  } catch {
    return { transitionFromVerdict: false };
  }
}

/**
 * Run a side effect that must never reach the caller. Returns the effect's
 * value, or `null` when it threw — the announcement steps below are each
 * wrapped individually so one failure cannot cancel the others or the pause.
 *
 * @param {() => any} effect
 * @returns {any|null}
 */
function attempt(effect) {
  try {
    return effect();
  } catch {
    return null; /* announcement is best-effort; the pause already happened */
  }
}

/**
 * Apply the PAUSED phase fields and archive the lesson — the same four fields
 * and the same lesson body as `engine.js#maybePause`.
 *
 * The field assignments are deliberately NOT guarded: a state that rejects them
 * (frozen, hostile setters) is a failed transition, and the caller's try/catch
 * degrades it to `applied: false`. The lesson is guarded, and skipped entirely
 * before Phase 0 has set `featureKey`.
 *
 * @param {object} state - Live session state (mutated).
 * @param {string} pausedReason
 * @returns {void}
 */
function enterPausedState(state, pausedReason) {
  if (state.phase && state.phase !== 'PAUSED') state.lastPhase = state.phase;
  state.phase = 'PAUSED';
  state.pendingPhase = state.lastPhase || null;
  state.pausedReason = pausedReason;
  attempt(() => {
    if (!state.featureKey) return null;
    return appendLesson(state.featureKey, {
      sessionId: state.sessionId,
      lesson: `Pause at ${state.lastPhase || 'unknown'}: ${pausedReason}`,
      errorPattern: pausedReason,
      sourcePhase: state.lastPhase || null,
    });
  });
}

/**
 * Emit the `pause` event and notify, after the transition is committed.
 *
 * The notification result is returned verbatim: night mode and `--no-notify`
 * are `notification.js#suppressActive`'s decision, and re-deriving them here
 * would be a second source of truth for "was the operator actually told".
 *
 * @param {object} state - Already-paused session state.
 * @param {string} pausedReason
 * @returns {object|null} `notifyPause` result, or `null` when it failed.
 */
function announcePause(state, pausedReason) {
  attempt(() => tick(state.sessionId, {
    phase: state.lastPhase || 'PAUSED',
    type: 'pause',
    level: 'warn',
    message: `Autopilot paused: ${pausedReason}`,
    data: { reason: pausedReason },
  }));
  return attempt(() => notifyPause(state.sessionId, pausedReason)) ?? null;
}

/**
 * How many `state.phases` records exist right now (0 while there is no array).
 * The route stores this so the settlement pass reads only what came AFTER it.
 * @param {object} state
 * @returns {number}
 */
function phaseRecordCount(state) {
  return Array.isArray(state?.phases) ? state.phases.length : 0;
}

/**
 * The first hand-out recorded at or after `mark`: a `state.phases` record with
 * `status: 'queued'`, which every runner in `engine.js` writes right after its
 * dispatch gate passed. Anything else in `phases` — a driver's own result
 * report, a `done`/`failed` line, junk — is not a hand-out.
 * @param {object} state
 * @param {number} mark - `row.phasesAtRoute`.
 * @returns {{name: string, status: 'queued'}|null}
 */
function firstHandOutAfter(state, mark) {
  const phases = state?.phases;
  if (!Array.isArray(phases)) return null;
  for (let i = mark; i < phases.length; i += 1) {
    const record = phases[i];
    if (record !== null && typeof record === 'object'
      && record.status === 'queued' && typeof record.name === 'string') return record;
  }
  return null;
}

/**
 * Stamp a row as carried out. `divergent` goes first on purpose: it is the write
 * a frozen row rejects, and nothing is announced once it throws, so a row that
 * cannot be stamped is never announced as applied.
 * @param {object} row
 * @param {string} target - The phase that actually went out (or 'PAUSED').
 * @returns {void}
 */
function stampApplied(row, target) {
  row.divergent = false;
  row.appliedNext = target;
  row.appliedBy = 'recovery-transition';
  row.applyStatus = APPLY_STATUS.APPLIED;
}

/**
 * Stamp a row as routed: `pendingPhase` now points at `target`, nothing has been
 * handed out. `divergent` stays `true` and `appliedNext` stays absent.
 * @param {object} row
 * @param {string} target
 * @param {number} mark - {@link phaseRecordCount} at the moment of the route.
 * @returns {void}
 */
function stampRoute(row, target, mark) {
  row.applyStatus = APPLY_STATUS.ROUTED;
  row.routedNext = target;
  row.phasesAtRoute = mark;
}

/**
 * A newer decision now owns `pendingPhase` (or has paused the session), so a
 * route that was still waiting for its hand-out can no longer be carried out.
 * Marking it superseded is what stops one later hand-out from settling two rows.
 * Each row is touched under its own guard: a hostile row elsewhere in the journal
 * must not undo a transition the state already made.
 * @param {object} state
 * @param {object} current - The row that took over; never superseded by itself.
 * @returns {void}
 */
function supersedeOpenRows(state, current) {
  const journal = state?.recoveryJournal;
  if (!Array.isArray(journal)) return;
  for (const other of journal) {
    attempt(() => {
      if (other === current || other === null || typeof other !== 'object') return;
      if (OPEN_STATUSES.includes(other.applyStatus)) other.applyStatus = APPLY_STATUS.SUPERSEDED;
    });
  }
}

/**
 * The routed phase went out: stamp the row applied and say so, once. The stamp
 * comes first and the event is best-effort, so a telemetry failure can never
 * leave a row unstamped after the hand-out was seen.
 * @param {object} state
 * @param {object} row
 * @param {string} target
 * @returns {void}
 */
function markApplied(state, row, target) {
  stampApplied(row, target);
  attempt(() => tick(state.sessionId, {
    phase: row.phase,
    type: 'recovery-applied',
    level: 'info',
    message: `복구 전이 적용: ${row.action} → ${target} (고정 전이 ${row.fixedNext ?? 'n/a'} 대신, 배정 확인)`,
    data: {
      action: row.action, from: row.fixedNext ?? null, to: target, pausedReason: null, divergent: false,
    },
  }));
}

/**
 * The session is paused AT the routed phase and nothing went out: the dispatch
 * gate refused. Recorded once, as its own status; `appliedNext` stays absent.
 * @param {object} state
 * @param {object} row
 * @param {string} target
 * @returns {void}
 */
function markBlocked(state, row, target) {
  row.applyStatus = APPLY_STATUS.BLOCKED;
  attempt(() => {
    const reason = typeof state.pausedReason === 'string' ? state.pausedReason : null;
    tick(state.sessionId, {
      phase: row.phase,
      type: 'recovery-blocked',
      level: 'warn',
      message: `복구 전이 배정 전 차단: ${row.action} → ${target} (${reason ?? 'unknown'})`,
      data: { action: row.action, to: target, reason },
    });
  });
}

/**
 * Settle ONE row against the state. Only an open row (`routed`, or a
 * `blocked-before-dispatch` that may still go out) with a well-formed route is
 * looked at; everything else — Observe rows, legacy rows, applied, superseded,
 * unknown statuses — is left exactly as it is.
 * @param {object} state
 * @param {*} row
 * @returns {boolean} true when the row changed.
 */
function settleRow(state, row) {
  if (row === null || typeof row !== 'object') return false;
  const status = row.applyStatus;
  if (!OPEN_STATUSES.includes(status)) return false;
  const target = row.routedNext;
  const mark = row.phasesAtRoute;
  if (typeof target !== 'string' || !Number.isInteger(mark) || mark < 0) return false;

  // A hand-out wins over any reading of the pause: PLAN can have gone out and
  // been paused on afterwards (a secret leak freezes the current phase).
  const handedOut = firstHandOutAfter(state, mark);
  if (handedOut) {
    if (handedOut.name === target) markApplied(state, row, target);
    else row.applyStatus = APPLY_STATUS.SUPERSEDED;
    return true;
  }
  if (status === APPLY_STATUS.ROUTED && state.phase === 'PAUSED' && state.lastPhase === target) {
    markBlocked(state, row, target);
    return true;
  }
  return false;
}

/**
 * The AP-N4 settlement pass: turn a `routed` row into `applied` once the engine
 * has actually handed its phase out, mark a route the dispatch gate refused as
 * `blocked-before-dispatch`, and a route something else replaced as
 * `superseded`. Idempotent — a settled row is never looked at again — and safe
 * to call from anywhere: it only writes into journal rows and emits at most one
 * event per status change.
 *
 * Never throws. Its callers are `enterPhase` (every runner's first line) and
 * `recordPhaseResult` (the phase ACK); bookkeeping must not break either, and a
 * hostile row must not hide the rows after it.
 *
 * @param {object} state - Live session state; only `recoveryJournal` rows are written.
 * @returns {number} How many rows changed status (0 for anything unusable).
 */
export function settleRecoveryTransitions(state) {
  let settled = 0;
  try {
    const journal = state?.recoveryJournal;
    if (!Array.isArray(journal)) return 0;
    for (const row of journal) {
      try {
        if (settleRow(state, row)) settled += 1;
      } catch { /* that row stays as it was */ }
    }
  } catch { /* an unreadable state settles nothing */ }
  return settled;
}

/**
 * The session event for a decision, built BEFORE anything is touched so that a
 * hostile row throws while the session is still exactly as the recorder left it.
 * A pause is applied on the spot (`recovery-applied`); a phase-advancing action
 * is only routed (`recovery-routed`) — its `recovery-applied` comes at hand-out.
 * @param {object} row
 * @param {{next: string, pausedReason: string|null}} t - {@link phaseForRecovery}.
 * @param {?string} from - The fixed transition the decision replaces.
 * @returns {object}
 */
function decisionEvent(row, t, from) {
  const paused = t.next === 'PAUSED';
  const replaces = `${row.action} → ${t.next} (고정 전이 ${from ?? 'n/a'} 대신`;
  return {
    phase: row.phase,
    type: paused ? 'recovery-applied' : 'recovery-routed',
    level: 'info',
    message: paused ? `복구 전이 적용: ${replaces})` : `복구 전이 라우팅: ${replaces}, 배정 확인 전)`,
    data: {
      action: row.action, from, to: t.next, pausedReason: t.pausedReason, divergent: !paused,
    },
  };
}

/**
 * The return value when nothing took effect.
 * @param {?string} from
 * @param {string} [error]
 * @returns {{applied: false, routed: false, next: null, from: ?string,
 *   pausedReason: null, notification: null, error?: string}}
 */
function notApplied(from, error) {
  const result = {
    applied: false, routed: false, next: null, from, pausedReason: null, notification: null,
  };
  return error === undefined ? result : { ...result, error };
}

/**
 * Carry out the row's recommendation: a pause takes effect and is stamped applied
 * at once; a phase-advancing action is only ROUTED — `pendingPhase` is written
 * and the row is stamped `routed`, to be settled by
 * {@link settleRecoveryTransitions} when the engine hands the phase out.
 * Mutates `state` and the SAME `row` object (it lives inside
 * `state.recoveryJournal`, so the journal entry updates through the reference).
 *
 * Does NOT persist — the caller owns that, as it owns the ACK.
 *
 * @param {object} state - Live session state.
 * @param {object} row - The journal row just recorded.
 * @param {{transitionFromVerdict?: boolean}} [cfg] - {@link loadRecoveryTransitionConfig}.
 * @returns {{applied: boolean, routed: boolean, next: ?string, from: ?string,
 *   pausedReason: ?string, notification: ?object, error?: string}} `applied` is
 *   true only when the transition took effect (a pause); `routed` is true when
 *   `pendingPhase` was rewritten and the hand-out is still to come. Exactly one
 *   of the two, or neither. `notification` is the
 *   `notification.js#notifyPause` result (`{tool, params?, suppressed, queued}`)
 *   on an applied PAUSED transition, and `null` everywhere else — a phase-
 *   advancing action, an unapplied gate, an absent row, or a notifier that threw.
 */
export function applyRecoveryTransition(state, row, cfg) {
  let from = null;
  try { from = row?.fixedNext ?? null; } catch { /* hostile accessor; degraded */ }
  if (!row || cfg?.transitionFromVerdict !== true) return notApplied(from);
  try {
    // Compute everything before touching state: a throw here must leave the
    // session exactly as the recorder left it.
    const t = phaseForRecovery(row);
    const event = decisionEvent(row, t, from);
    const paused = t.next === 'PAUSED';

    // A hand-out that already happened settles its row before this decision takes
    // over pendingPhase; only the routes still waiting are superseded below.
    settleRecoveryTransitions(state);

    if (paused) {
      enterPausedState(state, t.pausedReason);
      stampApplied(row, t.next);
    } else {
      state.pendingPhase = t.next;
      stampRoute(row, t.next, phaseRecordCount(state));
    }
    supersedeOpenRows(state, row);

    tick(state.sessionId, event);
    return {
      applied: paused,
      routed: !paused,
      next: t.next,
      from,
      pausedReason: t.pausedReason,
      notification: paused ? announcePause(state, t.pausedReason) : null,
    };
  } catch (err) {
    let message = 'unknown';
    try { message = String(err?.message ?? err); } catch { /* degraded */ }
    return notApplied(from, message);
  }
}
