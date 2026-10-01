#!/usr/bin/env node
/**
 * `/split lease-tick` — the lane-lease WRITER: the heartbeat that keeps a live
 * lane's lease alive (SH-12) and the release of ids a human confirmed (CA-09).
 *
 *   node scripts/split/lease-tick.mjs [--parent <root>] [--run-id <id>] [--store-dir <dir>] [--json]
 *                                     [--apply-reclaim <mission/task[,mission/task...]>]
 *
 * WHY A SCRIPT OF ITS OWN. `watch.mjs` is autonomy S0 — display and warn only
 * (design §03) — and design §9 names the lease emitters (hooks and
 * `lane-state.mjs`) without it. So the writes live here and `watch` only LISTS
 * what this script would act on. This script reuses `watch.mjs#collect` to
 * observe the lanes (ops word, lane-state time, trailer, lock pid), then writes.
 *
 * ── Root cause ────────────────────────────────────────────────────────────
 * The lane lease `task-feed.mjs` takes at dispatch (24h TTL) was renewed only
 * at a moment the leader declares — `lane-state`, or a re-dispatch — never on
 * a clock, and a lapsed lease was never looked at. Run this from a Monitor
 * every ~15 minutes.
 *
 * ── HEARTBEAT ─────────────────────────────────────────────────────────────
 * A lane is renewed — through `lane-lease.mjs#syncLaneLease`, imported and not
 * re-implemented — once min(ttl/3, 45 min) has passed since the lease's last
 * beat (`lib/topology/lease-reclaim.js#heartbeatCadence`), and ONLY with
 * positive liveness evidence (`classifyLaneLiveness`, ADV-4): the worktree
 * lock's pid is alive, or — with no lock line — the leader's lane-state
 * activity (`run.json.lanes[limb].updated_at`) is inside the TTL window. The
 * ops word `active` alone proves nothing; a lane with neither evidence is not
 * renewed, so its lease lapses into the report. A poll is stateless (the age is
 * read from the lease), so the rhythm of the caller does not matter and a tick
 * that is not due writes nothing. A `suspended` lane is neither renewed nor
 * reported (ADV-3); `done` is NOT released from here — that is `lane-state`'s.
 * LIMIT, unmeasured: the pid probe has no start-time check, so a dead session
 * whose pid the OS reused reads as alive until its lock line goes.
 *
 * ── What a tick writes (and why the ledger is not silent) ─────────────────
 * Each renewal is a store commit stamped `heartbeat_source: 'lease-tick'`
 * with ledger reason `split.lease-tick` — told apart from the lane-state
 * emitter's `lane-heartbeat` / `split.lane-lease`. The canon (design D11, §9)
 * wants heartbeats in the store only; the store appends its own `state.updated`
 * for EVERY commit (`ledger ⊇ store`, no opt-out in `state-manager.js`), and a
 * no-op ledger port would make every tick an `extraInStore` version that
 * `/doctor` Check 8 reads as a lost update. So a tick costs one pairing row,
 * at most 32 per lane-day, and D11's store-only mode is a `state-manager.js`
 * change (not this script's) — see `lib/topology/lease-reclaim.js`.
 *
 * ── RECLAIM: explicit ids only (ADV-1) ────────────────────────────────────
 * `watch.mjs` (or this script without the flag) prints the lapsed lane leases
 * as `<mission>/<task>` ids. `--apply-reclaim <id,...>` releases ONLY the ids
 * you list — and only those still expired after a fresh read, not held back
 * (a live lane, a suspended one), and still held by the same owner. There is no
 * release-all: with no list, an empty list or one malformed id the whole run is
 * REFUSED (exit 1, nothing read or written). No config key; the human's list is
 * the confirmation the canon asks for before GA.
 *
 * ── Fail-open, and the exit code ──────────────────────────────────────────
 * Exit 1 only for a refused invocation. Everything else — no session id, a
 * store that throws, a foreign holder, no lease — is an outcome in the output
 * and exit 0, like `lane-lease.mjs` (record-only). The legacy mission rule is
 * per SESSION: after a leader restart the new session id owns no mission row
 * and every renewal reads `skipped:no-mission` (reported, not fixed). A BOUND
 * run (SH-11 canary ON) has no lane lease — the bound feeder never claims — so
 * its lanes read `skipped:no-lease`.
 *
 * @module scripts/split/lease-tick
 */

