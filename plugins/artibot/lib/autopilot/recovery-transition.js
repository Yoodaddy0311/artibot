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
 * (fixed IMPROVE). When this module applies the recommendation it writes
 * `false`, matching the recovery-record header's promise ("CA-03 starts writing
 * `false`"). `appliedNext` is the actual target. The `recovery-decided` event
 * keeps `divergent: true` — it is emitted before this module runs and means
 * "relative to the fixed transition"; `recovery-applied` is the separate event
 * that says the transition moved.
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
 * Layer: L2. Imports `_engine-helpers.js` and `../core/platform.js` only. It
 * does NOT import `engine-state.js` — that module imports this one — keeping
 * the dependency one-directional.
 *
 * @module lib/autopilot/recovery-transition
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { tick } from './_engine-helpers.js';
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
 * Move `state` to the phase the row recommends, and stamp the row with what
 * actually happened. Mutates `state` and the SAME `row` object (it lives inside
 * `state.recoveryJournal`, so the journal entry updates through the reference).
 *
 * Does NOT persist — the caller owns that, as it owns the ACK.
 *
 * @param {object} state - Live session state.
 * @param {object} row - The journal row just recorded.
 * @param {{transitionFromVerdict?: boolean}} [cfg] - {@link loadRecoveryTransitionConfig}.
 * @returns {{applied: boolean, next: ?string, from: ?string, pausedReason: ?string, error?: string}}
 */
export function applyRecoveryTransition(state, row, cfg) {
  let from = null;
  try { from = row?.fixedNext ?? null; } catch { /* hostile accessor; degraded */ }
  if (!row || cfg?.transitionFromVerdict !== true) {
    return {
      applied: false, next: null, from, pausedReason: null,
    };
  }
  try {
    // Compute everything before touching state: a throw here must leave the
    // session exactly as the recorder left it.
    const t = phaseForRecovery(row);
    const event = {
      phase: row.phase,
      type: 'recovery-applied',
      level: 'info',
      message: `복구 전이 적용: ${row.action} → ${t.next} (고정 전이 ${from ?? 'n/a'} 대신)`,
      data: {
        action: row.action, from, to: t.next, pausedReason: t.pausedReason, divergent: false,
      },
    };

    if (t.next === 'PAUSED') {
      if (state.phase && state.phase !== 'PAUSED') state.lastPhase = state.phase;
      state.phase = 'PAUSED';
      state.pendingPhase = state.lastPhase || null;
      state.pausedReason = t.pausedReason;
    } else {
      state.pendingPhase = t.next;
    }
    row.divergent = false;
    row.appliedNext = t.next;
    row.appliedBy = 'recovery-transition';

    tick(state.sessionId, event);
    return {
      applied: true, next: t.next, from, pausedReason: t.pausedReason,
    };
  } catch (err) {
    let message = 'unknown';
    try { message = String(err?.message ?? err); } catch { /* degraded */ }
    return {
      applied: false, next: null, from, pausedReason: null, error: message,
    };
  }
}
