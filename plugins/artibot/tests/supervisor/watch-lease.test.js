/**
 * `scripts/split/watch.mjs` — the lease REPORT (CA-09) on a poll, and the S0
 * contract that goes with it: `watch` only lists. The lease writes (the
 * heartbeat, the release of confirmed ids) live in `lease-tick.mjs`
 * (`tests/scripts/lease-tick*.test.js`).
 *
 * Why this file exists: a first cut put the heartbeat inside `watch`. The canon
 * says autonomy S0 is display and warn only (design §03) and names the lease
 * emitters without `watch` (design §9), so the writes moved out and `watch` was
 * returned to zero StateStore writes. This file is what keeps it there.
 *
 * What is measured:
 *  - S0, four ways: the source has no write-port token (a text pin); the
 *    report is handed a facade with `getState` and nothing else; `collect`
 *    survives a store whose every writer throws; and against a REAL store the
 *    version, the journal bytes, the snapshot bytes and the ledger are
 *    untouched even with every lease due and every lane working. The one write
 *    `watch` has always had — the supervisor `state.json` cache, under
 *    `--store-dir` — is not a StateStore write and is left alone;
 *  - the report: a lapsed lane lease no lane holds is listed with the lane's
 *    own word (`laneOps`) beside it; a lane with liveness evidence (a live lock
 *    pid, or lane-state activity inside the TTL window) and a suspended lane
 *    are held back; a working lane with NO evidence is not (ADV-4), nor a dead
 *    pid; a stale lane of an older run says so;
 *  - the flags that moved (`--apply-reclaim`, `--no-heartbeat`) are said, never
 *    silently ignored.
 *
 * What it cannot see (rules §9): a live leader session, pid reuse, a
 * wall-clock wait. Fixtures hold a few lanes; a store with thousands of journal
 * records is not exercised.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStateStore } from '../../lib/project-state/state-manager.js';
import { feedLimb } from '../../scripts/split/task-feed.mjs';
import {
  annotateCandidates,
  collect,
  keepAliveLanes,
  parseArgs,
  readLaneOpsUpdatedAt,
  renderReclaimLines,
  renderText,
  reportLeaseReclaim,
} from '../../scripts/split/watch.mjs';

const H = 3_600_000;
const MIN = 60_000;
const T0 = Date.parse('2026-09-30T00:00:00.000Z');
const SESSION = 'abcd1234-ef56-7890-1234-567890abcdef';
const MISSION = 'M-20260930-Sabcd1234';
const OFF = { split: { missionBinding: { enabled: false } } };
const PLAN = {
  runId: 'split-wl',
  limbs: [
    { limb: 'auth', affectedPaths: ['lib/auth/**'] },
    { limb: 'billing', affectedPaths: ['lib/billing.js'] },
  ],
};
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'split', 'watch.mjs');
const WATCH_SRC = fs.readFileSync(SCRIPT, 'utf-8');

const idOf = (task) => `${MISSION}/${task}`;
const iso = (ms) => new Date(ms).toISOString();
/** lane-state activity at `ms`, the shape `writeWorkerState` stamps */
const touched = (ms, state = 'active') => ({ state, since: iso(ms), updated_at: iso(ms) });

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