import path from 'node:path';
import {
  classifyLaneLiveness,
  HEARTBEAT_INTERVAL_DIVISOR,
  HEARTBEAT_MAX_INTERVAL_MS,
  heartbeatCadence,
  LEASE_TICK_REASON,
  LEASE_TICK_SOURCE,
  parseReclaimIds,
  reclaimExpiredLaneLeases,
} from '../../lib/topology/lease-reclaim.js';
import { isMainEntry } from '../hooks/_main-entry.js';
import { syncLaneLease } from './lane-lease.mjs';
import { openFeedStore, sessionIdFromEnv } from './task-feed.mjs';
import { annotateCandidates, collect, fmtAge, keepAliveLanes, renderReclaimLines, sharedStorePorts } from './watch.mjs';

export const HELP = `usage: node scripts/split/lease-tick.mjs [--parent <root>] [--run-id <id>] [--store-dir <dir>] [--json]
                                        [--apply-reclaim <mission/task[,mission/task...]>]

  (no flags)        renew the lease of every working lane that has liveness evidence, once it is due
                    (min(ttl/3, 45 min) since its last beat); print what lapsed. Nothing is released.
  --apply-reclaim   release ONLY the listed ids (the ids the report printed), each only if it is still expired
                    and not held back. With no list, an empty list or a malformed id the run is REFUSED.
  --parent <root>   parent (main checkout) root — default: cwd
  --run-id <id>     run id (default: run.json / plan.json)
  --store-dir <dir> split store dir for the supervisor cache (default: runtime/split/)
  --json            machine output

Exit 1 only for a refused invocation; every other outcome is printed and exits 0.`;

/** Prefix of the refusal the cadence gate returns through `heartbeatWorker`'s `errors[0]`. */
const CADENCE_REFUSAL = 'cadence';

/**
 * Strict, like `lane-state`: an action tool does not guess. `--apply-reclaim`
 * takes a comma list (the flag may repeat); its ids are validated here, so a
 * refused list never reaches a store.
 *
 * @param {string[]} argv
 * @returns {{ json: boolean, runId: string|null, parent: string, storeDir: string|undefined, help?: true, applyIds?: string[] }}
 * @throws {Error} On an unknown option, a positional, a flag missing its value, or an unusable id list.
 */
