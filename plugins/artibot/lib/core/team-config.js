/**
 * `config.team` readers — the enable/opt-out meaning, owned once (core, L1).
 *
 * WHY L1. This predicate shipped in `lib/cognitive/workflow-plan.js` (L4). The
 * 5-layer rule is "upper layers import lower only", so every surface at L3 or
 * below was structurally unable to call the one owner and re-derived the
 * meaning inline instead (`Boolean(config?.team?.enabled)` in
 * `lib/learning/self-benchmark.js`, and the same shape in the L5 telemetry
 * envelope). Those inline copies are a DIFFERENT answer, not a second copy of
 * the same one: they read `enabled` alone, so a config that opts out via
 * `autoApply: false` still reported the team as on. Moving the owner to L1 puts
 * it in reach of all five layers; `workflow-plan.js` re-exports it, so no
 * existing import path changed.
 *
 * This module holds no state and reads no files — it is a pure predicate over
 * a plain object, which is what makes it safe at L1.
 *
 * @module lib/core/team-config
 */

/**
 * Is the auto-team machinery enabled at all for this config?
 *
 * SOLE OWNER of the enable/opt-out meaning, the same way `evaluateTrigger` is
 * the sole owner of the threshold meaning. `scripts/hooks/auto-team-trigger.js`
 * used to compute this expression itself; the two copies are now one, so a
 * change of meaning cannot reach one surface and miss the other.
 *
 * `enabled` and `autoApply` are ANDed (owner decision OD3, 2026-09-15): either
 * one set to `false` turns the team off. That is the meaning the hook already
 * shipped, carried over verbatim rather than redesigned. Absent keys mean ON —
 * the gate is `!== false`, not truthiness, so `undefined` keeps the default.
 *
 * @param {{ enabled?: boolean, autoApply?: boolean }|undefined} teamConfig - `config.team`
 * @returns {boolean}
 */
export function isTeamEnabled(teamConfig) {
  return teamConfig?.enabled !== false && teamConfig?.autoApply !== false;
}
