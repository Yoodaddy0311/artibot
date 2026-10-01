/**
 * `split-state.js` — the ONE reader/writer adapter for "what is this worker
 * doing right now" in a `/split` run (PRD T-46; v1.1 P1 #14 takes this name).
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 * The same question has three answers on disk today (lane-5 §2-D):
 *
 *   1. a StateStore / `state.yaml.workers`  — the design's canonical "now".
 *      It EXISTS (`lib/project-state/state-manager.js#createStateStore`, with
 *      production consumers in `lib/runtime/middleware/tasks.js`,
 *      `scripts/checkpoint/resume-report.mjs` and
 *      `scripts/hooks/post-compact-rehydrate.js`). It is reached from here
 *      only through an injected port, and only for a run that carries a
 *      `missionBinding` (SH-11, below); for every other run this source
 *      contributes nothing, exactly as before. Read-path evidence against a
 *      real store lives in `tests/topology/split-state-sources.test.js`.
 *   2. `<runDir>/run.json.lanes[limb]`      — the leader's operational state,
 *      written by `scripts/split/lane-state.mjs` in the ops vocabulary.
 *   3. the supervisor event stream          — `{runId}.state.json` lanes, a
 *      reducer-derived cache in the 12-word design vocabulary.
 *
 * Three answers to one question is itself the defect (v1.1 §12). This adapter
 * deletes none of them; it makes every reader go through one door that states
 * a fixed priority store -> run.json -> events, reports WHICH source answered,
 * and records disagreements instead of hiding them. `conflicts[]` is evidence,
 * never a verdict — this module never decides which source is right.
 *
 * Writing is narrower than reading: {@link writeWorkerState} has exactly ONE
 * canonical destination per run. An UNBOUND run writes `run.json.lanes[worker]`,
 * stamped `projected_from: 'run.json'`. A BOUND run — one whose `plan.json`
 * carries a `missionBinding` — writes the limb's Task Graph node in the bound
 * mission and only then rewrites `run.json.lanes[worker]` from it, stamped
 * `projected_from: 'store'`: the direction the design asked for
 * (`run.json.lanes` becomes the projection), with the "exactly one writer" rule
 * intact.
 *
 * ── SH-11: the flip, per run, opt-in by a record ────────────────────────────
 * Three things blocked the flip; none lives here, and each is now written:
 *  1. the run-to-mission BINDING — `plan.json.missionBinding`
 *     ({@link bindRunToMission}, {@link readMissionBinding}); the invariants
 *     I1–I4 are listed above `probeBinding`;
 *  2. a home for the ops keys — the closed `ops` object on the Task Graph node
 *     (`schemas/task-graph.schema.json`), with `ops.state` ↔ `status` (B1),
 *     the blocked-reason rules (B2) and `ops.since` (B3) enforced by
 *     `planBoundNode` in the sibling module;
 *  3. the caller wiring — `scripts/split/lane-state.mjs` and `dispatch.mjs`
 *     open a store (`task-feed.mjs#openFeedStore`) and inject it.
 * A run with no binding is not touched: {@link writeWorkerState} takes exactly
 * the code it took before. A run whose binding cannot be honoured is REFUSED
 * (`{ok:false, reason}`), never quietly written to `run.json`.
 *
 * ── SH-11: the canary switch (design canon :256 Shadow, :406 one config key back) ──
 * A binding on disk is an intention, not an order: the CALLER says whether it
 * is honoured, through the `honorBinding` port of {@link writeWorkerState} and
 * {@link readWorkerState} (`true`, or a function returning `true`; anything
 * else, a missing port included, is OFF — fail-closed). This layer is L4 and
 * never reads config: the CLIs read `split.missionBinding.enabled` (shipped
 * `false`) and inject it. OFF sends the run down the LEGACY path — `run.json`
 * written and stamped `projected_from: 'run.json'`, the store layer of a read
 * contributing nothing — and the result says so, `binding: { status:
 * 'disabled' }`, instead of saying nothing. Turning it back ON is guarded (④):
 * a lane the legacy path wrote AFTER the node last changed is refused as
 * `binding-stale`, because the node's `ops` is then behind `run.json`. The
 * judge that reads no clock is the lane's SEAL (`split-lane-seal.js`): a bound
 * write seals the lane it projects, and a lane that says something other than
 * its seal was rewritten since (SH-11 pre-flip condition 4). A lane with no
 * seal falls back to the stamps — a later `updated_at`, or a different word
 * than `ops.state` written after `ops.since`.
 * {@link bindRunToMission} is not gated here: it only records; the caller that
 * decides to bind (`task-feed.mjs`) asks the same key.
 *
 * The record vocabulary is v1.1's (`V11_STATUSES`: the seven worker statuses
 * plus `failed`); ops and lane words are converted on the way in through the
 * tables in `lib/supervisor/contracts.js` (L2, importable from L4), and an
 * unknown word converts to `null` — unknown, not a guess. That conversion, and
 * the three per-source normalizers that apply it, live in the sibling
 * `./split-state-sources.js`; this file owns priority, conflicts, the ledger
 * and the write.
 *
 * ── WHAT THIS MODULE DOES NOT DO (write it next to the gate, rules §9) ─────
 *  - It does not talk to the StateStore, the event log, or git. All three are
 *    injected ports (`store` / `openStore`, `appendEvent`, `commitReader`).
 *    The write's production caller is `scripts/split/lane-state.mjs`
 *    (`dispatch.mjs` through it); it injects a store, lazily, and no ledger
 *    port — a bound write's `worker.claimed` / `task.released` therefore still
 *    skips as `skipped:no-port` / `skipped:missing:<key>`, and the store's own
 *    `state.updated` is the only line a bound lane write adds to the ledger.
 *    The read has no production caller at all: no CLI, hook or middleware calls
 *    `readWorkerState`, so "canonical reads take the store from the binding" is
 *    measured by `tests/topology/split-state.test.js`, not by live traffic.
 *    Whether the leader's `lane-state` child process sees the session id the
 *    store needs is a host fact — measured for a Bash tool call on 2026-09-21
 *    (Wave 16), not re-measured for this path.
 *  - It does not create a mission row, ever. A bound run whose mission is gone
 *    is refused (`binding-dangling`); there is no implicit reseed into another
 *    mission. The HANDOFF the binding's invariant I4 reserves `generation` for
 *    (an explicit write: copy the run's limb nodes into a new mission, bump the
 *    generation, leave `blockers: ['reconcile:run-moved']` on the old mission)
 *    is NOT implemented: `generation` is 1 for every binding this module writes.
 *    Until it exists, the way out of a mission that is gone is a deliberate,
 *    human act — remove `missionBinding` from plan.json, which returns the run
 *    to the legacy path.
 *  - It does not clean up the residue of the per-session join (one run's limbs
 *    sitting in two missions with different states). It reports it: a limb
 *    present in another mission's graph in a different state is a
 *    `conflicts[]` entry of a bound read (`store:<mission>`), never a write.
 *  - Its bound write does not create, renew or release a LEASE record
 *    (`task_leases`): the node carries `heartbeat_at` / `owner` / `status`, in
 *    the same single commit. The lease sits BESIDE the node and is someone
 *    else's to keep: the bound feed takes it with `claimTask({ status: <the
 *    node's own status> })` (`task-feed.mjs#leaseBesideNode`, SH-11 pre-flip
 *    condition 1 — the legacy claim forced `claimed` over the ops word), and
 *    `lane-lease.mjs#syncLaneLease` renews and releases it.
 *  - It does not validate the events it hands to `appendEvent`; the writer is
 *    the one validator, and a refusal comes back as `{ok:false}`. The payload
 *    targets `lib/runtime/event-writer.js#writeEvent`, whose `EVENT_RE` takes
 *    the dotted v1.1 names. The SUPERVISOR ledger is a different destination
 *    with a different vocabulary — `contracts.js#validateEvent` rejects a dot
 *    (`TYPE_PATTERN = /^[a-z][a-z0-9-]+$/`), so routing these to
 *    `run-store.js#appendEvent` still needs the `event-types.js` alias
 *    registration lane-5 §2-D calls for and nobody has done.
 *  - It does not judge liveness. `heartbeat_at` is a timestamp, not a health
 *    verdict; `lib/supervisor/lane-monitor.js#assessLane` owns that judgment.
 *  - It does not reconcile `conflicts[]`. A caller that needs a single answer
 *    must decide, or block (`blocked_by: ['reconcile:<what>']`, lane-5 §2-D).
 *
 * @module lib/topology/split-state
 */