export function parseArgs(argv) {
  const out = { json: false, runId: null, parent: process.cwd(), storeDir: undefined };
  const withValue = { '--run-id': 'runId', '--parent': 'parent', '--store-dir': 'storeDir' };
  let listed = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--json') out.json = true;
    else if (a === '--apply-reclaim') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        throw new Error('--apply-reclaim requires <mission/task[,mission/task...]> — the ids the report printed; there is no release-all');
      }
      listed = [...(listed ?? []), ...v.split(',').map((s) => s.trim()).filter(Boolean)];
      i += 1;
    } else if (withValue[a]) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} requires a value`);
      out[withValue[a]] = v;
      i += 1;
    } else if (a.startsWith('--')) throw new Error(`unknown option: ${a}`);
    else throw new Error(`unexpected argument: ${a}`);
  }
  if (listed !== null) {
    const parsed = parseReclaimIds(listed);
    if (!parsed.ok) throw new Error(`--apply-reclaim: ${parsed.error}`);
    out.applyIds = parsed.ids;
  }
  out.parent = path.resolve(out.parent);
  if (out.storeDir) out.storeDir = path.resolve(out.storeDir);
  return out;
}

/**
 * The cadence gate: a view of `store` whose `heartbeatWorker` passes only when
 * the lease it is about to renew is due (`heartbeatCadence`), and stamps what it
 * lets through as a TICK (`heartbeatSource`, `reason`). Every other method is
 * the store's own, so `syncLaneLease` still owns the mission, the owner check,
 * the no-lease and held-by outcomes and the fail-open contract — and this file
 * calls no `resolveRunMission` (`tests/firewall/split-state-binding.test.js`
 * pins its two callers). A refusal is `{ok:false, errors:['cadence:<why>']}`;
 * `syncLaneLease` reports it as `refused:cadence:<why>`, which the caller turns
 * back into a `skipped:` outcome. The verdict it judged on is left in `seen`
 * (by task id) for the output.
 *
 * @param {object} store - StateStore.
 * @param {{ nowMs: number, seen: Map<string, object> }} ctx
 * @returns {object}
 */
function gateCadence(store, { nowMs, seen }) {
  return {
    ...store,
    heartbeatWorker: (params) => {
      const verdict = heartbeatCadence(store.getLease(params.missionId, params.taskId), nowMs);
      seen.set(params.taskId, verdict);
      if (!verdict.due) return { ok: false, conflict: false, errors: [`${CADENCE_REFUSAL}:${verdict.reason}`] };
      return store.heartbeatWorker({ ...params, heartbeatSource: LEASE_TICK_SOURCE, reason: LEASE_TICK_REASON });
    },
  };
}

/** @param {object} verdict - A `heartbeatCadence` answer. @returns {object} Its judged numbers, without the undefined ones. */
function verdictDetail(verdict) {
  const out = { reason: verdict.reason };
  for (const key of ['ageMs', 'intervalMs', 'ttlMs', 'expired']) if (verdict[key] !== undefined) out[key] = verdict[key];
  return out;
}

/**
 * One row of the heartbeat report.
 *
 * @param {{ limb: string|null, opsState: string|null, working: boolean, renew: boolean, evidence: string|null }} plan
 * @param {string} outcome
 * @param {object} [extra]
 * @returns {object}
 */
function laneRow(plan, outcome, extra = {}) {
  return {
    limb: plan.limb, opsState: plan.opsState, working: plan.working, renew: plan.renew, evidence: plan.evidence, outcome, missionId: null, ...extra,
  };
}

/**
 * Renew the lease of every lane that is working AND has liveness evidence,
 * once it is due. Never throws; every refusal is an outcome string.
 *
 * The write is `lane-lease.mjs#syncLaneLease` — imported, not re-implemented —
 * with the cadence gate on its store port (see {@link gateCadence}). One lane,
 * one `syncLaneLease` call, one commit when due and none when not.
 *
 * @param {{ parent?: string, lanes?: unknown[], nowMs?: number, ports?: { openStore?: Function, sessionId?: string|null, config?: object|null } }} [input]
 *   `ports` is the test seam: `openStore(root, sid)`, `sessionId` (absent = the host env; `''` = none) and `config`
 *   (the parsed artibot.config.json the canary key is read from; absent = the shipped file).
 * @returns {{ available: boolean, reason: string|null, divisor: number, maxIntervalMs: number, renewable: number, renewed: number,
 *   lanes: Array<{ limb: string|null, opsState: string|null, working: boolean, renew: boolean, evidence: string|null, outcome: string, missionId: string|null, detail?: object, binding?: object }> }}
 *   Outcomes: `renewed` | `skipped:not-due` | `skipped:<classifyLaneLiveness reason>` | any `syncLaneLease` outcome
 *   (`skipped:no-lease`, `skipped:no-mission`, `held-by:<owner>`, `refused:<msg>`, `skipped:store-threw:<msg>`, …) |
 *   `skipped:no-session-id`. `available` is false when a renewable lane could not be tried (`reason` says why).
 */
export function renewLaneHeartbeats({ parent, lanes, nowMs, ports = {} } = {}) {
  const plans = (Array.isArray(lanes) ? lanes : []).map((l) => ({
    limb: typeof l?.limb === 'string' ? l.limb : null,
    opsState: typeof l?.opsState === 'string' ? l.opsState : null,
    ...classifyLaneLiveness(l, { nowMs }),
  }));
  const renewable = plans.filter((p) => p.renew).length;
  const out = { available: true, reason: null, divisor: HEARTBEAT_INTERVAL_DIVISOR, maxIntervalMs: HEARTBEAT_MAX_INTERVAL_MS, renewable, renewed: 0, lanes: [] };
  const skipped = (p) => laneRow(p, `skipped:${p.reason}`);
  if (renewable === 0) return { ...out, lanes: plans.map(skipped) };
  try {
    const sid = ports.sessionId ?? sessionIdFromEnv();
    if (typeof sid !== 'string' || sid === '') {
      return { ...out, available: false, reason: 'no-session-id', lanes: plans.map((p) => (p.renew ? laneRow(p, 'skipped:no-session-id') : skipped(p))) };
    }
    const seen = new Map();
    const open = ports.openStore ?? openFeedStore;
    const gated = { openStore: (root, s) => gateCadence(open(root, s), { nowMs, seen }), config: ports.config };
    let renewed = 0;
    const rows = plans.map((p) => {
      if (!p.renew) return skipped(p);
      const r = syncLaneLease({ parentRoot: parent, limb: p.limb, state: p.opsState, sessionId: sid }, gated);
      const verdict = seen.get(p.limb);
      seen.delete(p.limb);
      const gate = `refused:${CADENCE_REFUSAL}:`;
      let outcome = r.outcome;
      if (outcome.startsWith(gate)) {
        const why = outcome.slice(gate.length);
        outcome = why === 'fresh' ? 'skipped:not-due' : `skipped:${why}`;
      }
      if (outcome === 'renewed') renewed += 1;
      return laneRow(p, outcome, {
        missionId: r.missionId ?? null,
        ...(verdict ? { detail: verdictDetail(verdict) } : {}),
        ...(r.binding ? { binding: r.binding } : {}),
      });
    });
    return { ...out, renewed, lanes: rows };
  } catch (err) {
    return { ...out, available: false, reason: `threw:${err?.message ?? 'unknown'}`, lanes: plans.map((p) => (p.renew ? laneRow(p, 'skipped:threw') : skipped(p))) };
  }
}

