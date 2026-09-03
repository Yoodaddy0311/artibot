/**
 * `split-state-sources.js` — the three source normalizers behind
 * `split-state.js`, plus the conversion tables they read (PRD T-46).
 *
 * Split out of `split-state.js` at 826 lines (leader ruling 2026-09-02) along
 * the seam the module already had: reading a source and turning its vocabulary
 * into v1.1 records is a separate job from merging those records, writing one
 * back, and appending to the ledger. Nothing about the contract changed in the
 * move; every function here was already private to that file and is exported
 * now only because a module boundary sits between them.
 *
 * Each normalizer answers the same question about one source and returns the
 * same {@link RawWorker} shape, so the merge in `readWorkerState` never has to
 * know which source it is looking at. Three rules hold across all three:
 *
 *  - an unrecognised word becomes `status: null` — unknown, never a guess;
 *  - the source's own word survives in `extra` (`ops_state`, `lane_state`), so
 *    a conversion that collapses two words does not destroy the finer one;
 *  - every other key of the source record is preserved verbatim, because live
 *    files carry free-form keys no schema here knows about.
 *
 * WHAT THIS MODULE DOES NOT DO: it does not read files, decide priority
 * between sources, judge conflicts, or write anything. It converts whatever
 * object it is handed. `split-state.js` owns all four of those.
 *
 * @module lib/topology/split-state-sources
 */

import {
  isLaneOpsState,
  isV11Status,
  LANE_OPS_STATES,
  LANE_OPS_TO_V11_STATUS,
  V11_STATUS_TO_LANE_STATE,
} from '../supervisor/contracts.js';

/**
 * lane state -> v1.1 status. Derived here from the ONE authored table
 * `V11_STATUS_TO_LANE_STATE`, because `contracts.js` keeps its own inverse
 * module-private and that file belongs to another task (T-45): copying the
 * rows out would create a second authored table to drift, deriving them
 * cannot. Four of the twelve lane states have no v1.1 word and are simply
 * absent here, so a lookup yields `undefined` -> `null` (fail-closed).
 */
export const LANE_STATE_TO_V11 = Object.freeze(Object.fromEntries(
  Object.entries(V11_STATUS_TO_LANE_STATE).map(([v11, lane]) => [lane, v11]),
));

/**
 * v1.1 status -> the ops words that project onto it. Derived by inverting
 * `LANE_OPS_TO_V11_STATUS` (itself derived), so it stays in step with the ops
 * allowlist automatically. Non-injective in two places, resolved explicitly by
 * `split-state.js#opsWordFor`; `cancelled` has NO ops word at all and is
 * absent here, which is why a write of `cancelled` is refused, not guessed.
 */
export const V11_TO_OPS_WORDS = Object.freeze(LANE_OPS_STATES.reduce((acc, ops) => {
  const v11 = LANE_OPS_TO_V11_STATUS[ops];
  if (v11) acc[v11] = Object.freeze([...(acc[v11] ?? []), ops]);
  return acc;
}, /** @type {Record<string, ReadonlyArray<string>>} */ ({})));

/**
 * `blocked_by` reason a bare ops word implies, when the record carries no
 * explicit list. `serial-gate` names itself as the gate: the ops word records
 * THAT the lane is gated but never WHICH lane or gate, and inventing a target
 * would be a fabricated fact. `suspended` is unambiguous (lane-5 §2-D).
 */
export const OPS_IMPLIED_BLOCKED_BY = Object.freeze({
  'suspended': Object.freeze(['human:suspend']),
  'serial-gate': Object.freeze(['gate:serial-gate']),
});

/** @param {unknown} v @returns {boolean} */
export function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** @param {unknown} v @returns {string[]} non-empty strings only */
export function stringList(v) {
  return Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.length > 0) : [];
}

/**
 * `plan.json.limbs[].affectedPaths` -> `owns[]`. A direct projection with no
 * loss (lane-5 §2-D); `scripts/split/land.mjs` already judges ownership from
 * this same key, so no new ownership logic is introduced here.
 *
 * @param {object|null} planJson
 * @returns {Record<string, string[]>}
 */
export function ownsFromPlan(planJson) {
  const limbs = Array.isArray(planJson?.limbs) ? planJson.limbs : [];
  /** @type {Record<string, string[]>} */ const out = {};
  for (const limb of limbs) {
    const name = typeof limb?.limb === 'string' ? limb.limb : null;
    if (!name) continue;
    out[name] = stringList(limb.affectedPaths);
  }
  return out;
}

/**
 * @typedef {object} RawWorker
 * @property {string|null} status
 * @property {string[]} owns
 * @property {string[]} blockedBy
 * @property {string|null} heartbeatAt - the lane-heartbeat component only; git commits enter via the `commitReader` port
 * @property {string|null} heartbeatSource
 * @property {Record<string, unknown>} extra - every other key of the source record, preserved verbatim
 */

