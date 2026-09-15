/**
 * Outcome-gate census — the Shadow metric for `outcome.md`.
 *
 * ONE QUESTION: "of the missions that declared completion, how many would the
 * artifact gates have stopped, and which gate stopped them?" Design §"Shadow"
 * spells it as `outcome.md 조건을 적용했다면 막혔을 건수 / 완료 선언 총수`. The
 * numerator and the denominator are different events and neither answers the
 * question alone — a count of blocks cannot separate "few missions declared
 * completion" from "most declarations were blocked", which is why the
 * denominator travels with the numerator through every shape here.
 *
 * ── WHY THE CALLER DOES THE JUDGING ────────────────────────────────────────
 * `lib/runtime/artifact-lifecycle.js#plan` decides whether a write is blocked,
 * and it is L5. This module is L2 and importing upward would invert the layer
 * order, so the verdicts arrive as DATA: the hook or CLI runs `plan()` per
 * mission and hands the results here. That also keeps this file pure — no
 * clock, no filesystem, no ledger.
 *
 * ── WHY A BLOCK CODE IS ANY NON-EMPTY STRING ───────────────────────────────
 * `BlockCode` lives in `lib/runtime/artifact-lifecycle-gates.js`, on the other
 * side of the same layer boundary. Copying it here would be a second vocabulary
 * that drifts silently, and a fold that rejected an unlisted code would make a
 * NEW code disappear from the census — the measurement failing exactly when
 * something new started blocking.
 *
 * More than drift, though: NOT EVERY BLOCK IS A GATE. The caller classifies
 * cases that never reach `plan()` at all — a mission whose `plan.md` or
 * `review.md` is ABSENT because the emitter never got there (leader ruling,
 * 2026-09-15: that is every live mission today), versus one PRESENT BUT
 * UNPARSEABLE, which is an emitter defect. Those two are the most interesting
 * rows the census will carry and neither is a `BlockCode`. Refusing them would
 * hide the finding. So any non-empty string is a code here.
 *
 * WHAT THAT COSTS, AND WHO PAYS IT. This fold no longer keeps its output keys
 * inside a closed vocabulary — a code built from a path or a message would
 * become a `by_block_code` key and travel into whatever prints the census.
 * Nothing downstream can undo that, so **the caller must choose from its own
 * fixed list** and never interpolate ledger or filesystem text into a code.
 * `tests/mission/outcome-gate-census.test.js` pins both halves: every landed
 * `BlockCode` member survives the fold, and a code outside the enum is counted
 * rather than rejected.
 *
 * ── WHAT THIS CENSUS CANNOT SEE ────────────────────────────────────────────
 *  - It counts what the caller EVALUATED. A mission nobody planned for is not
 *    in `missions`, and the fold cannot tell that from a mission that does not
 *    exist. The denominator is the caller's reach, not the repository's truth.
 *  - `declared` means a `mission.completed` line exists. Under the landed
 *    emitter that line is an INDUCED judgement written by a hook, not a human
 *    saying the mission is done, and `{accepted: null}` is a trigger rather
 *    than an acceptance.
 *  - `would_write` is a dry-run statement. It says a write was planned, never
 *    that a file exists; under the shipped kill switch none do.
 *  - Nothing here re-runs a gate. A census computed from stale verdicts is
 *    stale, and this file cannot tell.
 *
 * PURITY (design §1-8, L2): no clock, no filesystem, no randomness, no I/O.
 *
 * @module lib/mission/outcome-gate-census
 */