/** Source with comments blanked (strings kept): a text pin must not trip on prose. */
function codeOf(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('readLaneOpsUpdatedAt — the lane-state half of the liveness evidence', () => {
  it('prefers updated_at (stamped by every writeWorkerState, a re-assert included) and falls back to since', () => {
    const run = { lanes: { a: { state: 'active', since: iso(T0), updated_at: iso(T0 + H) }, b: { state: 'active', since: iso(T0) } } };
    expect(readLaneOpsUpdatedAt(run, 'a')).toBe(iso(T0 + H));
    expect(readLaneOpsUpdatedAt(run, 'b')).toBe(iso(T0));
  });

  it('is null when the entry carries no usable time: a string-form entry, an unparseable stamp, a missing lane or run', () => {
    expect(readLaneOpsUpdatedAt({ lanes: { a: 'active' } }, 'a')).toBe(null);
    expect(readLaneOpsUpdatedAt({ lanes: { a: { state: 'active', updated_at: 'yesterday', since: 7 } } }, 'a')).toBe(null);
    expect(readLaneOpsUpdatedAt({ lanes: {} }, 'a')).toBe(null);
    expect(readLaneOpsUpdatedAt({ lanes: { a: [iso(T0)] } }, 'a')).toBe(null);
    for (const run of [null, undefined, {}, 'x']) expect(readLaneOpsUpdatedAt(run, 'a')).toBe(null);
  });
});

describe('keepAliveLanes / annotateCandidates — pure', () => {
  const NOW = T0 + 10 * H;
  const lane = (over) => ({ limb: 'x', opsState: 'active', complete: false, sessionPresent: null, health: { health: 'unknown' }, opsUpdatedAt: iso(NOW - H), ...over });

  it('holds back the lanes a tick would renew and the suspended ones — and nothing else', () => {
    const lanes = [
      lane({ limb: 'fresh' }), // lane-state evidence
      lane({ limb: 'pid', opsUpdatedAt: null, sessionPresent: true }), // live lock pid
      lane({ limb: 'parked', opsState: 'suspended', sessionPresent: false }), // ADV-3
      lane({ limb: 'quiet', opsUpdatedAt: iso(NOW - 40 * H) }), // ADV-4: stale, no lock
      lane({ limb: 'blank', opsUpdatedAt: null }), // ADV-4: `active` is an undated word
      lane({ limb: 'dead', sessionPresent: false }),
      lane({ limb: 'done', opsState: 'done' }),
      lane({ limb: 'closed', complete: true }),
    ];
    expect(keepAliveLanes(lanes, NOW)).toEqual(['fresh', 'pid', 'parked']);
  });

  it('is total on garbage', () => {
    expect(keepAliveLanes(undefined, NOW)).toEqual([]);
    expect(keepAliveLanes([null, 7, {}, { limb: 3 }], NOW)).toEqual([]);
  });

  it('puts the lane word beside each candidate, null for a limb that is not in this run', () => {
    const out = annotateCandidates([{ taskId: 'a' }, { taskId: 'ghost' }], [{ limb: 'a', opsState: 'done' }, { limb: 'b', opsState: null }]);
    expect(out).toEqual([{ taskId: 'a', laneOps: 'done' }, { taskId: 'ghost', laneOps: null }]);
    expect(annotateCandidates([{ taskId: 'b' }], [{ limb: 'b', opsState: null }])[0].laneOps).toBe(null);
    expect(annotateCandidates([], undefined)).toEqual([]);
  });
});

describe('S0 — watch lists, and writes nothing to the StateStore', () => {
  it('the source carries no write-port token and imports neither the lease writer nor the tick (it NAMES the tick in its hint, which is prose)', () => {
    const code = codeOf(WATCH_SRC);
    for (const token of ['syncLaneLease', 'heartbeatWorker', 'releaseTask', 'claimTask', 'updateMission', 'appendLedgerEvent', 'lane-lease.mjs']) {
      expect(code, token).not.toContain(token);
    }
    const imports = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec, spec).not.toMatch(/lease-tick|lane-lease/);
  });

  it('the one call into the reclaim library names no apply and no ids: report mode, and the store handed in is a getState-only facade', () => {
    const code = codeOf(WATCH_SRC);
    const at = code.indexOf('reclaimExpiredLaneLeases({');
    expect(at).toBeGreaterThan(-1);
    let depth = 0;
    let end = at;
    for (let i = code.indexOf('(', at); i < code.length; i += 1) {
      if (code[i] === '(') depth += 1;
      else if (code[i] === ')' && (depth -= 1) === 0) { end = i; break; }
    }
    const call = code.slice(at, end + 1);
    expect(call).toContain('store: readOnly');
    expect(call).not.toMatch(/\bapply\b|\bids\b/);
    expect(code).toMatch(/const readOnly = \{ getState: \(\) => store\.getState\(\) \}/);
    expect(code.split('reclaimExpiredLaneLeases(').length - 1).toBe(1);
  });

  describe('against a real store', () => {
    let root;
    let storeDir;
    /** @type {object[]} */ let ledger;
    let clock;
    let store;

    function makeStore() {
      return createStateStore({
        projectRoot: root,
        sessionId: SESSION,
        renderProjectionFile: false,
        now: () => clock,
        resolveGitCommonDir: () => path.join(root, '.git'),
        appendEvent: (e) => void ledger.push(e),
      });
    }

    const feed = (limb) => feedLimb({ parentRoot: root, plan: PLAN, limb, sessionId: SESSION }, { openStore: () => store, config: OFF });
    const writeRun = (lanes) => fs.writeFileSync(path.join(root, '.artibot', 'split', 'run.json'), JSON.stringify({ runId: 'split-wl', lanes }));
    const poll = (ports) => collect({ parent: root, runId: null, storeDir, nowMs: clock.getTime(), ports: { sessionId: SESSION, config: OFF, ...ports } });

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-watch-s0-'));
      storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-watch-s0-store-'));
      const dir = path.join(root, '.artibot', 'split');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(PLAN));
      ledger = [];
      clock = new Date(T0);
      store = makeStore();
      expect(store.updateMission(MISSION, () => ({
        status: 'executing',
        intent: { path: '.artibot/intent.md', revision: 1 },
        plan: { path: '.artibot/plan.md', revision: 1 },
      }), { reason: 'test.seed' }).ok).toBe(true);
      expect(feed('auth').claim).toBe('claimed');
      expect(feed('billing').claim).toBe('claimed');
      // Thirty hours on: both leases lapsed (a poll is long overdue), auth is a working lane the leader touched just now.
      clock = new Date(T0 + 30 * H);
      writeRun({ auth: touched(clock.getTime()), billing: { state: 'done' } });
    });
    afterEach(() => {
      for (const d of [root, storeDir]) fs.rmSync(d, { recursive: true, force: true });
      vi.unstubAllEnvs();
    });

    it('collect leaves the version, the journal bytes, the snapshot bytes and the ledger untouched, and renews nothing', async () => {
      const version = store.getState().state_version;
      const journal = fs.readFileSync(store.paths.journal, 'utf-8');
      const snapshot = fs.readFileSync(store.paths.snapshot, 'utf-8');
      const events = ledger.length;

      const r = await poll({ openStore: () => store });

      expect(r.leases.reclaim).toMatchObject({ mode: 'report', available: true, applied: false });
      expect(store.getState().state_version).toBe(version);
      expect(fs.readFileSync(store.paths.journal, 'utf-8')).toBe(journal);
      expect(fs.readFileSync(store.paths.snapshot, 'utf-8')).toBe(snapshot);
      expect(ledger.length).toBe(events);
      // The lease of the working lane lapsed and a tick would renew it; watch did not.
      expect(store.getLease(MISSION, 'auth').heartbeat_at).toBe(iso(T0));
      expect(store.getTaskGraph(MISSION).tasks.find((t) => t.id === 'auth').heartbeat_at).toBeUndefined();
    });

    it('collect survives a store whose every writer throws — none is ever reached', async () => {
      const trip = (name) => vi.fn(() => { throw new Error(`${name} called by watch`); });
      const guarded = {
        getState: store.getState,
        getLease: store.getLease,
        updateMission: trip('updateMission'),
        claimTask: trip('claimTask'),
        releaseTask: trip('releaseTask'),
        heartbeatWorker: trip('heartbeatWorker'),
        appendEvent: trip('appendEvent'),
      };
      const r = await poll({ openStore: () => guarded });
      expect(r.leases.reclaim).toMatchObject({ available: true });
      for (const name of ['updateMission', 'claimTask', 'releaseTask', 'heartbeatWorker', 'appendEvent']) {
        expect(guarded[name], name).not.toHaveBeenCalled();
      }
    });

    it('the report needs getState and nothing else: a store that is only that is enough', () => {
      const report = reportLeaseReclaim({ parent: root, lanes: [], nowMs: clock.getTime(), ports: { openStore: () => ({ getState: store.getState }), sessionId: SESSION } });
      expect(report).toMatchObject({ mode: 'report', available: true });
      expect(report.candidates.map((c) => c.id)).toEqual([idOf('auth'), idOf('billing')]);
    });

    it('the report is a LISTING: the working lane is held back (lane-state evidence), the finished one is offered with its word', async () => {
      const r = await poll({ openStore: () => store });
      expect(r.leases.reclaim.candidates.map((c) => [c.id, c.laneOps, c.action])).toEqual([[idOf('billing'), 'done', 'release-to-queued']]);
      expect(r.leases.reclaim.protected.map((p) => p.id)).toEqual([idOf('auth')]);
      expect(r.leases.reclaim.results).toEqual([]);
    });

    it('ADV-4: the same working lane with a lane-state stamp older than the TTL window — and no lock line — is offered, not held', async () => {
      writeRun({ auth: touched(T0 + 30 * H - 25 * H), billing: { state: 'done' } });
      const r = await poll({ openStore: () => store });
      expect(r.leases.reclaim.candidates.map((c) => [c.id, c.laneOps])).toEqual([[idOf('auth'), 'active'], [idOf('billing'), 'done']]);
      expect(r.leases.reclaim.protected).toEqual([]);
    });

    it('ADV-4: `active` with no time at all (a string-form lane entry) is not evidence either', async () => {
      writeRun({ auth: 'active', billing: { state: 'done' } });
      const r = await poll({ openStore: () => store });
      expect(r.leases.reclaim.candidates.map((c) => c.id)).toEqual([idOf('auth'), idOf('billing')]);
    });

    it('ADV-3: a suspended lane is held back, however long its lease has been lapsed', async () => {
      writeRun({ auth: { state: 'suspended', updated_at: iso(T0) }, billing: { state: 'done' } });
      const r = await poll({ openStore: () => store });
      expect(r.leases.reclaim.candidates.map((c) => c.id)).toEqual([idOf('billing')]);
      expect(r.leases.reclaim.protected.map((p) => p.id)).toEqual([idOf('auth')]);
    });

    it('a stale lane of an OLDER run (its limb is not in this run\'s plan) is still reported, and says so', async () => {
      const older = { ...PLAN, limbs: [...PLAN.limbs, { limb: 'old-run-lane', affectedPaths: ['lib/old.js'] }] };
      clock = new Date(T0);
      expect(feedLimb({ parentRoot: root, plan: older, limb: 'old-run-lane', sessionId: SESSION }, { openStore: () => store, config: OFF }).claim).toBe('claimed');
      clock = new Date(T0 + 30 * H);
      const r = await poll({ openStore: () => store });
      expect(r.leases.reclaim.candidates.find((c) => c.taskId === 'old-run-lane')).toMatchObject({ laneOps: null, status: 'claimed', action: 'release-to-queued' });
      const text = renderText(r);
      expect(text).toMatch(/old-run-lane .*lane \(not in this run\)/);
      expect(text).toMatch(/billing .*lane done/);
    });

    it('the text names the ids a human would confirm, the way lease-tick takes them', async () => {
      const text = renderText(await poll({ openStore: () => store }));
      expect(text).toMatch(/\| limb\s+\| ops state\s+\| supervisor\s+\|/); // the table is padded to its widest row
      expect(text).toContain('lease reclaim [report-only]: 1 expired lane lease(s)');
      expect(text).toContain(idOf('billing'));
      expect(text).toContain('scripts/split/lease-tick.mjs --apply-reclaim <id[,id...]>');
      expect(text).toContain(`1 lapsed lease(s) held back (lane alive or suspended): ${idOf('auth')}`);
      expect(text).toContain('측정 고지 (raw):');
    });

    it('no session id: the report says so instead of guessing, collect still resolves, and nothing is opened', async () => {
      vi.stubEnv('CLAUDE_CODE_SESSION_ID', '');
      vi.stubEnv('CLAUDE_SESSION_ID', '');
      let opened = 0;
      const r = await collect({ parent: root, runId: null, storeDir, nowMs: clock.getTime(), ports: { openStore: () => { opened += 1; return store; } } });
      expect(r.leases.reclaim).toMatchObject({ mode: 'report', available: false, reason: 'no-session-id', applied: false, candidates: [] });
      expect(opened).toBe(0);
      expect(renderText(r)).toContain('lease reclaim: not run (no-session-id)');
    });

    it('a throwing store never breaks the dashboard', async () => {
      const r = await poll({ openStore: () => { throw new TypeError('boom'); } });
      expect(r.lanes).toHaveLength(2);
      expect(r.leases.reclaim).toMatchObject({ available: false, applied: false });
      expect(r.leases.reclaim.reason).toMatch(/boom/);
    });

    it('the existing dashboard is intact: table rows, notice, and the lanes carry the new lane-state time', async () => {
      const r = await poll({ openStore: () => store });
      expect(r.lanes.map((l) => [l.limb, l.opsState, l.opsUpdatedAt])).toEqual([['auth', 'active', iso(T0 + 30 * H)], ['billing', 'done', null]]);
      expect(r.notice.verdict).toBe('미측정');
      expect(JSON.parse(JSON.stringify(r.leases))).toEqual(r.leases);
    });
  });
});

