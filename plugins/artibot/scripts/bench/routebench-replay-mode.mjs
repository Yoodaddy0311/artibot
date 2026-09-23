/**
 * RouteBench replay-mode surface - the scenario's DECLARED `replay_mode` per
 * row, and one `replay_label` block per results envelope.
 *
 * TWO VOCABULARIES, ONE PINNED MAPPING
 *
 * The producer, `lib/replay/replay-label.js#labelReplay`, grades Actions with
 * `REPLAY_LABELS` = EXACT / PARTIAL / SIMULATED (upper case). The scenario
 * schema, `tests/evals/fixtures/routebench/scenarios.schema.json`
 * (`properties.replay_mode.enum`), spells the same three ideas in lower case
 * and with a different third word: exact / partial / simulation. Until this
 * file the mapping existed only as prose in the producer's header.
 * {@link REPLAY_MODE_BY_LABEL} is that mapping as data, and
 * `tests/evals/routebench-replay-mode.test.js` reads BOTH real sources - the
 * producer export and the schema enum - so drift on either side is a red test,
 * not a silently unmapped label.
 *
 * DECLARED, NOT MEASURED - AND WHY MEASURED IS NULL
 *
 * A row's `replay_mode` is what the scenario AUTHOR declared. Nothing here
 * observed it. The envelope block therefore counts DECLARATIONS (unit:
 * scenario) and carries `measured: null` with a named reason, never a
 * distribution computed from something else:
 *
 *   `labelReplay` counts an Action only for a `route.selected` line with a
 *   non-empty `routing_epoch_id` (`route-bind.js#isPreToolUseReceipt`), and
 *   binds it through `data.tool_use_id`. The runner's scrub gate
 *   (`routebench.mjs#FORBIDDEN_CORPUS_KEYS`) REFUSES any corpus carrying
 *   either key, at any depth, as `fixture-invalid`. So every corpus the runner
 *   admits yields zero Actions - a structural null, like the producer's EXACT,
 *   not an empty measurement. The shipped corpora are `routebench-corpus/v1`
 *   rows with no `event` key at all (the extractor's scrub renames the epoch
 *   to an 8-hex `epoch` hash). The test pins both halves.
 *
 * A scenario that declares `exact` (the shipped `seeded-defect-seven-axis-
 * review` does) can never be MEASURED exact by the producer - one Action is
 * one run (`EXACT_UNREACHABLE_REASON`). The block lists those scenario ids
 * rather than letting the declaration read as attainable.
 *
 * WHAT THIS FILE CANNOT SEE
 *
 *   1. Whether a declaration is TRUE. `simulation` on a live scenario is the
 *      author's reading of its corpus (no outcome rows); nothing re-derives it.
 *   2. A value outside the schema enum is counted `unrecognized` and carried
 *      as null on the row. The runner does not validate scenarios against the
 *      schema, so this is the only place such a value becomes visible.
 *
 * PURE: no filesystem, clock, randomness or network. Imports the producer
 * module only.
 *
 * @module scripts/bench/routebench-replay-mode
 */

import { EXACT_UNREACHABLE_REASON, labelReplay } from '../../lib/replay/replay-label.js';

/**
 * Producer label -> scenario-schema `replay_mode`. Key order is REPLAY_LABELS
 * order. The third entry is the one a case-fold would get wrong.
 */
export const REPLAY_MODE_BY_LABEL = Object.freeze({
  EXACT: 'exact',
  PARTIAL: 'partial',
  SIMULATED: 'simulation',
});

/** The declared vocabulary, derived from the mapping so there is one list. */
export const REPLAY_MODES = Object.freeze(Object.values(REPLAY_MODE_BY_LABEL));

/** Why `replay_label.measured` is null for every corpus the runner admits. */
export const MEASURED_UNAVAILABLE_REASON = 'scrubbed-corpus-has-no-join-keys';

/**
 * Where the labels come from, as a reader would grep for it. Recorded so a
 * results file names its producer instead of implying the runner graded rows.
 */
const PRODUCER = 'lib/replay/replay-label.js#labelReplay';

/**
 * The producer's own reachability answer, read from the producer rather than
 * copied: an empty slice still reports `exact_reachable`, and the fold is pure.
 * The day EXACT opens, the producer's header says EXACT_UNREACHABLE_REASON is
 * deleted - the import above then fails loudly, which is the intended prompt
 * to revisit `exact_unreachable_scenarios` here.
 */
const PRODUCER_EXACT_REACHABLE = labelReplay([]).exact_reachable;

/**
 * Byte-order comparison (not localeCompare - see routebench.mjs), with null
 * sorting after every string so unnamed entries collect at the end.
 * @param {string|null} a @param {string|null} b @returns {number}
 */
function compareIds(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/**
 * The replay_mode a row carries: the scenario's declared value when it is in
 * the schema vocabulary, otherwise null. Null is "not declared or not
 * recognized", never a guess - a missing declaration is not `simulation`.
 *
 * @param {unknown} scenario - one parsed scenarios.jsonl line
 * @returns {string|null}
 */
export function replayModeOf(scenario) {
  const declared = scenario && typeof scenario === 'object' ? scenario.replay_mode : undefined;
  return REPLAY_MODES.includes(declared) ? declared : null;
}

/**
 * Count declarations by mode. A scenario without the key is `undeclared`; one
 * whose value is outside the enum (null, 'SIMULATED', 'simulated', ...) is
 * `unrecognized`. `scenarios` always equals the sum of the three.
 *
 * `exact_unreachable_scenarios` has one entry per `exact` declaration, so its
 * length always equals `by_mode.exact`. An entry is the scenario's id, or null
 * when the id is not a non-empty string - never `String(id)`, which would print
 * a missing id as the scenario name "undefined".
 *
 * @param {unknown[]} list
 * @returns {object} the `declared` sub-block
 */
function declaredCounts(list) {
  const byMode = Object.fromEntries(REPLAY_MODES.map((mode) => [mode, 0]));
  let undeclared = 0;
  let unrecognized = 0;
  const exactUnreachable = [];
  for (const scenario of list) {
    const isObject = scenario !== null && typeof scenario === 'object';
    if (!isObject || !Object.hasOwn(scenario, 'replay_mode')) { undeclared += 1; continue; }
    const mode = replayModeOf(scenario);
    if (mode === null) { unrecognized += 1; continue; }
    byMode[mode] += 1;
    if (mode === REPLAY_MODE_BY_LABEL.EXACT) {
      const named = typeof scenario.id === 'string' && scenario.id !== '';
      exactUnreachable.push(named ? scenario.id : null);
    }
  }
  return {
    unit: 'scenario',
    scenarios: list.length,
    by_mode: byMode,
    undeclared,
    unrecognized,
    exact_unreachable_scenarios: exactUnreachable.sort(compareIds),
  };
}

/**
 * The envelope's `replay_label` block. Pure: same scenarios, same bytes. Key
 * order is fixed; `tests/evals/routebench-replay-mode.test.js` pins it.
 *
 * @param {unknown[]} scenarios - the parsed scenarios file, in file order
 * @returns {object}
 */
export function replayLabelBlock(scenarios) {
  const list = Array.isArray(scenarios) ? scenarios : [];
  return {
    producer: PRODUCER,
    mapping: { ...REPLAY_MODE_BY_LABEL },
    exact_reachable: PRODUCER_EXACT_REACHABLE,
    exact_unreachable_reason: EXACT_UNREACHABLE_REASON,
    declared: declaredCounts(list),
    measured: null,
    measured_reason: MEASURED_UNAVAILABLE_REASON,
  };
}
