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
 * ── SH-11: the pure core of the run-to-mission binding ──────────────────────
 * The same rule holds for what was added when the StateStore became the
 * canonical source of a BOUND run: {@link parseMissionBinding} (the binding
 * record `plan.json` carries), {@link normalizeTaskGraph} (a fourth normalizer,
 * reading the Task Graph NODES — see its note on why the state.yaml worker rows
 * cannot be used), {@link planBoundNode} (the node a write produces),
 * {@link attachRunOps} (the one-time backfill) and the B1/B2 guards. Every one
 * of them is a function of its arguments: files, the store and the ledger stay
 * in `split-state.js` and the `scripts/split/` callers.
 *
 * @module lib/topology/split-state-sources
 */

import { BLOCKER_PATTERN, MISSION_ID_PATTERN, OWNED_TASK_STATUSES } from '../project-state/validate.js';
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
 * worker map itself. The store EXISTS
 * (`lib/project-state/state-manager.js#createStateStore`); both shapes stay
 * accepted because neither is the store's own output. `getProjection()`
 * returns `{project, state_version, updated_at, active_missions}` and nests
 * the worker map two levels down under a mission, so a reader must unwrap it
 * and may hand over the bare map or re-wrap it — verified against the real
 * projection in `tests/topology/split-state-sources.test.js`, which also pins
 * that handing over the WHOLE projection object yields a spurious
 * `active_missions` row rather than an error.
 *
 * The cost of accepting two shapes, stated rather than hidden: in the bare-map
 * shape a worker literally named `workers` whose record is an object is read
 * as the wrapper and swallows the map. Not reachable from the real projection
 * today, and pinned in that test file.
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

/* ═══════════════ SH-11 — run-to-mission binding, ops key, canonical nodes ═══════════════ */

/** The `plan.json` key that carries the binding record. The plan, not `run.json`, because a plan is write-once per run and the binding is a fact about the RUN, not about one moment of it. */
export const MISSION_BINDING_KEY = 'missionBinding';

/**
 * The binding record's closed key set — an ALLOWLIST: a key outside it makes
 * the record invalid rather than being carried along, so a future field has to
 * change this list and its readers together.
 *
 *  - `mission_id`        the mission whose Task Graph is this run's canonical "now"
 *  - `run_id`            the run it binds (must equal `plan.runId`)
 *  - `generation`        integer >= 1; only a handoff raises it (invariant I4)
 *  - `bound_at`          ISO instant of the bind
 *  - `bound_by_session`  the session that wrote it — an audit fact, NEVER a key
 */
export const MISSION_BINDING_KEYS = Object.freeze(['mission_id', 'run_id', 'generation', 'bound_at', 'bound_by_session']);

const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Whether `v` is a full ISO-8601 instant. Looser strings (`2026-09-29`,
 * `2026-09-29 05:00:00`) are refused: `since` and `bound_at` are compared and
 * echoed into idempotency keys, so their spelling has to be one spelling.
 *
 * @param {unknown} v
 * @returns {boolean}
 */
export function isIsoInstant(v) {
  return typeof v === 'string' && ISO_INSTANT_RE.test(v) && Number.isFinite(Date.parse(v));
}

/** @param {unknown} v @returns {boolean} */
const isNonEmptyString = (v) => typeof v === 'string' && v !== '';

const BINDING_FIELD_CHECKS = Object.freeze({
  mission_id: (v) => typeof v === 'string' && MISSION_ID_PATTERN.test(v),
  run_id: isNonEmptyString,
  generation: (v) => Number.isInteger(v) && v >= 1,
  bound_at: isIsoInstant,
  bound_by_session: isNonEmptyString,
});

/**
 * Validate a `plan.json` `missionBinding` record. Pure, total, fail-closed:
 * the reason names the FIRST thing wrong, and an unknown key is a reason too.
 *
 * It checks the record in isolation. Whether `run_id` equals the plan's own
 * `runId`, and whether the mission still exists, are facts about OTHER files
 * and the store, judged by `split-state.js`.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, binding: Readonly<{ mission_id: string, run_id: string, generation: number, bound_at: string, bound_by_session: string }> } | { ok: false, reason: string }}
 */
