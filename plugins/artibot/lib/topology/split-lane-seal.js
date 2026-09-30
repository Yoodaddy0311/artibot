/**
 * `split-lane-seal.js` — the clock-free marker behind the SH-11 stale guard
 * (pre-flip condition 4).
 *
 * ── The problem it closes ───────────────────────────────────────────────────
 * Turning the `split.missionBinding.enabled` key OFF is safe; turning it back
 * ON is not free. While it is off the legacy path writes `run.json.lanes[limb]`
 * and never the Task Graph node, so after off -> on the node's `ops` can be
 * BEHIND the lane. A bound write builds its previous state, its `since` and its
 * ledger key from the node, so `split-state.js#staleLaneDetail` refuses to build
 * on a node the lane has moved past. It used to decide that by comparing
 * `updated_at` stamps — which inherits the clock's two blind spots: a legacy
 * write made with a clock BEHIND the node's reads as older than the node, and a
 * lane edited by hand without touching `updated_at` reads as untouched.
 *
 * ── The seal ────────────────────────────────────────────────────────────────
 * A bound write SEALS the lane it projects: `projection_seal` is the five facts
 * the projection gave the lane (state, since, window, note, blocked_by). The
 * legacy path rewrites a lane by spreading the entry it finds, so the seal rides
 * through it UNTOUCHED while the facts do not. Drift is then a comparison of two
 * values the lane holds — what it says now against what the store last said into
 * it — and reads no clock.
 *
 * What the comparison means, stated so a caller does not over-read it:
 *  - Drift says "something other than the store's projection wrote this lane
 *    after the store last did". It does not say who, and it does not say the
 *    lane is wrong — only that `node.ops` may be behind it.
 *  - No drift is not "the lane is current". A legacy write that leaves all five
 *    facts as they were (a re-assert of the same word) is invisible here; the
 *    timestamp clauses in `split-state.js` still judge that case.
 *  - A lane the projection never reached carries no seal, and so is judged by
 *    those timestamp clauses alone. A seal that is not an object holding all
 *    five keys is no seal: a damaged marker must read as absent, not as drift,
 *    or one bad byte would brick every bound write of its limb.
 *  - The seal lives in `run.json`, a free-form file. It is not in the Task Graph
 *    node: `schemas/task-graph.schema.json` closes `task.ops`, and this marker is
 *    a fact about the PROJECTION, which is `run.json`'s side of the pair.
 *
 * The legacy (OFF) path never writes a seal and never changes one: a run that
 * has never been bound carries no `projection_seal` key anywhere.
 *
 * @module lib/topology/split-lane-seal
 */

import { isPlainObject, stringList } from './split-state-sources.js';

/** The `run.json.lanes[limb]` key that carries the seal. */
export const LANE_SEAL_KEY = 'projection_seal';

/** The facts a seal holds, in the order they are reported. */
export const LANE_SEAL_FACTS = Object.freeze(['state', 'since', 'window', 'note', 'blocked_by']);

/** @param {unknown} v @returns {string|null} the string, or `null` for anything else (empty included) */
const textOrNull = (v) => (typeof v === 'string' && v !== '' ? v : null);

/**
 * The five facts a lane entry says, normalised so an absent value, an empty
 * string and an empty list are all the same `null` — the projection omits what
 * the node does not have, and a comparison must not call that drift.
 *
 * @param {unknown} entry - A `run.json.lanes[limb]` object (anything else yields all-null facts)
 * @returns {{ state: string|null, since: string|null, window: string|null, note: string|null, blocked_by: string[]|null }}
 */
export function laneFacts(entry) {
  const e = isPlainObject(entry) ? /** @type {Record<string, unknown>} */ (entry) : {};
  const blocked = stringList(e.blocked_by);
  return {
    state: textOrNull(e.state),
    since: textOrNull(e.since),
    window: textOrNull(e.window),
    note: textOrNull(e.note),
    blocked_by: blocked.length > 0 ? [...blocked] : null,
  };
}

/**
 * The seal a lane entry carries, as facts — or `null` when it carries none. A
 * value that is not an object holding all five keys is treated as absent.
 *
 * @param {unknown} laneRaw - `run.json.lanes[limb]` as stored
 * @returns {ReturnType<typeof laneFacts>|null}
 */
export function readLaneSeal(laneRaw) {
  const raw = isPlainObject(laneRaw) ? /** @type {Record<string, unknown>} */ (laneRaw)[LANE_SEAL_KEY] : undefined;
  if (!isPlainObject(raw) || !LANE_SEAL_FACTS.every((k) => Object.hasOwn(/** @type {object} */ (raw), k))) return null;
  return laneFacts(raw);
}

/**
 * What the lane says now that differs from what the store last projected into it.
 *
 * @param {unknown} laneRaw - `run.json.lanes[limb]` as stored
 * @returns {Array<{ fact: string, sealed: unknown, now: unknown }>|null} `null` when the lane carries no
 *   (valid) seal — nothing to compare — and `[]` when it is unchanged since its projection
 */
export function laneSealDrift(laneRaw) {
  const sealed = readLaneSeal(laneRaw);
  if (sealed === null) return null;
  const now = laneFacts(laneRaw);
  return LANE_SEAL_FACTS
    .filter((fact) => JSON.stringify(sealed[fact]) !== JSON.stringify(now[fact]))
    .map((fact) => ({ fact, sealed: sealed[fact], now: now[fact] }));
}