import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteJsonSync } from '../core/file.js';
import { withFileLock } from '../core/file-lock.js';
import { readRunJson, updatePlanJson, updateRunJson } from '../git/split-run-file.js';
import { MISSION_ID_PATTERN } from '../project-state/validate.js';
import { isLaneOpsState, isV11Status, LANE_OPS_STATES, LANE_OPS_TO_V11_STATUS } from '../supervisor/contracts.js';
// The `now` port contract has ONE judge, and it is not this file: rather than
// keep a second copy of the same nine lines, L4 imports the definition, which
// lives at `lib/core/clock.js` (L1) since 2026-09-03 — `unified-verifier.js`
// only re-exports it (`:444`). Imported from the definition site, not through
// the re-export: a clock is a core leaf, and routing through a verification
// module would make this file depend on a verifier it does not otherwise use.
import { readClock } from '../core/clock.js';
import { LANE_SEAL_KEY, laneFacts, laneSealDrift } from './split-lane-seal.js';
import {
  BINDING_DISABLED,
  honorsBinding,
  isPlainObject,
  MISSION_BINDING_KEY,
  normalizeEvents,
  normalizeRunJson,
  normalizeStore,
  normalizeTaskGraph,
  ownsFromPlan,
  parseMissionBinding,
  planBoundNode,
  readLaneEntry,
  stringList,
  V11_TO_OPS_WORDS,
} from './split-state-sources.js';

/**
 * Read priority, highest first. `'store'` stands for the StateStore /
 * `state.yaml`, which exists (`lib/project-state/state-manager.js`) but is
 * reached from here only through the injected `storeReader`; the token names
 * the SOURCE, not a file this module opens.
 */
export const STATE_SOURCES = Object.freeze(['store', 'run.json', 'events']);

/** Value of the `projected_from` stamp {@link writeWorkerState} writes for an UNBOUND run. */
export const PROJECTION_MARK = 'run.json';

/** `projected_from` of a lane written for a BOUND run: `run.json.lanes[limb]` is then a projection of the store node. */
export const STORE_PROJECTION_MARK = 'store';

/** Ledger `reason` on the store commit of a bound lane write (`state.updated{reason}`). */
export const BOUND_WRITE_REASON = 'split.lane-state';

/**
 * @typedef {object} WorkerRecord
 * @property {string|null} status - v1.1 status, or `null` when the source's word has no v1.1 equivalent
 * @property {ReadonlyArray<string>} owns - owned paths (plan.json `affectedPaths` when the plan lists the limb)
 * @property {string|null} heartbeat_at - ISO; the lane heartbeat, else the last commit (`assessLane` priority, see {@link pickHeartbeat})
 * @property {string|null} heartbeat_source - `'lane-heartbeat'` | `'last-commit'` | a store-declared value | `null`
 * @property {ReadonlyArray<string>} blocked_by - reason strings (`lane:` / `gate:` / `human:` / `reconcile:`)
 * @property {string} source - which of {@link STATE_SOURCES} supplied this record
 */

/**
 * @typedef {object} StateConflict
 * @property {string} worker
 * @property {'status'|'owns'} field
 * @property {ReadonlyArray<{ source: string, value: unknown }>} values - every source that stated a value, in priority order
 */

/* ─────────────────────────── paths & file access ────────────────────────── */

/**
 * Resolve the files of a `/split` run directory.
 *
 * `runDir` holds `plan.json` and `run.json` — canonically
 * `<parentRoot>/.artibot/split`. With that shape the helpers in
 * `lib/git/split-run-file.js` are reused (atomic write, "missing is null but
 * corrupt throws"); a non-canonical directory (a test tmpdir, a moved run) is
 * read and written directly with the same semantics rather than refused, so
 * the adapter is testable without faking a repo layout.
 *
 * @param {unknown} runDir
 * @param {string} label - caller name, for error messages
 * @returns {{ dir: string, parentRoot: string|null, runJsonPath: string, planJsonPath: string }}
 */
function resolveRunDir(runDir, label) {
  if (typeof runDir !== 'string' || !runDir.trim()) {
    throw new TypeError(`${label}: runDir is required (the /split run directory holding plan.json and run.json)`);
  }
  const dir = path.resolve(runDir);
  const canonical = path.basename(dir) === 'split' && path.basename(path.dirname(dir)) === '.artibot';
  return {
    dir,
    parentRoot: canonical ? path.dirname(path.dirname(dir)) : null,
    runJsonPath: path.join(dir, 'run.json'),
    planJsonPath: path.join(dir, 'plan.json'),
  };
}

/**
 * Read a JSON object file. Missing -> `null`. Malformed or non-object ->
 * throws: a damaged run/plan file must never read as "no workers", which a
 * silent `{}` would make indistinguishable from an empty run.
 *
 * @param {string} p
 * @returns {object|null}
 */
function readJsonObjectOrNull(p) {
  let text;
  try {
    text = fs.readFileSync(p, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`split-state: ${p} is not a JSON object`);
  }
  return parsed;
}

/**
 * @param {ReturnType<typeof resolveRunDir>} paths
 * @returns {object|null}
 */
function readRunJsonAt(paths) {
  return paths.parentRoot ? readRunJson(paths.parentRoot) : readJsonObjectOrNull(paths.runJsonPath);
}

/**
 * @param {ReturnType<typeof resolveRunDir>} paths
 * @param {(current: object) => object|undefined} fn
 * @returns {object}
 */
function updateRunJsonAt(paths, fn) {
  if (paths.parentRoot) return updateRunJson(paths.parentRoot, fn);
  const current = readJsonObjectOrNull(paths.runJsonPath) ?? {};
  const next = fn(current);
  const out = next === undefined ? current : next;
  atomicWriteJsonSync(paths.runJsonPath, out);
  return out;
}

/**
 * `plan.json` read-modify-write, the twin of {@link updateRunJsonAt}. Used by
 * exactly one caller shape: recording the run-to-mission binding.
 *
 * Serialised by the plan.json lock on BOTH branches (SH-11 pre-flip condition
 * 3): the canonical layout goes through `updatePlanJson`, which takes it, and
 * a non-canonical directory takes the same `withFileLock` here, so the binder
 * behaves the same wherever the run directory sits.
 *
 * @param {ReturnType<typeof resolveRunDir>} paths
 * @param {(current: object) => object|undefined} fn
 * @returns {object}
 */
function updatePlanJsonAt(paths, fn) {
  if (paths.parentRoot) return updatePlanJson(paths.parentRoot, fn);
  return withFileLock(paths.planJsonPath, () => {
    const current = readJsonObjectOrNull(paths.planJsonPath) ?? {};
    const next = fn(current);
    const out = next === undefined ? current : next;
    atomicWriteJsonSync(paths.planJsonPath, out);
    return out;
  });
}

/* ─────────────────────── the run-to-mission binding (SH-11) ──────────────────────
 *
 * A `/split` run is identified by `plan.runId`; the StateStore is addressed by
 * a mission id. Until SH-11 the join was per-SESSION (the `-S<sid8>` tail of a
 * mission id, resolved from whichever session happened to dispatch), which
 * broke across sessions (one run seeded two missions with contradictory
 * states) and across midnight (a tail with two dated missions resolves to
 * none). The join is now a record the RUN carries: `plan.json.missionBinding`.
 *
 *  I1  one run_id -> exactly one mission           (the writer never overwrites)
 *  I2  every limb node of the run carries the same `ops.run_id`
 *  I3  canonical reads and writes take the mission from THIS record only
 *  I4  `generation` never decreases                (only a handoff raises it)
 *
 * WHAT THE RECORD DOES NOT DO: it does not create a mission row (a row without
 * a `mission.created` event is `/doctor` Check 8-3's orphan), it does not say
 * the mission is still alive (a fact about the store, judged per call), and it
 * is not itself a lock. Two windows binding the same run at the same instant
 * are serialised by the plan.json lock `updatePlanJson` takes (SH-11 pre-flip
 * condition 3): the first binds, the second reads that record inside its own
 * read-modify-write and reuses it (I1).
 */

/**
 * Judge the binding a plan carries.
 *
 * @param {ReturnType<typeof resolveRunDir>} paths
 * @param {object|null} plan - parsed plan.json
 * @returns {{ status: 'none' } | { status: 'invalid', reason: string } | { status: 'bound', binding: Readonly<object>, runId: string }}
 */
function probeBinding(paths, plan) {
  if (!isPlainObject(plan) || !Object.hasOwn(plan, MISSION_BINDING_KEY)) return { status: 'none' };
  const parsed = parseMissionBinding(plan[MISSION_BINDING_KEY]);
  if (!parsed.ok) return { status: 'invalid', reason: parsed.reason };
  const planRunId = typeof plan.runId === 'string' && plan.runId !== '' ? plan.runId : null;
  if (planRunId === null || parsed.binding.run_id !== planRunId) return { status: 'invalid', reason: 'binding-run-mismatch' };
  // F3: the two run files must name the same run. A copy of one run's
  // plan.json next to another run's run.json is the shape this catches.
  const run = readRunJsonAt(paths);
  if (typeof run?.runId === 'string' && run.runId !== '' && run.runId !== planRunId) return { status: 'invalid', reason: 'run-id-mismatch' };
  return { status: 'bound', binding: parsed.binding, runId: planRunId };
}

