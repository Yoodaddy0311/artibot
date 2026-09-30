/**
 * `lib/topology/lease-reclaim.js` — the TTL arithmetic of a `/split` LANE lease:
 * when a heartbeat is due (SH-12) and which expired leases are reclaimable
 * (CA-09). Report-only unless `apply` is the literal `true`.
 *
 * What is measured here, and how:
 *  - `heartbeatCadence`: boundary at exactly ttl/3, the TTL read the way
 *    `lease.js#renewLease` reads it (pinned against `renewLease` itself, not
 *    against a second copy of the arithmetic), a lapsed lease is due, and the
 *    function is total on garbage.
 *  - `isLaneTask`: pinned against the REAL feeder (`mergeLimbTasks`), so a
 *    change of the seeded title turns this red instead of silently emptying
 *    every reclaim report.
 *  - `findReclaimCandidates`: pure, on hand-built snapshots — live vs lapsed,
 *    the expiry boundary, terminal and bound (`ops`) nodes keep their status,
 *    non-lane leases are out of scope, a keep-alive lane is protected, damaged
 *    records are listed and never candidates.
 *  - `reclaimExpiredLaneLeases`: against a REAL StateStore in a tmp dir with a
 *    fake clock. Report mode writes nothing (version, journal bytes, ledger);
 *    only the literal `true` applies; a renewal or an unrelated write between
 *    report and apply is honoured (`not-expired` / `conflict`); apply
 *    releases through the store, so a re-dispatch can claim the limb again.
 *
 * What it cannot see (rules §9): a live `/split` run, the real 24h cadence on a
 * wall clock, and whether a human reads the report. Fixtures are a handful of
 * tasks — nothing here says how the scan behaves on a store with thousands of
 * journal records (every `getState()` re-parses the whole journal).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStateStore } from '../../lib/project-state/state-manager.js';
import { createLease, renewLease } from '../../lib/project-state/lease.js';
import { LIMB_LEASE_TTL_MS, mergeLimbTasks } from '../../lib/topology/split-task-feed.js';
import {
  findReclaimCandidates,
  HEARTBEAT_INTERVAL_DIVISOR,
  heartbeatCadence,
  isLaneTask,
  LANE_TASK_TITLE_PREFIX,
  LEASE_RECLAIM_REASON,
  reclaimExpiredLaneLeases,
} from '../../lib/topology/lease-reclaim.js';
import { feedLimb } from '../../scripts/split/task-feed.mjs';

const H = 3_600_000;
const T0 = Date.parse('2026-09-30T00:00:00.000Z');
const SESSION = 'abcd1234-ef56-7890-1234-567890abcdef';
const MISSION = 'M-20260930-Sabcd1234';
const OFF = { split: { missionBinding: { enabled: false } } };
const PLAN = {
  runId: 'split-lr',
  limbs: [
    { limb: 'auth', affectedPaths: ['lib/auth/**'] },
    { limb: 'billing', affectedPaths: ['lib/billing.js'] },
  ],
};

/** @param {string} id @param {object} [extra] */
const laneTask = (id, extra = {}) => ({ id, mission_id: MISSION, title: `${LANE_TASK_TITLE_PREFIX}${id}`, status: 'claimed', owner: id, ...extra });

/** A hand-built snapshot with one mission. */
function snap(tasks, leases, mission = MISSION) {
  return {
    state_version: 7,
    task_graphs: { [mission]: { schema_version: 1, mission_id: mission, tasks } },
    task_leases: { [mission]: leases },
  };
}

/** @param {unknown} v */
function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

