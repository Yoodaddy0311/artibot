/**
 * Schema v2 → v3 migration for autopilot session state.
 *
 * v3 changes (additive):
 *   - Adds `state.subCheckpoints[]` array (sub-step granularity, see
 *     lib/autopilot/sub-checkpoint.js).
 *   - Adds `state.machineId` slot (cross-machine drift detection, see
 *     lib/autopilot/cross-machine.js). NOT stamped here — left undefined
 *     so the first save with a machineId records the current host.
 *
 * Lives in a separate module so the rollout can be staged without touching
 * `lib/autopilot/session-store.js`. The orchestrator will eventually wire
 * `migrateV2toV3` into the loader chain.
 *
 * Idempotent. Pure function: input state is not mutated.
 *
 * @module lib/autopilot/migrate-v3
 */

/**
 * Target schema version for v3.
 */
export const SCHEMA_VERSION_V3 = 3;

/**
 * Lower bound: v2 is the only legal predecessor handled by this migration.
 */
export const SUPPORTED_FROM_VERSION = 2;

/**
 * Predicate — true if state needs v2→v3 upgrade.
 * @param {object} state
 * @returns {boolean}
 */
export function needsV3Migration(state) {
  if (!state || typeof state !== 'object') return false;
  const v = state.schemaVersion;
  if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  return v >= SUPPORTED_FROM_VERSION && v < SCHEMA_VERSION_V3;
}

/**
 * Pure migration step v2 → v3. Returns a NEW state object — input is not
 * mutated. Idempotent: passing an already-v3 state yields an equivalent v3.
 *
 * Throws TypeError on non-object input. Throws RangeError if state predates
 * v2 (caller must run earlier migrations first).
 *
 * @param {object} state
 * @returns {object} migrated state (new reference)
 */
export function migrateV2toV3(state) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('migrateV2toV3: state must be an object');
  }
  const v = state.schemaVersion;
  if (typeof v === 'number' && Number.isFinite(v) && v < SUPPORTED_FROM_VERSION) {
    throw new RangeError(
      `migrateV2toV3: state at schemaVersion=${v} predates v${SUPPORTED_FROM_VERSION}; run earlier migrations first`,
    );
  }
  const next = { ...state };
  if (!Array.isArray(next.subCheckpoints)) next.subCheckpoints = [];
  // machineId intentionally untouched — cross-machine module stamps it
  // on first save so we don't lie about which host last wrote the state.
  next.schemaVersion = SCHEMA_VERSION_V3;
  return next;
}