/**
 * Whether (and to what) a run is bound. `none` is the legacy answer: nothing
 * in this module changes for such a run. Every other status is a statement the
 * caller must act on — `invalid` is NOT `none`, so a damaged binding can never
 * quietly send a write back to `run.json`.
 *
 * A missing plan.json reads as `none`; an unreadable one throws (a damaged
 * plan must never read as "unbound").
 *
 * @param {object} p
 * @param {string} p.runDir
 * @returns {{ status: 'none' } | { status: 'invalid', reason: string } | { status: 'bound', binding: Readonly<object>, runId: string }}
 */
export function readMissionBinding({ runDir } = {}) {
  const paths = resolveRunDir(runDir, 'readMissionBinding');
  return probeBinding(paths, readJsonObjectOrNull(paths.planJsonPath));
}

/**
 * Bind a run to a mission, ONCE (I1). Reuses the record that is already there,
 * whichever mission the caller now names — a second session must not re-home a
 * run, which is the defect being fixed.
 *
 * Never creates a mission row: with a `store` port it REFUSES when the row is
 * absent (`mission-missing`); without one the caller vouches for the row.
 * Never overwrites a damaged binding — that is reported, and repaired by a
 * person or a handoff.
 *
 * @param {object} p
 * @param {string} p.runDir
 * @param {string} p.missionId - `M-YYYYMMDD-…` (either accepted form)
 * @param {string} p.sessionId - the binding session, recorded as `bound_by_session` (an audit fact, never a key)
 * @param {() => Date} [p.now] - clock port (strict, like every writer here)
 * @param {{ getState: () => object }} [p.store] - optional StateStore port, used only to check the mission row exists
 * @returns {{ ok: true, bound: boolean, binding: Readonly<object> } | { ok: false, reason: string }}
 */
export function bindRunToMission({ runDir, missionId, sessionId, now, store } = {}) {
  const paths = resolveRunDir(runDir, 'bindRunToMission');
  if (typeof missionId !== 'string' || !MISSION_ID_PATTERN.test(missionId)) return { ok: false, reason: 'binding-invalid:mission_id' };
  if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, reason: 'binding-invalid:bound_by_session' };
  const ts = readClock(now, 'bindRunToMission');

  const plan = readJsonObjectOrNull(paths.planJsonPath);
  if (plan === null) return { ok: false, reason: 'plan-missing' };
  const existing = probeBinding(paths, plan);
  if (existing.status === 'bound') return { ok: true, bound: false, binding: existing.binding };
  if (existing.status === 'invalid') return { ok: false, reason: existing.reason };

  if (typeof plan.runId !== 'string' || plan.runId === '') return { ok: false, reason: 'plan-run-id-missing' };
  const run = readRunJsonAt(paths);
  if (typeof run?.runId === 'string' && run.runId !== '' && run.runId !== plan.runId) return { ok: false, reason: 'run-id-mismatch' };
  if (store && !store.getState()?.active_missions?.[missionId]) return { ok: false, reason: 'mission-missing' };

  const binding = Object.freeze({ mission_id: missionId, run_id: plan.runId, generation: 1, bound_at: ts, bound_by_session: sessionId });
  // A LOCKED read-modify-write (M1, closed by SH-11 pre-flip condition 3):
  // `updatePlanJson` holds the plan.json lock across read -> `fn` -> rename, so a
  // second window binding the same run takes its turn and its `fn` finds the
  // record the first one wrote — the check below is then decided, not merely
  // narrowed. The write is STILL not trusted: the plan is read back and the
  // record it NOW carries is what the caller gets — no caller acts on a binding
  // that is not on disk. The read-back earns its keep against a writer that does
  // not take the lock (the leader's inline plan write at `/split plan` time).
  // Contended past the lock's wait budget the update throws ELOCKTIMEOUT and
  // nothing is bound; the callers here are record-only and report a skip.
  updatePlanJsonAt(paths, (current) => (Object.hasOwn(current, MISSION_BINDING_KEY) ? current : { ...current, [MISSION_BINDING_KEY]: binding }));
  const landed = probeBinding(paths, readJsonObjectOrNull(paths.planJsonPath));
  if (landed.status === 'invalid') return { ok: false, reason: landed.reason };
  // A whole-file plan write that read before ours and renamed after it (the
  // forkPoint recorder is such a writer) can drop the key again.
  if (landed.status !== 'bound') return { ok: false, reason: 'binding-lost' };
  return { ok: true, bound: sameBinding(landed.binding, binding), binding: landed.binding };
}

/* ──────────────────────────────── helpers ───────────────────────────────── */

/**
 * Whether two binding records are the same record (all five fields).
 *
 * @param {Readonly<object>} a
 * @param {Readonly<object>} b
 * @returns {boolean}
 */
function sameBinding(a, b) {
  return a.mission_id === b.mission_id && a.run_id === b.run_id && a.generation === b.generation
    && a.bound_at === b.bound_at && a.bound_by_session === b.bound_by_session;
}

/** @param {unknown} v @returns {number} epoch ms, or `NaN` */
function isoMs(v) {
  if (typeof v !== 'string' || !v) return NaN;
  return Date.parse(v);
}

/* ──────────────────────────────── reading ───────────────────────────────── */

/**
 * Read every worker's state through the one door.
 *
 * Priority is `store -> run.json -> events` and is applied PER WORKER: the
 * highest-priority source that names a worker supplies its record. Three
 * fields deviate, each for a stated reason:
 *
 *  - **`owns`** comes from `plan.json` when the plan lists the limb: the plan
 *    is the de-facto canonical for ownership (lane-5 §5-①) and `land.mjs`
 *    already judges from it. A source claiming different paths does not lose
 *    silently — the disagreement lands in `conflicts[]`.
 *  - **`heartbeat_at`** follows `assessLane`'s PRIORITY, not `max` (see
 *    {@link pickHeartbeat}). Its lane-heartbeat component comes from the
 *    highest-priority source that HAS one, because `run.json` structurally
 *    never carries a heartbeat and a record-level read would blank it whenever
 *    run.json wins; git `%cI` arrives through the `commitReader` port.
 *  - **`blocked_by`** comes from the winning record only — mixing reasons from
 *    different sources would fabricate a combined cause.
 *
 * `conflicts[]` records, without judging, every worker where two or more
 * sources STATE a different `status` or `owns`. A source that names a worker
 * but yields no value is a gap, not a disagreement, and is not recorded —
 * otherwise every unmapped lane word would masquerade as a conflict.
 *
 * ── A BOUND run (SH-11) reads its store layer differently ──────────────────
 * When `plan.json` carries a `missionBinding`, the `store` layer is the bound
 * mission's Task Graph NODES (`normalizeTaskGraph`), taken through the `store`
 * port and through the binding only — a caller-supplied `storeReader` is
 * IGNORED for such a run, because two "store" answers is the defect being
 * removed. The result then carries a `binding` report (`bound` · `unread` when
 * no `store` port came · `dangling` when the mission is gone · `invalid`);
 * an unbound run's result has no such key. Three kinds of evidence join
 * `conflicts[]` for a bound run and none of them is ever a winner: a node whose
 * `ops.state` and `status` disagree at rest (`store:ops`), and the same limb
 * sitting in ANOTHER mission's graph in a different state (`store:<mission>`,
 * the residue of the per-session join).
 *
 * With the canary switch OFF (`honorBinding` absent or not a literal `true` —
 * see {@link writeWorkerState}) a run that carries a record reads exactly as an
 * unbound one: `storeReader` answers, `store` is never touched, and the result
 * carries `binding: {status:'disabled'}`.
 *
 * @param {object} p
 * @param {string} p.runDir - the `/split` run directory (holds `plan.json`, `run.json`)
 * @param {(ctx: { runDir: string }) => unknown} [p.storeReader] - StateStore port for an UNBOUND run; absent -> that source contributes nothing
 * @param {{ getState: () => object }} [p.store] - StateStore for a BOUND run (read via `getState()` only)
 * @param {(ctx: { runDir: string }) => unknown} [p.eventsReader] - reduced supervisor state port; absent -> no-op
 * @param {(worker: string, ctx: { runDir: string }) => (string|null|undefined)} [p.commitReader] - git `%cI` port; absent -> no commit component
 * @param {boolean|(() => boolean)} [p.honorBinding] - the canary switch, as on {@link writeWorkerState}; ABSENT MEANS OFF
 * @returns {{ workers: Readonly<Record<string, WorkerRecord>>, source: string|null, conflicts: ReadonlyArray<StateConflict>, binding?: object }}
 */