describe('heartbeatCadence — when a lane lease is due a heartbeat', () => {
  const lease = createLease({ owner: 'auth', now: T0, ttlMs: 24 * H });

  it('the divisor is 3: a 24h lease is due at exactly 8h, not a millisecond before', () => {
    expect(HEARTBEAT_INTERVAL_DIVISOR).toBe(3);
    const early = heartbeatCadence(lease, T0 + 8 * H - 1);
    expect(early).toMatchObject({ due: false, reason: 'fresh', ttlMs: 24 * H, intervalMs: 8 * H, ageMs: 8 * H - 1, expired: false });
    const edge = heartbeatCadence(lease, T0 + 8 * H);
    expect(edge).toMatchObject({ due: true, reason: 'due', ttlMs: 24 * H, intervalMs: 8 * H, ageMs: 8 * H, expired: false });
  });

  it('the TTL is read the way renewLease grants it: pinned against renewLease, including a renewed and a damaged record', () => {
    const now = T0 + 9 * H;
    const granted = (l) => Date.parse(renewLease(l, { now }).expires_at) - now;
    expect(heartbeatCadence(lease, now).ttlMs).toBe(granted(lease));

    // Renewed once: the span stays 24h (SP-05), it does not grow by the time held.
    const renewed = renewLease(lease, { now: T0 + 8 * H });
    expect(heartbeatCadence(renewed, now).ttlMs).toBe(granted(renewed));
    expect(heartbeatCadence(renewed, now).ttlMs).toBe(24 * H);

    // heartbeat_at missing: renewLease falls back to expires_at - acquired_at, and so does this.
    const damaged = { ...lease };
    delete damaged.heartbeat_at;
    expect(heartbeatCadence(damaged, now).ttlMs).toBe(granted(damaged));
    expect(heartbeatCadence(damaged, now).ageMs).toBe(9 * H);
  });

  it('the age runs from the LAST heartbeat, not from acquisition', () => {
    const renewed = renewLease(lease, { now: T0 + 8 * H });
    expect(heartbeatCadence(renewed, T0 + 8 * H + 30 * 60_000)).toMatchObject({ due: false, ageMs: 30 * 60_000 });
    expect(heartbeatCadence(renewed, T0 + 16 * H)).toMatchObject({ due: true, ageMs: 8 * H });
  });

  it('a lapsed lease is due (and says so): the lane is renewed back, not left to lapse further', () => {
    expect(heartbeatCadence(lease, T0 + 30 * H)).toMatchObject({ due: true, reason: 'due', expired: true });
    // Not expired exactly AT expires_at (isLeaseExpired is strictly after).
    expect(heartbeatCadence(lease, T0 + 24 * H).expired).toBe(false);
    expect(heartbeatCadence(lease, T0 + 24 * H + 1).expired).toBe(true);
  });

  it('a heartbeat in the future (clock skew) is not due', () => {
    const future = renewLease(lease, { now: T0 + 50 * H });
    expect(heartbeatCadence(future, T0 + 10 * H)).toMatchObject({ due: false, reason: 'fresh' });
  });

  it('the divisor is an option, and an unusable one falls back to 3 (a divisor below 1 would outlive the lease)', () => {
    expect(heartbeatCadence(lease, T0 + 24 * H, { divisor: 1 }).due).toBe(true);
    expect(heartbeatCadence(lease, T0 + 24 * H - 1, { divisor: 1 }).due).toBe(false);
    for (const bad of [0, -2, 0.5, NaN, Infinity, '3', null]) {
      expect(heartbeatCadence(lease, T0 + 8 * H, { divisor: bad }).intervalMs, String(bad)).toBe(8 * H);
    }
  });

  it('is total: no lease, a damaged lease or a bad clock is a reason, never a throw and never due', () => {
    expect(heartbeatCadence(null, T0)).toEqual({ due: false, reason: 'no-lease' });
    expect(heartbeatCadence(undefined, T0).reason).toBe('no-lease');
    expect(heartbeatCadence('nope', T0).reason).toBe('bad-lease');
    expect(heartbeatCadence({ owner: 'x', acquired_at: 'x', expires_at: 'y', heartbeat_at: 'z' }, T0).reason).toBe('bad-lease');
    expect(heartbeatCadence({ owner: 'x', acquired_at: new Date(T0).toISOString(), expires_at: new Date(T0).toISOString() }, T0).reason).toBe('bad-lease');
    expect(heartbeatCadence(lease, NaN).reason).toBe('bad-clock');
    expect(heartbeatCadence(lease, '2026').reason).toBe('bad-clock');
    for (const r of [null, 'nope', { owner: 'x' }]) expect(heartbeatCadence(r, T0).due).toBe(false);
  });
});