/**
 * StateStore / `state.yaml` shape. Accepts either `{ workers: {...} }` or the
 * worker map itself, because the store does not exist yet and pinning one of
 * the two shapes would be guessing at an interface nobody has written.
 *
 * @param {unknown} raw
 * @returns {Record<string, RawWorker>}
 */
export function normalizeStore(raw) {
  if (!isPlainObject(raw)) return {};
  const map = isPlainObject(raw.workers) ? raw.workers : raw;
  /** @type {Record<string, RawWorker>} */ const out = {};
  for (const [name, rec] of Object.entries(map)) {
    if (!isPlainObject(rec)) continue;
    const { status, owns, blocked_by: blockedBy, heartbeat_at: hbAt, heartbeat_source: hbSrc, ...extra } = rec;
    out[name] = {
      status: isV11Status(status) ? status : null,
      owns: stringList(owns),
      blockedBy: stringList(blockedBy),
      heartbeatAt: typeof hbAt === 'string' ? hbAt : null,
      heartbeatSource: typeof hbSrc === 'string' ? hbSrc : null,
      extra,
    };
  }
  return out;
}

/**
 * `run.json.lanes[limb]` -> v1.1. Accepts both live shapes the writer
 * documents: a bare state string, or `{ state, since, window, note }`. The ops
 * word is kept as `ops_state` so the two words the ops vocabulary loses on
 * conversion (`closing`, `suspended`) survive in the record even though
 * `status` collapses them.
 *
 * @param {object|null} runJson
 * @returns {Record<string, RawWorker>}
 */
export function normalizeRunJson(runJson) {
  const lanes = isPlainObject(runJson?.lanes) ? runJson.lanes : null;
  if (!lanes) return {};
  /** @type {Record<string, RawWorker>} */ const out = {};
  for (const [name, entry] of Object.entries(lanes)) {
    /** @type {unknown} */ let ops;
    /** @type {Record<string, unknown>} */ let extra = {};
    /** @type {string[]} */ let blockedBy = [];
    if (typeof entry === 'string') {
      ops = entry;
    } else if (isPlainObject(entry)) {
      const { state, blocked_by: bb, ...restKeys } = entry;
      ops = state;
      extra = restKeys;
      // An explicit list wins over the word's implication: a writer that
      // recorded WHY beats a reader re-deriving a weaker reason.
      blockedBy = stringList(bb);
    } else {
      continue;
    }
    const opsWord = isLaneOpsState(ops) ? ops : null;
    if (opsWord) extra = { ...extra, ops_state: opsWord };
    if (blockedBy.length === 0 && opsWord && OPS_IMPLIED_BLOCKED_BY[opsWord]) {
      blockedBy = [...OPS_IMPLIED_BLOCKED_BY[opsWord]];
    }
    out[name] = {
      status: opsWord ? (LANE_OPS_TO_V11_STATUS[opsWord] ?? null) : null,
      owns: [],
      blockedBy,
      // run.json structurally has no heartbeat: `since` is the state-change
      // time, not a liveness signal (lane-5 §2-D "heartbeat 대응").
      heartbeatAt: null,
      heartbeatSource: null,
      extra,
    };
  }
  return out;
}

/**
 * Reducer output (`run-store.js#readState` / `#rebuildState`) -> v1.1. Accepts
 * `{ lanes: {...} }` or the lane map itself. The 12-word lane vocabulary is
 * finer than v1.1's: `CLAIMED`, `CHECKPOINTING`, `FIXING` and `FAILED_TERMINAL`
 * have no v1.1 word and yield `status: null` while the raw word survives as
 * `lane_state`.
 *
 * @param {unknown} raw
 * @returns {Record<string, RawWorker>}
 */
export function normalizeEvents(raw) {
  if (!isPlainObject(raw)) return {};
  const map = isPlainObject(raw.lanes) ? raw.lanes : raw;
  /** @type {Record<string, RawWorker>} */ const out = {};
  for (const [name, lane] of Object.entries(map)) {
    if (!isPlainObject(lane)) continue;
    const { state, ownedPaths, lastHeartbeatAt, ...extra } = lane;
    const laneWord = typeof state === 'string' ? state : null;
    out[name] = {
      status: laneWord ? (LANE_STATE_TO_V11[laneWord] ?? null) : null,
      owns: stringList(ownedPaths),
      blockedBy: [],
      heartbeatAt: typeof lastHeartbeatAt === 'string' ? lastHeartbeatAt : null,
      heartbeatSource: typeof lastHeartbeatAt === 'string' ? 'lane-heartbeat' : null,
      extra: laneWord ? { ...extra, lane_state: laneWord } : extra,
    };
  }
  return out;
}
