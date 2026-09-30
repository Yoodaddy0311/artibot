/**
 * `scripts/split/watch.mjs` — the lane-lease heartbeat (SH-12) and the reclaim
 * report (CA-09) that ride on every poll.
 *
 * Root cause this closes: a `/split` lane lease (`task-feed.mjs` claims it at
 * dispatch with a 24h TTL) was renewed only at leader-declared moments —
 * `lane-state` (`lane-lease.mjs#syncLaneLease`) and a re-dispatch
 * (`task-feed.mjs#claimLimb`). Nothing renewed it on a clock, and nothing
 * looked at a lease that lapsed. A poll of the dashboard now renews a working
 * lane's lease once ttl/3 has passed, and lists the lapsed lane leases that no
 * lane is keeping alive.
 *
 * What is measured, against a REAL StateStore in a tmp dir with a fake clock:
 *  - cadence: no write before ttl/3, one at ttl/3, the lease never lapses over
 *    48h of polls every 30 minutes, the TTL does not grow (SP-05), and a poll is
 *    not a write — the ledger gains a row per RENEWAL only;
 *  - who is renewed: exactly the ops states `LANE_LEASE_ACTIONS` calls
 *    `heartbeat`, and not a lane the trailer / supervisor calls finished, nor one
 *    whose session is known dead — and `done` is never RELEASED from here;
 *  - fail-open and transparent: no session id, a throwing store, a foreign
 *    holder, no lease — each is an outcome string, never an exception;
 *  - the reclaim report is report-only unless `applyReclaim` is `true`, and a
 *    lane the poll keeps alive is never a candidate.
 *
 * What it cannot see (rules §9): a live leader session (whether the dispatching
 * session is the one that runs `watch` — the legacy mission rule is per
 * session), a wall-clock 8h wait, a bound run (SH-11 canary ON: the bound feeder
 * never claims, so the honest outcome there is `skipped:no-lease`). Fixtures
 * hold two lanes; a store with thousands of journal records is not exercised.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGitCommonDir } from '../../lib/project-state/git-common-dir.js';
import { createStateStore } from '../../lib/project-state/state-manager.js';
import { appendLedgerEvent } from '../../lib/runtime/ledger.js';
import { LANE_OPS_STATES } from '../../lib/supervisor/contracts.js';
import { LIMB_LEASE_TTL_MS } from '../../lib/topology/split-task-feed.js';
import { LANE_LEASE_ACTIONS, LANE_LEASE_REASON } from '../../scripts/split/lane-lease.mjs';
import { feedLimb } from '../../scripts/split/task-feed.mjs';
import {
  collect,
  heartbeatEligibility,
  parseArgs,
  renderLeaseLines,
  renderText,
  renewLaneHeartbeats,
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

// The host exports the session id to every child; a test that means "no session" must say so twice.
const NO_SESSION_ENV = { ...process.env, CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' };

/** @param {object} [over] */
const lane = (over = {}) => ({
  limb: 'auth', opsState: 'active', complete: false, sessionPresent: null, health: { health: 'unknown' }, ...over,
});

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

describe('heartbeatEligibility — who the poll keeps alive', () => {
  it('follows LANE_LEASE_ACTIONS for EVERY ops state: heartbeat-class renews, everything else does not', () => {
    for (const state of LANE_OPS_STATES) {
      const v = heartbeatEligibility(lane({ opsState: state }));
      const expected = LANE_LEASE_ACTIONS[state] === 'heartbeat';
      expect(v.eligible, state).toBe(expected);
      expect(v.reason, state).toBe(expected ? null : `ops-state:${state}`);
    }
    // The brief says "active/review"; the allowlist is wider (serial-gate and closing are still the worker's turn).
    const renewing = LANE_OPS_STATES.filter((s) => heartbeatEligibility(lane({ opsState: s })).eligible).sort();
    expect(renewing).toEqual(['active', 'closing', 'review', 'serial-gate']);
  });

  it('an unknown ops word, or none, is not renewed — the reader\'s fail-closed answer', () => {
    for (const opsState of [null, undefined, 'dispatched', 'landed', '', 7]) {
      expect(heartbeatEligibility(lane({ opsState })), String(opsState)).toEqual({ eligible: false, reason: 'ops-state:unknown' });
    }
  });

  it('a lane the trailer calls complete is closed: not renewed, even while its ops word still says closing', () => {
    expect(heartbeatEligibility(lane({ opsState: 'closing', complete: true }))).toEqual({ eligible: false, reason: 'lane-complete' });
    expect(heartbeatEligibility(lane({ opsState: 'active', complete: true })).reason).toBe('lane-complete');
  });

  it('a lane the supervisor reduced to DONE (health done, no trailer) is closed too', () => {
    expect(heartbeatEligibility(lane({ opsState: 'review', health: { health: 'done' } }))).toEqual({ eligible: false, reason: 'lane-state-done' });
  });

  it('a session known to be dead is not renewed — a heartbeat would be false evidence of liveness', () => {
    expect(heartbeatEligibility(lane({ opsState: 'active', sessionPresent: false }))).toEqual({ eligible: false, reason: 'session-absent' });
    // Absence of evidence is not evidence of absence: unobserved (null) and alive (true) still renew.
    expect(heartbeatEligibility(lane({ sessionPresent: null })).eligible).toBe(true);
    expect(heartbeatEligibility(lane({ sessionPresent: true })).eligible).toBe(true);
  });

  it('the ops word is judged first, so a finished lane reports why it is not a working lane', () => {
    expect(heartbeatEligibility(lane({ opsState: 'done', complete: true, sessionPresent: false })).reason).toBe('ops-state:done');
  });

  it('is total on garbage', () => {
    for (const v of [null, undefined, {}, 'auth', 7, []]) expect(heartbeatEligibility(v).eligible).toBe(false);
  });
});

