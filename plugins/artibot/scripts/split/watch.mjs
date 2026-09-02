#!/usr/bin/env node
/**
 * `/split watch` — read-only supervisor dashboard (PR-SV02, autonomy S0).
 *
 *   node scripts/split/watch.mjs [--json] [--run-id <id>] [--parent <root>] [--store-dir <dir>]
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
 * Side effects: exactly one — `rebuildState` rewrites
 * `<storeDir>/{runId}.state.json` (a cache of the append-only streams). No
 * git mutation, no session contact, no telemetry write. Exit code is always
 * 0: an observer that fails to observe says so on stdout and leaves.
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
import { isMainEntry } from '../hooks/_main-entry.js';

/**
 * @param {string[]} argv
 * @returns {{ json: boolean, runId: string|null, parent: string, storeDir: string|undefined }}
 */
export function parseArgs(argv) {
  const out = { json: false, runId: null, parent: process.cwd(), storeDir: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--run-id' && argv[i + 1]) out.runId = argv[++i];
    else if (a === '--parent' && argv[i + 1]) out.parent = argv[++i];
    else if (a === '--store-dir' && argv[i + 1]) out.storeDir = path.resolve(argv[++i]);
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

/**
 * Collect everything the dashboard shows. Performs the reads listed in the
 * module header and the single `state.json` write.
 *
 * @param {{ parent: string, runId: string|null, nowMs?: number, storeDir?: string }} opts
 * @returns {Promise<object>}
 */
export async function collect({ parent, runId: runIdArg, nowMs = Date.now(), storeDir }) {
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

  return {
    parent, runId, missing, thresholds, reevalPct,
    run: { state: supervisor.state?.state ?? null, warnings: supervisor.warnings, events: supervisor.events, statePath: supervisor.path },
    lanes, wallClock: wall, lastEventTs,
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