describe('isLaneTask — which nodes carry a LANE lease', () => {
  it('recognises every node the real feeder seeds (drift guard against split-task-feed.js)', () => {
    const { graph } = mergeLimbTasks({ graph: null, plan: PLAN, missionId: MISSION, now: new Date(T0) });
    expect(graph.tasks.map((t) => t.id)).toEqual(['auth', 'billing']);
    for (const t of graph.tasks) expect(isLaneTask(t), t.id).toBe(true);
  });

  it('does not recognise a /team-style task, nor garbage', () => {
    expect(isLaneTask({ id: 'T-14', title: 'write the docs', status: 'queued' })).toBe(false);
    expect(isLaneTask({ id: 'T-15', status: 'queued' })).toBe(false);
    for (const v of [null, undefined, 'auth', 7, []]) expect(isLaneTask(v)).toBe(false);
  });

  it('a bound node (it carries `ops`) is a lane even if its title was rewritten', () => {
    expect(isLaneTask({ id: 'x', title: 'renamed', status: 'executing', ops: { state: 'active', since: new Date(T0).toISOString(), run_id: 'r' } })).toBe(true);
    expect(isLaneTask({ id: 'x', title: 'renamed', status: 'executing', ops: 'active' })).toBe(false);
  });
});

describe('findReclaimCandidates — the pure scan', () => {
  const lapsed = (owner = 'auth') => createLease({ owner, now: T0, ttlMs: 24 * H });

  it('needs a finite clock, because a pure function does not read Date.now()', () => {
    expect(() => findReclaimCandidates({ state: snap([], {}) })).toThrow(TypeError);
    expect(() => findReclaimCandidates({ state: snap([], {}), nowMs: NaN })).toThrow(TypeError);
    expect(() => findReclaimCandidates()).toThrow(TypeError);
  });

  it('a live lease is not a candidate; a lapsed one is, with the exact record a human needs', () => {
    const state = snap([laneTask('auth'), laneTask('billing')], {
      auth: lapsed('auth'),
      billing: createLease({ owner: 'billing', now: T0 + 20 * H, ttlMs: 24 * H }),
    });
    const r = findReclaimCandidates({ state, nowMs: T0 + 25 * H });
    expect(r.scanned).toEqual({ missions: 1, leases: 2, laneLeases: 2 });
    expect(r.live).toBe(1);
    expect(r.candidates).toEqual([{
      missionId: MISSION,
      taskId: 'auth',
      owner: 'auth',
      ownerIsLane: true,
      status: 'claimed',
      carriesOps: false,
      acquiredAt: '2026-09-30T00:00:00.000Z',
      heartbeatAt: '2026-09-30T00:00:00.000Z',
      expiresAt: '2026-10-01T00:00:00.000Z',
      expiredForMs: H,
      silentForMs: 25 * H,
      heartbeatSource: null,
      action: 'release-to-queued',
      targetStatus: 'queued',
    }]);
    expect(r.protected).toEqual([]);
    expect(r.malformed).toEqual([]);
  });

  it('the expiry boundary is isLeaseExpired: not expired AT expires_at, expired one millisecond after', () => {
    const state = snap([laneTask('auth')], { auth: lapsed() });
    expect(findReclaimCandidates({ state, nowMs: T0 + 24 * H }).candidates).toEqual([]);
    expect(findReclaimCandidates({ state, nowMs: T0 + 24 * H }).live).toBe(1);
    expect(findReclaimCandidates({ state, nowMs: T0 + 24 * H + 1 }).candidates).toHaveLength(1);
  });

  it('reports the heartbeat the task carries, and whose lease it was', () => {
    const state = snap(
      [laneTask('auth', { heartbeat_at: '2026-09-30T05:00:00.000Z', heartbeat_source: 'lane-heartbeat' })],
      { auth: lapsed('intruder') },
    );
    const [c] = findReclaimCandidates({ state, nowMs: T0 + 25 * H }).candidates;
    expect(c).toMatchObject({ owner: 'intruder', ownerIsLane: false, heartbeatSource: 'lane-heartbeat' });
  });

  it('an owned node goes back to queued; a finished or blocked node only loses the dead lease and keeps its status', () => {
    const tasks = [
      laneTask('a', { status: 'claimed' }),
      laneTask('b', { status: 'executing' }),
      laneTask('c', { status: 'reviewing' }),
      laneTask('d', { status: 'done', owner: null }),
      laneTask('e', { status: 'failed', owner: null }),
      laneTask('f', { status: 'cancelled', owner: null }),
      laneTask('g', { status: 'queued', owner: null }),
      laneTask('h', { status: 'blocked', owner: null, blockers: ['lane:a'] }),
    ];
    const leases = Object.fromEntries(tasks.map((t) => [t.id, lapsed(t.id)]));
    const { candidates } = findReclaimCandidates({ state: snap(tasks, leases), nowMs: T0 + 25 * H });
    const by = Object.fromEntries(candidates.map((c) => [c.taskId, [c.action, c.targetStatus]]));
    expect(by).toEqual({
      a: ['release-to-queued', 'queued'],
      b: ['release-to-queued', 'queued'],
      c: ['release-to-queued', 'queued'],
      d: ['clear-lease', 'done'],
      e: ['clear-lease', 'failed'],
      f: ['clear-lease', 'cancelled'],
      g: ['clear-lease', 'queued'],
      h: ['clear-lease', 'blocked'],
    });
  });

  it('a bound node (carries ops) keeps its status even when owned: ops.state and status must keep agreeing', () => {
    const ops = { state: 'active', since: new Date(T0).toISOString(), run_id: 'split-lr' };
    const state = snap([laneTask('auth', { status: 'executing', ops })], { auth: lapsed() });
    const [c] = findReclaimCandidates({ state, nowMs: T0 + 25 * H }).candidates;
    expect(c).toMatchObject({ carriesOps: true, action: 'clear-lease', targetStatus: 'executing' });
  });

  it('a lease on a task that is not a lane is out of scope: counted as scanned, never a candidate', () => {
    const state = snap(
      [laneTask('auth'), { id: 'T-14', mission_id: MISSION, title: 'write the docs', status: 'claimed', owner: 'writer' }],
      { auth: lapsed(), 'T-14': lapsed('writer') },
    );
    const r = findReclaimCandidates({ state, nowMs: T0 + 25 * H });
    expect(r.scanned).toEqual({ missions: 1, leases: 2, laneLeases: 1 });
    expect(r.candidates.map((c) => c.taskId)).toEqual(['auth']);
  });

  it('a keep-alive lane is protected, not a candidate; a keep-alive id that holds nothing changes nothing', () => {
    const state = snap([laneTask('auth'), laneTask('billing')], { auth: lapsed('auth'), billing: lapsed('billing') });
    const r = findReclaimCandidates({ state, nowMs: T0 + 25 * H, keepAlive: new Set(['auth', 'nobody']) });
    expect(r.candidates.map((c) => c.taskId)).toEqual(['billing']);
    expect(r.protected).toEqual([{ missionId: MISSION, taskId: 'auth', owner: 'auth', expiredForMs: H }]);
  });

  it('keepAlive is lenient about its container but never widens: an array, a set, nothing, garbage', () => {
    const state = snap([laneTask('auth')], { auth: lapsed() });
    const run = (keepAlive) => findReclaimCandidates({ state, nowMs: T0 + 25 * H, keepAlive }).candidates.length;
    expect(run(['auth'])).toBe(0);
    expect(run(new Set(['auth']))).toBe(0);
    expect(run(undefined)).toBe(1);
    expect(run(null)).toBe(1);
    expect(run('auth')).toBe(1);
    expect(run(42)).toBe(1);
  });

  it('damaged records are listed with a reason and are never candidates (only a parsed, expired lease is)', () => {
    const state = snap([laneTask('auth'), laneTask('bad-date'), laneTask('bad-shape')], {
      auth: lapsed(),
      ghost: lapsed('ghost'),
      'bad-date': { ...lapsed('bad-date'), expires_at: 'never' },
      'bad-shape': 'held',
    });
    const r = findReclaimCandidates({ state, nowMs: T0 + 25 * H });
    expect(r.candidates.map((c) => c.taskId)).toEqual(['auth']);
    expect(r.malformed).toEqual([
      { missionId: MISSION, taskId: 'bad-date', reason: 'bad-expires_at' },
      { missionId: MISSION, taskId: 'bad-shape', reason: 'not-an-object' },
      { missionId: MISSION, taskId: 'ghost', reason: 'no-task-node' },
    ]);
  });

  it('is deterministic across missions: sorted by mission then task, whatever the object order', () => {
    const a = 'M-20260930-Saaaaaaaa';
    const b = 'M-20260930-Sbbbbbbbb';
    const state = {
      state_version: 1,
      task_graphs: {
        [b]: { schema_version: 1, mission_id: b, tasks: [laneTask('z', { mission_id: b }), laneTask('m', { mission_id: b })] },
        [a]: { schema_version: 1, mission_id: a, tasks: [laneTask('q', { mission_id: a })] },
      },
      task_leases: { [b]: { z: lapsed('z'), m: lapsed('m') }, [a]: { q: lapsed('q') } },
    };
    const r = findReclaimCandidates({ state, nowMs: T0 + 25 * H });
    expect(r.candidates.map((c) => `${c.missionId}/${c.taskId}`)).toEqual([`${a}/q`, `${b}/m`, `${b}/z`]);
    expect(r.scanned.missions).toBe(2);
  });

  it('does not mutate its input, and is total on an empty or foreign snapshot', () => {
    const state = deepFreeze(snap([laneTask('auth')], { auth: lapsed() }));
    expect(() => findReclaimCandidates({ state, nowMs: T0 + 25 * H })).not.toThrow();
    for (const s of [undefined, null, {}, { task_leases: null }, { task_leases: { [MISSION]: null } }, { task_leases: { [MISSION]: { x: lapsed() } } }]) {
      const r = findReclaimCandidates({ state: s, nowMs: T0 });
      expect(r.candidates).toEqual([]);
    }
  });
});