export function readWorkerState({ runDir, storeReader, store, eventsReader, commitReader, honorBinding } = {}) {
  const paths = resolveRunDir(runDir, 'readWorkerState');
  const ctx = Object.freeze({ runDir: paths.dir });
  const plan = readJsonObjectOrNull(paths.planJsonPath);
  const planOwns = ownsFromPlan(plan);
  const bound = readBoundStoreLayer({ paths, plan, store, limbs: Object.keys(planOwns), honor: honorBinding });
  // `bound` is non-null for a run that carries a record; the switch decides
  // whether that record is CONSULTED. Off: the legacy storeReader answers and
  // the store port is never touched (`bound.disabled`).
  const canonical = bound !== null && bound.disabled !== true;

  const layers = [
    { source: 'store', workers: canonical ? bound.workers : normalizeStore(typeof storeReader === 'function' ? storeReader(ctx) : null) },
    { source: 'run.json', workers: normalizeRunJson(readRunJsonAt(paths)) },
    { source: 'events', workers: normalizeEvents(typeof eventsReader === 'function' ? eventsReader(ctx) : null) },
  ];

  /** @type {string[]} */ const names = [];
  for (const layer of layers) {
    for (const name of Object.keys(layer.workers)) if (!names.includes(name)) names.push(name);
  }

  /** @type {Record<string, WorkerRecord>} */ const workers = {};
  /** @type {StateConflict[]} */ const conflicts = [];

  for (const name of names) {
    const present = layers.filter((l) => l.workers[name]);
    const winner = present[0];
    const raw = winner.workers[name];

    const beating = present.map((l) => l.workers[name]).find((w) => typeof w.heartbeatAt === 'string');
    const commitAt = typeof commitReader === 'function' ? commitReader(name, ctx) : null;
    const heartbeat = pickHeartbeat(
      beating ? beating.heartbeatAt : null,
      beating ? beating.heartbeatSource : null,
      typeof commitAt === 'string' ? commitAt : null,
    );

    const owns = Object.prototype.hasOwnProperty.call(planOwns, name) ? planOwns[name] : raw.owns;

    workers[name] = Object.freeze({
      ...raw.extra,
      status: raw.status,
      owns: Object.freeze([...owns]),
      heartbeat_at: heartbeat.at,
      heartbeat_source: heartbeat.source,
      blocked_by: Object.freeze([...raw.blockedBy]),
      source: winner.source,
    });

    collectConflict(conflicts, name, 'status', [
      ...present
        .filter((l) => typeof l.workers[name].status === 'string')
        .map((l) => ({ source: l.source, value: l.workers[name].status })),
      ...(canonical ? (bound.evidence[name] ?? []) : []),
    ]);

    const ownsClaims = present
      .filter((l) => l.workers[name].owns.length > 0)
      .map((l) => ({ source: l.source, value: l.workers[name].owns }));
    if (Object.prototype.hasOwnProperty.call(planOwns, name) && planOwns[name].length > 0) {
      ownsClaims.unshift({ source: 'plan.json', value: planOwns[name] });
    }
    collectConflict(conflicts, name, 'owns', ownsClaims);
  }

  const primary = layers.find((l) => Object.keys(l.workers).length > 0);
  return Object.freeze({
    workers: Object.freeze(workers),
    source: primary ? primary.source : null,
    conflicts: Object.freeze(conflicts),
    ...(bound ? { binding: Object.freeze(bound.binding) } : {}),
  });
}

/**
 * The `store` layer of a BOUND run, or `null` for an unbound one (the caller
 * then keeps the legacy `storeReader` path untouched).
 *
 * `evidence` maps a limb to extra status claims that join `conflicts[]` and
 * never win: the node's own `ops.state` projection when it disagrees with the
 * node's `status`, and the same limb's status in every OTHER mission graph the
 * snapshot holds. Only the plan's limbs are looked up in other missions — the
 * run's own declared names, not a scan of everything.
 *
 * A run that carries a record while the canary switch is OFF returns
 * `{disabled: true}`: the record is not even judged (a damaged one reads as
 * `disabled`, not `invalid`) and the store port is not touched.
 *
 * @param {object} p
 * @param {ReturnType<typeof resolveRunDir>} p.paths
 * @param {object|null} p.plan
 * @param {{ getState: () => object }|undefined} p.store
 * @param {string[]} p.limbs - the plan's limb names
 * @param {unknown} p.honor - the caller's `honorBinding` port
 * @returns {{ disabled?: true, workers: Record<string, object>, evidence: Record<string, Array<{ source: string, value: string }>>, binding: object }|null}
 */
