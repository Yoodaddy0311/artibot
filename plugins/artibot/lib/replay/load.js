/**
 * Replay's only door to a stored ledger — and it does not open it itself.
 *
 * WHY THE OBVIOUS IMPORT IS NOT HERE
 * ---------------------------------------------------------------------------
 * The natural way to write this file is `import { readAllEvents } from
 * '../runtime/ledger.js'`. That is a LAYER VIOLATION and eslint fails on it.
 *
 *   - `lib/replay/**` is registered at L2 Auxiliary (`eslint.config.js`, the L2
 *     `files[]` list; pinned by `tests/firewall/layer-registration-coverage.
 *     test.js` describe "v5 Phase 0 신규 디렉터리 배치").
 *   - The L2 block forbids `'**\/runtime/**'` — runtime is L5. Upper layers
 *     import lower only (5→4→3→2→1).
 *
 * The design anticipates exactly this call and names the remedy:
 * "상향 호출(L2 → L4 effort-resolver, **L2 → L5 task-budget·ledger**, L2 → L3
 * spawn-ledger)은 전부 **주입 포트**로 받는다" (ARTIBOT-5.0-DESIGN.md §1-8, the
 * numbered item 8 in the design's layer-rule paragraph), and the L2 eslint
 * block states the same ground for these ten directories: "each is a pure
 * module that receives its effects through injected ports, so its dependency
 * ceiling is lib/core. If one later grows an edge into learning/ or cognitive/,
 * the correct move is to move the module, not to re-register the directory."
 *
 * So the reader arrives as a PORT. Dodging the rule with a dynamic `import()`
 * was rejected: it would satisfy the linter while breaking the architecture the
 * linter exists to protect, which is filing down the gate to get past it.
 *
 * WHAT THE CALLER PASSES
 * ---------------------------------------------------------------------------
 * `lib/runtime/ledger.js#readAllEvents`, whose signature is
 * `(projectRoot, filter) => object[]` and which already handles the filesystem,
 * the dedupe, and the torn-tail tolerance. Nothing here duplicates that work;
 * this module exists to make the dependency explicit and to keep the filesystem
 * out of `replay.js` entirely.
 *
 * FAIL-CLOSED
 * ---------------------------------------------------------------------------
 * A missing port THROWS. The tempting alternative — default to an empty array —
 * would make a miswired caller return a perfectly well-formed index describing
 * a run in which nothing happened, and "no events" and "never asked" would
 * become the same output. That is the fail-open shape this repo keeps getting
 * bitten by, so it is refused loudly instead.
 *
 * @module lib/replay/load
 */

import { buildReplay } from './replay.js';

/**
 * Read a project's ledger through an injected reader and build the index.
 *
 * @param {string} projectRoot - absolute project root. Passed straight through
 *   to the port; INJECTED, never derived here. Nothing in this directory reads
 *   the working directory of the running process — deriving a root instead of
 *   receiving one is how a reader ends up indexing the wrong project.
 * @param {{readEvents: (root: string, filter?: object) => object[],
 *          filter?: object, includeEvents?: boolean}} opts
 *   `readEvents` is the required port — pass `lib/runtime/ledger.js#readAllEvents`.
 *   `filter` is forwarded to it verbatim (`since`, `mission_id`, `session_id`,
 *   `event`, `includeRejected`, `ledgerPath`), so this module adds no filtering
 *   vocabulary of its own and cannot drift from the reader's.
 * @returns {object} a `buildReplay` index.
 * @throws {TypeError} when `readEvents` is missing or is not a function.
 */
export function loadReplay(projectRoot, opts = {}) {
  const { readEvents, filter = {}, includeEvents } = opts;
  if (typeof readEvents !== 'function') {
    throw new TypeError(
      'loadReplay requires a `readEvents` port — lib/replay is L2 and cannot '
      + 'import lib/runtime (L5) directly. Pass readAllEvents from '
      + 'lib/runtime/ledger.js.',
    );
  }
  const events = readEvents(projectRoot, filter);
  return buildReplay(Array.isArray(events) ? events : [], { includeEvents });
}