/**
 * Release the LISTED lapsed lane leases (ADV-1). Never throws. A malformed or
 * empty list is refused before the store is opened; the lanes a tick keeps
 * alive or holds (`keepAliveLanes` — the same rule the `watch` report uses) are
 * handed to the scan as `keepAlive`, so a listed id that is held back answers
 * `skipped:protected`.
 *
 * @param {{ parent?: string, lanes?: unknown[], nowMs?: number, ids?: string[], ports?: { openStore?: Function, sessionId?: string|null } }} [input]
 * @returns {{ mode: 'apply'|'refused', available: boolean, reason: string|null, applied: boolean, scanned: object, live: number, liveIds: string[],
 *   protected: object[], candidates: object[], malformed: object[], results: object[] }}
 */
export function applyLeaseReclaim({ parent, lanes, nowMs, ids, ports = {} } = {}) {
  const base = {
    mode: 'apply',
    available: true,
    reason: null,
    applied: false,
    scanned: { missions: 0, leases: 0, laneLeases: 0 },
    live: 0,
    liveIds: [],
    protected: [],
    candidates: [],
    malformed: [],
    results: [],
  };
  const listed = parseReclaimIds(ids);
  if (!listed.ok) return { ...base, mode: 'refused', reason: listed.error };
  try {
    const sid = ports.sessionId ?? sessionIdFromEnv();
    if (typeof sid !== 'string' || sid === '') return { ...base, available: false, reason: 'no-session-id' };
    const store = (ports.openStore ?? openFeedStore)(parent, sid);
    const report = reclaimExpiredLaneLeases({ store, nowMs, keepAlive: keepAliveLanes(lanes, nowMs), apply: true, ids: listed.ids });
    return { ...base, ...report, candidates: annotateCandidates(report.candidates, lanes), available: true };
  } catch (err) {
    return { ...base, available: false, reason: `store-threw:${err?.message ?? 'unknown'}` };
  }
}

/**
 * One tick: observe the lanes (`watch.mjs#collect`), renew what is due, and —
 * only with `applyIds` — release the listed ids. Without `applyIds` the reclaim
 * block is the same read-only report `watch` prints.
 *
 * @param {{ parent: string, runId?: string|null, nowMs?: number, storeDir?: string, applyIds?: string[], ports?: object }} opts
 * @returns {Promise<{ at: string, parent: string, runId: string|null, missing: string[], leases: { heartbeat: object, reclaim: object } }>}
 */
export async function tick({ parent, runId = null, nowMs = Date.now(), storeDir, applyIds, ports = {} }) {
  const shared = sharedStorePorts(ports);
  const dashboard = await collect({ parent, runId, nowMs, storeDir, ports: shared });
  const heartbeat = renewLaneHeartbeats({ parent, lanes: dashboard.lanes, nowMs, ports: shared });
  const reclaim = applyIds === undefined
    ? dashboard.leases.reclaim
    : applyLeaseReclaim({ parent, lanes: dashboard.lanes, nowMs, ids: applyIds, ports: shared });
  return { at: new Date(nowMs).toISOString(), parent, runId: dashboard.runId, missing: dashboard.missing, leases: { heartbeat, reclaim } };
}

/**
 * What follows a working lane's outcome in the heartbeat block: the numbers a
 * not-due lane was judged on, or what a renewal rested on. Pure and total.
 *
 * @param {{ outcome?: string, evidence?: string|null, detail?: object }} lane - One `renewLaneHeartbeats` row.
 * @returns {string}
 */
function laneNote(lane) {
  const d = lane.detail;
  if (lane.outcome === 'skipped:not-due' && d) return ` (last beat ${fmtAge(d.ageMs)} ago, due after ${fmtAge(d.intervalMs)})`;
  if (lane.outcome === 'renewed') return `${lane.evidence ? ` (evidence: ${lane.evidence})` : ''}${d?.expired ? ' (the lease had already lapsed)' : ''}`;
  return '';
}