function readBoundStoreLayer({ paths, plan, store, limbs, honor }) {
  if (!isPlainObject(plan) || !Object.hasOwn(plan, MISSION_BINDING_KEY)) return null;
  if (!honorsBinding(honor)) return { disabled: true, workers: {}, evidence: {}, binding: BINDING_DISABLED };
  const probe = probeBinding(paths, plan);
  if (probe.status === 'invalid') return { workers: {}, evidence: {}, binding: { status: 'invalid', reason: probe.reason } };

  const { binding } = probe;
  const head = { mission_id: binding.mission_id, run_id: binding.run_id, generation: binding.generation };
  if (!store || typeof store.getState !== 'function') return { workers: {}, evidence: {}, binding: { status: 'unread', ...head } };
  const snapshot = store.getState();
  if (!snapshot?.active_missions?.[binding.mission_id]) return { workers: {}, evidence: {}, binding: { status: 'dangling', ...head } };

  const workers = normalizeTaskGraph(snapshot.task_graphs?.[binding.mission_id], { runId: binding.run_id });
  /** @type {Record<string, Array<{ source: string, value: string }>>} */ const evidence = {};
  const claim = (name, source, value) => {
    if (typeof value === 'string') (evidence[name] ??= []).push({ source, value });
  };
  for (const [name, w] of Object.entries(workers)) {
    const implied = LANE_OPS_TO_V11_STATUS[w.extra.ops_state];
    if (implied && implied !== w.status) claim(name, 'store:ops', implied);
  }
  for (const [missionId, graph] of Object.entries(snapshot.task_graphs ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (missionId === binding.mission_id || !Array.isArray(graph?.tasks)) continue;
    for (const task of graph.tasks) {
      if (limbs.includes(task?.id)) claim(task.id, `store:${missionId}`, task.status);
    }
  }
  return { workers, evidence, binding: { status: 'bound', ...head } };
}

/**
 * Heartbeat priority, the same rule as `lib/supervisor/lane-monitor.js:127-139`
 * (`assessLane`): a parseable lane heartbeat wins outright, the commit is
 * consulted only when there is no usable heartbeat, and an unparseable
 * heartbeat falls through to the commit exactly as `assessLane`'s `toMs` ->
 * `NaN` -> else branch does.
 *
 * Deliberately NOT `max(lane-heartbeat, last-commit)`. Lane-5 §2-D says "max"
 * in its sentence and "assessLane's priority as-is" in the parenthesis; the
 * leader ruled the parenthesis canonical (2026-09-02), because two active
 * liveness judges would mean two truths. The rules differ only when the last
 * commit is NEWER, and there the older heartbeat still wins here. Neither rule
 * has been measured against a live run.
 *
 * @param {string|null} laneAt
 * @param {string|null} laneSource - a store-declared `heartbeat_source` is preserved rather than overwritten
 * @param {string|null} commitAt
 * @returns {{ at: string|null, source: string|null }}
 */
function pickHeartbeat(laneAt, laneSource, commitAt) {
  if (Number.isFinite(isoMs(laneAt))) return { at: laneAt, source: laneSource ?? 'lane-heartbeat' };
  if (Number.isFinite(isoMs(commitAt))) return { at: commitAt, source: 'last-commit' };
  return { at: null, source: null };
}

/**
 * Push a conflict when two or more sources state DIFFERENT values. Evidence
 * only — the caller decides, or blocks.
 *
 * @param {StateConflict[]} out
 * @param {string} worker
 * @param {'status'|'owns'} field
 * @param {Array<{ source: string, value: unknown }>} claims
 * @returns {void}
 */
function collectConflict(out, worker, field, claims) {
  if (claims.length < 2) return;
  const distinct = new Set(claims.map((c) => JSON.stringify(Array.isArray(c.value) ? [...c.value].sort() : c.value)));
  if (distinct.size < 2) return;
  out.push(Object.freeze({
    worker,
    field,
    values: Object.freeze(claims.map((c) => Object.freeze({ source: c.source, value: c.value }))),
  }));
}

/* ──────────────────────────────── writing ───────────────────────────────── */

/**
 * The ops word to record for a v1.1 status.
 *
 * Two statuses have more than one ops word because the ops vocabulary is finer
 * there, and both are resolved by a STATED rule rather than by picking the
 * first row:
 *  - `blocked` -> `suspended` when a `human:` reason is present (that is what
 *    the ops word means), otherwise `serial-gate`.
 *  - `executing` -> `active`. `closing` is the last moments of the same state
 *    and is unreachable from the status alone, so a caller that means
 *    `closing` must say so with `patch.ops_state`.
 * `cancelled` has no ops word at all -> `null`, and the caller is refused.
 *
 * @param {string} status
 * @param {ReadonlyArray<string>} blockedBy
 * @returns {string|null}
 */
function opsWordFor(status, blockedBy) {
  const words = V11_TO_OPS_WORDS[status] ?? [];
  if (words.length === 0) return null;
  if (words.length === 1) return words[0];
  if (status === 'blocked') return blockedBy.some((b) => b.startsWith('human:')) ? 'suspended' : 'serial-gate';
  if (status === 'executing') return 'active';
  return null;
}

/**
 * The name of the one ledger event a transition owes, or `null`. At most one
 * per write, by design: a state change is one fact.
 *
 * @param {string|null} prevOps
 * @param {string|null} nextOps
 * @returns {string|null}
 */
function ledgerEventNameFor(prevOps, nextOps) {
  if (!nextOps || nextOps === prevOps) return null;
  if (nextOps === 'awaiting-dispatch') return 'worker.claimed';
  if (nextOps === 'done' || nextOps === 'failed') return 'task.released';
  return null;
}

/**
 * Idempotency key for the one ledger line a transition owes.
 *
 * `<event>:<run>:<worker>:<from-ops>:<to-ops>:<from-since>`, the
 * `verify-writer.js#verifyCompletedIdempotencyKey` shape with the run in the
 * session's place. The key names the TRANSITION, so its material is the state
 * being LEFT, as `run.json` stored it before this write — or, for a BOUND run,
 * as the limb's node stored it (`task.ops.state` / `task.ops.since`; the
 * `run.json` lane stands in only until the node has an `ops`, the backfill):
 *
 *  - `from-since` is that state's stored `since`. `writeWorkerState` moves
 *    `since` only on a state change, so it is the identity of the state, not a
 *    reading of the clock. A retry of the same write finds the same prior
 *    record — the ledger goes first, so a crash or a refusal leaves `run.json`
 *    where it was — and mints the same key. A re-dispatch after a release
 *    leaves a different state (`done`, a newer `since`) and mints a new one.
 *    It goes LAST because an ISO stamp carries colons of its own.
 *  - The NEW state's `since` is deliberately not used: it is this write's
 *    `now`, so a retry would carry a new value.
 *  - `from-ops` as well as `from-since`: two states set in one clock tick
 *    share a `since`. `to-ops` too: `done` and `failed` both owe
 *    `task.released`, and leaving one state for each is two facts.
 *  - `none` marks a lane with no prior record, or no stored `since` (the
 *    bare-string lane shape). A lane gets a `since` on its first write here,
 *    so only its first transition can key on `none`.
 *  - The run id, not the session, scopes it: the same retry from another
 *    session is still the same transition, while the same limb in another run
 *    is not. With no run id there is no deterministic scope — a fresh lane in
 *    one run would collide with a fresh lane of the same name in the next — so
 *    the result is `null` and the caller omits the key.
 *
 * LIMIT: two entries into one state from the same from-state with the same
 * stored `since` collide — with a frozen clock, active→done→claimed→executing
 * →done→claimed gives 3 keys for 4 events. Across separate processes on a ms
 * wall clock that is practically unreachable; an injected or repeated `now`
 * reaches it. No reader dedupes on this key today (2026-09-23).
 *
 * @param {object} p
 * @param {string|null} p.eventName
 * @param {unknown} p.runId - `plan.json` / `run.json` `runId`
 * @param {string} p.worker
 * @param {string|null} p.prevOps
 * @param {string|null} p.nextOps
 * @param {string|null} p.prevSince
 * @returns {string|null}
 */
export function workerTransitionIdempotencyKey({ eventName, runId, worker, prevOps, nextOps, prevSince }) {
  const parts = [eventName, runId, worker, nextOps];
  if (parts.some((v) => typeof v !== 'string' || !v)) return null;
  return `${eventName}:${runId}:${worker}:${prevOps || 'none'}:${nextOps}:${prevSince || 'none'}`;
}

/**
 * Build the payload for the ledger port, in the shape
 * `lib/runtime/event-writer.js#writeEvent` takes as its `input`.
 *
 * The writer assembles `v`, `ts`, `pid` and `seq` itself ("so no caller can
 * invent a field", `event-writer.js:17-18`), so they are absent here.
 * Allowlist requirements: `worker.claimed` needs `data.{agent_type, model_tier,
 * owns}` plus a top-level `worker`; `task.released` needs `data.owner`.
 *
 * Two are DERIVED, because the value is the same fact under another name:
 * `owns` is the limb's `plan.json` `affectedPaths` (the projection
 * `readWorkerState` documents), and `owner` defaults to the limb name, which
 * IS the worker identity here. Everything else must be handed in — a missing
 * value SKIPS the append and is reported, never guessed. `owns` separates two
 * absences: a limb listed with no paths is `[]` (owns nothing), a limb absent
 * from the plan is unknown and skips.
 *
 * @param {object} p
 * @param {string} p.eventName
 * @param {string} p.worker
 * @param {object} p.ledgerOpts
 * @param {string[]|null} p.owns - plan projection, or `null` when the plan does not list the limb
 * @param {string|null} p.idempotencyKey - {@link workerTransitionIdempotencyKey}; `null` omits the field
 * @returns {{ ok: true, envelope: object } | { ok: false, missing: string }}
 */
function buildLedgerPayload({ eventName, worker, ledgerOpts, owns, idempotencyKey }) {
  const { session_id: sessionId, mission_id: missionId, source = 'supervisor', data: extra } = ledgerOpts;
  if (typeof sessionId !== 'string' || !sessionId) return { ok: false, missing: 'session_id' };

  /** @type {Record<string, unknown>} */
  let data;
  if (eventName === 'worker.claimed') {
    const { agent_type: agentType, model_tier: modelTier } = ledgerOpts;
    if (typeof agentType !== 'string' || !agentType) return { ok: false, missing: 'agent_type' };
    if (typeof modelTier !== 'string' || !modelTier) return { ok: false, missing: 'model_tier' };
    if (!Array.isArray(owns)) return { ok: false, missing: 'owns' };
    data = { agent_type: agentType, model_tier: modelTier, owns: [...owns] };
  } else {
    const owner = typeof ledgerOpts.owner === 'string' && ledgerOpts.owner ? ledgerOpts.owner : worker;
    data = { owner };
  }

  return {
    ok: true,
    envelope: Object.freeze({
      event: eventName,
      session_id: sessionId,
      // Omitted when absent: the writer derives one through its own documented
      // fallback (`event-writer.js#sessionFallbackMissionId`). Copying
      // that policy here would make two mission-id authorities.
      ...(typeof missionId === 'string' && missionId ? { mission_id: missionId } : {}),
      source,
      worker,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      data: Object.freeze(isPlainObject(extra) ? { ...extra, ...data } : data),
    }),
  };
}

/**
 * Validate a `patch` and resolve the ops word it asks for. Throws on caller
 * error (the refusals listed on {@link writeWorkerState}).
 *
 * @param {object} patch
 * @returns {{ opsWord: string|null, blockedBy: string[]|null, rest: Record<string, unknown> }}
 */
function resolveWriteOps(patch) {
  const { status, ops_state: opsOverride, blocked_by: blockedByIn, ...rest } = patch;
  if (status !== undefined && !isV11Status(status)) {
    throw new Error(`writeWorkerState: status ${JSON.stringify(status)} is not a v1.1 status`);
  }
  if (opsOverride !== undefined && !isLaneOpsState(opsOverride)) {
    throw new Error(`writeWorkerState: ops_state ${JSON.stringify(opsOverride)} is not in the ops allowlist (${LANE_OPS_STATES.join(' | ')})`);
  }
  const blockedBy = blockedByIn === undefined ? null : stringList(blockedByIn);

  if (opsOverride !== undefined) {
    if (status !== undefined && LANE_OPS_TO_V11_STATUS[opsOverride] !== status) {
      throw new Error(`writeWorkerState: ops_state '${opsOverride}' projects to '${LANE_OPS_TO_V11_STATUS[opsOverride]}', not the given status '${status}'`);
    }
    return { opsWord: opsOverride, blockedBy, rest };
  }
  if (status === undefined) return { opsWord: null, blockedBy, rest };

  const opsWord = opsWordFor(status, blockedBy ?? []);
  if (!opsWord) {
    throw new Error(`writeWorkerState: v1.1 status '${status}' has no ops word in run.json — pass ops_state explicitly or wait for the StateStore (T-21)`);
  }
  return { opsWord, blockedBy, rest };
}

/**
 * The ledger half of a write, run BEFORE the store is touched. Never throws:
 * a port that throws is a refusal, reported as one.
 *
 * @param {object} p
 * @param {ReturnType<typeof resolveRunDir>} p.paths
 * @param {string} p.worker
 * @param {string|null} p.eventName
 * @param {object} p.ledgerOpts
 * @param {((event: object) => unknown)} [p.appendEvent]
 * @param {{ prevOps: string|null, nextOps: string|null, prevSince: string|null, runJsonRunId: unknown }} p.transition - the state being left, as `run.json` stored it before this write
 * @returns {{ refused: boolean, status: string, event: object|null, reason?: string }}
 */
function runLedgerPhase({ paths, worker, eventName, ledgerOpts, appendEvent, transition }) {
  if (!eventName) return { refused: false, status: 'skipped:no-event', event: null };

  const plan = readJsonObjectOrNull(paths.planJsonPath);
  const planOwns = ownsFromPlan(plan);
  const owns = Object.prototype.hasOwnProperty.call(planOwns, worker) ? planOwns[worker] : null;
  // plan.json first, run.json second: `resume-notices.mjs`'s order
  // (`watch.mjs` reads the reverse; the live run carried one id in both
  // files on 2026-09-23).
  const runId = [plan?.runId, transition.runJsonRunId].find((v) => typeof v === 'string' && v) ?? null;
  const idempotencyKey = workerTransitionIdempotencyKey({
    eventName, runId, worker, prevOps: transition.prevOps, nextOps: transition.nextOps, prevSince: transition.prevSince,
  });
  const built = buildLedgerPayload({ eventName, worker, ledgerOpts, owns, idempotencyKey });
  if (!built.ok) return { refused: false, status: `skipped:missing:${built.missing}`, event: null };

  const event = built.envelope;
  if (typeof appendEvent !== 'function') return { refused: false, status: 'skipped:no-port', event };

  let outcome;
  try {
    outcome = appendEvent(event);
  } catch (err) {
    return { refused: true, status: 'refused', event, reason: `ledger port threw on ${eventName}: ${err?.message ?? err}` };
  }
  const refusal = ledgerRefusal(outcome);
  if (refusal) {
    return { refused: true, status: 'refused', event, reason: `ledger refused ${eventName}: ${refusal}` };
  }
  return { refused: false, status: 'appended', event };
}

/**
 * Did the ledger port refuse the event?
 *
 * SAME RULE as `state-manager.js#ledgerRefusal` (aligned 2026-09-03), and it
 * must stay that way: two modules disagreeing about what "the ledger said no"
 * means is how one of them commits a write with no paired event.
 *
 * Both `{ok: false}` and `{appended: false}` count. `ok` is what the real
 * writer returns (`event-writer.js#writeEvent`); `appended` is what simpler
 * in-process ports use. A throw is a refusal either way. A non-object outcome,
 * `undefined` included, is NOT a refusal — a port that returns nothing is the
 * ordinary "appended, nothing to report", and reading silence as failure would
 * fail every such write closed.
 *
 * @param {unknown} outcome
 * @returns {string|null} the reason when refused, else `null`
 */
function ledgerRefusal(outcome) {
  if (!isPlainObject(outcome)) return null;
  if (outcome.appended !== false && outcome.ok !== false) return null;
  const stated = outcome.reason ?? (Array.isArray(outcome.errors) ? outcome.errors.join('; ') : null);
  return typeof stated === 'string' && stated ? stated : 'no reason given';
}

/* ───────────────────────── the BOUND write (SH-11) ─────────────────────────
 *
 * The order is the one `state-manager.js` documents, with the store as the
 * write and `run.json` as the view:
 *
 *   ledger event (worker.claimed / task.released, if a port is injected)
 *     -> ONE store commit of the limb's node   (CAS on state_version, one retry)
 *       -> run.json.lanes[limb] rewritten from that node, `projected_from:'store'`
 *
 * A refusal at any step before the commit leaves run.json byte-identical. A
 * failure AFTER the commit does not undo it: the store is the truth, the
 * result says `projection: 'failed:<why>'`, and the next read answers from the
 * store with the disagreement in `conflicts[]` until a write heals the view.
 *
 * WHAT THIS DOES NOT DO: no lease record is created, renewed or released here.
 * The node carries the liveness (`heartbeat_at`, `owner`, `status`) in the one
 * commit, which is what "fold the lane-lease write" means for a bound run. The
 * lease record is beside the node, not in this write: the bound feed takes it
 * with `claimTask({ status })` so the node keeps the status its ops word derives
 * (a bare `claimTask` would set `claimed` over it — a B1 violation by
 * construction), and the lane-lease sync renews and releases it.
 *
 * The commit itself is `store.updateTask` — ONE `task.upsert`, the node this
 * write planned (SH-11 pre-flip condition 2) — not a graph replacement: the
 * mission row and every sibling node stay exactly as the store holds them.
 */

/** @returns {Readonly<object>} the `{ok:false}` result of a bound write refused before any effect. */
function rejectBound(worker, reason, detail) {
  return Object.freeze({ ok: false, reason, detail, worker, event: null, ledger: 'not-attempted' });
}

/**
 * The StateStore a bound write goes through. Never throws: a store that cannot
 * be opened is a refusal to report, and the caller (a CLI) turns it into exit 1.
 *
 * @param {{ store?: object|null, openStore?: (() => (object|null)) }} p
 * @returns {{ store: object } | { store?: undefined, reason: string, detail: string }}
 */
function acquireStore({ store, openStore }) {
  try {
    const got = store ?? (typeof openStore === 'function' ? openStore() : null);
    if (got && typeof got.getState === 'function' && typeof got.updateTask === 'function') return { store: got };
    return {
      reason: 'store-unavailable',
      detail: 'a bound run writes the StateStore and none was supplied (no store port, or the opener returned none — usually no session id) — run.json left unchanged',
    };
  } catch (err) {
    return { reason: 'store-unavailable', detail: `opening the StateStore threw: ${err?.message ?? err} — run.json left unchanged` };
  }
}

/**
 * The stale guard (④). Turning the canary switch off is safe; turning it back
 * on is not free: while it is off the legacy branch writes `run.json` and never
 * the node, so after off -> on the node's `ops` describes a moment BEFORE the
 * lane's last word. A bound write computes its previous state, its `since` and
 * its ledger key from that node, so it must not build on it.
 *
 * TWO judges, the first of them clock-free (SH-11 pre-flip condition 4):
 *
 * A. THE SEAL (`split-lane-seal.js`). A bound write seals the lane it projects
 *    with the facts it gave it; the legacy path spreads the entry it rewrites, so
 *    the seal survives it while the facts do not. A lane that says something
 *    other than what its seal says was written by something other than the
 *    store's projection since the store last did — drift, judged by comparing two
 *    values the lane holds, and stale whatever the stamps say. That is what a
 *    clock cannot see: a legacy write made with a clock BEHIND the node's, and a
 *    lane edited by hand without touching `updated_at`.
 *
 * B. THE TIMESTAMP CLAUSES, for a lane with no seal (it was never projected — the
 *    backfill case) and as the belt for one that has it. Stale = the node carries
 *    `ops`, the `run.json` lane was NOT projected by the store (`projected_from`
 *    is anything but `'store'`, absent included), and EITHER
 *     (1) the lane's `updated_at` is strictly LATER than the node's, OR
 *     (2) the lane's word differs from `node.ops.state` and the lane's
 *         `updated_at` is strictly later than `node.ops.since`.
 *    Clause (2) exists because `node.updated_at` is not only the bound writer's
 *    stamp: the LEGACY feeder's ownership refresh (`mergeLimbTasks`) also stamps
 *    it, and `dispatch` runs that refresh right AFTER its own lane write — so
 *    (1) alone reads "the node is newer" and misses a drifted lane. `ops.since`
 *    moves only when the bound writer changes the state, and `ops` is never
 *    touched by the legacy path. (`claimTask` / `releaseTask` / `heartbeatWorker`
 *    do not stamp `updated_at`.) Clause (2) does NOT fire on a lane the
 *    projection left BEHIND the node (a projection failure after a commit): that
 *    lane is OLDER than `ops.since`, and the store is the side that is right.
 *
 * What cannot be judged — a node with no `ops` (the lane is then its previous
 * state, the backfill), a lane with no seal and a stamp that is missing or
 * unparseable — is not called stale: a lane written before `updated_at` existed
 * would otherwise brick every bound write of its limb. A lane the projection
 * failed to rewrite is sealed at its LAST projection, so it is not drift either:
 * the store is the side that is right and the next write heals it.
 *
 * WHAT THIS CANNOT SEE: a legacy write that leaves the sealed facts as they were
 * (a re-assert of the same word) made with a clock behind the node's — it moved
 * nothing the node is behind on; and a lane hand-edited to say exactly what it
 * said before.
 *
 * @param {string} worker
 * @param {unknown} laneRaw - `run.json.lanes[worker]` as stored
 * @param {object|null} node
 * @returns {string|null} the refusal detail, or `null` when the node is not behind
 */
function staleLaneDetail(worker, laneRaw, node) {
  if (!isPlainObject(laneRaw) || !isPlainObject(node?.ops)) return null;
  const drift = laneSealDrift(laneRaw);
  if (drift !== null && drift.length > 0) {
    const moved = drift.map((d) => `${d.fact}: ${JSON.stringify(d.sealed)} -> ${JSON.stringify(d.now)}`).join(', ');
    return `run.json lanes.${worker} no longer says what the store last projected into it (${moved}) ${staleWayOut(worker)}`;
  }
  if (laneRaw.projected_from === STORE_PROJECTION_MARK) return null;
  const laneAt = isoMs(laneRaw.updated_at);
  const newerThanNode = laneAt > isoMs(node.updated_at); // NaN compares false: unjudgeable is not stale
  const driftedFromOps = laneRaw.state !== node.ops.state && laneAt > isoMs(node.ops.since);
  if (!newerThanNode && !driftedFromOps) return null;
  const writer = String(laneRaw.projected_from ?? 'unstamped');
  const how = newerThanNode
    ? `was written by the ${writer} path at ${laneRaw.updated_at}, after this node's last update at ${node.updated_at}`
    : `says '${String(laneRaw.state)}' (written by the ${writer} path at ${laneRaw.updated_at}) while this node's ops says '${node.ops.state}' since ${node.ops.since}`;
  return `run.json lanes.${worker} ${how} ${staleWayOut(worker)}`;
}

/** The end of every `binding-stale` detail: why the write was refused and the two deliberate ways out. */
function staleWayOut(worker) {
  return `— the split.missionBinding switch was off in between (or the lane was edited by hand), so node.ops may be behind run.json; run.json and the store were left unchanged. Reconcile deliberately: the store node is canonical for a bound run, so either remove lanes.${worker} from run.json (the node then answers alone) or remove ${MISSION_BINDING_KEY} from plan.json to stay on the legacy path`;
}

/**
 * Plan the node, run the ledger half, commit — with ONE retry on a CAS
 * conflict. The plan is re-derived from the fresh snapshot on the retry (the
 * competing writer may have moved this very limb); the ledger half is not
 * repeated (its key names the transition, so a re-run mints the same one).
 * UNMEASURED under real contention: if the competing commit moved THIS limb,
 * the ledger line already appended names the transition from the state read
 * first, and the retry commits from the state it re-read.
 *
 * KNOWN LEAK (M3): a `planBoundNode` THROW on the second try — B1/B2, or "needs
 * a state", against the state the competing writer left — escapes AFTER the
 * ledger half already ran, so it leaves a `worker.claimed` / `task.released`
 * line with no store commit behind it. `ledger ⊇ store` still holds and a
 * re-run mints the same key, but the line is real. It is not caught here on
 * purpose: a caller error stays loud.
 *
 * The stale guard (④) is judged on EVERY try, against the node that try read.
 *
 * @returns {{ ok: true, planned: object, commit: object, phase: object } | { ok: false, result: Readonly<object> }}
 */
function commitBoundWrite({ paths, plan, binding, store, worker, opsWord, blockedBy, rest, ts, appendEvent, ledger }) {
  const missionId = binding.mission_id;
  const dangling = () => ({
    ok: false,
    result: rejectBound(worker, 'binding-dangling', `mission ${missionId} is not in the StateStore (archived or removed?) — run.json left unchanged; remove ${MISSION_BINDING_KEY} from plan.json to fall back to the legacy path (a handoff to another mission is not implemented)`),
  });
  let snapshot = store.getState();
  if (!snapshot?.active_missions?.[missionId]) return dangling();

  const before = readRunJsonAt(paths);
  const laneRaw = isPlainObject(before?.lanes) ? before.lanes[worker] : undefined;
  const lane = readLaneEntry(laneRaw);
  const ownsList = ownsFromPlan(plan)[worker] ?? [];
  let phase = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const node = snapshot.task_graphs?.[missionId]?.tasks?.find((t) => t?.id === worker) ?? null;
    const behind = staleLaneDetail(worker, laneRaw, node);
    if (behind !== null) return { ok: false, result: rejectBound(worker, 'binding-stale', behind) };
    const planned = planBoundNode({ node, lane, worker, missionId, runId: binding.run_id, opsWord, blockedBy, rest, ts, ownsList });
    if (!planned.ok) return { ok: false, result: rejectBound(worker, planned.reason, planned.detail) };
    if (phase === null) {
      phase = runLedgerPhase({
        paths, worker, eventName: ledgerEventNameFor(planned.prev.state, opsWord), ledgerOpts: ledger, appendEvent,
        transition: { prevOps: planned.prev.state, nextOps: opsWord, prevSince: planned.prev.since, runJsonRunId: before?.runId },
      });
      if (phase.refused) return { ok: false, result: Object.freeze({ ok: false, reason: phase.reason, worker, event: phase.event, ledger: 'refused' }) };
    }
    let commit;
    try {
      // ONE node, ONE `task.upsert` (SH-11 pre-flip condition 2): the mission row
      // and every sibling node stay as they are. The node is the one just planned,
      // so the mutator ignores the stored copy — the CAS on `state_version` is what
      // says the stored copy is still the one the plan was derived from.
      commit = store.updateTask({
        missionId, taskId: worker, mutate: () => planned.node, expectedVersion: snapshot.state_version, reason: BOUND_WRITE_REASON,
      });
    } catch (err) {
      return { ok: false, result: rejectBound(worker, 'store-threw', `the StateStore threw on the commit: ${err?.message ?? err} — run.json left unchanged`) };
    }
    if (commit.ok) return { ok: true, planned, commit, phase };
    if (commit.conflict !== true) return { ok: false, result: rejectBound(worker, 'store-refused', String(commit.errors?.[0] ?? 'the store refused the commit')) };
    if (attempt === 1) break;
    snapshot = store.getState();
    if (!snapshot?.active_missions?.[missionId]) return dangling();
  }
  return { ok: false, result: rejectBound(worker, 'cas-conflict', 'the store moved under this write twice (CAS conflict, retried once) — run.json left unchanged') };
}

