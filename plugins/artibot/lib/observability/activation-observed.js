/**
 * NL-activation numerator/denominator — the pure half.
 *
 * WHAT THIS MEASURES. `scripts/evals/nl-activation-report.mjs#foldActivation`
 * computes the §3.7 slash-agreement axis as: denominator = records whose
 * `command_activation` map has at least one `true` key; numerator = those where
 * `activation_observed.slash` equals one of those keys. Until this module
 * existed no runtime producer wrote either key, so the axis read `0/0` forever
 * while looking like a working instrument. This builds the `data` payload the
 * reader already expects; `decision-events.js#recordActivationObserved`
 * persists it.
 *
 * WHY THE KEY NAMES ARE NOT NEGOTIABLE. They are pinned on the reader side by
 * `nl-activation-report.mjs#ACTIVATION_FIELDS` (`command_activation` /
 * `activation_observed`, verified 2026-09-17). A writer that invented
 * `activation_actual` would leave the reader reading `null` forever.
 *
 * PREDICTED, NOT SELECTED. `lib/topology/topology-router.js#routeTopology` is
 * observe-only — it routes nothing. `command_activation` is therefore what the
 * router WOULD have activated, projected through the one existing owner of that
 * projection, `lib/mission/compiler.js#projectCommandActivation`, rather than
 * recomputed here. Two projections of the same fact would be free to disagree.
 *
 * PRIVACY. No prompt text, ever. Two mechanisms, because the two inputs have
 * different shapes:
 *   - `reason[]` is never copied wholesale. Only the ID inside an `nl-match:`
 *     literal is extracted, and only when it satisfies a strict id charset — a
 *     fragment of prompt text cannot pass that filter.
 *   - `slashCommand` is re-validated against the same charset
 *     `lib/mission/mission-id.js#detectSlashCommand` produces, so an argument
 *     tail (`/split please leak`) cannot ride along on the command name.
 * Nothing here spreads an input object.
 *
 * PURE. No fs, no clock, no config. The recorder owns the run id and the store.
 *
 * DATA POLICY: 100% local file; no external transmission.
 *
 * @module lib/observability/activation-observed
 */

import { projectCommandActivation } from '../mission/compiler.js';

/**
 * Every key {@link buildActivationRecord} emits, and the ONLY ones. The
 * recorder copies by this list rather than spreading, so a field added to an
 * upstream result cannot leak to disk by default.
 */
export const ACTIVATION_DATA_KEYS = Object.freeze([
  'observe_only', 'command_activation', 'activation_observed', 'predicted_mode',
  'predicted_signal', 'predicted_nl_match', 'prompt_id', 'idempotency_key',
]);

/**
 * The activation keys a slash command can actually be compared against today.
 * These are the three `projectCommandActivation` derives from `topology.mode`,
 * and each one names a real slash command a user could have typed.
 */
export const MEASURABLE_ACTIVATION_KEYS = Object.freeze(['autopilot', 'autopilot_fast', 'split']);

/**
 * Activation keys with NO runtime producer, documented rather than written.
 *
 * `projectCommandActivation` derives `plan`/`ultraplan` from `input.planning`
 * and `review` from `input.review`, but the live compile site
 * (`lib/runtime/middleware/tasks.js#recordMissionCompile`) passes neither, so
 * nothing in the runtime can set them. Listing them here keeps the gap visible:
 * a reader of the axis must not mistake their absence for "always false".
 */
export const UNMEASURED_ACTIVATION_KEYS = Object.freeze(['plan', 'ultraplan', 'review']);

/**
 * The signal vocabulary, mirroring the `signal` field
 * `topology-router.js#decideMode` attaches to its decision. An ALLOWLIST: the
 * recorder nulls anything outside it rather than writing an unknown token.
 *
 * WHY IT IS RE-DERIVED HERE. `routeTopology` DROPS `signal` from its frozen
 * return (verified 2026-09-17: the return names `mode`, `reason`,
 * `parallelGain`, `exception`, `humanGateHits`, `confidence` and no `signal`),
 * so the only surviving evidence of the signal is the `reason[]` literals.
 * {@link derivePredictedSignal} reconstructs it from those.
 */
export const PREDICTED_SIGNALS = Object.freeze([
  'nl-explicit', 'recommendation', 'runner', 'inference', 'config-default',
]);

/**
 * Wave 13 hint axis: a planner `recommendation` value to the slash command a
 * user would type to accept it.
 *
 * `workflow` is DELIBERATELY ABSENT. There is no `/workflow` command to accept,
 * so Wave 13 must resolve it as `hint_resolved_by: 'unmapped'` with
 * `accepted: false` rather than silently mapping it onto a neighbour. Mapping
 * it would manufacture agreement out of a recommendation nobody could act on.
 * Not consumed in Wave 12 — the slash axis only.
 */
export const HINT_SLASH_MAP = Object.freeze({ split: 'split', autopilot: 'autopilot', watch: 'watch' });

/**
 * Charset a slash command name must satisfy: exactly what
 * `lib/mission/mission-id.js#detectSlashCommand` can return (it lowercases and
 * matches `^([a-z][a-z0-9_-]{0,31})(?=\s|$)`). Re-validated here rather than
 * trusted, because the caller may not have gone through that function.
 */
