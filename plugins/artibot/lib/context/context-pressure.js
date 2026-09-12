/**
 * Context pressure scoring (vNext PR-CX02 / V5-BACKLOG SH-16).
 *
 * Turns "how full is this worker's context window" into one number, one level,
 * and one recommendation STRING. Nothing in this repository acts on the
 * recommendation: PR-CX02 ships the score and the event only, rotation stays
 * OFF. A caller that wants to rotate must add that decision somewhere else,
 * deliberately, so the scoring change and the behaviour change land in
 * separate reviewable steps.
 *
 * The module is pure on purpose. It reads no files, no clock, no environment,
 * no randomness, and imports nothing, so the same input always produces the
 * same output and the hooks that call it stay testable without a fixture tree.
 * `tests/context/context-pressure.test.js` greps this source to keep that true.
 *
 * ## Where the constants came from
 * - `estimateTokens` is the chars/4 heuristic that lived module-private in
 *   `scripts/hooks/pre-compact.js` (`function estimateTokens`, verified
 *   2026-09-12). This module is now its single home; the formula is kept
 *   byte-identical because `tests/hooks/pre-compact.test.js` pins the values
 *   it produces.
 * - `PRESSURE_THRESHOLDS` reuses `WARN_THRESHOLD = 0.70` and
 *   `CRITICAL_THRESHOLD = 0.90` from `scripts/hooks/context-tracker.js`
 *   (lines 27-28, verified 2026-09-12). That hook is in the scripts layer, so
 *   a lib module cannot import it; the values are copied and cited instead.
 *
 * ## The capacity number is contested — so it is an input, not a default
 * The repository disagrees with itself about how large a context window is:
 *
 * - `scripts/hooks/context-tracker.js` uses `DEFAULT_MAX_TOKENS = 128_000`.
 * - `lib/core/model-catalog.js` gives `MODELS.*.ctxLimit` as 200_000 for one
 *   model and 1_000_000 for three others.
 *
 * Picking either one here would bake a silent, wrong denominator into every
 * score. So `computeContextPressure` has NO default capacity: when `maxTokens`
 * is missing or unusable the result is a null score with reason
 * `capacity-unknown`, and resolving the disagreement stays with the caller
 * that actually knows which model is running.
 */

/** Scoring strategy version, stamped on every result so stored scores stay comparable. */
export const PRESSURE_STRATEGY_VERSION = 1;

/**
 * Level boundaries, by value from `scripts/hooks/context-tracker.js:27-28`.
 * Frozen: a caller retuning these at runtime would make two scores from the
 * same strategy version incomparable.
 *
 * @type {Readonly<{ warn: number, critical: number }>}
 */
export const PRESSURE_THRESHOLDS = Object.freeze({ warn: 0.70, critical: 0.90 });

/** Characters per token for the heuristic sources. Matches both hooks. */
const CHARS_PER_TOKEN = 4;

/**
 * Estimate a token count with the chars/4 + 1 heuristic.
 *
 * Byte-identical to the formula that was module-private in
 * `scripts/hooks/pre-compact.js`, including the `+ 1` that makes the empty
 * string cost 1 token. Non-string input is treated as empty rather than
 * throwing, because hook payloads arrive from a host process.
 *
 * @param {string} text
 * @returns {number} token estimate, always >= 1
 */
export function estimateTokens(text) {
  const length = typeof text === 'string' ? text.length : 0;
  return Math.ceil(length / CHARS_PER_TOKEN) + 1;
}

/**
 * @param {unknown} value
 * @returns {number|null} the value if it is a finite number >= 0, else null
 */
function asNonNegativeFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * @param {unknown} value
 * @returns {number|null} the value if it is a finite number > 0, else null
 */
function asPositiveFinite(value) {
  const n = asNonNegativeFinite(value);
  return n !== null && n > 0 ? n : null;
}

/**
 * Pick the token count, best source first.
 *
 * 1. `currentTokens` — the host's own `context_window.current_tokens`. The
 *    only MEASURED source; `context-tracker.js:47-48` prefers it for the same
 *    reason.
 * 2. `tokenEstimate` — a chars/4 estimate a hook already computed.
 * 3. `transcriptBytes` — raw JSONL transcript bytes run through the same
 *    chars/4 shape. This OVERSTATES context: the transcript keeps JSON
 *    envelopes, tool results, and turns the host has already compacted away,
 *    none of which still occupy the window. Results from this source carry
 *    `overstates: true` so a reader never mistakes the number for a
 *    measurement.
 *
 * An invalid value at one level falls through to the next rather than
 * poisoning the result.
 *
 * @param {Record<string, unknown>} src
 * @returns {{ tokenSource: string|null, tokens: number|null, measured: boolean, overstates: boolean }}
 */
function pickTokenSource(src) {
  const current = asNonNegativeFinite(src.currentTokens);
  if (current !== null) {
    return { tokenSource: 'currentTokens', tokens: current, measured: true, overstates: false };
  }
  const estimate = asNonNegativeFinite(src.tokenEstimate);
  if (estimate !== null) {
    return { tokenSource: 'tokenEstimate', tokens: estimate, measured: false, overstates: false };
  }
  const bytes = asNonNegativeFinite(src.transcriptBytes);
  if (bytes !== null) {
    return {
      tokenSource: 'transcriptBytes',
      tokens: Math.ceil(bytes / CHARS_PER_TOKEN) + 1,
      measured: false,
      overstates: true,
    };
  }
  return { tokenSource: null, tokens: null, measured: false, overstates: false };
}