/**
 * The `run.json.lanes[limb]` record for a committed node: the shape the legacy
 * writer stamps (`state`, `since`, `window`, `note`, `blocked_by`,
 * `projected_from`, `updated_at`), read FROM the node, with every other key of
 * the existing lane entry and of the patch carried as before.
 */
function projectedLane(atWrite, rest, node, ts) {
  const base = { ...atWrite, ...rest };
  delete base.blocked_by; // the node's blockers are the truth; a stale list must not outlive them
  const { ops } = node;
  const lane = {
    ...base,
    state: ops.state,
    since: ops.since,
    ...(Array.isArray(node.blockers) ? { blocked_by: [...node.blockers] } : {}),
    ...(ops.window ? { window: ops.window } : {}),
    ...(ops.note ? { note: ops.note } : {}),
    projected_from: STORE_PROJECTION_MARK,
    updated_at: ts,
  };
  // SH-11 pre-flip condition 4: seal what was just projected. The legacy path
  // spreads the entry it finds, so the seal outlives a legacy write that changes
  // the facts — which is how the stale guard sees that write without a clock.
  return { ...lane, [LANE_SEAL_KEY]: laneFacts(lane) };
}

/** Write one worker of a BOUND run. See the section comment above. */
function writeBound({ paths, plan, probe, worker, opsWord, blockedBy, rest, ts, appendEvent, ledger, store, openStore, projectRunJson }) {
  if (probe.status !== 'bound') {
    return rejectBound(worker, probe.reason, `plan.json ${MISSION_BINDING_KEY} is unusable (${probe.reason}) — run.json left unchanged; repair the record, or remove it to use the legacy path`);
  }
  const acquired = acquireStore({ store, openStore });
  if (!acquired.store) return rejectBound(worker, acquired.reason, acquired.detail);

  const done = commitBoundWrite({ paths, plan, binding: probe.binding, store: acquired.store, worker, opsWord, blockedBy, rest, ts, appendEvent, ledger });
  if (!done.ok) return done.result;
  const { planned, commit, phase } = done;

  const project = typeof projectRunJson === 'function' ? projectRunJson : (mutate) => updateRunJsonAt(paths, mutate);
  let record = projectedLane({}, rest, planned.node, ts);
  let projection = 'written';
  try {
    project((current) => {
      const lanes = isPlainObject(current.lanes) ? { ...current.lanes } : {};
      const raw = lanes[worker];
      const atWrite = typeof raw === 'string' ? { state: raw } : (isPlainObject(raw) ? raw : {});
      record = projectedLane(atWrite, rest, planned.node, ts);
      lanes[worker] = record;
      return { ...current, lanes };
    });
  } catch (err) {
    projection = `failed:${err?.message ?? err}`;
  }
  return Object.freeze({
    ok: true,
    path: paths.runJsonPath,
    worker,
    opsState: planned.node.ops.state,
    status: planned.node.status,
    record: Object.freeze(record),
    event: phase.event,
    ledger: phase.status,
    source: 'store',
    missionId: probe.binding.mission_id,
    stateVersion: commit.state_version,
    previousOps: planned.prev.state,
    previousSince: planned.prev.since,
    changed: planned.changed,
    projection,
  });
}

