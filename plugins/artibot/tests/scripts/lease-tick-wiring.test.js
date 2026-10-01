/**
 * `scripts/split/lease-tick.mjs` and `watch.mjs` through their REAL wiring —
 * the things the injected-store tests in `lease-tick.test.js` cannot give.
 *
 *  - a real locked worktree, read the way `collect` reads it (`git worktree
 *    list --porcelain` + a pid probe): a live pid keeps its lane renewed, a dead
 *    pid does not, and with no lock line only fresh lane-state activity does
 *    (ADV-4);
 *  - child processes against a temp git repo through the REAL `openFeedStore`
 *    and the REAL central ledger writer: a lease the real feeder claimed in the
 *    past is renewed AS A TICK (`heartbeat_source` lease-tick, ledger reason
 *    split.lease-tick — the row the SH-12 measurement reads), an immediate
 *    second tick writes nothing, a listed lapsed id is released and an unlisted
 *    one is not, `--apply-reclaim` with no list exits 1 with the ledger
 *    byte-identical, and `watch.mjs` (S0) wrote nothing to the same store.
 *
 * What it cannot see (rules §9): a live leader session, pid reuse, a
 * wall-clock wait. The dead pid is a number no host hands out, not a session
 * that died.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGitCommonDir } from '../../lib/project-state/git-common-dir.js';
import { createStateStore } from '../../lib/project-state/state-manager.js';
import { appendLedgerEvent } from '../../lib/runtime/ledger.js';
import { LEASE_RECLAIM_REASON, LEASE_TICK_REASON } from '../../lib/topology/lease-reclaim.js';
import { LANE_LEASE_REASON } from '../../scripts/split/lane-lease.mjs';
import { feedLimb } from '../../scripts/split/task-feed.mjs';
import { tick } from '../../scripts/split/lease-tick.mjs';
import { usePatientRename } from '../helpers/patient-rename.js';

const H = 3_600_000;
const MIN = 60_000;
const T0 = Date.parse('2026-09-30T00:00:00.000Z');
const SESSION = 'abcd1234-ef56-7890-1234-567890abcdef';
const MISSION = 'M-20260930-Sabcd1234';
const OFF = { split: { missionBinding: { enabled: false } } };
const PLAN = {
  runId: 'split-lt',
  limbs: [
    { limb: 'auth', affectedPaths: ['lib/auth/**'] },
    { limb: 'billing', affectedPaths: ['lib/billing.js'] },
    { limb: 'carol', affectedPaths: ['lib/carol.js'] },
  ],
};
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'split', 'lease-tick.mjs');
const WATCH = path.join(PLUGIN_ROOT, 'scripts', 'split', 'watch.mjs');

const idOf = (task) => `${MISSION}/${task}`;
const iso = (ms) => new Date(ms).toISOString();

// The host exports the session id to every child; a test that means "no session" must say so twice.
const NO_SESSION_ENV = { ...process.env, CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' };

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

// The in-process store commits (the seeding and the aged claims) wait out the Windows EPERM-on-rename that outlasts core's ~150ms retry
// (tests/helpers/patient-rename.js). The child processes below are NOT covered: they run the unpatched rename.
usePatientRename();

describe('a real locked worktree — liveness read the way collect reads it (`git worktree list --porcelain` + a pid probe)', () => {
  let repo;
  let storeDir;
  /** @type {object[]} */ let ledger;
  let clock;
  let store;
  // A pid no host hands out (Windows pids are 32-bit but small in practice, Linux caps at 4194304).
  const DEAD_PID = 2_000_000_000;

  function makeStore() {
    return createStateStore({
      projectRoot: repo,
      sessionId: SESSION,
      renderProjectionFile: false,
      now: () => clock,
      resolveGitCommonDir: () => path.join(repo, '.git'),
      appendEvent: (e) => void ledger.push(e),
    });
  }

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-lease-tick-git-'));
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-lease-tick-git-store-'));
    git(['init', '-q', '-b', 'master'], repo);
    git(['config', 'user.email', 't@example.com'], repo);
    git(['config', 'user.name', 't'], repo);
    git(['config', 'commit.gpgsign', 'false'], repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
    git(['add', 'a.txt'], repo);
    git(['commit', '-q', '-m', 'base'], repo);
    fs.mkdirSync(path.join(repo, '.artibot', 'split'), { recursive: true });
  }, 60_000);
  afterAll(() => {
    for (const d of [repo, storeDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(path.join(repo, '.git', 'artibot'), { recursive: true, force: true });
    ledger = [];
    clock = new Date(T0);
    store = makeStore();
  });

  it('live pid -> renewed; dead pid -> session-absent; no lock + stale stamp -> no evidence; no lock + fresh stamp -> renewed', async () => {
    const tmp = fs.realpathSync.native(os.tmpdir());
    const liveWt = path.join(tmp, `artibot-lease-tick-wt-live-${process.pid}`);
    const deadWt = path.join(tmp, `artibot-lease-tick-wt-dead-${process.pid}`);
    git(['worktree', 'add', '-q', '--lock', '--reason', `claude session live-1 (pid ${process.pid})`, '-b', `worktree-split-repo-live-${process.pid}`, liveWt, 'master'], repo);
    git(['worktree', 'add', '-q', '--lock', '--reason', `claude session dead-1 (pid ${DEAD_PID})`, '-b', `worktree-split-repo-dead-${process.pid}`, deadWt, 'master'], repo);
    try {
      const limbs = ['live', 'dead', 'quiet', 'recent'];
      const plan = { runId: 'split-lt-git', base: 'master', repoShort: 'repo', limbs: limbs.map((limb) => ({ limb, affectedPaths: [`lib/${limb}.js`] })) };
      fs.writeFileSync(path.join(repo, '.artibot', 'split', 'plan.json'), JSON.stringify({
        ...plan,
        limbs: [
          { limb: 'live', worktreePath: liveWt, branch: `worktree-split-repo-live-${process.pid}` },
          { limb: 'dead', worktreePath: deadWt, branch: `worktree-split-repo-dead-${process.pid}` },
          { limb: 'quiet' },
          { limb: 'recent' },
        ],
      }));
      expect(store.updateMission(MISSION, () => ({
        status: 'executing',
        intent: { path: '.artibot/intent.md', revision: 1 },
        plan: { path: '.artibot/plan.md', revision: 1 },
      }), { reason: 'test.seed' }).ok).toBe(true);
      for (const limb of limbs) {
        expect(feedLimb({ parentRoot: repo, plan, limb, sessionId: SESSION }, { openStore: () => store, config: OFF }).claim, limb).toBe('claimed');
      }
      const now = T0 + 2 * H;
      clock = new Date(now);
      fs.writeFileSync(path.join(repo, '.artibot', 'split', 'run.json'), JSON.stringify({
        runId: 'split-lt-git',
        lanes: {
          // live: no lane-state time at all — only the lock pid can speak for it.
          live: { state: 'active' },
          // dead: touched ten minutes ago, which alone WOULD be evidence — the dead pid is the direct evidence and wins.
          dead: { state: 'active', since: iso(now - 10 * MIN), updated_at: iso(now - 10 * MIN) },
          quiet: { state: 'active', since: iso(T0 - 30 * H), updated_at: iso(T0 - 30 * H) },
          recent: { state: 'active', since: iso(now - 10 * MIN), updated_at: iso(now - 10 * MIN) },
        },
      }));

      const r = await tick({ parent: repo, runId: null, storeDir, nowMs: now, ports: { openStore: () => store, sessionId: SESSION, config: OFF } });

      const by = Object.fromEntries(r.leases.heartbeat.lanes.map((l) => [l.limb, l]));
      expect(by.live).toMatchObject({ outcome: 'renewed', evidence: 'session-alive' });
      expect(by.dead).toMatchObject({ outcome: 'skipped:session-absent', renew: false });
      expect(by.quiet).toMatchObject({ outcome: 'skipped:no-liveness-evidence', renew: false });
      expect(by.recent).toMatchObject({ outcome: 'renewed', evidence: 'lane-state-fresh' });
      expect(store.getLease(MISSION, 'dead').heartbeat_at).toBe(iso(T0));
      expect(store.getLease(MISSION, 'live').heartbeat_at).toBe(iso(now));
    } finally {
      git(['worktree', 'remove', '-f', '-f', liveWt], repo);
      git(['worktree', 'remove', '-f', '-f', deadWt], repo);
      git(['branch', '-D', `worktree-split-repo-live-${process.pid}`], repo);
      git(['branch', '-D', `worktree-split-repo-dead-${process.pid}`], repo);
    }
  }, 120_000);
});