export function parseMissionBinding(raw) {
  if (!isPlainObject(raw)) return { ok: false, reason: 'binding-invalid:not-an-object' };
  const unknown = Object.keys(raw).find((k) => !MISSION_BINDING_KEYS.includes(k));
  if (unknown !== undefined) return { ok: false, reason: `binding-invalid:unknown-key:${unknown}` };
  for (const key of MISSION_BINDING_KEYS) {
    if (!BINDING_FIELD_CHECKS[key](raw[key])) return { ok: false, reason: `binding-invalid:${key}` };
  }
  return {
    ok: true,
    binding: Object.freeze({
      mission_id: raw.mission_id,
      run_id: raw.run_id,
      generation: raw.generation,
      bound_at: raw.bound_at,
      bound_by_session: raw.bound_by_session,
    }),
  };
}

/**
 * The environment carrier the design canon names (`ARTIBOT_MISSION_ID`, with
 * the split run id as its alias), DERIVED from the binding. The direction is
 * one-way on purpose: there is no function that builds a binding from the
 * environment, because an env var is per-process and a binding must outlive
 * the process that wrote it.
 *
 * @param {unknown} binding - a `parseMissionBinding` input
 * @returns {Record<string, string>} `{}` for anything that is not a valid binding
 */
export function missionEnvFromBinding(binding) {
  const parsed = parseMissionBinding(binding);
  return parsed.ok ? { ARTIBOT_MISSION_ID: parsed.binding.mission_id } : {};
}

/**
 * Ops states whose write stamps `heartbeat_at` on the node. The same four
 * words `scripts/split/lane-lease.mjs#LANE_LEASE_ACTIONS` classifies as
 * `heartbeat` (the lane is being worked); a bound write folds that stamp into
 * its own single store commit instead of paying a second one. A drift test in
 * `tests/scripts/lane-lease.test.js` pins the two lists together.
 */
export const HEARTBEAT_OPS_STATES = Object.freeze(['active', 'review', 'serial-gate', 'closing']);

/* ─────────────────── the canary switch: split.missionBinding.enabled ───────────────────
 *
 * Binding a run and making the store the canonical lane state is a BEHAVIOUR
 * change (design canon: the adapter is a Shadow item, "#22 split integration" a
 * Canary item — "config 1키 되돌림"), so it ships behind one key, OFF. The key
 * gates two things: whether `dispatch` may WRITE a binding, and whether a
 * binding that is ALREADY on disk is HONOURED — with the key off, a bound run
 * is written and read exactly as an unbound one.
 *
 * `lib/topology` is L4 and never reads config. The callers do, and hand the
 * answer in as a PORT: `honorBinding`, `true` or a function returning `true`.
 * The port is FAIL-CLOSED — absent, `'true'`, `1` and a port that throws all
 * mean "off" — so a caller that forgets it gets the legacy behaviour, never a
 * silent store write.
 */

/**
 * Config path of the SH-11 switch. Read by the CALLERS (`scripts/split/*`);
 * exported so the firewall pin and the readers share one spelling.
 * @type {string}
 */
export const MISSION_BINDING_ENABLED_CONFIG_PATH = 'split.missionBinding.enabled';

/**
 * Resolve the switch from an already-read config object.
 *
 * @param {unknown} cfg - Parsed `artibot.config.json`, or anything at all.
 * @returns {boolean} `true` only for the literal `true` at
 *   {@link MISSION_BINDING_ENABLED_CONFIG_PATH}. `'true'`, `1`, an absent key
 *   and a non-object config all read OFF, so a value that failed to parse
 *   cannot switch the feature on.
 */
export function readMissionBindingEnabled(cfg) {
  return MISSION_BINDING_ENABLED_CONFIG_PATH
    .split('.')
    .reduce((node, key) => /** @type {any} */ (node)?.[key], cfg) === true;
}

/**
 * Whether a caller's `honorBinding` port says a binding is to be honoured.
 * A function is called (once) and must return the literal `true`; a throw is
 * "off".
 *
 * @param {unknown} port
 * @returns {boolean}
 */
export function honorsBinding(port) {
  if (typeof port === 'function') {
    try {
      return port() === true;
    } catch {
      return false;
    }
  }
  return port === true;
}