/**
 * The heartbeat block of a tick's text output: one line per WORKING lane under
 * a header, nothing when no lane is working. Pure and total.
 *
 * @param {object} hb - `tick().leases.heartbeat`
 * @returns {string[]}
 */
function heartbeatLines(hb) {
  if (hb.available === false) return [`lease heartbeat: not run (${hb.reason ?? 'unavailable'})`];
  const working = (Array.isArray(hb.lanes) ? hb.lanes : []).filter((l) => l?.working);
  if (working.length === 0) return [];
  const cap = Number.isFinite(hb.maxIntervalMs) ? Math.round(hb.maxIntervalMs / 60000) : 45;
  return [
    `lease heartbeat (every min(ttl/${hb.divisor ?? 3}, ${cap}m), only with liveness evidence): renewed ${hb.renewed} of ${hb.renewable} renewable lane(s)`,
    ...working.map((l) => `  ${l.limb}: ${l.outcome}${laneNote(l)}`),
  ];
}

/**
 * The lines of a tick's text output. Quiet when there is nothing to say: no
 * working lane and nothing lapsed print nothing. Pure and total.
 *
 * @param {{ heartbeat?: object|null, reclaim?: object|null }|null|undefined} leases - `tick().leases`
 * @returns {string[]}
 */
export function renderTickLines(leases) {
  const lines = [];
  const hb = leases?.heartbeat;
  if (hb && typeof hb === 'object') lines.push(...heartbeatLines(hb));
  const rc = leases?.reclaim;
  if (rc && typeof rc === 'object' && (rc.mode === 'apply' || rc.mode === 'refused')) {
    const results = Array.isArray(rc.results) ? rc.results : [];
    if (rc.mode === 'refused') lines.push(`lease reclaim [apply]: refused (${rc.reason ?? 'no usable list'})`);
    else if (rc.available === false) lines.push(`lease reclaim [apply]: not run (${rc.reason ?? 'unavailable'})`);
    else {
      const done = results.filter((r) => typeof r?.outcome === 'string' && r.outcome.startsWith('reclaimed:')).length;
      lines.push(`lease reclaim [apply]: reclaimed ${done} of ${results.length} listed`);
      for (const r of results) lines.push(`  ${r.id}: ${r.outcome}`);
      const listedIds = new Set(results.map((r) => r.id));
      const others = (Array.isArray(rc.candidates) ? rc.candidates : []).filter((c) => !listedIds.has(c.id));
      if (others.length > 0) lines.push(`  (${others.length} other expired lease(s) left untouched: ${others.map((c) => c.id).join(', ')})`);
    }
  } else {
    lines.push(...renderReclaimLines(rc));
  }
  return lines;
}

/**
 * @param {Awaited<ReturnType<typeof tick>>} r
 * @returns {string}
 */
function renderTick(r) {
  const lines = [`lease-tick ${r.at}  runId=${r.runId ?? '(runId 미확인)'}  parent=${r.parent}`];
  if (r.missing.length) lines.push(`missing: ${r.missing.join('; ')}`);
  const body = renderTickLines(r.leases);
  lines.push(...(body.length ? body : ['nothing due: no working lane needs a heartbeat and no lapsed lease to report']));
  return lines.join('\n');
}

/**
 * CLI entry. Returns the exit code: 1 for a refused invocation, 0 otherwise.
 *
 * @param {string[]} argv
 * @param {{ nowMs?: number, ports?: object, stdout?: (s: string) => void, stderr?: (s: string) => void }} [opts] - Test seams.
 * @returns {Promise<number>}
 */
export async function main(argv, opts = {}) {
  const out = opts.stdout ?? ((s) => process.stdout.write(s));
  const err = opts.stderr ?? ((s) => process.stderr.write(s));
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err(`lease-tick refused: ${e.message}\n${HELP}\n`);
    return 1;
  }
  if (args.help) {
    out(`${HELP}\n`);
    return 0;
  }
  try {
    const r = await tick({ ...args, nowMs: opts.nowMs, ports: opts.ports });
    out(args.json ? `${JSON.stringify(r, null, 2)}\n` : `${renderTick(r)}\n`);
  } catch (e) {
    out(`lease-tick: could not run — ${e?.message ?? e}\n`);
  }
  return 0;
}

if (isMainEntry(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