describe('production wiring — the REAL openFeedStore and the REAL central ledger writer, in child processes', () => {
  let repo;
  let storeDir;

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-lease-tick-prod-'));
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-lease-tick-prod-store-'));
    git(['init', '-q', '-b', 'master'], repo);
    git(['config', 'user.email', 't@example.com'], repo);
    git(['config', 'user.name', 't'], repo);
    git(['config', 'commit.gpgsign', 'false'], repo);
    fs.mkdirSync(path.join(repo, '.artibot', 'split'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.artibot', 'split', 'plan.json'), JSON.stringify({ ...PLAN, runId: 'split-prod' }));
    // A working lane the leader touched just now, so a tick has something renewable whatever test runs first.
    fs.writeFileSync(path.join(repo, '.artibot', 'split', 'run.json'), JSON.stringify({
      runId: 'split-prod',
      lanes: { auth: { state: 'active', since: iso(Date.now()), updated_at: iso(Date.now()) } },
    }));
  }, 60_000);
  afterAll(() => {
    for (const d of [repo, storeDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  /** What `task-feed.mjs#openFeedStore` builds, with one difference: a clock, so a lease can be aged. */
  const openAged = (now) => createStateStore({
    projectRoot: repo,
    sessionId: SESSION,
    source: 'supervisor',
    renderProjectionFile: false,
    now,
    appendEvent: (envelope) => appendLedgerEvent(repo, envelope),
    resolveGitCommonDir: () => resolveGitCommonDir(repo),
  });
  const ledgerPath = () => path.join(repo, '.git', 'artibot', 'ledger.jsonl');
  const ledgerRows = () => fs.readFileSync(ledgerPath(), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const rowsWith = (reason) => ledgerRows().filter((e) => e.event === 'state.updated' && e.data?.reason === reason);
  const childEnv = () => {
    const env = { ...process.env, CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_SESSION_ID: '' };
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
    return env;
  };
  const runScript = (script, args) => spawnSync(process.execPath, [script, ...args, '--parent', repo, '--store-dir', storeDir], { encoding: 'utf-8', windowsHide: true, env: childEnv() });
  const runJson = (script, args = []) => {
    const r = runScript(script, ['--json', ...args]);
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout);
  };

  it('a tick past 45 minutes renews a real lease as a TICK; the next one writes nothing; a listed lapsed id is released and an unlisted one is not; watch wrote nothing', () => {
    const now = Date.now();
    // Leases the real feeder claimed in the past: auth 2h ago (due, and the lane is alive), billing and carol 30h ago (lapsed, lanes done).
    const agedAt = (ms) => openAged(() => new Date(now - ms));
    const seed = agedAt(2 * H);
    expect(seed.updateMission(MISSION, () => ({
      status: 'executing',
      intent: { path: '.artibot/intent.md', revision: 1 },
      plan: { path: '.artibot/plan.md', revision: 1 },
    }), { reason: 'test.seed' }).ok).toBe(true);
    const plan = { ...PLAN, runId: 'split-prod' };
    const claim = (limb, ms) => feedLimb({ parentRoot: repo, plan, limb, sessionId: SESSION }, { openStore: () => agedAt(ms), config: OFF }).claim;
    expect(claim('auth', 2 * H)).toBe('claimed');
    expect(claim('billing', 30 * H)).toBe('claimed');
    expect(claim('carol', 30 * H)).toBe('claimed');
    fs.writeFileSync(path.join(repo, '.artibot', 'split', 'run.json'), JSON.stringify({
      runId: 'split-prod',
      lanes: { auth: { state: 'active', since: iso(now - 10 * MIN), updated_at: iso(now - 10 * MIN) }, billing: { state: 'done' }, carol: { state: 'done' } },
    }));
    const ledgerBefore = fs.readFileSync(ledgerPath(), 'utf-8');

    // S0: watch reads the same store and writes nothing to it.
    const watched = runJson(WATCH);
    expect(watched.leases.reclaim.candidates.map((c) => c.id)).toEqual([idOf('billing'), idOf('carol')]);
    expect(watched.leases.reclaim.mode).toBe('report');
    expect(fs.readFileSync(ledgerPath(), 'utf-8')).toBe(ledgerBefore);

    const first = runJson(SCRIPT);
    expect(first.leases.heartbeat).toMatchObject({ available: true, renewed: 1 });
    expect(first.leases.heartbeat.lanes.find((l) => l.limb === 'auth')).toMatchObject({ outcome: 'renewed', missionId: MISSION, evidence: 'lane-state-fresh' });
    expect(first.leases.reclaim.candidates.map((c) => c.id)).toEqual([idOf('billing'), idOf('carol')]);
    const reader = openAged(() => new Date());
    const lease = reader.getLease(MISSION, 'auth');
    expect(Math.abs(Date.now() - Date.parse(lease.heartbeat_at))).toBeLessThan(5 * MIN);
    expect(Date.parse(lease.expires_at) - Date.parse(lease.heartbeat_at)).toBe(24 * H);
    expect(reader.getTaskGraph(MISSION).tasks.find((t) => t.id === 'auth')).toMatchObject({ status: 'claimed', heartbeat_source: 'lease-tick' });
    // The row the SH-12 measurement reads — and it is a tick row, not a lane-state row.
    expect(rowsWith(LEASE_TICK_REASON)).toHaveLength(1);
    expect(rowsWith(LANE_LEASE_REASON)).toHaveLength(0);
    expect(rowsWith(LEASE_TICK_REASON)[0]).toMatchObject({ mission_id: MISSION, session_id: SESSION });

    const second = runJson(SCRIPT);
    expect(second.leases.heartbeat.lanes.find((l) => l.limb === 'auth').outcome).toBe('skipped:not-due');
    expect(rowsWith(LEASE_TICK_REASON)).toHaveLength(1);

    // Release exactly one of the two reported ids.
    const applied = runJson(SCRIPT, ['--apply-reclaim', idOf('billing')]);
    expect(applied.leases.reclaim.results).toEqual([{ id: idOf('billing'), missionId: MISSION, taskId: 'billing', outcome: 'reclaimed:queued' }]);
    expect(reader.getLease(MISSION, 'billing')).toBe(null);
    expect(reader.getLease(MISSION, 'carol')?.owner).toBe('carol');
    expect(rowsWith(LEASE_RECLAIM_REASON)).toHaveLength(1);
  }, 180_000);

  it('--apply-reclaim with no list: exit 1, a refusal on stderr, nothing on stdout, and the ledger is byte-identical', () => {
    const read = () => (fs.existsSync(ledgerPath()) ? fs.readFileSync(ledgerPath(), 'utf-8') : null); // absent is a state too
    const before = read();
    for (const args of [['--apply-reclaim'], ['--apply-reclaim', 'everything']]) {
      const r = runScript(SCRIPT, args);
      expect(r.status, args.join(' ')).toBe(1);
      expect(r.stderr).toContain('lease-tick refused');
      expect(r.stdout).toBe('');
    }
    expect(read()).toBe(before);
  }, 60_000);

  it('with no session id the tick runs, says no-session-id, and exits 0', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--json', '--parent', repo, '--store-dir', storeDir], { encoding: 'utf-8', windowsHide: true, env: { ...NO_SESSION_ENV } });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.leases.reclaim).toMatchObject({ available: false, reason: 'no-session-id' });
    expect(out.leases.heartbeat).toMatchObject({ available: false, reason: 'no-session-id', renewed: 0 });
  }, 60_000);
});