/**
 * `'auto'` and `'manual'` are the compaction triggers the host reports;
 * anything else (including absent) normalises to null.
 *
 * @param {unknown} value
 * @returns {'auto'|'manual'|null}
 */
function normalizeTrigger(value) {
  return value === 'auto' || value === 'manual' ? value : null;
}

/**
 * @param {number} score
 * @returns {'low'|'warn'|'critical'}
 */
function levelFor(score) {
  if (score >= PRESSURE_THRESHOLDS.critical) return 'critical';
  if (score >= PRESSURE_THRESHOLDS.warn) return 'warn';
  return 'low';
}

/**
 * Compute context pressure from whatever a hook could observe.
 *
 * `compactTrigger` is recorded but does NOT move the score. An auto compaction
 * is the host telling us what IT decided; folding that into our number would
 * mix a host-side signal with our own measurement, and the two would then be
 * impossible to separate when reading stored events. It rides along as
 * context for whoever reads the event instead.
 *
 * Never throws. Degenerate input yields a null score with a `reason`, because
 * the caller is a hook whose failure would be invisible to the user.
 *
 * @param {{
 *   currentTokens?: number, maxTokens?: number, tokenEstimate?: number,
 *   transcriptBytes?: number, compactTrigger?: 'auto'|'manual'|null,
 *   measured?: boolean
 * }} [input]
 * @returns {{
 *   score: number|null, level: 'low'|'warn'|'critical'|null,
 *   recommendation: 'none'|'rotate-worker', reason: string|null,
 *   strategy_version: number,
 *   inputs: { tokenSource: string|null, tokens: number|null, maxTokens: number|null,
 *             measured: boolean, compactTrigger: 'auto'|'manual'|null,
 *             clamped: boolean, overstates: boolean }
 * }}
 */
export function computeContextPressure(input) {
  const src = input && typeof input === 'object' ? /** @type {Record<string, unknown>} */ (input) : {};
  const picked = pickTokenSource(src);
  const maxTokens = asPositiveFinite(src.maxTokens);
  const inputs = {
    tokenSource: picked.tokenSource,
    tokens: picked.tokens,
    maxTokens,
    // An explicit boolean from the caller wins: a hook that knows the host
    // reported exact usage through some other field can say so. Anything
    // non-boolean leaves the source-derived value alone.
    measured: typeof src.measured === 'boolean' ? src.measured : picked.measured,
    compactTrigger: normalizeTrigger(src.compactTrigger),
    clamped: false,
    overstates: picked.overstates,
  };

  if (picked.tokens === null) return degenerate('no-token-input', inputs);
  if (maxTokens === null) return degenerate('capacity-unknown', inputs);

  const raw = picked.tokens / maxTokens;
  inputs.clamped = raw > 1;
  const score = Math.round(Math.min(Math.max(raw, 0), 1) * 10_000) / 10_000;
  const level = levelFor(score);
  return {
    score,
    level,
    // A string only. PR-CX02 keeps rotation OFF; nothing reads this to act.
    recommendation: level === 'critical' ? 'rotate-worker' : 'none',
    reason: null,
    strategy_version: PRESSURE_STRATEGY_VERSION,
    inputs,
  };
}

/**
 * Result shape for input we cannot score. Same keys as a scored result so a
 * consumer never has to branch on presence.
 *
 * @param {string} reason
 * @param {object} inputs
 * @returns {object}
 */
function degenerate(reason, inputs) {
  return {
    score: null,
    level: null,
    recommendation: 'none',
    reason,
    strategy_version: PRESSURE_STRATEGY_VERSION,
    inputs,
  };
}

/**
 * Build the supervisor envelope PARTIAL for a `context-pressure` event.
 *
 * Partial by design: `version`, `eventId`, `ts`, `runId`, `actionId`, and
 * `evidenceRef` are filled by `lib/supervisor/run-store.js#normalizeEnvelope`.
 * Setting `eventId` or `ts` here would need randomness and a clock, which is
 * exactly what keeps this module pure. `type` is already in
 * `lib/supervisor/event-types.js#SUPERVISOR_EVENT_TYPES` and the reducer
 * treats it as a heartbeat only — the run-state schema has no slot for the
 * score, so the number lives in `data` and nowhere else.
 *
 * @param {object} [pressure] - a {@link computeContextPressure} result
 * @param {{ laneId?: string|null, sessionId?: string|null, cwd?: string|null }} [meta]
 * @returns {{ type: string, source: string, laneId: string|null, data: object }}
 */
export function buildContextPressureEvent(pressure, meta = {}) {
  const p = pressure && typeof pressure === 'object' ? pressure : computeContextPressure({});
  const m = meta && typeof meta === 'object' ? meta : {};
  return {
    type: 'context-pressure',
    source: 'hook',
    laneId: m.laneId ?? null,
    data: {
      score: p.score ?? null,
      level: p.level ?? null,
      recommendation: p.recommendation ?? 'none',
      reason: p.reason ?? null,
      strategy_version: p.strategy_version ?? PRESSURE_STRATEGY_VERSION,
      inputs: p.inputs ?? null,
      session_id: m.sessionId ?? null,
    },
  };
}