describe('renewLaneHeartbeats — cadence with a fake clock, against a real store', () => {
  let root;
  /** @type {object[]} */ let ledger;
  let clock;
  let store;
  let opened;

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

  function seedMission(s) {
    const r = s.updateMission(MISSION, () => ({
      status: 'executing',
      intent: { path: '.artibot/intent.md', revision: 1 },
      plan: { path: '.artibot/plan.md', revision: 1 },
    }), { reason: 'test.seed' });
    expect(r.ok).toBe(true);
  }

  const feed = (limb = 'auth') => feedLimb({ parentRoot: root, plan: PLAN, limb, sessionId: SESSION }, { openStore: () => store, config: OFF });
  const at = (ms) => { clock = new Date(ms); return ms; };
  const ports = (over = {}) => ({ openStore: () => { opened += 1; return store; }, sessionId: SESSION, config: OFF, ...over });
  const poll = (lanes = [lane()], over = {}) => renewLaneHeartbeats({ parent: root, lanes, nowMs: clock.getTime(), ports: ports(over) });
  const updates = () => ledger.filter((e) => e.event === 'state.updated');
  const task = (limb = 'auth') => store.getTaskGraph(MISSION).tasks.find((t) => t.id === limb);
  const outcome = (r, limb = 'auth') => r.lanes.find((l) => l.limb === limb).outcome;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-watch-lease-'));
    const dir = path.join(root, '.artibot', 'split');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(PLAN));
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ runId: 'split-wl' }));
    ledger = [];
    opened = 0;
    clock = new Date(T0);
    store = makeStore();
    seedMission(store);
    expect(feed('auth').claim).toBe('claimed');
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

  it('the fixture is what it claims: the real feeder took a 24h lease at T0 and nothing has renewed it', () => {
    const lease = store.getLease(MISSION, 'auth');
    expect(lease.heartbeat_at).toBe('2026-09-30T00:00:00.000Z');
    expect(Date.parse(lease.expires_at) - Date.parse(lease.heartbeat_at)).toBe(LIMB_LEASE_TTL_MS);
    expect(task().heartbeat_at).toBeUndefined();
  });

  it('writes NOTHING before ttl/3: a poll at 1h and at 7h59m is skipped:not-due, with the numbers a human needs', () => {
    const before = store.getState().state_version;
    const events = ledger.length;

    at(T0 + 1 * H);
    const early = poll();
    at(T0 + 8 * H - MIN);
    const late = poll();

    expect(outcome(early)).toBe('skipped:not-due');
    expect(outcome(late)).toBe('skipped:not-due');
    expect(early.lanes[0].detail).toMatchObject({ reason: 'fresh', ageMs: 1 * H, intervalMs: 8 * H, ttlMs: 24 * H });
    expect(early.renewed).toBe(0);
    expect(store.getState().state_version).toBe(before);
    expect(ledger.length).toBe(events);
  });

  it('renews at exactly ttl/3 through syncLaneLease: a lane-heartbeat stamp on task and lease, one ledger row, reason split.lane-lease', () => {
    const events = updates().length;
    at(T0 + 8 * H);

    const r = poll();

    expect(outcome(r)).toBe('renewed');
    expect(r).toMatchObject({ enabled: true, available: true, eligible: 1, renewed: 1 });
    expect(r.lanes[0].missionId).toBe(MISSION);
    const lease = store.getLease(MISSION, 'auth');
    expect(lease.heartbeat_at).toBe(new Date(T0 + 8 * H).toISOString());
    expect(lease.expires_at).toBe(new Date(T0 + 32 * H).toISOString());
    expect(lease.acquired_at).toBe('2026-09-30T00:00:00.000Z');
    expect(task().heartbeat_at).toBe(new Date(T0 + 8 * H).toISOString());
    expect(task().heartbeat_source).toBe('lane-heartbeat');
    expect(task().status).toBe('claimed');
    expect(updates().length).toBe(events + 1);
    expect(updates().at(-1).data.reason).toBe(LANE_LEASE_REASON);
    expect(new Set(ledger.map((e) => e.event))).toEqual(new Set(['state.updated']));
  });

  it('a renewal restarts the clock: a poll a minute later is not due, the next is due one interval on', () => {
    at(T0 + 8 * H);
    expect(outcome(poll())).toBe('renewed');
    at(T0 + 8 * H + MIN);
    expect(outcome(poll())).toBe('skipped:not-due');
    at(T0 + 16 * H - 1);
    expect(outcome(poll())).toBe('skipped:not-due');
    at(T0 + 16 * H);
    expect(outcome(poll())).toBe('renewed');
  });

  it('48h of polls every 30 minutes: exactly 6 renewals, never a per-poll write, the lease never lapses, the TTL never grows', () => {
    let renewals = 0;
    const renewedAt = [];
    for (let i = 1; i <= 96; i += 1) {
      const now = at(T0 + i * 30 * MIN);
      const r = poll();
      if (outcome(r) === 'renewed') { renewals += 1; renewedAt.push((now - T0) / H); }
      const lease = store.getLease(MISSION, 'auth');
      expect(Date.parse(lease.expires_at), `poll ${i}: the lease must still be live`).toBeGreaterThan(now);
      expect(Date.parse(lease.expires_at) - Date.parse(lease.heartbeat_at), `poll ${i}: ttl`).toBe(24 * H);
    }
    expect(renewals).toBe(6);
    expect(renewedAt).toEqual([8, 16, 24, 32, 40, 48]);
    // Claim (1) + seed (1) are not renewals; the heartbeat rows are exactly the 6.
    expect(updates().filter((e) => e.data.reason === LANE_LEASE_REASON)).toHaveLength(6);
  });

  it('a lapsed lease on a lane still declared working is renewed back, not left to lapse', () => {
    at(T0 + 30 * H); // five hours past expires_at
    const r = poll();
    expect(outcome(r)).toBe('renewed');
    expect(r.lanes[0].detail).toMatchObject({ expired: true });
    expect(store.getLease(MISSION, 'auth').heartbeat_at).toBe(new Date(T0 + 30 * H).toISOString());
  });

  it('every heartbeat-class state renews a due lease (closing and serial-gate included)', () => {
    for (const [i, state] of ['active', 'review', 'serial-gate', 'closing'].entries()) {
      at(T0 + (8 + i * 8) * H);
      expect(outcome(poll([lane({ opsState: state })])), state).toBe('renewed');
    }
  });

  it('NOT renewed, and the lease is NOT released either: a non-working state with a due lease changes nothing (done is lane-state\'s release, not the poll\'s)', () => {
    at(T0 + 30 * H);
    const version = store.getState().state_version;
    const events = ledger.length;
    for (const state of ['pending', 'awaiting-dispatch', 'suspended', 'done', 'failed']) {
      const r = poll([lane({ opsState: state })]);
      expect(outcome(r), state).toBe(`skipped:ops-state:${state}`);
      expect(r.renewed).toBe(0);
    }
    expect(store.getState().state_version).toBe(version);
    expect(ledger.length).toBe(events);
    expect(store.getLease(MISSION, 'auth')?.owner).toBe('auth');
    expect(task().status).toBe('claimed');
    expect(opened, 'no eligible lane → no store opened at all').toBe(0);
  });

  it('a closed lane (trailer complete, or supervisor DONE) and a dead session are not renewed; no store is opened', () => {
    at(T0 + 30 * H);
    const version = store.getState().state_version;
    const lanes = [
      lane({ limb: 'auth', opsState: 'closing', complete: true }),
      lane({ limb: 'billing', opsState: 'active', health: { health: 'done' } }),
      lane({ limb: 'third', opsState: 'active', sessionPresent: false }),
    ];
    const r = poll(lanes);
    expect(r.lanes.map((l) => [l.limb, l.outcome])).toEqual([
      ['auth', 'skipped:lane-complete'],
      ['billing', 'skipped:lane-state-done'],
      ['third', 'skipped:session-absent'],
    ]);
    expect(r.eligible).toBe(0);
    expect(store.getState().state_version).toBe(version);
    expect(opened).toBe(0);
  });

  it('no lease → skipped:no-lease; a lease held by someone else is reported and never renewed', () => {
    // billing is claimed by the feeder, then its lease is dropped: a working lane that holds no lease.
    feed('billing');
    store.releaseTask({ missionId: MISSION, taskId: 'billing', owner: 'billing', status: 'queued' });
    at(T0 + 9 * H);
    expect(outcome(poll([lane({ limb: 'billing' })]), 'billing')).toBe('skipped:no-lease');

    store.releaseTask({ missionId: MISSION, taskId: 'auth', owner: 'auth', status: 'queued' });
    expect(store.claimTask({ missionId: MISSION, taskId: 'auth', owner: 'intruder', ttlMs: 24 * H }).ok).toBe(true);
    at(T0 + 18 * H);
    const before = store.getState().state_version;
    expect(outcome(poll())).toBe('held-by:intruder');
    expect(store.getState().state_version).toBe(before);
    expect(store.getLease(MISSION, 'auth').owner).toBe('intruder');
  });

  it('two due lanes are both renewed, one commit each', () => {
    feed('billing');
    const events = updates().length;
    at(T0 + 8 * H);
    const r = poll([lane({ limb: 'auth' }), lane({ limb: 'billing' })]);
    expect(r.lanes.map((l) => l.outcome)).toEqual(['renewed', 'renewed']);
    expect(r.renewed).toBe(2);
    expect(updates().length).toBe(events + 2);
  });

  it('no session id → available:false, the eligible lane says skipped:no-session-id, and no store is opened', () => {
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', '');
    vi.stubEnv('CLAUDE_SESSION_ID', '');
    at(T0 + 9 * H);
    const version = store.getState().state_version;
    const r = poll([lane()], { sessionId: '' });
    expect(r).toMatchObject({ enabled: true, available: false, reason: 'no-session-id', eligible: 1, renewed: 0 });
    expect(outcome(r)).toBe('skipped:no-session-id');
    expect(opened).toBe(0);
    expect(store.getState().state_version).toBe(version);
  });

  it('a store that throws is an outcome, not an exception', () => {
    at(T0 + 9 * H);
    const r = poll([lane()], { openStore: () => { throw new TypeError('boom'); } });
    expect(outcome(r)).toBe('skipped:store-threw:boom');
    expect(r.renewed).toBe(0);
  });

  it('is total: no lanes, garbage lanes and a missing ports object never throw', () => {
    expect(renewLaneHeartbeats({ parent: root, lanes: [], nowMs: T0 })).toMatchObject({ eligible: 0, renewed: 0, lanes: [] });
    expect(() => renewLaneHeartbeats({ parent: root, lanes: [null, 7, {}], nowMs: T0, ports: ports() })).not.toThrow();
    expect(renewLaneHeartbeats({ parent: root, lanes: [null], nowMs: T0, ports: ports() }).eligible).toBe(0);
    expect(() => renewLaneHeartbeats()).not.toThrow();
  });
});