/**
 * The result annotation for a run that carries a binding while the switch is
 * off: "there is a record, and it was not consulted". Frozen, shared.
 */
export const BINDING_DISABLED = Object.freeze({ status: 'disabled' });

/**
 * One `run.json.lanes[limb]` entry, in either live shape (a bare word, or the
 * `{state, since, window, note, blocked_by}` object). Everything that cannot be
 * vouched for is `null` / `[]` — an unknown ops word is not a state, an
 * unparseable `since` is not an instant.
 *
 * @param {unknown} raw
 * @returns {{ state: string|null, since: string|null, window: string|null, note: string|null, blockedBy: string[] }}
 */
export function readLaneEntry(raw) {
  const none = { state: null, since: null, window: null, note: null, blockedBy: [] };
  if (typeof raw === 'string') return { ...none, state: isLaneOpsState(raw) ? raw : null };
  if (!isPlainObject(raw)) return none;
  return {
    state: isLaneOpsState(raw.state) ? raw.state : null,
    since: isIsoInstant(raw.since) ? raw.since : null,
    window: isNonEmptyString(raw.window) ? raw.window : null,
    note: isNonEmptyString(raw.note) ? raw.note : null,
    blockedBy: stringList(raw.blocked_by),
  };
}

/**
 * B1 — the two words on one node must say the same thing. `ops.state` projects
 * to a v1.1 status through `LANE_OPS_TO_V11_STATUS`, and that status must be
 * the node's own. Throws, so a caller cannot write a node that disagrees with
 * itself; a node with no `ops` has nothing to disagree with.
 *
 * WHAT THIS DOES NOT SEE: it judges one node. A store where two missions hold
 * the same limb in different states is not a B1 question (see the `conflicts`
 * `readWorkerState` reports).
 *
 * @param {{ id?: unknown, status?: unknown, ops?: unknown }} task
 * @returns {void}
 */
export function assertOpsStatusAgree(task) {
  const ops = task?.ops;
  if (!isPlainObject(ops)) return;
  const label = typeof task.id === 'string' ? task.id : '(no id)';
  if (!isLaneOpsState(ops.state)) {
    throw new Error(`split-state: task '${label}' ops.state ${JSON.stringify(ops.state)} is not in the ops allowlist (${LANE_OPS_STATES.join(' | ')})`);
  }
  const expected = LANE_OPS_TO_V11_STATUS[ops.state];
  if (task.status !== expected) {
    throw new Error(`split-state: task '${label}' ops.state '${ops.state}' projects to status '${expected}' but the node says '${String(task.status)}'`);
  }
}

/**
 * B2 — what a node's blockers must look like for the state it is in. A blocked
 * node needs at least one reason, a suspended one needs a `human:` reason (that
 * is what the word means), every reason matches the store's own allowlist
 * (`validate.js#BLOCKER_PATTERN`), and a node that is not blocked carries none.
 * The pattern check is here because the store's refusal of a free-form reason
 * is an opaque `blockers[0]` error one commit too late.
 *
 * @param {{ state: string, status: string, blockers: ReadonlyArray<unknown> }} p
 * @returns {void}
 */
export function assertBlockersForState({ state, status, blockers }) {
  const list = Array.isArray(blockers) ? blockers : [];
  const bad = list.find((b) => typeof b !== 'string' || !BLOCKER_PATTERN.test(b));
  if (bad !== undefined) {
    throw new Error(`split-state: blocker ${JSON.stringify(bad)} must match lane|gate|human|reconcile:<reason>`);
  }
  if (status !== 'blocked') {
    if (list.length > 0) throw new Error(`split-state: blockers are only allowed on a blocked node (state '${state}' projects to '${status}')`);
    return;
  }
  if (list.length === 0) throw new Error(`split-state: a blocked node (state '${state}') needs at least one blocker`);
  if (state === 'suspended' && !list.some((b) => b.startsWith('human:'))) {
    throw new Error(`split-state: a suspended node needs a human: reason, got ${JSON.stringify(list)}`);
  }
}

/** @param {...unknown} values @returns {string|null} the first non-empty string */
const firstString = (...values) => values.find(isNonEmptyString) ?? null;