export const SLASH_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** Charset an `nl-match:` pattern id must satisfy. The privacy filter. */
export const NL_MATCH_ID_RE = /^[a-z0-9-]{1,32}$/;

/** Prefix `decideMode` pushes for a natural-language / flag pattern hit. */
const NL_MATCH_PREFIX = 'nl-match:';

/** Longest prompt id kept. A bound, not a privacy claim — ids are not text. */
export const MAX_PROMPT_ID_LENGTH = 128;

/**
 * Which signal produced `mode`, reconstructed from the router's `reason[]`.
 *
 * Mirrors `topology-router.js#decideMode`, whose own `signal` never survives
 * `routeTopology`. The `nl-match:` test comes FIRST because that branch returns
 * before any other in `decideMode`: a `split` reached by pattern is
 * `nl-explicit`, not `recommendation`, and collapsing the two would make the
 * axis unable to tell "the user said so" from "the planner guessed".
 *
 * @param {unknown} mode - `routeTopology().mode`
 * @param {unknown} reason - `routeTopology().reason`, an array of literals
 * @returns {string|null} a member of {@link PREDICTED_SIGNALS}, or null
 */
export function derivePredictedSignal(mode, reason) {
  const literals = Array.isArray(reason) ? reason : [];
  if (literals.some((r) => typeof r === 'string' && r.startsWith(NL_MATCH_PREFIX))) {
    return 'nl-explicit';
  }
  if (mode === 'split' || mode === 'autopilot') return 'recommendation';
  if (mode === 'team') return 'runner';
  if (mode === 'subagent') return 'inference';
  if (mode === 'solo') return 'config-default';
  return null;
}

/**
 * The first `nl-match:<id>` pattern id in `reason[]`, when it is a plausible id.
 *
 * THE CHARSET IS THE PRIVACY BOUNDARY. `topology-router.js` only ever pushes
 * `pattern.id` values from its two frozen tables (`FAST_PATTERNS`,
 * `SPLIT_PATTERNS`), so a real id is always `[a-z0-9-]`. Anything else — a
 * space, punctuation, length — is not an id this router produces, and is
 * dropped rather than written, so a future change that put matched TEXT after
 * the prefix would record `null` instead of leaking.
 *
 * @param {unknown} reason - `routeTopology().reason`
 * @returns {string|null}
 */
export function extractNlMatch(reason) {
  const literals = Array.isArray(reason) ? reason : [];
  for (const r of literals) {
    if (typeof r !== 'string' || !r.startsWith(NL_MATCH_PREFIX)) continue;
    const id = r.slice(NL_MATCH_PREFIX.length);
    return NL_MATCH_ID_RE.test(id) ? id : null;
  }
  return null;
}

/**
 * Build the `data` payload for one activation observation.
 *
 * `activation_observed` is `{}` — never `{ slash: null }` — when there is no
 * usable slash command. The reader does `typeof observed?.slash === 'string'`,
 * so both spell "no slash" correctly; the empty object is chosen because a
 * literal `null` under a key named `slash` reads, to a human scanning the
 * store, as "a slash command happened and we lost it".
 *
 * NOTE ON `flag-split`. `SPLIT_PATTERNS[0]` is `/(^|\s)\/split\b/`, so a
 * literal `/split …` prompt matches its own flag: the router "predicts" split
 * from the very text that also produces the observed slash, and that pair is
 * agreement by construction rather than evidence. It is recorded anyway —
 * dropping it would bias the denominator — and marked instead: a reader can
 * exclude `predicted_nl_match: 'flag-split'` to get the non-tautological rate.
 *
 * `idempotency_key` is left WITHOUT the run id here on purpose. This function
 * is pure and has no run id; the recorder, which does, prefixes it to the final
 * `activation:<runId>:<promptId>`. The half-formed key never reaches disk.
 *
 * @param {object} [input]
 * @param {object} [input.topology] - a `routeTopology` result
 * @param {string} [input.slashCommand] - a `detectSlashCommand` result
 * @param {string} [input.promptId] - correlation id for this prompt
 * @returns {object} exactly the {@link ACTIVATION_DATA_KEYS} keys
 */
export function buildActivationRecord({ topology, slashCommand, promptId } = {}) {
  const t = topology && typeof topology === 'object' ? topology : {};
  const mode = typeof t.mode === 'string' ? t.mode : null;

  const commandActivation = mode === null
    ? null
    : (projectCommandActivation({ topology: { mode } }) ?? null);

  const observed = {};
  if (typeof slashCommand === 'string' && SLASH_NAME_RE.test(slashCommand)) {
    observed.slash = slashCommand;
  }

  const promptIdOk = typeof promptId === 'string'
    && promptId.length > 0
    && promptId.length <= MAX_PROMPT_ID_LENGTH;

  return {
    observe_only: true,
    command_activation: commandActivation,
    activation_observed: observed,
    predicted_mode: mode,
    predicted_signal: derivePredictedSignal(mode, t.reason),
    predicted_nl_match: extractNlMatch(t.reason),
    prompt_id: promptIdOk ? promptId : null,
    idempotency_key: promptIdOk ? `activation:${promptId}` : null,
  };
}