describe('collect — the heartbeat and the reclaim report on a poll', () => {
  let repo;
  let storeDir;
  /** @type {object[]} */ let ledger;
  let clock;
  let store;

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

  function seedMission(s) {
    expect(s.updateMission(MISSION, () => ({
      status: 'executing',
      intent: { path: '.artibot/intent.md', revision: 1 },
      plan: { path: '.artibot/plan.md', revision: 1 },
    }), { reason: 'test.seed' }).ok).toBe(true);
  }

  /** @param {Record<string, unknown>} lanes */
  function writeRun(lanes) {
    fs.writeFileSync(path.join(repo, '.artibot', 'split', 'run.json'), JSON.stringify({ runId: 'split-wl', lanes }));
  }

  const feed = (limb) => feedLimb({ parentRoot: repo, plan: PLAN, limb, sessionId: SESSION }, { openStore: () => store, config: OFF });
  const ports = (over = {}) => ({ openStore: () => store, sessionId: SESSION, config: OFF, ...over });
  const poll = (over = {}) => collect({ parent: repo, runId: null, storeDir, nowMs: clock.getTime(), ports: ports(), ...over });
  const updates = () => ledger.filter((e) => e.event === 'state.updated');

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-watch-lease-git-'));
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
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-watch-lease-store-'));
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
    seedMission(store);
    expect(feed('auth').claim).toBe('claimed');
    expect(feed('billing').claim).toBe('claimed');
    writeRun({ auth: { state: 'active' }, billing: { state: 'closing' } });
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('a poll at ttl/3 renews the working lane; the trailer-complete lane (still `closing`) is skipped — and the existing keys are intact', async () => {
    clock = new Date(T0 + 8 * H);
    const r = await poll();
    expect(r.missing).toEqual([]);
    expect(r.leases.heartbeat).toMatchObject({ enabled: true, available: true, eligible: 1, renewed: 1 });
    expect(r.leases.heartbeat.lanes.map((l) => [l.limb, l.outcome])).toEqual([
      ['auth', 'renewed'],
      ['billing', 'skipped:lane-complete'],
    ]);
    expect(store.getLease(MISSION, 'auth').heartbeat_at).toBe(new Date(T0 + 8 * H).toISOString());
    expect(store.getLease(MISSION, 'billing').heartbeat_at).toBe('2026-09-30T00:00:00.000Z');
    // The dashboard itself is unchanged.
    expect(r.lanes.map((l) => [l.limb, l.opsState, l.complete])).toEqual([['auth', 'active', false], ['billing', 'closing', true]]);
    expect(r.notice.verdict).toBe('미측정');
    expect(JSON.parse(JSON.stringify(r.leases))).toEqual(r.leases);
  });

  it('REPORT-ONLY by default: the finished lane\'s lapsed lease is listed, the working lane is renewed first and so is not, and nothing is released', async () => {
    clock = new Date(T0 + 25 * H);
    const before = updates().length;
    const r = await poll();

    expect(r.leases.heartbeat.lanes[0]).toMatchObject({ limb: 'auth', outcome: 'renewed' });
    expect(r.leases.reclaim).toMatchObject({ mode: 'report', available: true, applied: false });
    expect(r.leases.reclaim.candidates.map((c) => [c.taskId, c.action, c.targetStatus])).toEqual([['billing', 'release-to-queued', 'queued']]);
    // What this run's lane says is shown next to the clock's verdict, so a human can confirm or refuse.
    expect(r.leases.reclaim.candidates[0].laneOps).toBe('closing');
    expect(r.leases.reclaim.results).toEqual([]);
    expect(store.getLease(MISSION, 'billing')?.owner).toBe('billing');
    expect(updates().length).toBe(before + 1); // the auth renewal only
  });

  it('applyReclaim:true releases what the report listed — and only that', async () => {
    clock = new Date(T0 + 25 * H);
    const r = await poll({ applyReclaim: true });
    expect(r.leases.reclaim).toMatchObject({ mode: 'apply', applied: true });
    expect(r.leases.reclaim.results).toEqual([{ missionId: MISSION, taskId: 'billing', outcome: 'reclaimed:queued' }]);
    expect(store.getLease(MISSION, 'billing')).toBe(null);
    expect(store.getLease(MISSION, 'auth')?.owner).toBe('auth');
    expect(updates().at(-1).data.reason).toBe('split.lease-reclaim');
  });

  it('applyReclaim is strictly boolean true: a string flag does not apply', async () => {
    clock = new Date(T0 + 25 * H);
    const r = await poll({ applyReclaim: 'true' });
    expect(r.leases.reclaim.mode).toBe('report');
    expect(store.getLease(MISSION, 'billing')).not.toBe(null);
  });

  it('heartbeat:false is a pure observer: no renewal, yet the lane it would have kept alive is still protected from the report', async () => {
    clock = new Date(T0 + 25 * H);
    const before = store.getState().state_version;
    const r = await poll({ heartbeat: false });
    expect(r.leases.heartbeat.enabled).toBe(false);
    expect(r.leases.heartbeat.renewed).toBe(0);
    expect(r.leases.reclaim.protected.map((p) => p.taskId)).toEqual(['auth']);
    expect(r.leases.reclaim.candidates.map((c) => c.taskId)).toEqual(['billing']);
    expect(store.getState().state_version).toBe(before);
  });

  describe('a real locked worktree, read the way collect reads it (`git worktree list --porcelain` + a pid probe)', () => {
    const PLAN_ZED = { ...PLAN, limbs: [...PLAN.limbs, { limb: 'zed', affectedPaths: ['lib/zed.js'] }] };
    // A pid no host hands out (Windows pids are 32-bit but small in practice, Linux caps at 4194304).
    const DEAD_PID = 2_000_000_000;

    /**
     * Run `fn` with limb `zed` sitting in a real worktree locked by `pid`, the
     * line Claude Code writes (`locked claude session <name> (pid N)`).
     * @param {number} pid
     * @param {(wt: string) => Promise<void>} fn
     */
    async function withZedSession(pid, fn) {
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
        writeRun({ auth: { state: 'done' }, billing: { state: 'done' }, zed: { state: 'active' } });
        feedLimb({ parentRoot: repo, plan: PLAN_ZED, limb: 'zed', sessionId: SESSION }, { openStore: () => store, config: OFF });
        expect(store.getLease(MISSION, 'zed')?.owner).toBe('zed');
        await fn(wt);
      } finally {
        git(['worktree', 'remove', '-f', '-f', wt], repo);
        git(['branch', '-D', `worktree-split-repo-zed-${pid}`], repo);
      }
    }

    it('DEAD pid: the session is read as absent, the lane is NOT renewed, and once its lease lapses it is in the report — a heartbeat does not hold a dead lane alive', async () => {
      await withZedSession(DEAD_PID, async () => {
        clock = new Date(T0 + 25 * H);
        const r = await poll();
        const zed = r.lanes.find((l) => l.limb === 'zed');
        expect(zed.sessionPresent).toBe(false);
        expect(r.leases.heartbeat.lanes.find((l) => l.limb === 'zed').outcome).toBe('skipped:session-absent');
        expect(r.leases.heartbeat.renewed).toBe(0);
        expect(store.getLease(MISSION, 'zed').heartbeat_at).toBe('2026-09-30T00:00:00.000Z');
        expect(r.leases.reclaim.candidates.map((c) => c.taskId)).toContain('zed');
        expect(r.leases.reclaim.protected.map((p) => p.taskId)).not.toContain('zed');
        // The contradiction a human needs to see: the lane is declared active, its session is gone.
        expect(r.leases.reclaim.candidates.find((c) => c.taskId === 'zed').laneOps).toBe('active');
      });
    }, 60_000);

    it('LIVE pid (positive control, the same fixture): the session is present, the lane IS renewed and is not a candidate', async () => {
      await withZedSession(process.pid, async () => {
        clock = new Date(T0 + 25 * H);
        const r = await poll();
        const zed = r.lanes.find((l) => l.limb === 'zed');
        expect(zed.sessionPresent).toBe(true);
        expect(r.leases.heartbeat.lanes.find((l) => l.limb === 'zed').outcome).toBe('renewed');
        expect(store.getLease(MISSION, 'zed').heartbeat_at).toBe(new Date(T0 + 25 * H).toISOString());
        expect(r.leases.reclaim.candidates.map((c) => c.taskId)).not.toContain('zed');
      });
    }, 60_000);
  });

  it('a stale lane of an OLDER run (its limb is not in this run\'s plan) is still reported, and says so', async () => {
    const older = { ...PLAN, limbs: [...PLAN.limbs, { limb: 'old-run-lane', affectedPaths: ['lib/old.js'] }] };
    expect(feedLimb({ parentRoot: repo, plan: older, limb: 'old-run-lane', sessionId: SESSION }, { openStore: () => store, config: OFF }).claim).toBe('claimed');
    clock = new Date(T0 + 25 * H);
    const r = await poll();
    const stale = r.leases.reclaim.candidates.find((c) => c.taskId === 'old-run-lane');
    expect(stale).toMatchObject({ laneOps: null, status: 'claimed', action: 'release-to-queued' });
    const text = renderText(r);
    expect(text).toMatch(/old-run-lane .*lane \(not in this run\)/);
    expect(text).toMatch(/billing .*lane closing/);
  });

  it('no session id: the report says so instead of guessing, collect still resolves, and `missing` is untouched', async () => {
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', '');
    vi.stubEnv('CLAUDE_SESSION_ID', '');
    clock = new Date(T0 + 25 * H);
    const before = store.getState().state_version;
    const r = await collect({ parent: repo, runId: null, storeDir, nowMs: clock.getTime() });
    expect(r.leases.reclaim).toMatchObject({ available: false, reason: 'no-session-id', applied: false, candidates: [] });
    expect(r.leases.heartbeat).toMatchObject({ available: false, reason: 'no-session-id', renewed: 0 });
    expect(r.missing).toEqual([]);
    expect(store.getState().state_version).toBe(before);
  });

  it('--apply-reclaim with no store to read says it did not apply', async () => {
    clock = new Date(T0 + 25 * H);
    const r = await poll({ applyReclaim: true, ports: ports({ sessionId: '' }) });
    expect(r.leases.reclaim).toMatchObject({ mode: 'apply', available: false, applied: false, reason: 'no-session-id' });
    expect(store.getLease(MISSION, 'billing')).not.toBe(null);
  });

  it('a throwing store never breaks the dashboard', async () => {
    clock = new Date(T0 + 25 * H);
    const r = await poll({ ports: ports({ openStore: () => { throw new TypeError('boom'); } }) });
    expect(r.lanes).toHaveLength(2);
    expect(r.leases.reclaim).toMatchObject({ available: false, applied: false });
    expect(r.leases.reclaim.reason).toMatch(/boom/);
    expect(r.leases.heartbeat.lanes[0].outcome).toBe('skipped:store-threw:boom');
  });

  it('the text output carries the lease lines; the table header and notice are still there', async () => {
    clock = new Date(T0 + 25 * H);
    const text = renderText(await poll());
    expect(text).toMatch(/\| limb\s+\| ops state\s+\| supervisor\s+\|/); // the table is padded to its widest row
    expect(text).toContain('lease heartbeat');
    expect(text).toContain('auth: renewed');
    expect(text).toContain('lease reclaim [report-only]: 1 ');
    expect(text).toContain('billing');
    expect(text).toContain('--apply-reclaim');
    expect(text).toContain('측정 고지 (raw):');
  });
});