/**
 * Write one worker's state. ONE destination: `run.json.lanes[worker]`.
 *
 * The record keeps the shape `scripts/split/lane-state.mjs` writes — `state`
 * in the ops vocabulary, `since` moved only when the state actually changes so
 * a re-assert does not reset the clock — plus `blocked_by` (so the reason
 * survives the ops word's loss and a read round-trips), `projected_from` and
 * `updated_at`. Every other key of the lane entry and of `run.json` is
 * preserved verbatim; live files carry hundreds of free-form lines. The v1.1
 * `status` is deliberately NOT written beside the ops word: two words for one
 * fact in one record is the same defect as two files, one scale down, so
 * readers derive it through `LANE_OPS_TO_V11_STATUS`.
 *
 * ── Ledger first, then the store ──────────────────────────────────────────
 * A transition that owes an event appends it BEFORE `run.json` is touched —
 * the order and the reason of `state-manager.js` ("Write ordering, and why the
 * ledger goes first"). It
 * keeps `ledger ⊇ store` true under a crash: crash between the two and the
 * ledger names a transition the store has not reached, which reconciliation
 * can finish, where the reverse order leaves a state change no history
 * explains. If the port REFUSES (throws, or returns `{appended:false}` /
 * `{ok:false}`), `run.json` is not written and the call returns
 * `{ok:false, reason}`.
 *
 * A SKIP is not a refusal and does not abandon the write: the port was never
 * asked, because none was injected (`skipped:no-port`) or a required value was
 * missing (`skipped:missing:<key>`). Both still write and say so in the
 * return. What that costs, stated plainly: a skipped append is a real hole in
 * `ledger ⊇ store`, and the return value is its ONLY signal — nothing here
 * queues, retries, or back-fills it.
 *
 * Refusals that THROW (caller error, fail-closed):
 *  - a `status` outside the v1.1 vocabulary;
 *  - `status: 'cancelled'`, which has no ops word — recording it as anything
 *    else would put a wrong state on disk;
 *  - an `ops_state` outside the ops allowlist, or one that contradicts the
 *    `status` given alongside it;
 *  - a `now` port that is present but is not a function returning a valid
 *    `Date` — judged by the shared `core/clock.js#readClock`, so no two
 *    modules in this repo can disagree about what a clock is.
 *
 * @param {object} p
 * @param {string} p.runDir
 * @param {string} p.worker - limb name
 * @param {object} [p.patch] - `{ status?, blocked_by?, ops_state?, note?, window?, ...free-form }`. Free-form keys land in the lane record, so ledger identity never travels here.
 * @param {(event: object) => unknown} [p.appendEvent] - ledger port, called with a `writeEvent` input envelope. Injected, never imported: `lib/topology` is L4 and `lib/runtime` is L5.
 * @param {object} [p.ledger] - what the event contract needs and this module cannot derive: `{ session_id, mission_id?, source?, agent_type?, model_tier?, owner?, data? }`. `source` defaults to `'supervisor'`, which is the one value the allowlist accepts for BOTH events.
 * @param {() => Date} [p.now] - clock port. Omit for the wall clock; present-but-wrong throws (`core/clock.js#readClock`, the same judge `state-manager` uses).
 * @param {{ getState: Function, updateTask: Function }} [p.store] - StateStore port. Used ONLY when the run is bound; an unbound run never touches it. A store with no `updateTask` is not a usable port (`store-unavailable`).
 * @param {() => (object|null)} [p.openStore] - lazy alternative to `store`, called only for a bound run, so an unbound write pays nothing (a session id is needed to open a store).
 * @param {(mutate: (current: object) => object) => unknown} [p.projectRunJson] - replaces the run.json read-modify-write of a bound run's projection (a test seam and a rewire point).
 * @param {boolean|(() => boolean)} [p.honorBinding] - the canary switch (`artibot.config.json#split.missionBinding.enabled`), read by the CALLER — this module is L4 and reads no config. Only a literal `true`, or a function returning one, honours a binding; a function is asked lazily, never for a run that carries none. ABSENT MEANS OFF: a run that carries a binding is then written by the legacy branch, exactly as an unbound one, and the result carries `binding: {status:'disabled'}` (an unbound run's result never has the key).
 * @returns {{ ok: true, path: string, worker: string, opsState: string|null, status: string|null, record: object, event: object|null, ledger: string } | { ok: false, reason: string, worker: string, event: object, ledger: 'refused' }} A bound run adds, on success: `source: 'store'`, `missionId`, `stateVersion`, `previousOps`, `previousSince`, `changed`, `projection`; and a third failure shape `{ ok: false, reason, detail, worker, event: null, ledger: 'not-attempted' }` — see the section above.
 */
