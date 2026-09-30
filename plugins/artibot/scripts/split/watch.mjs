#!/usr/bin/env node
/**
 * `/split watch` — supervisor dashboard (PR-SV02). It observes; since SH-12 it
 * also keeps the working lanes' leases alive and reports the lapsed ones (see
 * "Lease" below — the lines that used to say "read-only, S0" no longer hold).
 *
 *   node scripts/split/watch.mjs [--json] [--run-id <id>] [--parent <root>] [--store-dir <dir>]
 *                                [--no-heartbeat] [--apply-reclaim]
 *
 * `--store-dir` overrides the split store dir (`runtime/split/` under the
 * plugin root by default) — the same seam `split-telemetry.js` exposes so
 * tests never touch the real store.
 *
 * Reads, in order of trust (design §03):
 *   1. `<parent>/.artibot/split/plan.json` + `run.json` (both optional; what
 *      is missing is said, never guessed)
 *   2. git — `lib/git/limb-completion.js#readPlanCompletion` (trailer), last
 *      commit time per limb branch (`git log -1 --format=%cI`), worktree lock
 *      + dirtiness (`git worktree list --porcelain`, `git status --porcelain`)
 *   3. the two event streams under the split store dir, replayed through
 *      `lib/supervisor/run-store.js#rebuildState`
 *
 * and prints the design §08 table: limb · ops state · supervisor state ·
 * complete/reason · last commit age · heartbeat age · health, followed by the
 * `commands/split.md` "측정 고지" values raw (`humanWaitPct` `null` stays
 * `null`).
 *
 * Side effects: (1) `rebuildState` rewrites `<storeDir>/{runId}.state.json` (a
 * cache of the append-only streams); (2) the lease heartbeat below — one
 * StateStore commit per lease it renews, off with `--no-heartbeat`; (3) a lease
 * RELEASE, only with `--apply-reclaim`. No git mutation, no session contact, no
 * telemetry write. Exit code is always 0: an observer that fails to observe
 * says so on stdout and leaves.
 *
 * ── Lease: heartbeat (SH-12) and reclaim report (CA-09) ───────────────────
 * Root cause: the lane lease `task-feed.mjs` takes at dispatch (24h TTL) was
 * renewed only at a moment the leader declares — `lane-state`, or a
 * re-dispatch — never on a clock, and a lapsed lease was never looked at. One
 * poll of this dashboard is now the clock:
 *
 *  - HEARTBEAT. A lane that is WORKING — its ops word is one
 *    `lane-lease.mjs#LANE_LEASE_ACTIONS` classifies `heartbeat` (active,
 *    review, serial-gate, closing) — and is not known finished (trailer
 *    `complete`, supervisor DONE) or dead (`sessionPresent === false`) has its
 *    lease renewed THROUGH `syncLaneLease`, once ttl/3 of the lease's own
 *    granted span has passed since its last beat
 *    (`lib/topology/lease-reclaim.js#heartbeatCadence`). A poll is stateless —
 *    the age is read from the lease — so any polling rhythm works, and a poll
 *    that is not due writes nothing. With the shipped 24h TTL the first renewal
 *    is at 8h; `LIMB_LEASE_TTL_MS` says to shorten it only together with an
 *    emitter, which this now is. Not renewed, and said per lane: a non-working
 *    ops word (`done` is NOT released from here — that is `lane-state`'s),
 *    a finished lane, a dead session. A dead session is not renewed because a
 *    heartbeat is a claim of liveness and the observer has evidence against it.
 *  - NO SECOND MISSION RULE. `resolveRunMission` has exactly two production
 *    callers, pinned by `tests/firewall/split-state-binding.test.js`; this file
 *    is not one. The cadence gate sits on the store PORT handed to
 *    `syncLaneLease`: it lets `heartbeatWorker` through only when the lease it
 *    is about to renew is due. The mission, the owner check, the no-lease and
 *    held-by-another outcomes, the `split.lane-lease` reason and the fail-open
 *    contract all stay `lane-lease.mjs`'s.
 *  - RECLAIM REPORT. The lapsed lane leases no lane keeps alive, from
 *    `lib/topology/lease-reclaim.js`, in the output of every poll. REPORT-ONLY:
 *    nothing is released unless `--apply-reclaim` — the human confirmation the
 *    canon asks for before GA. There is no config key; both switches are flags.
 *  - Both need a session id (the store stamps its ledger envelopes with one);
 *    without it the output says `no-session-id` instead of guessing. The legacy
 *    mission rule is per session, so the heartbeat reaches a lane's lease only
 *    from the session that dispatched it. A BOUND run (SH-11 canary ON) has no
 *    lane lease — the bound feeder never claims — so its lanes answer
 *    `skipped:no-lease`.
 *
 * Session presence is inferred from the worktree lock line
 * (`locked claude session <name> (pid N)`) plus a `kill(pid, 0)` liveness
 * probe. A dead pid with a lingering lock (measured 2026-09-02 on Ontology:
 * 5 locks, 5 dead pids) reads as `present: false`.
 *
 * Config (read with defaults; keys proposed in laneC-notes.md):
 *   `split.supervisor.suspectHeartbeatSeconds` (480)
 *   `split.supervisor.staleHeartbeatSeconds`   (900)
 *   `split.humanWaitReevalPct`                 (existing, 50)
 *
 * @module scripts/split/watch
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../../lib/core/config.js';
import { getRepoIdentity, repoShortName, splitLimbBranch } from '../../lib/git/repo-identity.js';
import { readPlanCompletion } from '../../lib/git/limb-completion.js';
import { summarizeWallClock } from '../../lib/observability/split-telemetry.js';
import { readAllEvents, rebuildState } from '../../lib/supervisor/run-store.js';
import { assessLane, DEFAULT_THRESHOLDS, readLaneOpsState } from '../../lib/supervisor/lane-monitor.js';
import {
  HEARTBEAT_INTERVAL_DIVISOR,
  heartbeatCadence,
  reclaimExpiredLaneLeases,
} from '../../lib/topology/lease-reclaim.js';
import { isMainEntry } from '../hooks/_main-entry.js';
import { LANE_LEASE_ACTIONS, syncLaneLease } from './lane-lease.mjs';
import { openFeedStore, sessionIdFromEnv } from './task-feed.mjs';

/**
 * `--no-heartbeat` and `--apply-reclaim` are set only when given, so the result
 * of a plain invocation keeps the shape it always had.
 *
 * @param {string[]} argv
 * @returns {{ json: boolean, runId: string|null, parent: string, storeDir: string|undefined, heartbeat?: false, applyReclaim?: true }}
 */