describe('CLI surface', () => {
  it('parseArgs: the new flags appear only when given, so the existing result shape is unchanged', () => {
    expect(parseArgs(['--json', '--run-id', 'r1', '--parent', 'C:/p', '--store-dir', 'C:/s']))
      .toEqual({ json: true, runId: 'r1', parent: path.resolve('C:/p'), storeDir: path.resolve('C:/s') });
    expect(parseArgs(['--no-heartbeat']).heartbeat).toBe(false);
    expect(parseArgs(['--apply-reclaim']).applyReclaim).toBe(true);
    const both = parseArgs(['--no-heartbeat', '--apply-reclaim', '--json']);
    expect(both).toMatchObject({ heartbeat: false, applyReclaim: true, json: true });
    expect('heartbeat' in parseArgs([])).toBe(false);
    expect('applyReclaim' in parseArgs([])).toBe(false);
  });

  it('a run with no session id: exit 0, valid JSON, and the lease block says why it did nothing', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-watch-lease-empty-'));
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-watch-lease-empty-store-'));
    try {
      const out = execFileSync(process.execPath, [SCRIPT, '--json', '--parent', empty, '--store-dir', storeDir], { encoding: 'utf-8', windowsHide: true, env: NO_SESSION_ENV });
      const parsed = JSON.parse(out);
      expect(parsed.leases.reclaim).toMatchObject({ available: false, reason: 'no-session-id', applied: false });
      expect(parsed.leases.heartbeat).toMatchObject({ enabled: true, eligible: 0, renewed: 0 });
      const text = execFileSync(process.execPath, [SCRIPT, '--parent', empty, '--store-dir', storeDir, '--apply-reclaim'], { encoding: 'utf-8', windowsHide: true, env: NO_SESSION_ENV });
      expect(text).toContain('lease reclaim');
      expect(text).toContain('no-session-id');
    } finally {
      for (const d of [empty, storeDir]) fs.rmSync(d, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('production wiring — the REAL openFeedStore and the REAL central ledger writer, in a child process', () => {
  let repo;
  let storeDir;

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-watch-lease-prod-'));
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-watch-lease-prod-store-'));
    git(['init', '-q', '-b', 'master'], repo);
    git(['config', 'user.email', 't@example.com'], repo);
    git(['config', 'user.name', 't'], repo);
    git(['config', 'commit.gpgsign', 'false'], repo);
    fs.mkdirSync(path.join(repo, '.artibot', 'split'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.artibot', 'split', 'plan.json'), JSON.stringify({ runId: 'split-prod', limbs: [{ limb: 'auth', affectedPaths: ['lib/auth/**'] }] }));
    fs.writeFileSync(path.join(repo, '.artibot', 'split', 'run.json'), JSON.stringify({ runId: 'split-prod', lanes: { auth: { state: 'active' } } }));
  }, 60_000);
  afterAll(() => {
    for (const d of [repo, storeDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  /** What `task-feed.mjs#openFeedStore` builds, with one difference: a clock, so the lease can be aged. */
  const openAged = (now) => createStateStore({
    projectRoot: repo,
    sessionId: SESSION,
    source: 'supervisor',
    renderProjectionFile: false,
    now,
    appendEvent: (envelope) => appendLedgerEvent(repo, envelope),
    resolveGitCommonDir: () => resolveGitCommonDir(repo),
  });
  const ledgerRows = () => fs.readFileSync(path.join(repo, '.git', 'artibot', 'ledger.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const heartbeatRows = () => ledgerRows().filter((e) => e.event === 'state.updated' && e.data?.reason === LANE_LEASE_REASON);
  const childEnv = () => {
    const env = { ...process.env, CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_SESSION_ID: '' };
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
    return env;
  };
  const runWatch = () => JSON.parse(execFileSync(process.execPath, [SCRIPT, '--json', '--parent', repo, '--store-dir', storeDir], { encoding: 'utf-8', windowsHide: true, env: childEnv() }));

  it('a poll past ttl/3 renews a real lease and leaves a split.lane-lease row in the central ledger; the next poll writes nothing', () => {
    // A lease the real feeder claimed 10 hours ago (the real clock minus 10h), through the same store location the child will open.
    const aged = openAged(() => new Date(Date.now() - 10 * H));
    expect(aged.updateMission(MISSION, () => ({
      status: 'executing',
      intent: { path: '.artibot/intent.md', revision: 1 },
      plan: { path: '.artibot/plan.md', revision: 1 },
    }), { reason: 'test.seed' }).ok).toBe(true);
    const plan = { runId: 'split-prod', limbs: [{ limb: 'auth', affectedPaths: ['lib/auth/**'] }] };
    expect(feedLimb({ parentRoot: repo, plan, limb: 'auth', sessionId: SESSION }, { openStore: () => aged, config: OFF }).claim).toBe('claimed');
    expect(heartbeatRows()).toHaveLength(0);

    const first = runWatch();

    expect(first.leases.heartbeat).toMatchObject({ enabled: true, available: true, eligible: 1, renewed: 1 });
    expect(first.leases.heartbeat.lanes[0]).toMatchObject({ limb: 'auth', outcome: 'renewed', missionId: MISSION });
    const now = openAged(() => new Date());
    const lease = now.getLease(MISSION, 'auth');
    expect(Math.abs(Date.now() - Date.parse(lease.heartbeat_at))).toBeLessThan(5 * MIN);
    expect(Date.parse(lease.heartbeat_at) - Date.parse(lease.acquired_at)).toBeGreaterThan(9.9 * H);
    expect(Date.parse(lease.expires_at) - Date.parse(lease.heartbeat_at)).toBe(24 * H);
    expect(now.getTaskGraph(MISSION).tasks.find((t) => t.id === 'auth')).toMatchObject({ status: 'claimed', heartbeat_source: 'lane-heartbeat' });
    // The exact evidence the SH-12 measurement reads: a state.updated row, reason split.lane-lease, in the central ledger.
    expect(heartbeatRows()).toHaveLength(1);
    expect(heartbeatRows()[0]).toMatchObject({ event: 'state.updated', mission_id: MISSION, session_id: SESSION });

    const second = runWatch();

    expect(second.leases.heartbeat.lanes[0].outcome).toBe('skipped:not-due');
    expect(second.leases.heartbeat.renewed).toBe(0);
    expect(heartbeatRows()).toHaveLength(1);
    expect(second.leases.reclaim).toMatchObject({ mode: 'report', available: true, applied: false, candidates: [] });
  }, 120_000);
});

describe('renderLeaseLines — pure', () => {
  const heartbeat = (over = {}) => ({
    enabled: true, available: true, reason: null, divisor: 3, eligible: 2, renewed: 1,
    lanes: [
      { limb: 'auth', opsState: 'active', eligible: true, outcome: 'renewed', missionId: MISSION },
      { limb: 'billing', opsState: 'active', eligible: true, outcome: 'skipped:not-due', missionId: MISSION, detail: { reason: 'fresh', ageMs: 2 * H, intervalMs: 8 * H, ttlMs: 24 * H, expired: false } },
      { limb: 'done-lane', opsState: 'done', eligible: false, outcome: 'skipped:ops-state:done', missionId: null },
    ],
    ...over,
  });
  const reclaim = (over = {}) => ({
    mode: 'report', available: true, reason: null, applied: false, scanned: { missions: 1, leases: 1, laneLeases: 1 }, live: 0,
    protected: [], malformed: [], results: [],
    candidates: [{
      missionId: MISSION, taskId: 'gone', owner: 'gone', ownerIsLane: true, status: 'claimed', carriesOps: false, laneOps: 'done',
      acquiredAt: 'x', heartbeatAt: 'x', expiresAt: 'x', expiredForMs: 3 * H + 10 * MIN, silentForMs: 27 * H, heartbeatSource: null,
      action: 'release-to-queued', targetStatus: 'queued',
    }],
    ...over,
  });

  it('prints one line per ELIGIBLE lane (the finished ones are not interesting), with the due time for a not-due lane', () => {
    const text = renderLeaseLines({ heartbeat: heartbeat(), reclaim: reclaim({ candidates: [] }) }).join('\n');
    expect(text).toContain('lease heartbeat');
    expect(text).toContain('1 of 2');
    expect(text).toContain('auth: renewed');
    expect(text).toMatch(/billing: skipped:not-due.*2h 0m.*8h 0m/);
    expect(text).not.toContain('done-lane');
  });

  it('is quiet when there is nothing to say: no eligible lane, no candidate', () => {
    const lines = renderLeaseLines({
      heartbeat: heartbeat({ eligible: 0, renewed: 0, lanes: [] }),
      reclaim: reclaim({ candidates: [] }),
    });
    expect(lines).toEqual([]);
  });

  it('says so when the heartbeat is off or could not run', () => {
    expect(renderLeaseLines({ heartbeat: heartbeat({ enabled: false }), reclaim: reclaim({ candidates: [] }) }).join('\n')).toContain('--no-heartbeat');
    const unavailable = renderLeaseLines({
      heartbeat: heartbeat({ available: false, reason: 'no-session-id', renewed: 0 }),
      reclaim: reclaim({ available: false, reason: 'no-session-id', candidates: [] }),
    }).join('\n');
    expect(unavailable).toContain('no-session-id');
    expect(unavailable).toContain('lease reclaim: not run');
  });

  it('the report is labelled report-only, names each candidate and how to apply; apply mode prints outcomes instead', () => {
    const report = renderLeaseLines({ heartbeat: heartbeat({ eligible: 0, renewed: 0, lanes: [] }), reclaim: reclaim() }).join('\n');
    expect(report).toContain('lease reclaim [report-only]: 1 ');
    expect(report).toContain('gone');
    expect(report).toContain(MISSION);
    expect(report).toContain('release-to-queued');
    expect(report).toContain('3h 10m');
    expect(report).toContain('--apply-reclaim');
    expect(report).toContain('lane done');
    const stale = renderLeaseLines({
      heartbeat: heartbeat({ eligible: 0, renewed: 0, lanes: [] }),
      reclaim: reclaim({ candidates: [{ ...reclaim().candidates[0], laneOps: null }] }),
    }).join('\n');
    expect(stale).toContain('lane (not in this run)');

    const applied = renderLeaseLines({
      heartbeat: heartbeat({ eligible: 0, renewed: 0, lanes: [] }),
      reclaim: reclaim({ mode: 'apply', applied: true, results: [{ missionId: MISSION, taskId: 'gone', outcome: 'reclaimed:queued' }] }),
    }).join('\n');
    expect(applied).toContain('lease reclaim [apply]');
    expect(applied).toContain('gone: reclaimed:queued');
    expect(applied).not.toContain('pass --apply-reclaim');
  });

  it('is total on missing or malformed input', () => {
    for (const v of [undefined, null, {}, { heartbeat: null, reclaim: null }, 'x']) expect(() => renderLeaseLines(v)).not.toThrow();
    expect(renderLeaseLines(undefined)).toEqual([]);
  });
});