/**
 * Blockers for a node about to be written in `state`. Order of preference:
 * the reasons the caller gave, then — on a RE-ASSERT of a blocked state only —
 * the reasons the node (or, before backfill, the run.json lane) already had,
 * then the reason the ops word implies. A CHANGE into a blocked state never
 * inherits the old reasons: `serial-gate -> suspended` carrying `gate:` would
 * be exactly what B2 refuses.
 *
 * @returns {string[]|null} `null` when the state is not blocked and nothing was given
 */
function blockersFor({ state, status, blockedBy, node, lane, own, changed }) {
  if (status !== 'blocked') return Array.isArray(blockedBy) && blockedBy.length > 0 ? [...blockedBy] : null;
  if (Array.isArray(blockedBy) && blockedBy.length > 0) return [...blockedBy];
  if (!changed && Array.isArray(node?.blockers) && node.blockers.length > 0) return [...node.blockers];
  if (!changed && !own && lane.blockedBy.length > 0) return [...lane.blockedBy];
  return [...(OPS_IMPLIED_BLOCKED_BY[state] ?? [])];
}

/**
 * Plan the Task Graph node a BOUND write produces (B1 · B2 · B3), pure.
 *
 * `opsWord` is the state the caller asks for, or `null` for "keep the recorded
 * one" (a metadata-only patch). The previous state comes from the node's own
 * `ops`; a node with none — seeded by the legacy feeder, or new — takes it from
 * the `run.json` lane, which is what makes the backfill preserve `since`.
 *
 *  - **B1** status and owner are DERIVED from the ops word, never taken from
 *    the caller, so the node cannot disagree with itself. The one place a
 *    disagreement can already exist is a stored node (a lease call flipped
 *    `status` after `ops` was written): a state-less patch on such a node
 *    THROWS instead of guessing which field is right, and an explicit state
 *    rewrites both.
 *  - **B2** see {@link assertBlockersForState}.
 *  - **B3** `ops.since` moves only when the state changes; `heartbeat_at` is
 *    stamped on every write into a working state (that is the lease sync's job
 *    folded into the one commit).
 *
 * Returns `{ok:false}` for the one refusal that is a fact about the graph and
 * not a caller error — the node belongs to ANOTHER run (I2): overwriting it
 * would erase that run's record. Everything else that is wrong throws.
 *
 * WHAT THIS DOES NOT SEPARATE (M2): a node with the limb's id and NO `ops` is
 * taken as this run's own — its status, owner and blockers are rewritten from
 * the ops word. That absorbs a same-id node another feeder wrote (a `/team`
 * TaskCreate node, say), exactly as `split-task-feed.js#mergeLimbTasks` already
 * carries such a node through and refreshes its `file_ownership`. The two were
 * never disjoint on task id and this does not make them so: `ops.run_id`
 * separates one RUN's nodes from another RUN's (I2), not a run's nodes from a
 * stranger's.
 *
 * @param {object} p
 * @param {object|null} p.node - the current node, or `null` when the graph has none
 * @param {ReturnType<typeof readLaneEntry>} p.lane - the run.json lane, for backfill
 * @param {string} p.worker - limb name = task id
 * @param {string} p.missionId
 * @param {string} p.runId
 * @param {string|null} p.opsWord - requested ops word, or `null`
 * @param {string[]|null} p.blockedBy - reasons the caller gave, or `null`
 * @param {Record<string, unknown>} p.rest - the patch minus status / ops_state / blocked_by; only `window` and `note` reach the node
 * @param {string} p.ts - ISO instant of this write
 * @param {ReadonlyArray<string>} p.ownsList - plan `affectedPaths`, for a node that does not exist yet
 * @returns {{ ok: true, node: object, prev: { state: string|null, since: string|null }, changed: boolean } | { ok: false, reason: string, detail: string }}
 */