describe('a real git repo and real locked worktrees — liveness read the way collect reads it', () => {
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

  const writeRun = (lanes) => fs.writeFileSync(path.join(repo, '.artibot', 'split', 'run.json'), JSON.stringify({ runId: 'split-wl', lanes }));
  const poll = () => collect({ parent: repo, runId: null, storeDir, nowMs: clock.getTime(), ports: { openStore: () => store, sessionId: SESSION, config: OFF } });

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-watch-lease-git-'));
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-watch-lease-store-'));
    git(['init', '-q', '-b', 'master'], repo);
    git(['config', 'user.email', 't@example.com'], repo);
    git(['config', 'user.name', 't'], repo);
    git(['config', 'commit.gpgsign', 'false'], repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
    git(['add', 'a.txt'], repo);
    git(['commit', '-q', '-m', 'base'], repo);
    // A finished limb: the trailer says done.
    git(['checkout', '-q', '-b', 'worktree-split-repo-billing'], repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'limb\n');
    git(['commit', '-q', '-am', 'feat: limb billing\n\nSplit-Limb: done'], repo);
    git(['checkout', '-q', 'master'], repo);
    fs.mkdirSync(path.join(repo, '.artibot', 'split'), { recursive: true });
  }, 60_000);
  afterAll(() => {
    for (const d of [repo, storeDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.writeFileSync(path.join(repo, '.artibot', 'split', 'plan.json'), JSON.stringify({
      runId: 'split-wl', base: 'master', repoShort: 'repo',
      limbs: [
        { limb: 'auth', branch: 'worktree-split-repo-auth', affectedPaths: ['lib/auth/**'] },
        { limb: 'billing', branch: 'worktree-split-repo-billing', affectedPaths: ['lib/billing.js'] },
      ],
    }));
    fs.rmSync(path.join(repo, '.git', 'artibot'), { recursive: true, force: true });
    ledger = [];
    clock = new Date(T0);
    store = makeStore();
    expect(store.updateMission(MISSION, () => ({
      status: 'executing',
      intent: { path: '.artibot/intent.md', revision: 1 },
      plan: { path: '.artibot/plan.md', revision: 1 },
    }), { reason: 'test.seed' }).ok).toBe(true);
    for (const limb of ['auth', 'billing']) {
      expect(feedLimb({ parentRoot: repo, plan: PLAN, limb, sessionId: SESSION }, { openStore: () => store, config: OFF }).claim).toBe('claimed');
    }
  });

  it('a trailer-complete lane that still says `closing` is finished: offered with its word, never held, and the table still reads it done', async () => {
    clock = new Date(T0 + 25 * H);
    writeRun({ auth: touched(clock.getTime()), billing: { state: 'closing' } });
    const before = store.getState().state_version;

    const r = await poll();

    expect(r.missing).toEqual([]);
    expect(r.lanes.map((l) => [l.limb, l.opsState, l.complete])).toEqual([['auth', 'active', false], ['billing', 'closing', true]]);
    expect(r.leases.reclaim.candidates.map((c) => [c.id, c.laneOps])).toEqual([[idOf('billing'), 'closing']]);
    expect(r.leases.reclaim.protected.map((p) => p.id)).toEqual([idOf('auth')]);
    expect(store.getState().state_version).toBe(before);
  });

  describe('a worktree locked by a session pid', () => {
    const PLAN_ZED = { ...PLAN, limbs: [...PLAN.limbs, { limb: 'zed', affectedPaths: ['lib/zed.js'] }] };

    /**
     * Run `fn` with limb `zed` sitting in a real worktree locked by `pid` — the
     * line Claude Code writes (`locked claude session <name> (pid N)`) — and
     * `zed`'s run.json entry as given.
     * @param {number} pid
     * @param {object} zedLane - `run.json.lanes.zed`
     * @param {() => Promise<void>} fn
     */
    async function withZedSession(pid, zedLane, fn) {
      const wt = path.join(fs.realpathSync.native(os.tmpdir()), `artibot-watch-lease-wt-${process.pid}-${pid}`);
      git(['worktree', 'add', '-q', '--lock', '--reason', `claude session zed-1 (pid ${pid})`, '-b', `worktree-split-repo-zed-${pid}`, wt, 'master'], repo);
      try {
        fs.writeFileSync(path.join(repo, '.artibot', 'split', 'plan.json'), JSON.stringify({
          runId: 'split-wl', base: 'master', repoShort: 'repo',
          limbs: [
            { limb: 'auth', branch: 'worktree-split-repo-auth' },
            { limb: 'billing', branch: 'worktree-split-repo-billing' },
            { limb: 'zed', branch: `worktree-split-repo-zed-${pid}`, worktreePath: wt },
          ],
        }));
        writeRun({ auth: { state: 'done' }, billing: { state: 'done' }, zed: zedLane });
        expect(feedLimb({ parentRoot: repo, plan: PLAN_ZED, limb: 'zed', sessionId: SESSION }, { openStore: () => store, config: OFF }).claim).toBe('claimed');
        clock = new Date(T0 + 25 * H);
        await fn();
      } finally {
        git(['worktree', 'remove', '-f', '-f', wt], repo);
        git(['branch', '-D', `worktree-split-repo-zed-${pid}`], repo);
      }
    }

    it('DEAD pid: the session reads as absent and its lapsed lease is OFFERED even though the leader touched the lane just now — the pid is the direct evidence, and the contradiction is visible (lane says active)', async () => {
      await withZedSession(DEAD_PID, touched(T0 + 25 * H), async () => {
        const r = await poll();
        expect(r.lanes.find((l) => l.limb === 'zed').sessionPresent).toBe(false);
        const zed = r.leases.reclaim.candidates.find((c) => c.taskId === 'zed');
        expect(zed).toMatchObject({ laneOps: 'active', action: 'release-to-queued' });
        expect(r.leases.reclaim.protected.map((p) => p.taskId)).not.toContain('zed');
      });
    }, 60_000);

    it('LIVE pid (positive control, the same fixture but NO lane-state time): the session is present and the lapsed lease is HELD BACK, not offered', async () => {
      await withZedSession(process.pid, { state: 'active' }, async () => {
        const r = await poll();
        expect(r.lanes.find((l) => l.limb === 'zed').sessionPresent).toBe(true);
        expect(r.leases.reclaim.candidates.map((c) => c.taskId)).not.toContain('zed');
        expect(r.leases.reclaim.protected.map((p) => p.taskId)).toContain('zed');
      });
    }, 60_000);
  });
});

describe('CLI surface', () => {
  it('parseArgs: a plain invocation keeps the shape it always had; the moved flags are recorded only when given', () => {
    expect(parseArgs(['--json', '--run-id', 'r1', '--parent', 'C:/p', '--store-dir', 'C:/s']))
      .toEqual({ json: true, runId: 'r1', parent: path.resolve('C:/p'), storeDir: path.resolve('C:/s') });
    expect('moved' in parseArgs([])).toBe(false);
    expect(parseArgs(['--apply-reclaim', 'M-20260930-Sabcd1234/auth', '--no-heartbeat']).moved).toEqual(['--apply-reclaim', '--no-heartbeat']);
    expect(parseArgs(['--no-heartbeat']).moved).toEqual(['--no-heartbeat']);
  });

  it('a moved flag is SAID, not silently ignored: a note in text mode, ignoredFlags in JSON, exit 0, and nothing applied', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-watch-lease-empty-'));
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-watch-lease-empty-store-'));
    try {
      const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args, '--parent', empty, '--store-dir', storeDir], { encoding: 'utf-8', windowsHide: true, env: NO_SESSION_ENV });
      const text = run(['--apply-reclaim', 'M-20260930-Sabcd1234/auth', '--no-heartbeat']);
      expect(text.status).toBe(0);
      expect(text.stdout.split('\n')[0]).toBe('watch is read-only: --apply-reclaim --no-heartbeat moved to scripts/split/lease-tick.mjs and was ignored.');
      const json = run(['--json', '--apply-reclaim', 'M-20260930-Sabcd1234/auth']);
      expect(json.status).toBe(0);
      const parsed = JSON.parse(json.stdout);
      expect(parsed.ignoredFlags).toEqual(['--apply-reclaim']);
      expect(parsed.leases.reclaim).toMatchObject({ mode: 'report', available: false, reason: 'no-session-id', applied: false });
      const plain = JSON.parse(run(['--json']).stdout);
      expect('ignoredFlags' in plain).toBe(false);
    } finally {
      for (const d of [empty, storeDir]) fs.rmSync(d, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('renderReclaimLines — pure', () => {
  const report = (over = {}) => ({
    mode: 'report', available: true, reason: null, applied: false, protected: [], results: [],
    candidates: [{
      id: idOf('gone'), missionId: MISSION, taskId: 'gone', owner: 'gone', status: 'claimed', laneOps: 'done',
      expiredForMs: 3 * H + 10 * MIN, silentForMs: 27 * H, action: 'release-to-queued',
    }],
    ...over,
  });

  it('names each candidate by the id lease-tick takes, with the lane word, the ages and the act', () => {
    const text = renderReclaimLines(report()).join('\n');
    expect(text).toContain('lease reclaim [report-only]: 1 expired lane lease(s)');
    expect(text).toContain('scripts/split/lease-tick.mjs --apply-reclaim <id[,id...]>');
    expect(text).toContain(`${idOf('gone')}  owner gone  status claimed  lane done  silent 27h 0m  expired 3h 10m ago  → release-to-queued`);
  });

  it('says `lane (not in this run)` for a limb the run does not know', () => {
    const [, line] = renderReclaimLines(report({ candidates: [{ ...report().candidates[0], laneOps: null }] }));
    expect(line).toContain('lane (not in this run)');
  });

  it('lists the leases it held back, even with nothing to offer', () => {
    const lines = renderReclaimLines(report({ candidates: [], protected: [{ id: idOf('a') }, { id: idOf('b') }] }));
    expect(lines).toEqual([`lease reclaim: 2 lapsed lease(s) held back (lane alive or suspended): ${idOf('a')}, ${idOf('b')}`]);
  });

  it('is quiet when there is nothing to say, and says why when it could not look', () => {
    expect(renderReclaimLines(report({ candidates: [] }))).toEqual([]);
    expect(renderReclaimLines(report({ available: false, reason: 'no-session-id', candidates: [] }))).toEqual(['lease reclaim: not run (no-session-id)']);
  });

  it('is total on missing or malformed input', () => {
    for (const v of [undefined, null, {}, 'x', 7, { candidates: 'no' }]) expect(() => renderReclaimLines(v)).not.toThrow();
    expect(renderReclaimLines(undefined)).toEqual([]);
  });
});