export function writeWorkerState({ runDir, worker, patch = {}, appendEvent, ledger = {}, now, store, openStore, projectRunJson, honorBinding } = {}) {
  const paths = resolveRunDir(runDir, 'writeWorkerState');
  if (typeof worker !== 'string' || !worker.trim()) throw new TypeError('writeWorkerState: worker is required');
  if (!isPlainObject(patch)) throw new TypeError('writeWorkerState: patch must be a plain object');
  if (!isPlainObject(ledger)) throw new TypeError('writeWorkerState: ledger must be a plain object');

  const { opsWord, blockedBy, rest } = resolveWriteOps(patch);
  const ts = readClock(now, 'writeWorkerState');

  // SH-11: a run that carries a binding AND whose caller honours it is written
  // through its StateStore and NEVER through the legacy branch below — not on a
  // damaged binding, not on a missing store. The canary switch is decided FIRST,
  // by presence of the record alone: with it off, a bound run — a damaged one
  // included, the feature being off — is written by the legacy branch exactly as
  // an unbound one, and the result says `binding: {status:'disabled'}`. Only an
  // unbound or switched-off run reaches the code that follows, which is why
  // that code is unchanged.
  const plan = readJsonObjectOrNull(paths.planJsonPath);
  const carriesBinding = isPlainObject(plan) && Object.hasOwn(plan, MISSION_BINDING_KEY);
  if (carriesBinding && honorsBinding(honorBinding)) {
    return writeBound({ paths, plan, probe: probeBinding(paths, plan), worker, opsWord, blockedBy, rest, ts, appendEvent, ledger, store, openStore, projectRunJson });
  }
  const switchedOff = carriesBinding ? { binding: BINDING_DISABLED } : {};

  // The previous ops word decides whether an event is owed, and the ledger
  // goes first, so `run.json` is read before it is written. The two reads are
  // not atomic — see the concurrency note in the tests' "does not cover" list.
  const before = readRunJsonAt(paths);
  const prevRaw = isPlainObject(before?.lanes) ? before.lanes[worker] : undefined;
  const prevOps = typeof prevRaw === 'string'
    ? prevRaw
    : (isPlainObject(prevRaw) && typeof prevRaw.state === 'string' ? prevRaw.state : null);
  const nextOps = opsWord ?? prevOps;
  const prevSince = isPlainObject(prevRaw) && typeof prevRaw.since === 'string' ? prevRaw.since : null;

  const phase = runLedgerPhase({
    paths, worker, eventName: ledgerEventNameFor(prevOps, opsWord), ledgerOpts: ledger, appendEvent,
    transition: { prevOps, nextOps: opsWord, prevSince, runJsonRunId: before?.runId },
  });
  if (phase.refused) {
    return Object.freeze({ ok: false, reason: phase.reason, worker, event: phase.event, ledger: 'refused', ...switchedOff });
  }

  let record = null;
  updateRunJsonAt(paths, (current) => {
    const lanes = isPlainObject(current.lanes) ? { ...current.lanes } : {};
    const atWriteRaw = lanes[worker];
    const atWrite = typeof atWriteRaw === 'string' ? { state: atWriteRaw } : (isPlainObject(atWriteRaw) ? atWriteRaw : {});
    const changed = Boolean(nextOps) && nextOps !== (typeof atWrite.state === 'string' ? atWrite.state : null);

    record = {
      ...atWrite,
      ...rest,
      ...(nextOps ? { state: nextOps } : {}),
      ...(blockedBy ? { blocked_by: blockedBy } : {}),
      since: changed || typeof atWrite.since !== 'string' ? ts : atWrite.since,
      projected_from: PROJECTION_MARK,
      updated_at: ts,
    };
    lanes[worker] = record;
    return { ...current, lanes };
  });

  return Object.freeze({
    ok: true,
    path: paths.runJsonPath,
    worker,
    opsState: typeof record.state === 'string' ? record.state : null,
    status: typeof record.state === 'string' ? (LANE_OPS_TO_V11_STATUS[record.state] ?? null) : null,
    record: Object.freeze(record),
    event: phase.event,
    ledger: phase.status,
    ...switchedOff,
  });
}