export function planBoundNode({ node, lane, worker, missionId, runId, opsWord, blockedBy, rest, ts, ownsList }) {
  const own = isPlainObject(node?.ops) ? node.ops : null;
  if (own && own.run_id !== runId) {
    return { ok: false, reason: 'task-run-mismatch', detail: `task '${worker}' belongs to run '${String(own.run_id)}', not '${runId}'` };
  }
  const laneNow = lane ?? readLaneEntry(undefined);
  if (own && !isLaneOpsState(own.state)) assertOpsStatusAgree(node);

  const prev = own
    ? { state: own.state, since: isIsoInstant(own.since) ? own.since : null }
    : { state: laneNow.state, since: laneNow.since };
  const asked = typeof opsWord === 'string' ? opsWord : null;
  if (asked === null && own) assertOpsStatusAgree(node);
  const state = asked ?? prev.state;
  if (state === null) {
    throw new Error(`split-state: worker '${worker}' needs a state: no ops word was given and none is recorded (node ops, then run.json lane)`);
  }

  const changed = state !== prev.state;
  const since = changed || prev.since === null ? ts : prev.since;
  const windowName = firstString(rest?.window, own?.window, laneNow.window);
  const note = firstString(rest?.note, own?.note, laneNow.note);
  const status = LANE_OPS_TO_V11_STATUS[state];
  const blockers = blockersFor({ state, status, blockedBy, node, lane: laneNow, own, changed });
  assertBlockersForState({ state, status, blockers });

  const kept = node ? { ...node } : {
    id: worker, mission_id: missionId, title: `/split limb ${worker}`, file_ownership: [...ownsList], created_at: ts,
  };
  delete kept.blockers; // re-added below only when this state is blocked
  const next = {
    ...kept,
    status,
    owner: OWNED_TASK_STATUSES.includes(status) ? worker : null,
    ...(blockers ? { blockers } : {}),
    ...(HEARTBEAT_OPS_STATES.includes(state) ? { heartbeat_at: ts, heartbeat_source: 'lane-heartbeat' } : {}),
    ops: { state, since, run_id: runId, ...(windowName ? { window: windowName } : {}), ...(note ? { note } : {}) },
    updated_at: ts,
  };
  assertOpsStatusAgree(next);
  return { ok: true, node: next, prev, changed };
}

/**
 * Canonical reads use the Task Graph NODES, keyed by task id (the limb name).
 *
 * `state.yaml`'s worker rows cannot carry a split lane: a row is a fixed
 * five-field projection of one task (`projection.js#projectWorker`), it is
 * keyed by the task's OWNER when that owner holds exactly one task, and it
 * drops `ops` (all three pinned in `tests/topology/split-state-sources.test.js`).
 * So the reader takes the graph itself. Only nodes whose `ops.run_id` is THIS
 * run's are workers here: a `/team` node, a legacy-seeded node with no `ops`
 * and another run's node are all outside it.
 *
 * @param {unknown} graph - a Task Graph (`store.getTaskGraph(missionId)`)
 * @param {{ runId?: unknown }} [opts]
 * @returns {Record<string, RawWorker>}
 */
export function normalizeTaskGraph(graph, { runId } = {}) {
  /** @type {Record<string, RawWorker>} */ const out = {};
  const tasks = Array.isArray(/** @type {any} */ (graph)?.tasks) ? /** @type {any} */ (graph).tasks : [];
  if (!isNonEmptyString(runId)) return out;
  for (const task of tasks) {
    if (!isPlainObject(task) || !isNonEmptyString(task.id)) continue;
    const ops = task.ops;
    if (!isPlainObject(ops) || ops.run_id !== runId) continue;
    out[task.id] = {
      status: isV11Status(task.status) ? task.status : null,
      owns: stringList(task.file_ownership),
      blockedBy: stringList(task.blockers),
      heartbeatAt: typeof task.heartbeat_at === 'string' ? task.heartbeat_at : null,
      heartbeatSource: typeof task.heartbeat_source === 'string' ? task.heartbeat_source : null,
      extra: {
        ...(isLaneOpsState(ops.state) ? { ops_state: ops.state } : {}),
        ...(typeof ops.since === 'string' ? { since: ops.since } : {}),
        ...(typeof ops.window === 'string' ? { window: ops.window } : {}),
        ...(typeof ops.note === 'string' ? { note: ops.note } : {}),
      },
    };
  }
  return out;
}

/**
 * The plan limbs whose node in `graph` already belongs to ANOTHER run. A bound
 * merge leaves these nodes alone (I2), and a run is not bound to a mission in
 * which its dispatched limb is one of them.
 *
 * @param {unknown} graph
 * @param {{ runId: string, limbs: ReadonlyArray<string> }} p
 * @returns {string[]}
 */
