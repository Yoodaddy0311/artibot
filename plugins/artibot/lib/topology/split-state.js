/**
 * `split-state.js` — the ONE reader/writer adapter for "what is this worker
 * doing right now" in a `/split` run (PRD T-46; v1.1 P1 #14 takes this name).
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 * The same question has three answers on disk today (lane-5 §2-D):
 *
 *   1. a StateStore / `state.yaml.workers`  — the design's canonical "now",
 *      NOT BUILT YET (T-21). Reached here only through an injected port.
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
 * Writing is narrower than reading: {@link writeWorkerState} writes exactly
 * ONE place, `run.json.lanes[worker]`, stamped `projected_from: 'run.json'`.
 * When the StateStore lands the write target flips to it and `run.json.lanes`
 * becomes the projection — the direction reverses, the "exactly one writer"
 * rule does not.
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
 *    injected ports. Nothing here proves those readers exist or work; today
 *    exactly zero callers pass any of them — this module is written ahead of
 *    its consumers.
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
import { readRunJson, updateRunJson } from '../git/split-run-file.js';
import { isLaneOpsState, isV11Status, LANE_OPS_STATES, LANE_OPS_TO_V11_STATUS } from '../supervisor/contracts.js';
// The `now` port contract has ONE judge, and it is not this file: rather than
// keep a second copy of the same nine lines, L4 imports the definition, which
// lives at `lib/core/clock.js` (L1) since 2026-09-03 — `unified-verifier.js`
// only re-exports it (`:444`). Imported from the definition site, not through
// the re-export: a clock is a core leaf, and routing through a verification
// module would make this file depend on a verifier it does not otherwise use.
import { readClock } from '../core/clock.js';
import {
  isPlainObject,
  normalizeEvents,
  normalizeRunJson,
  normalizeStore,
  ownsFromPlan,
  stringList,
  V11_TO_OPS_WORDS,
} from './split-state-sources.js';

/**
 * Read priority, highest first. `'store'` stands for the not-yet-built
 * StateStore / `state.yaml` (T-21); the token is the design's, not a file's.
 */
export const STATE_SOURCES = Object.freeze(['store', 'run.json', 'events']);

/** Value of the `projected_from` stamp {@link writeWorkerState} writes. */
export const PROJECTION_MARK = 'run.json';

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

/* ──────────────────────────────── helpers ───────────────────────────────── */

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
 * @param {object} p
 * @param {string} p.runDir - the `/split` run directory (holds `plan.json`, `run.json`)
 * @param {(ctx: { runDir: string }) => unknown} [p.storeReader] - StateStore port; absent -> that source contributes nothing
 * @param {(ctx: { runDir: string }) => unknown} [p.eventsReader] - reduced supervisor state port; absent -> no-op
 * @param {(worker: string, ctx: { runDir: string }) => (string|null|undefined)} [p.commitReader] - git `%cI` port; absent -> no commit component
 * @returns {{ workers: Readonly<Record<string, WorkerRecord>>, source: string|null, conflicts: ReadonlyArray<StateConflict> }}
 */
export function readWorkerState({ runDir, storeReader, eventsReader, commitReader } = {}) {
  const paths = resolveRunDir(runDir, 'readWorkerState');
  const ctx = Object.freeze({ runDir: paths.dir });
  const planOwns = ownsFromPlan(readJsonObjectOrNull(paths.planJsonPath));

  const layers = [
    { source: 'store', workers: normalizeStore(typeof storeReader === 'function' ? storeReader(ctx) : null) },
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

    collectConflict(conflicts, name, 'status', present
      .filter((l) => typeof l.workers[name].status === 'string')
      .map((l) => ({ source: l.source, value: l.workers[name].status })));

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
  });
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
 * @returns {{ ok: true, envelope: object } | { ok: false, missing: string }}
 */
function buildLedgerPayload({ eventName, worker, ledgerOpts, owns }) {
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
 * @returns {{ refused: boolean, status: string, event: object|null, reason?: string }}
 */
function runLedgerPhase({ paths, worker, eventName, ledgerOpts, appendEvent }) {
  if (!eventName) return { refused: false, status: 'skipped:no-event', event: null };

  const planOwns = ownsFromPlan(readJsonObjectOrNull(paths.planJsonPath));
  const owns = Object.prototype.hasOwnProperty.call(planOwns, worker) ? planOwns[worker] : null;
  const built = buildLedgerPayload({ eventName, worker, ledgerOpts, owns });
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
 * @returns {{ ok: true, path: string, worker: string, opsState: string|null, status: string|null, record: object, event: object|null, ledger: string } | { ok: false, reason: string, worker: string, event: object, ledger: 'refused' }}
 */
export function writeWorkerState({ runDir, worker, patch = {}, appendEvent, ledger = {}, now } = {}) {
  const paths = resolveRunDir(runDir, 'writeWorkerState');
  if (typeof worker !== 'string' || !worker.trim()) throw new TypeError('writeWorkerState: worker is required');
  if (!isPlainObject(patch)) throw new TypeError('writeWorkerState: patch must be a plain object');
  if (!isPlainObject(ledger)) throw new TypeError('writeWorkerState: ledger must be a plain object');

  const { opsWord, blockedBy, rest } = resolveWriteOps(patch);
  const ts = readClock(now, 'writeWorkerState');

  // The previous ops word decides whether an event is owed, and the ledger
  // goes first, so `run.json` is read before it is written. The two reads are
  // not atomic — see the concurrency note in the tests' "does not cover" list.
  const before = readRunJsonAt(paths);
  const prevRaw = isPlainObject(before?.lanes) ? before.lanes[worker] : undefined;
  const prevOps = typeof prevRaw === 'string'
    ? prevRaw
    : (isPlainObject(prevRaw) && typeof prevRaw.state === 'string' ? prevRaw.state : null);
  const nextOps = opsWord ?? prevOps;

  const phase = runLedgerPhase({
    paths, worker, eventName: ledgerEventNameFor(prevOps, opsWord), ledgerOpts: ledger, appendEvent,
  });
  if (phase.refused) {
    return Object.freeze({ ok: false, reason: phase.reason, worker, event: phase.event, ledger: 'refused' });
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
  });
}