/** The zero census. `blocked_ratio` is `null` here for the reason below. */
export function emptyOutcomeGateCensus() {
  return {
    missions: 0,
    declared: 0,
    blocked: 0,
    would_write: 0,
    by_block_code: {},
    blocked_ratio: null,
  };
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(message) {
  throw new TypeError(`outcome-gate-census: ${message}`);
}

/**
 * Validate one entry. Throws rather than skipping.
 *
 * Every rejection here is a CALLER BUG, not bad data: the caller built this
 * record from its own `plan()` result moments ago, so a missing field means the
 * reader and the writer disagree about the shape. Dropping such a row would
 * shrink a denominator quietly, and a census that silently measures fewer
 * missions than it was given is worse than one that refuses.
 *
 * @param {unknown} raw
 * @param {number} index
 * @param {Set<string>} seen
 * @returns {{missionId: string, declared: boolean, blockCode: string|null, wouldWrite: boolean}}
 */
function readEntry(raw, index, seen) {
  if (!isPlainObject(raw)) fail(`entry ${index} is not an object`);
  const { missionId, declared, blockCode, wouldWrite } = /** @type {any} */ (raw);
  if (typeof missionId !== 'string' || missionId.length === 0) {
    fail(`entry ${index} has no missionId`);
  }
  if (seen.has(missionId)) fail(`mission ${missionId} appears twice — one entry per mission`);
  if (typeof declared !== 'boolean') fail(`mission ${missionId} has a non-boolean declared`);
  if (typeof wouldWrite !== 'boolean') fail(`mission ${missionId} has a non-boolean wouldWrite`);
  if (blockCode !== null) {
    // Any non-empty string. `null` is the only spelling of "not blocked", so an
    // empty string would be a third state nobody can read.
    if (typeof blockCode !== 'string' || blockCode.length === 0) {
      fail(`mission ${missionId} has a blockCode that is not a non-empty string`);
    }
    // `plan()` cannot both block a write and plan it; one of the two is wrong.
    if (wouldWrite) fail(`mission ${missionId} is blocked and would write at the same time`);
  }
  if (!declared && (blockCode !== null || wouldWrite)) {
    // No `mission.completed` line means `plan()` had no outcome candidate to
    // judge, so a verdict on one is a contradiction, not an extra fact.
    fail(`mission ${missionId} carries an outcome verdict but declared nothing`);
  }
  return { missionId, declared, blockCode, wouldWrite };
}

/**
 * Fold per-mission gate verdicts into the Shadow census. Pure.
 *
 * `blocked_ratio` is `null` — never `0` — when `declared` is 0. A zero reads as
 * "nothing was blocked", which is a measurement; `null` reads as "nothing was
 * measured", which is the truth when nobody declared completion. Same rule as
 * `lib/replay/session-coverage.js:218`, whose header explains why a measuring
 * tool must not report an absent observation as a value.
 *
 * `by_block_code` carries only codes actually seen, with SORTED keys, so two
 * runs with the same counts serialize to the same bytes and a diff of two
 * censuses is a diff of the numbers.
 *
 * @param {Array<{missionId: string, declared: boolean, blockCode: string|null,
 *   wouldWrite: boolean}>} entries One per mission the caller evaluated.
 *   `declared` = a `mission.completed` line exists for that mission;
 *   `blockCode` = why this mission produced no `outcome.md` — the `BlockCode`
 *   from `plan()` (`writes[i].blocked`, set by
 *   `artifact-lifecycle.js#planOneWrite` only when a gate fired) OR one of the
 *   caller's own codes for a mission that never reached `plan()`. Any non-empty
 *   string; `null` when the write would proceed OR when `plan()` planned no
 *   outcome write at all. `wouldWrite` = that write was planned and unblocked.
 * @returns {{missions: number, declared: number, blocked: number,
 *   would_write: number, by_block_code: Record<string, number>,
 *   blocked_ratio: number|null}}
 * @throws {TypeError} On any malformed entry — nothing partial is returned.
 */
export function foldOutcomeGateCensus(entries) {
  if (!Array.isArray(entries)) fail('entries must be an array');

  const seen = new Set();
  const counts = new Map();
  const census = emptyOutcomeGateCensus();

  for (const [index, raw] of entries.entries()) {
    const entry = readEntry(raw, index, seen);
    seen.add(entry.missionId);
    census.missions += 1;
    if (!entry.declared) continue;
    census.declared += 1;
    if (entry.wouldWrite) census.would_write += 1;
    if (entry.blockCode !== null) {
      census.blocked += 1;
      counts.set(entry.blockCode, (counts.get(entry.blockCode) ?? 0) + 1);
    }
  }

  for (const code of [...counts.keys()].sort()) census.by_block_code[code] = counts.get(code);
  census.blocked_ratio = census.declared === 0 ? null : census.blocked / census.declared;
  return census;
}