export function parseArgs(argv) {
  const out = { json: false, runId: null, parent: process.cwd(), storeDir: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--run-id' && argv[i + 1]) out.runId = argv[++i];
    else if (a === '--parent' && argv[i + 1]) out.parent = argv[++i];
    else if (a === '--store-dir' && argv[i + 1]) out.storeDir = path.resolve(argv[++i]);
    else if (a === '--no-heartbeat') out.heartbeat = false;
    else if (a === '--apply-reclaim') out.applyReclaim = true;
  }
  out.parent = path.resolve(out.parent);
  return out;
}

/**
 * @param {string} file
 * @returns {object|null}
 */
function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Shell-free git; `{ ok, out }`, never throws.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{ ok: boolean, out: string }}
 */
function git(args, cwd) {
  try {
    const out = execFileSync('git', args, {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true,
    });
    return { ok: true, out: String(out) };
  } catch {
    return { ok: false, out: '' };
  }
}

/**
 * Limb list for the dashboard. `plan.json` limbs carry `branch`/`worktreePath`;
 * `run.json` limbs are bare names whose branch follows the naming rule
 * (`lib/git/repo-identity.js#splitLimbBranch`). Pure.
 *
 * @param {object|null} plan
 * @param {object|null} run
 * @param {string} repoShort
 * @returns {Array<{ limb: string, branch: string|null, worktreePath: string|null }>}
 */