describe('reclaimExpiredLaneLeases — against a real StateStore', () => {
  let root;
  /** @type {object[]} */ let ledger;
  let clock;
  let refuseLedger;

  function makeStore() {
    return createStateStore({
      projectRoot: root,
      sessionId: SESSION,
      renderProjectionFile: false,
      now: () => clock,
      resolveGitCommonDir: () => path.join(root, '.git'),
      appendEvent: (e) => (refuseLedger ? { ok: false, reason: 'port-down' } : void ledger.push(e)),
    });
  }

  function seedMission(store) {
    const r = store.updateMission(MISSION, () => ({
      status: 'executing',
      intent: { path: '.artibot/intent.md', revision: 1 },
      plan: { path: '.artibot/plan.md', revision: 1 },
    }), { reason: 'test.seed' });
    expect(r.ok).toBe(true);
  }

  const feed = (store, limb = 'auth') => feedLimb({ parentRoot: root, plan: PLAN, limb, sessionId: SESSION }, { openStore: () => store, config: OFF });
  const updates = () => ledger.filter((e) => e.event === 'state.updated');
  const task = (store, limb = 'auth') => store.getTaskGraph(MISSION).tasks.find((t) => t.id === limb);
  const journal = (store) => fs.readFileSync(store.paths.journal, 'utf-8');

  /** A store whose `auth` lane was claimed at T0 and whose clock now reads T0 + 25h. Returns the store and "now". */
  function lapsedStore(limbs = ['auth']) {
    const store = makeStore();
    seedMission(store);
    clock = new Date(T0);
    for (const l of limbs) expect(feed(store, l).claim).toBe('claimed');
    clock = new Date(T0 + 25 * H);
    return { store, nowMs: T0 + 25 * H };
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-lease-reclaim-'));
    const dir = path.join(root, '.artibot', 'split');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(PLAN));
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ runId: 'split-lr' }));
    ledger = [];
    clock = new Date(T0);
    refuseLedger = false;
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('the fixture is what it claims: the real feeder took a 24h lease at T0', () => {
    const store = makeStore();
    seedMission(store);
    expect(feed(store).claim).toBe('claimed');
    const lease = store.getLease(MISSION, 'auth');
    expect(lease.owner).toBe('auth');
    expect(Date.parse(lease.expires_at) - Date.parse(lease.acquired_at)).toBe(LIMB_LEASE_TTL_MS);
  });

  it('REPORT-ONLY by default: it names the candidate and writes nothing — version, journal bytes and ledger are untouched', () => {
    const { store, nowMs } = lapsedStore();
    const version = store.getState().state_version;
    const before = journal(store);
    const events = ledger.length;

    const out = reclaimExpiredLaneLeases({ store, nowMs });

    expect(out.mode).toBe('report');
    expect(out.applied).toBe(false);
    expect(out.results).toEqual([]);
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]).toMatchObject({ missionId: MISSION, taskId: 'auth', owner: 'auth', status: 'claimed', action: 'release-to-queued', expiredForMs: H });
    expect(store.getState().state_version).toBe(version);
    expect(journal(store)).toBe(before);
    expect(ledger.length).toBe(events);
    expect(store.getLease(MISSION, 'auth')?.owner).toBe('auth');
    expect(task(store).status).toBe('claimed');
  });

  it('report mode never reaches a store write port (every writer throws if touched)', () => {
    const { store, nowMs } = lapsedStore();
    const trip = (name) => vi.fn(() => { throw new Error(`${name} called in report mode`); });
    const guarded = {
      getState: store.getState,
      getLease: store.getLease,
      updateMission: trip('updateMission'),
      claimTask: trip('claimTask'),
      releaseTask: trip('releaseTask'),
      heartbeatWorker: trip('heartbeatWorker'),
      appendEvent: trip('appendEvent'),
    };
    expect(() => reclaimExpiredLaneLeases({ store: guarded, nowMs })).not.toThrow();
    expect(() => reclaimExpiredLaneLeases({ store: guarded, nowMs, apply: false })).not.toThrow();
    for (const name of ['updateMission', 'claimTask', 'releaseTask', 'heartbeatWorker', 'appendEvent']) {
      expect(guarded[name], name).not.toHaveBeenCalled();
    }
  });

  it('only the literal `true` applies — truthy look-alikes stay report-only', () => {
    const { store, nowMs } = lapsedStore();
    const version = store.getState().state_version;
    for (const apply of ['true', 'yes', 1, {}, [], 'apply', 'false']) {
      const out = reclaimExpiredLaneLeases({ store, nowMs, apply });
      expect(out.mode, String(apply)).toBe('report');
      expect(out.applied).toBe(false);
    }
    expect(store.getState().state_version).toBe(version);
    expect(store.getLease(MISSION, 'auth')).not.toBe(null);
  });

  it('apply:true releases the lease and returns the owned node to queued in ONE commit, reason split.lease-reclaim', () => {
    const { store, nowMs } = lapsedStore();
    const before = updates().length;

    const out = reclaimExpiredLaneLeases({ store, nowMs, apply: true });

    expect(out.mode).toBe('apply');
    expect(out.applied).toBe(true);
    expect(out.results).toEqual([{ missionId: MISSION, taskId: 'auth', outcome: 'reclaimed:queued' }]);
    expect(store.getLease(MISSION, 'auth')).toBe(null);
    expect(task(store)).toMatchObject({ status: 'queued', owner: null });
    expect(updates().length).toBe(before + 1);
    expect(updates().at(-1).data.reason).toBe(LEASE_RECLAIM_REASON);
    expect(LEASE_RECLAIM_REASON).toBe('split.lease-reclaim');
    // No new ledger event name: the store's own state.updated is the only one.
    expect(new Set(ledger.map((e) => e.event))).toEqual(new Set(['state.updated']));
  });

  it('the reclaimed limb is claimable again: a re-dispatch takes a fresh lease (positive control for "reclaim")', () => {
    const { store, nowMs } = lapsedStore();
    expect(reclaimExpiredLaneLeases({ store, nowMs, apply: true }).applied).toBe(true);

    expect(feed(store).claim).toBe('claimed');
    const lease = store.getLease(MISSION, 'auth');
    expect(Date.parse(lease.acquired_at)).toBe(nowMs);
    expect(Date.parse(lease.expires_at)).toBe(nowMs + LIMB_LEASE_TTL_MS);
    expect(task(store).status).toBe('claimed');
  });

  it('a second apply finds nothing: the reclaim is idempotent and writes no second commit', () => {
    const { store, nowMs } = lapsedStore();
    expect(reclaimExpiredLaneLeases({ store, nowMs, apply: true }).applied).toBe(true);
    const version = store.getState().state_version;
    const again = reclaimExpiredLaneLeases({ store, nowMs, apply: true });
    expect(again.candidates).toEqual([]);
    expect(again.applied).toBe(false);
    expect(store.getState().state_version).toBe(version);
  });

  it('a live lease is left alone even in apply mode', () => {
    const store = makeStore();
    seedMission(store);
    feed(store, 'auth');
    clock = new Date(T0 + 23 * H);
    const version = store.getState().state_version;
    const out = reclaimExpiredLaneLeases({ store, nowMs: T0 + 23 * H, apply: true });
    expect(out.candidates).toEqual([]);
    expect(out.live).toBe(1);
    expect(out.applied).toBe(false);
    expect(store.getState().state_version).toBe(version);
    expect(store.getLease(MISSION, 'auth')).not.toBe(null);
  });

  it('a keep-alive lane survives apply; its sibling does not', () => {
    const { store, nowMs } = lapsedStore(['auth', 'billing']);
    const out = reclaimExpiredLaneLeases({ store, nowMs, apply: true, keepAlive: ['auth'] });
    expect(out.protected.map((p) => p.taskId)).toEqual(['auth']);
    expect(out.results.map((r) => [r.taskId, r.outcome])).toEqual([['billing', 'reclaimed:queued']]);
    expect(store.getLease(MISSION, 'auth')?.owner).toBe('auth');
    expect(store.getLease(MISSION, 'billing')).toBe(null);
  });

  it('a holder that renews between the report and the release keeps its lease (skipped:not-expired)', () => {
    const { store, nowMs } = lapsedStore();
    let reads = 0;
    const racing = {
      ...store,
      getState: () => {
        reads += 1;
        // read #1 is the report; read #2 is the apply's own re-read — the holder beats it.
        if (reads === 2) {
          clock = new Date(nowMs);
          expect(store.heartbeatWorker({ missionId: MISSION, taskId: 'auth', owner: 'auth' }).ok).toBe(true);
        }
        return store.getState();
      },
    };

    const out = reclaimExpiredLaneLeases({ store: racing, nowMs, apply: true });

    expect(out.candidates).toHaveLength(1);
    expect(out.results).toEqual([{ missionId: MISSION, taskId: 'auth', outcome: 'skipped:not-expired' }]);
    expect(out.applied).toBe(false);
    expect(store.getLease(MISSION, 'auth')?.heartbeat_at).toBe(new Date(nowMs).toISOString());
    expect(task(store).status).toBe('claimed');
  });

  it('any store write between the re-read and the release is a CAS conflict: nothing is released (skipped:conflict)', () => {
    const { store, nowMs } = lapsedStore();
    const racing = {
      ...store,
      releaseTask: (params) => {
        store.updateMission(MISSION, (cur) => cur, { reason: 'test.bump' });
        return store.releaseTask(params);
      },
    };

    const out = reclaimExpiredLaneLeases({ store: racing, nowMs, apply: true });

    expect(out.results).toEqual([{ missionId: MISSION, taskId: 'auth', outcome: 'skipped:conflict' }]);
    expect(out.applied).toBe(false);
    expect(store.getLease(MISSION, 'auth')?.owner).toBe('auth');
  });

  it('a lease that changed hands between the report and the re-read is not released (skipped:lease-changed)', () => {
    const { store, nowMs } = lapsedStore();
    let reads = 0;
    const swapped = {
      ...store,
      getState: () => {
        reads += 1;
        if (reads === 2) {
          clock = new Date(nowMs);
          // Another owner reclaims the lapsed lease the normal way (claimTask judges expiry in its lock).
          expect(store.claimTask({ missionId: MISSION, taskId: 'auth', owner: 'rescuer', ttlMs: 60_000 }).reclaimed).toBe(true);
          clock = new Date(nowMs + 2 * 60_000); // and that lease lapses too, so only the owner differs
        }
        return store.getState();
      },
    };
    const out = reclaimExpiredLaneLeases({ store: swapped, nowMs: nowMs + 2 * 60_000, apply: true });
    // The report (read #1) saw owner 'auth'; the re-read saw 'rescuer'.
    expect(out.results).toEqual([{ missionId: MISSION, taskId: 'auth', outcome: 'skipped:lease-changed' }]);
    expect(store.getLease(MISSION, 'auth')?.owner).toBe('rescuer');
  });

  it('a finished node with a leftover lease only loses the lease: status done is kept', () => {
    const { store, nowMs } = lapsedStore();
    const graph = store.getTaskGraph(MISSION);
    expect(store.updateMission(MISSION, (cur) => cur, {
      reason: 'test.finish',
      graph: { ...graph, tasks: graph.tasks.map((t) => (t.id === 'auth' ? { ...t, status: 'done', owner: null } : t)) },
    }).ok).toBe(true);
    expect(store.getLease(MISSION, 'auth')).not.toBe(null);

    const out = reclaimExpiredLaneLeases({ store, nowMs, apply: true });

    expect(out.results).toEqual([{ missionId: MISSION, taskId: 'auth', outcome: 'reclaimed:done' }]);
    expect(store.getLease(MISSION, 'auth')).toBe(null);
    expect(task(store)).toMatchObject({ status: 'done', owner: null });
  });

  it('a bound node (ops) keeps status and owner: ops.state and status still agree after the reclaim', () => {
    const { store, nowMs } = lapsedStore();
    const graph = store.getTaskGraph(MISSION);
    const ops = { state: 'active', since: new Date(T0).toISOString(), run_id: 'split-lr' };
    expect(store.updateMission(MISSION, (cur) => cur, {
      reason: 'test.bind',
      graph: { ...graph, tasks: graph.tasks.map((t) => (t.id === 'auth' ? { ...t, status: 'executing', ops } : t)) },
    }).ok).toBe(true);

    const out = reclaimExpiredLaneLeases({ store, nowMs, apply: true });

    expect(out.results).toEqual([{ missionId: MISSION, taskId: 'auth', outcome: 'reclaimed:executing' }]);
    expect(store.getLease(MISSION, 'auth')).toBe(null);
    expect(task(store)).toMatchObject({ status: 'executing', owner: 'auth', ops });
  });

  it('the release carries the lease token, so a tokened lease is reclaimable and the guard stays armed', () => {
    const store = makeStore();
    seedMission(store);
    feed(store, 'auth');
    // Replace the feeder's tokenless lease with a tokened one, as a different claimer would have.
    expect(store.releaseTask({ missionId: MISSION, taskId: 'auth', owner: 'auth', status: 'queued' }).ok).toBe(true);
    expect(store.claimTask({ missionId: MISSION, taskId: 'auth', owner: 'auth', ttlMs: 24 * H, token: 'tok-1' }).ok).toBe(true);
    expect(store.getLease(MISSION, 'auth').token).toBe('tok-1');
    clock = new Date(T0 + 25 * H);

    const out = reclaimExpiredLaneLeases({ store, nowMs: T0 + 25 * H, apply: true });

    expect(out.results[0].outcome).toBe('reclaimed:queued');
    expect(store.getLease(MISSION, 'auth')).toBe(null);
  });

  it('a refused ledger port abandons the write and is reported as refused; the lease stays', () => {
    const { store, nowMs } = lapsedStore();
    refuseLedger = true;
    const out = reclaimExpiredLaneLeases({ store, nowMs, apply: true });
    expect(out.results[0].outcome).toMatch(/^refused:ledger refused state\.updated/);
    expect(out.applied).toBe(false);
    expect(store.getLease(MISSION, 'auth')?.owner).toBe('auth');
  });

  it('a store that throws mid-apply becomes a refused outcome for that lease, never an exception', () => {
    const { store, nowMs } = lapsedStore(['auth', 'billing']);
    let calls = 0;
    const flaky = {
      ...store,
      releaseTask: (params) => {
        calls += 1;
        if (calls === 1) throw new Error('lock timeout');
        return store.releaseTask(params);
      },
    };
    const out = reclaimExpiredLaneLeases({ store: flaky, nowMs, apply: true });
    expect(out.results.map((r) => [r.taskId, r.outcome])).toEqual([
      ['auth', 'refused:threw:lock timeout'],
      ['billing', 'reclaimed:queued'],
    ]);
    expect(out.applied).toBe(true);
  });
});

describe('module hygiene', () => {
  const SRC = fs.readFileSync(new URL('../../lib/topology/lease-reclaim.js', import.meta.url), 'utf-8');
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('L4: imports only lib siblings — nothing from scripts/, nothing from runtime/', () => {
    const specs = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) {
      expect(s, s).toMatch(/^\.\.?\//);
      expect(s, s).not.toMatch(/scripts|runtime/);
    }
  });

  it('reads no config: the apply switch is a function option, and a config key is the leader\'s later decision', () => {
    expect(code).not.toMatch(/loadConfig|getConfig|readJsonFileSync|getPluginRoot|artibot\.config|process\.env/);
  });

  it('apply is never defaulted on', () => {
    expect(code).not.toMatch(/apply\s*=\s*true/);
    expect(code).toMatch(/apply\s*=\s*false/);
    expect(code).toMatch(/apply\s*[!=]==\s*true/); // the literal-true comparison, in either polarity
  });
});
