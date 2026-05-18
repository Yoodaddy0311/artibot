/**
 * Engine helpers — v4.11.0 Track J extension.
 *
 * Companion to `_engine-helpers.js` (kept untouched per the v4.11 quality
 * gate). Adds two engine-internal helpers used to surface auto-wire results
 * to the orchestrator without bloating engine.js past the 800-line cap.
 *
 * Underscored filename signals "internal — not part of the public autopilot
 * surface". Do not re-export from `index.js`.
 *
 * Public (engine-internal) surface:
 *   - buildAutoWireBlock(autoWireResult)
 *   - mergeAutoWireIntoState(state, autoWireResult)
 *
 * @module lib/autopilot/_engine-helpers-v4.11
 */

/**
 * The shape we expect from any `wireXxx()` output. Only `instruction` is
 * required; other fields are optional decoration.
 *
 * @typedef {{
 *   instruction?: string,
 *   costEstimate?: object,
 *   complexity?: object,
 *   suggestedTemplate?: string,
 *   skippablePhases?: object,
 *   driftDetected?: boolean,
 *   migrationNeeded?: boolean,
 *   rebasePlan?: Array<object>|null,
 *   targets?: Array<object>,
 *   recommended?: object|null,
 *   driftPct?: number,
 *   warning?: boolean,
 *   missing?: string[],
 *   extra?: string[],
 * }} AutoWireResult
 */

/**
 * Render an auto-wire result as a user-facing markdown block. The block is
 * intentionally minimal: a heading delimiter + the `instruction` field. The
 * orchestrator handles font/color/positioning in the surrounding UI.
 *
 * Returns an empty string for null / non-object / missing-instruction input
 * so the caller can blindly concatenate without conditional guards.
 *
 * @param {AutoWireResult|null|undefined} autoWireResult
 * @returns {string}
 */
export function buildAutoWireBlock(autoWireResult) {
  if (!autoWireResult || typeof autoWireResult !== 'object') return '';
  const instr = typeof autoWireResult.instruction === 'string'
    ? autoWireResult.instruction.trim()
    : '';
  if (!instr) return '';
  return ['---', '', instr, '', '---'].join('\n');
}

/**
 * Strip the `instruction` field from a wire result so we don't double-store
 * the rendered markdown when the structured data is what telemetry/replay
 * cares about.
 *
 * @param {AutoWireResult} result
 * @returns {object} new object without `instruction`
 */
function stripInstruction(result) {
  const copy = { ...result };
  delete copy.instruction;
  return copy;
}

/**
 * Immutably append an auto-wire result to `state.autoWireData[]`. Returns a
 * NEW state — never mutates the input. The appended entry carries a `ts`
 * timestamp so replay can rebuild the timeline.
 *
 * Accepts a single result or an array; non-object entries are skipped.
 *
 * Shape of the appended entry:
 *   { ts: ISO8601, kind?: string, ...resultWithoutInstruction }
 *
 * @param {object} state
 * @param {AutoWireResult|AutoWireResult[]|null|undefined} autoWireResult
 * @returns {object} new state
 */
export function mergeAutoWireIntoState(state, autoWireResult) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('mergeAutoWireIntoState: state must be an object');
  }
  const prior = Array.isArray(state.autoWireData) ? state.autoWireData : [];
  const incoming = Array.isArray(autoWireResult) ? autoWireResult : [autoWireResult];
  const ts = new Date().toISOString();
  const fresh = [];
  for (const item of incoming) {
    if (!item || typeof item !== 'object') continue;
    fresh.push({ ts, ...stripInstruction(item) });
  }
  return { ...state, autoWireData: [...prior, ...fresh] };
}