export function resolveLimbs(plan, run, repoShort) {
  const out = [];
  const seen = new Set();
  const planLimbs = Array.isArray(plan?.limbs) ? plan.limbs : [];
  for (const l of planLimbs) {
    const limb = typeof l?.limb === 'string' ? l.limb : null;
    if (!limb || seen.has(limb)) continue;
    seen.add(limb);
    out.push({
      limb,
      branch: typeof l.branch === 'string' ? l.branch : null,
      worktreePath: typeof l.worktreePath === 'string' ? l.worktreePath : null,
    });
  }
  const runLimbs = Array.isArray(run?.limbs) ? run.limbs : [];
  for (const name of runLimbs) {
    if (typeof name !== 'string' || seen.has(name)) continue;
    seen.add(name);
    out.push({ limb: name, branch: safeLimbBranch(repoShort, name), worktreePath: null });
  }
  return out;
}

/**
 * @param {string} repoShort
 * @param {string} limb
 * @returns {string|null}
 */
function safeLimbBranch(repoShort, limb) {
  try {
    return repoShort ? splitLimbBranch(repoShort, limb) : null;
  } catch {
    return null;
  }
}

/**
 * Parse `git worktree list --porcelain` for path → lock info. Pure.
 * @param {string} text
 * @returns {Map<string, { locked: boolean, reason: string|null, pid: number|null }>}
 */
export function parseLocks(text) {
  const map = new Map();
  if (typeof text !== 'string') return map;
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (t.startsWith('worktree ')) {
      cur = { locked: false, reason: null, pid: null };
      map.set(normPath(t.slice(9)), cur);
    } else if (cur && t.startsWith('locked')) {
      cur.locked = true;
      cur.reason = t.slice(6).trim() || null;
      const m = /\(pid\s+(\d+)\)/.exec(t);
      cur.pid = m ? Number(m[1]) : null;
    }
  }
  return map;
}

/**
 * @param {string} p
 * @returns {string}
 */