export function foreignRunLimbs(graph, { runId, limbs }) {
  const tasks = Array.isArray(/** @type {any} */ (graph)?.tasks) ? /** @type {any} */ (graph).tasks : [];
  return tasks
    .filter((t) => isPlainObject(t) && limbs.includes(t.id) && isPlainObject(t.ops) && t.ops.run_id !== runId)
    .map((t) => t.id);
}

/**
 * Give one legacy node its `ops` record from a lane word, and align `status`,
 * `owner` and `blockers` to it (B1/B2) in the same breath.
 *
 * @param {object} task
 * @param {{ state: string, since: string, runId: string, lane: ReturnType<typeof readLaneEntry>, nowIso: string }} p
 * @returns {object}
 */
function nodeWithOps(task, { state, since, runId, lane, nowIso }) {
  const status = LANE_OPS_TO_V11_STATUS[state];
  const kept = { ...task };
  delete kept.blockers; // re-added below only when the lane word is a blocked one
  let blockers = null;
  if (status === 'blocked') {
    const valid = lane.blockedBy.filter((b) => BLOCKER_PATTERN.test(b));
    const usable = valid.length > 0 && (state !== 'suspended' || valid.some((b) => b.startsWith('human:')));
    blockers = usable ? valid : [...(OPS_IMPLIED_BLOCKED_BY[state] ?? [])];
  }
  return {
    ...kept,
    status,
    owner: OWNED_TASK_STATUSES.includes(status) ? task.id : null,
    ...(blockers ? { blockers } : {}),
    ops: { state, since, run_id: runId, ...(lane.window ? { window: lane.window } : {}), ...(lane.note ? { note: lane.note } : {}) },
    updated_at: nowIso,
  };
}

/**
 * The one-time backfill: give every plan limb's node an `ops` record, ONCE.
 *
 * A limb with a lane word in `run.json` takes it (state, `since` preserved,
 * window, note) — the operator's word beats a status a lease call may have left
 * behind, and `status` / `owner` / `blockers` are realigned to it. A `queued`
 * node with no lane word becomes `pending`. Anything else (a claimed node with
 * no lane word) is REPORTED in `skipped`, not guessed at. A node that already
 * has `ops` is never touched, so a second application is a no-op — which is
 * what makes the backfill safe to run from every feed.
 *
 * A node with a plan limb's id and no `ops` is taken as this run's own even if
 * something else wrote it (M2) — the same absorption `mergeLimbTasks` already
 * performs on a same-id node; see {@link planBoundNode}.
 *
 * @param {object|null} graph
 * @param {{ runId: string, limbs: ReadonlyArray<string>, lanes: unknown, nowIso: string }} p
 * @returns {{ graph: object|null, attached: string[], skipped: Array<{ limb: string, reason: string }>, changed: boolean }}
 */
export function attachRunOps(graph, { runId, limbs, lanes, nowIso }) {
  const tasks = Array.isArray(graph?.tasks) ? graph.tasks : [];
  const table = isPlainObject(lanes) ? lanes : {};
  /** @type {string[]} */ const attached = [];
  /** @type {Array<{ limb: string, reason: string }>} */ const skipped = [];
  const next = tasks.map((task) => {
    if (!isPlainObject(task) || !limbs.includes(task.id)) return task;
    if (isPlainObject(task.ops)) {
      if (task.ops.run_id !== runId) skipped.push({ limb: task.id, reason: 'task-run-mismatch' });
      return task;
    }
    const lane = readLaneEntry(table[task.id]);
    if (lane.state === null && task.status !== 'queued') {
      skipped.push({ limb: task.id, reason: 'no-lane-word' });
      return task;
    }
    attached.push(task.id);
    const state = lane.state ?? 'pending';
    return nodeWithOps(task, { state, since: lane.state ? (lane.since ?? nowIso) : nowIso, runId, lane, nowIso });
  });
  if (attached.length === 0) return { graph, attached, skipped, changed: false };
  return { graph: { ...graph, updated_at: nowIso, tasks: next }, attached, skipped, changed: true };
}