function normPath(p) {
  return path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * @param {number|null} pid
 * @returns {boolean|null} null when no pid to test
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/**
 * @param {number|null} ms
 * @returns {string}
 */
export function fmtAge(ms) {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '-';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Render the §08 table. Pure.
 * @param {Array<Record<string, string>>} rows
 * @returns {string}
 */
export function renderTable(rows) {
  const cols = ['limb', 'ops', 'supervisor', 'complete', 'lastCommit', 'heartbeat', 'health'];
  const head = ['limb', 'ops state', 'supervisor', 'complete/reason', 'last commit', 'heartbeat', 'health'];
  const width = cols.map((c, i) => Math.max(head[i].length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (cells) => `| ${cells.map((v, i) => String(v).padEnd(width[i])).join(' | ')} |`;
  return [
    line(head),
    `|${width.map((w) => '-'.repeat(w + 2)).join('|')}|`,
    ...rows.map((r) => line(cols.map((c) => r[c] ?? ''))),
  ].join('\n');
}

/**
 * The "측정 고지" numbers, raw. `null` is printed as `null`. Pure.
 * @param {ReturnType<typeof summarizeWallClock>} wall
 * @param {string|null} lastEventTs
 * @param {number|null} reevalPct
 * @returns {{ text: string, verdict: '초과'|'미만'|'미측정' }}
 */
export function renderNotice(wall, lastEventTs, reevalPct) {
  let verdict = '미측정';
  if (wall.humanWaitPct !== null && Number.isFinite(reevalPct)) {
    verdict = wall.humanWaitPct >= reevalPct ? '초과' : '미만';
  }
  const text = [
    '측정 고지 (raw):',
    `  humanWaitPct=${JSON.stringify(wall.humanWaitPct)} humanWaitMs=${JSON.stringify(wall.humanWaitMs)} run=${JSON.stringify(wall.totalMs)}ms`,
    `  unpaired=${wall.unpaired.length} lastEventTs=${JSON.stringify(lastEventTs)}`,
    `  config.split.humanWaitReevalPct=${JSON.stringify(reevalPct)} → ${verdict}`,
  ].join('\n');
  return { text, verdict };
}

/* ─────────────────── lane lease: heartbeat (SH-12) and reclaim report (CA-09) ─────────────────── */

/** Prefix of the refusal the cadence gate returns through `heartbeatWorker`'s `errors[0]`. */
const CADENCE_REFUSAL = 'cadence';

/**
 * Should this poll keep this lane's lease alive? Pure and total.
 *
 * Yes only for a lane that is WORKING and not known to be over: its ops word is
 * one `LANE_LEASE_ACTIONS` classifies `heartbeat` (the allowlist itself, so a
 * new ops word is classified in ONE place), its trailer does not say `complete`,
 * the supervisor has not reduced it to DONE, and its session is not known dead.
 * The ops word is judged first, so a finished lane reports the word it carries.
 * Absence of evidence is not evidence of absence: an unobserved session (`null`)
 * still renews.
 *
 * @param {unknown} lane - One `collect()` lane: `{ opsState, complete, health, sessionPresent }`.
 * @returns {{ eligible: boolean, reason: string|null }} `reason` is `ops-state:<word|unknown>` |
 *   `lane-complete` | `lane-state-done` | `session-absent`, and null when eligible.
 */
export function heartbeatEligibility(lane) {
  const l = lane !== null && typeof lane === 'object' ? lane : {};
  const ops = typeof l.opsState === 'string' && Object.hasOwn(LANE_LEASE_ACTIONS, l.opsState) ? l.opsState : null;
  if (ops === null) return { eligible: false, reason: 'ops-state:unknown' };
  if (LANE_LEASE_ACTIONS[ops] !== 'heartbeat') return { eligible: false, reason: `ops-state:${ops}` };
  if (l.complete === true) return { eligible: false, reason: 'lane-complete' };
  if (l.health?.health === 'done') return { eligible: false, reason: 'lane-state-done' };
  if (l.sessionPresent === false) return { eligible: false, reason: 'session-absent' };
  return { eligible: true, reason: null };
}

/**
 * The cadence gate: a view of `store` whose `heartbeatWorker` passes only when
 * the lease it is about to renew is due (`heartbeatCadence`). Every other
 * method is the store's own, so `syncLaneLease` still owns the mission, the
 * owner check and the reason. A refusal is `{ok:false, errors:['cadence:<why>']}`
 * — `syncLaneLease` reports it as `refused:cadence:<why>`, which the caller
 * turns back into a `skipped:` outcome. The verdict it judged on is left in
 * `seen` (by task id) for the output.
 *
 * @param {object} store - StateStore.
 * @param {{ nowMs: number, seen: Map<string, object> }} ctx
 * @returns {object}
 */
function gateCadence(store, { nowMs, seen }) {
  return {
    ...store,
    heartbeatWorker: (params) => {
      const verdict = heartbeatCadence(store.getLease(params.missionId, params.taskId), nowMs, { divisor: HEARTBEAT_INTERVAL_DIVISOR });
      seen.set(params.taskId, verdict);
      if (!verdict.due) return { ok: false, conflict: false, errors: [`${CADENCE_REFUSAL}:${verdict.reason}`] };
      return store.heartbeatWorker(params);
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
 * @param {{ limb: string|null, opsState: string|null, eligible: boolean }} plan
 * @param {string} outcome
 * @param {object} [extra]
 * @returns {{ limb: string|null, opsState: string|null, eligible: boolean, outcome: string, missionId: string|null }}
 */
function laneRow(plan, outcome, extra = {}) {
  return { limb: plan.limb, opsState: plan.opsState, eligible: plan.eligible, outcome, missionId: null, ...extra };
}

/**
 * Renew the lease of every lane this poll keeps alive, once it is due.
 * Never throws; every refusal is an outcome string.
 *
 * The write is `lane-lease.mjs#syncLaneLease` — imported, not re-implemented —
 * with the cadence gate on its store port (see {@link gateCadence}). One lane,
 * one `syncLaneLease` call, one commit when due and none when not.
 *
 * @param {{ parent?: string, lanes?: unknown[], nowMs?: number, ports?: { openStore?: Function, sessionId?: string|null, config?: object|null } }} [input]
 *   `ports` is the test seam: `openStore(root, sid)`, `sessionId` (absent = the host env; `''` = none) and `config`
 *   (the parsed artibot.config.json the canary key is read from; absent = the shipped file).
 * @returns {{ enabled: true, available: boolean, reason: string|null, divisor: number, eligible: number, renewed: number,
 *   lanes: Array<{ limb: string|null, opsState: string|null, eligible: boolean, outcome: string, missionId: string|null, detail?: object, binding?: object }> }}
 *   Outcomes: `renewed` | `skipped:not-due` | `skipped:<heartbeatEligibility reason>` | any `syncLaneLease` outcome
 *   (`skipped:no-lease`, `held-by:<owner>`, `refused:<msg>`, `skipped:store-threw:<msg>`, …) | `skipped:no-session-id`.
 *   `available` is false when an eligible lane could not be tried (`reason` says why).
 */
export function renewLaneHeartbeats({ parent, lanes, nowMs, ports = {} } = {}) {
  const plans = (Array.isArray(lanes) ? lanes : []).map((l) => ({
    limb: typeof l?.limb === 'string' ? l.limb : null,
    opsState: typeof l?.opsState === 'string' ? l.opsState : null,
    ...heartbeatEligibility(l),
  }));
  const eligible = plans.filter((p) => p.eligible).length;
  const out = { enabled: true, available: true, reason: null, divisor: HEARTBEAT_INTERVAL_DIVISOR, eligible, renewed: 0, lanes: [] };
  const skipped = (p) => laneRow(p, `skipped:${p.reason}`);
  if (eligible === 0) return { ...out, lanes: plans.map(skipped) };
  try {
    const sid = ports.sessionId ?? sessionIdFromEnv();
    if (typeof sid !== 'string' || sid === '') {
      return { ...out, available: false, reason: 'no-session-id', lanes: plans.map((p) => (p.eligible ? laneRow(p, 'skipped:no-session-id') : skipped(p))) };
    }
    const seen = new Map();
    const open = ports.openStore ?? openFeedStore;
    const gated = { openStore: (root, s) => gateCadence(open(root, s), { nowMs, seen }), config: ports.config };
    let renewed = 0;
    const rows = plans.map((p) => {
      if (!p.eligible) return skipped(p);
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
    return { ...out, available: false, reason: `threw:${err?.message ?? 'unknown'}`, lanes: plans.map((p) => (p.eligible ? laneRow(p, 'skipped:threw') : skipped(p))) };
  }
}

/**
 * The heartbeat block of a poll that was told not to renew (`--no-heartbeat`).
 *
 * @param {unknown[]} lanes
 * @returns {{ enabled: false, available: true, reason: null, divisor: number, eligible: number, renewed: 0, lanes: [] }}
 */
function heartbeatOff(lanes) {
  const eligible = lanes.filter((l) => heartbeatEligibility(l).eligible).length;
  return { enabled: false, available: true, reason: null, divisor: HEARTBEAT_INTERVAL_DIVISOR, eligible, renewed: 0, lanes: [] };
}

/**
 * The lapsed lane leases no lane keeps alive — REPORT-ONLY unless `apply` is
 * the literal `true`. Never throws. The lanes this poll keeps alive
 * (`heartbeatEligibility`) are handed to the scan as `keepAlive`, so a lane it
 * just renewed, or would have, is never a candidate.
 *
 * @param {{ parent?: string, lanes?: unknown[], nowMs?: number, apply?: boolean, ports?: { openStore?: Function, sessionId?: string|null } }} [input]
 * @returns {{ mode: 'report'|'apply', available: boolean, reason: string|null, applied: boolean, scanned: object, live: number,
 *   protected: object[], candidates: object[], malformed: object[], results: object[] }}
 */
export function reportLeaseReclaim({ parent, lanes, nowMs, apply = false, ports = {} } = {}) {
  const base = {
    mode: apply === true ? 'apply' : 'report',
    available: true,
    reason: null,
    applied: false,
    scanned: { missions: 0, leases: 0, laneLeases: 0 },
    live: 0,
    protected: [],
    candidates: [],
    malformed: [],
    results: [],
  };
  try {
    const sid = ports.sessionId ?? sessionIdFromEnv();
    if (typeof sid !== 'string' || sid === '') return { ...base, available: false, reason: 'no-session-id' };
    const store = (ports.openStore ?? openFeedStore)(parent, sid);
    const keepAlive = (Array.isArray(lanes) ? lanes : []).filter((l) => heartbeatEligibility(l).eligible).map((l) => l.limb);
    return { ...base, ...reclaimExpiredLaneLeases({ store, nowMs, keepAlive, apply }), available: true };
  } catch (err) {
    return { ...base, available: false, reason: `store-threw:${err?.message ?? 'unknown'}` };
  }
}

/**
 * Ports for one poll's two lease passes that open the StateStore ONCE: the
 * store re-reads its files on every call, so sharing the instance is safe and
 * saves a git spawn (`resolveGitCommonDir`) per pass.
 *
 * @param {{ openStore?: Function }|null|undefined} ports
 * @returns {object}
 */
function sharedStorePorts(ports) {
  const base = ports ?? {};
  const open = base.openStore ?? openFeedStore;
  let store = null;
  return { ...base, openStore: (root, sid) => (store ??= open(root, sid)) };
}

/**
 * The lease lines of the text output. Quiet when there is nothing to say: no
 * eligible lane and no candidate print nothing. Pure and total.
 *
 * @param {{ heartbeat?: object|null, reclaim?: object|null }|null|undefined} leases - `collect().leases`
 * @returns {string[]}
 */
export function renderLeaseLines(leases) {
  const lines = [];
  const hb = leases?.heartbeat;
  if (hb && typeof hb === 'object') {
    if (hb.enabled === false) lines.push('lease heartbeat: off (--no-heartbeat)');
    else if (hb.available === false) lines.push(`lease heartbeat: not run (${hb.reason ?? 'unavailable'})`);
    else if (hb.eligible > 0) {
      lines.push(`lease heartbeat (renew at ttl/${hb.divisor ?? HEARTBEAT_INTERVAL_DIVISOR}): renewed ${hb.renewed} of ${hb.eligible} eligible lane(s)`);
      for (const l of (Array.isArray(hb.lanes) ? hb.lanes : []).filter((x) => x?.eligible)) {
        const d = l.detail;
        let note = '';
        if (l.outcome === 'skipped:not-due' && d) note = ` (last beat ${fmtAge(d.ageMs)} ago, due after ${fmtAge(d.intervalMs)})`;
        else if (l.outcome === 'renewed' && d?.expired) note = ' (the lease had already lapsed)';
        lines.push(`  ${l.limb}: ${l.outcome}${note}`);
      }
    }
  }
  const rc = leases?.reclaim;
  if (rc && typeof rc === 'object') {
    const apply = rc.mode === 'apply';
    const candidates = Array.isArray(rc.candidates) ? rc.candidates : [];
    const results = Array.isArray(rc.results) ? rc.results : [];
    if (rc.available === false) {
      lines.push(`lease reclaim${apply ? ' [apply]' : ''}: not run (${rc.reason ?? 'unavailable'})`);
    } else if (apply && candidates.length > 0) {
      const done = results.filter((r) => typeof r?.outcome === 'string' && r.outcome.startsWith('reclaimed:')).length;
      lines.push(`lease reclaim [apply]: reclaimed ${done} of ${candidates.length}`);
      for (const r of results) lines.push(`  ${r.taskId}: ${r.outcome}`);
    } else if (!apply && candidates.length > 0) {
      lines.push(`lease reclaim [report-only]: ${candidates.length} expired lane lease(s) — pass --apply-reclaim to release them`);
      for (const c of candidates) {
        lines.push(`  ${c.taskId}  mission ${c.missionId}  owner ${c.owner}  status ${c.status}  silent ${fmtAge(c.silentForMs)}  expired ${fmtAge(c.expiredForMs)} ago  → ${c.action}`);
      }
    }
  }
  return lines;
}

/**
 * Collect everything the dashboard shows. Performs the reads listed in the
 * module header and the single `state.json` write, then the lease passes: the
 * heartbeat (unless `heartbeat` is `false`) and the reclaim report (REPORT-ONLY
 * unless `applyReclaim` is `true`).
 *
 * @param {{ parent: string, runId: string|null, nowMs?: number, storeDir?: string, heartbeat?: boolean, applyReclaim?: boolean, ports?: object }} opts
 *   `ports`: the lease passes' test seam — see {@link renewLaneHeartbeats}.
 * @returns {Promise<object>} The dashboard, plus `leases: { heartbeat, reclaim }`.
 */
export async function collect({ parent, runId: runIdArg, nowMs = Date.now(), storeDir, heartbeat = true, applyReclaim = false, ports = {} }) {
  const store = storeDir ? { storeDir } : {};
  const missing = [];
  const splitDir = path.join(parent, '.artibot', 'split');
  const plan = readJson(path.join(splitDir, 'plan.json'));
  const run = readJson(path.join(splitDir, 'run.json'));
  if (!plan) missing.push('plan.json');
  if (!run) missing.push('run.json');

  let config = null;
  try {
    config = await loadConfig();
  } catch {
    missing.push('artibot.config.json (defaults used)');
  }
  const sup = config?.split?.supervisor && typeof config.split.supervisor === 'object' ? config.split.supervisor : {};
  const thresholds = {
    suspectHeartbeatSeconds: Number.isFinite(sup.suspectHeartbeatSeconds) ? sup.suspectHeartbeatSeconds : DEFAULT_THRESHOLDS.suspectHeartbeatSeconds,
    staleHeartbeatSeconds: Number.isFinite(sup.staleHeartbeatSeconds) ? sup.staleHeartbeatSeconds : DEFAULT_THRESHOLDS.staleHeartbeatSeconds,
  };
  const reevalPct = Number.isFinite(config?.split?.humanWaitReevalPct) ? config.split.humanWaitReevalPct : null;

  const runId = runIdArg ?? (typeof run?.runId === 'string' ? run.runId : null) ?? (typeof plan?.runId === 'string' ? plan.runId : null);
  if (!runId) missing.push('runId (pass --run-id)');

  let repoShort = typeof plan?.repoShort === 'string' ? plan.repoShort : '';
  if (!repoShort) {
    try {
      repoShort = repoShortName(getRepoIdentity(parent));
    } catch {
      repoShort = '';
    }
  }
  const limbs = resolveLimbs(plan, run, repoShort);
  if (limbs.length === 0) missing.push('limbs (no plan.json limbs and no run.json limbs)');

  const base = typeof plan?.base === 'string' ? plan.base : (typeof run?.base === 'string' ? run.base : undefined);
  const completion = readPlanCompletion({ cwd: parent, base, limbs: limbs.map((l) => ({ limb: l.limb, branch: l.branch ?? '' })) });
  const completionByLimb = new Map(completion.map((c) => [c.limb, c]));

  const porcelain = git(['worktree', 'list', '--porcelain'], parent);
  const locks = porcelain.ok ? parseLocks(porcelain.out) : new Map();
  if (!porcelain.ok) missing.push('git worktree list (parent is not a git repo?)');

  let supervisor = { state: null, warnings: [], events: 0, path: null };
  let events = [];
  if (runId) {
    try {
      supervisor = rebuildState(runId, store);
      events = readAllEvents(runId, store);
    } catch (err) {
      missing.push(`supervisor state (${err?.message ?? err})`);
    }
  }
  const wall = summarizeWallClock(events);
  const lastEventTs = events.length ? (typeof events[events.length - 1]?.ts === 'string' ? events[events.length - 1].ts : null) : null;

  const lanes = limbs.map((l) => {
    const comp = completionByLimb.get(l.limb) ?? null;
    const lastCommitAt = l.branch && git(['log', '-1', '--format=%cI', `refs/heads/${l.branch}`, '--'], parent).out.trim() || null;
    const wt = l.worktreePath ? normPath(l.worktreePath) : null;
    const lock = wt ? locks.get(wt) ?? null : null;
    // A `locked … claude session (pid N)` line is positive evidence of a
    // session; its ABSENCE is not evidence of absence (review finding
    // 2026-09-02: an unlocked worktree with a fresh heartbeat was reported as
    // `restart`). Only a lock whose pid is dead yields `false`; no lock → null.
    let sessionPresent = null;
    if (lock && lock.locked) sessionPresent = pidAlive(lock.pid);
    let dirty = null;
    if (l.worktreePath && fs.existsSync(l.worktreePath)) {
      const st = git(['status', '--porcelain'], l.worktreePath);
      dirty = st.ok ? st.out.trim().length > 0 : null;
    }
    const lane = supervisor.state?.lanes?.[l.limb] ?? null;
    const ops = readLaneOpsState(run, l.limb);
    const health = assessLane({
      lane, nowMs, thresholds,
      gitEvidence: { lastCommitAt, complete: comp?.complete === true, dirty },
      session: { present: sessionPresent },
    });
    const hbMs = lane?.lastHeartbeatAt ? nowMs - Date.parse(lane.lastHeartbeatAt) : null;
    const commitMs = lastCommitAt ? nowMs - Date.parse(lastCommitAt) : null;
    return {
      limb: l.limb,
      branch: l.branch,
      worktreePath: l.worktreePath,
      opsState: ops,
      supervisorState: lane?.state ?? null,
      complete: comp?.complete === true,
      reason: comp?.reason ?? 'no-branch',
      lastCommitAt,
      lastCommitAgeMs: Number.isFinite(commitMs) ? commitMs : null,
      heartbeatAt: lane?.lastHeartbeatAt ?? null,
      heartbeatAgeMs: Number.isFinite(hbMs) ? hbMs : null,
      sessionPresent,
      dirty,
      health,
    };
  });

  // The lease passes run AFTER the lanes are observed and in this order: the
  // heartbeat first, so a lease it just renewed is live when the reclaim scan
  // reads the store.
  const leasePorts = sharedStorePorts(ports);
  const leases = {
    heartbeat: heartbeat === false ? heartbeatOff(lanes) : renewLaneHeartbeats({ parent, lanes, nowMs, ports: leasePorts }),
    reclaim: reportLeaseReclaim({ parent, lanes, nowMs, apply: applyReclaim === true, ports: leasePorts }),
  };

  return {
    parent, runId, missing, thresholds, reevalPct,
    run: { state: supervisor.state?.state ?? null, warnings: supervisor.warnings, events: supervisor.events, statePath: supervisor.path },
    lanes, wallClock: wall, lastEventTs,
    leases,
    notice: renderNotice(wall, lastEventTs, reevalPct),
  };
}

/**
 * @param {object} r - `collect()` result
 * @returns {string}
 */
export function renderText(r) {
  const lines = [];
  lines.push(`Run ${r.runId ?? '(runId 미확인)'}  supervisor=${r.run.state ?? 'n/a'}  events=${r.run.events}  parent=${r.parent}`);
  if (r.missing.length) lines.push(`missing: ${r.missing.join('; ')}`);
  lines.push('');
  lines.push(renderTable(r.lanes.map((l) => ({
    limb: l.limb,
    ops: l.opsState ?? 'unknown',
    supervisor: l.supervisorState ?? '-',
    complete: `${l.complete ? 'yes' : 'no'}/${l.reason}`,
    lastCommit: fmtAge(l.lastCommitAgeMs),
    heartbeat: fmtAge(l.heartbeatAgeMs),
    health: l.health.health,
  }))));
  lines.push('');
  for (const l of r.lanes) lines.push(`  ${l.limb}: ${l.health.reason}`);
  if (r.run.warnings.length) {
    lines.push('');
    lines.push(`reducer warnings (${r.run.warnings.length}):`);
    for (const w of r.run.warnings.slice(0, 20)) lines.push(`  [${w.code}] #${w.index} ${w.message}`);
  }
  const leaseLines = renderLeaseLines(r.leases);
  if (leaseLines.length) {
    lines.push('');
    lines.push(...leaseLines);
  }
  lines.push('');
  lines.push(r.notice.text);
  if (r.run.statePath) lines.push(`(state cache written: ${r.run.statePath})`);
  return lines.join('\n');
}

/**
 * CLI entry. Always exits 0.
 * @returns {Promise<void>}
 */
export async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const r = await collect(args);
    process.stdout.write(`${args.json ? JSON.stringify(r, null, 2) : renderText(r)}\n`);
  } catch (err) {
    process.stdout.write(`watch: could not observe — ${err?.message ?? err}\n`);
  }
  process.exitCode = 0;
}

if (isMainEntry(import.meta.url)) {
  await main();
}
