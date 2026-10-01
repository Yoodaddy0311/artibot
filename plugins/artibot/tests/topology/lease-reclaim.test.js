/**
 * `lib/topology/lease-reclaim.js` — the TTL arithmetic of a `/split` LANE lease:
 * when a heartbeat is due (SH-12), who a tick may keep alive, and which expired
 * leases are reclaimable (CA-09). Report-only unless `apply` is the literal
 * `true` AND an explicit id list names what to release.
 *
 * What is measured here, and how:
 *  - `heartbeatCadence`: the interval is min(ttl/3, 45 min) with the boundary
 *    exact to the millisecond, the TTL is read the way `lease.js#renewLease`
 *    reads it (pinned against `renewLease` itself, not against a second copy of
 *    the arithmetic), a lapsed lease is due, and the function is total.
 *  - `classifyLaneLiveness`: a lane is renewed only with POSITIVE liveness
 *    evidence (a live lock pid, or lane-state activity inside the TTL window),
 *    finished and dead lanes are not, and a `suspended` lane is held back from
 *    the report without being renewed (ADV-3, ADV-4).
 *  - `parseReclaimIds`: the explicit `<mission>/<task>` list (ADV-1).
 *  - `isLaneTask`: pinned against the REAL feeder (`mergeLimbTasks`), so a
 *    change of the seeded title turns this red instead of silently emptying
 *    every reclaim report.
 *  - `findReclaimCandidates`: pure, on hand-built snapshots — live vs lapsed,
 *    the expiry boundary, terminal and bound (`ops`) nodes keep their status,
 *    non-lane leases are out of scope, a keep-alive lane is protected, damaged
 *    records are listed and never candidates.
 *
 * `reclaimExpiredLaneLeases` (report-only, explicit-id apply) is measured
 * against a REAL StateStore in `lease-reclaim-apply.test.js`.
 *
 * What it cannot see (rules §9): a live `/split` run, the real 24h TTL on a
 * wall clock, pid reuse (a dead session's pid taken by another process reads as
 * alive — no start-time check exists), and whether a human reads the report.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createLease, renewLease } from '../../lib/project-state/lease.js';
import { LANE_OPS_STATES } from '../../lib/supervisor/contracts.js';
import { HEARTBEAT_OPS_STATES } from '../../lib/topology/split-state-sources.js';
import { LIMB_LEASE_TTL_MS, mergeLimbTasks } from '../../lib/topology/split-task-feed.js';
import {
  classifyLaneLiveness,
  findReclaimCandidates,
  HEARTBEAT_INTERVAL_DIVISOR,
  HEARTBEAT_MAX_INTERVAL_MS,
  heartbeatCadence,
  isLaneTask,
  LANE_TASK_TITLE_PREFIX,
  LEASE_TICK_REASON,
  LEASE_TICK_SOURCE,
  LIVENESS_EVIDENCE_WINDOW_MS,
  parseReclaimIds,
} from '../../lib/topology/lease-reclaim.js';

const H = 3_600_000;
const MIN = 60_000;
const T0 = Date.parse('2026-09-30T00:00:00.000Z');
const MISSION = 'M-20260930-Sabcd1234';
const PLAN = {
  runId: 'split-lr',
  limbs: [
    { limb: 'auth', affectedPaths: ['lib/auth/**'] },
    { limb: 'billing', affectedPaths: ['lib/billing.js'] },
  ],
};
/** The id `--apply-reclaim` takes for a lane of the fixture mission. */
const idOf = (task) => `${MISSION}/${task}`;

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

  it('the interval is min(ttl/3, 45 min): a 24h lease is due at exactly 45 minutes, not a millisecond before', () => {
    expect(HEARTBEAT_INTERVAL_DIVISOR).toBe(3);
    expect(HEARTBEAT_MAX_INTERVAL_MS).toBe(45 * MIN);
    const early = heartbeatCadence(lease, T0 + 45 * MIN - 1);
    expect(early).toMatchObject({ due: false, reason: 'fresh', ttlMs: 24 * H, intervalMs: 45 * MIN, ageMs: 45 * MIN - 1, expired: false });
    const edge = heartbeatCadence(lease, T0 + 45 * MIN);
    expect(edge).toMatchObject({ due: true, reason: 'due', ttlMs: 24 * H, intervalMs: 45 * MIN, ageMs: 45 * MIN, expired: false });
  });

  it('a short lease is bound by ttl/3, not by the cap — the two meet at a 135 minute lease', () => {
    const short = createLease({ owner: 'auth', now: T0, ttlMs: 60 * MIN });
    expect(heartbeatCadence(short, T0 + 20 * MIN - 1).due).toBe(false);
    expect(heartbeatCadence(short, T0 + 20 * MIN)).toMatchObject({ due: true, intervalMs: 20 * MIN });
    expect(heartbeatCadence(createLease({ owner: 'a', now: T0, ttlMs: 135 * MIN }), T0).intervalMs).toBe(45 * MIN);
    expect(heartbeatCadence(createLease({ owner: 'a', now: T0, ttlMs: 136 * MIN }), T0).intervalMs).toBe(45 * MIN);
    expect(heartbeatCadence(createLease({ owner: 'a', now: T0, ttlMs: 134 * MIN }), T0).intervalMs).toBeLessThan(45 * MIN);
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
    const renewed = renewLease(lease, { now: T0 + 1 * H });
    expect(heartbeatCadence(renewed, T0 + 1 * H + 30 * MIN)).toMatchObject({ due: false, ageMs: 30 * MIN });
    expect(heartbeatCadence(renewed, T0 + 1 * H + 45 * MIN)).toMatchObject({ due: true, ageMs: 45 * MIN });
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

  it('the divisor and the cap are options; an unusable one falls back to its default', () => {
    const wide = { maxIntervalMs: 24 * H }; // lift the cap, to see the divisor alone
    expect(heartbeatCadence(lease, T0 + 24 * H, { divisor: 1, ...wide }).due).toBe(true);
    expect(heartbeatCadence(lease, T0 + 24 * H - 1, { divisor: 1, ...wide }).due).toBe(false);
    for (const bad of [0, -2, 0.5, NaN, Infinity, '3', null]) {
      expect(heartbeatCadence(lease, T0 + 8 * H, { divisor: bad, ...wide }).intervalMs, `divisor ${String(bad)}`).toBe(8 * H);
    }
    expect(heartbeatCadence(lease, T0, { maxIntervalMs: 10 * MIN }).intervalMs).toBe(10 * MIN);
    for (const bad of [0, -1, NaN, Infinity, '45', null]) {
      expect(heartbeatCadence(lease, T0, { maxIntervalMs: bad }).intervalMs, `cap ${String(bad)}`).toBe(45 * MIN);
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

describe('classifyLaneLiveness — who a tick keeps alive, and who it holds back from the reclaim report', () => {
  const NOW = T0 + 10 * H;
  const fresh = new Date(NOW - 1 * H).toISOString();
  const ago = (ms) => new Date(NOW - ms).toISOString();
  const lane = (over = {}) => ({ opsState: 'active', complete: false, sessionPresent: null, health: { health: 'unknown' }, opsUpdatedAt: fresh, ...over });
  const classify = (over, opts) => classifyLaneLiveness(lane(over), { nowMs: NOW, ...opts });

  it('follows the heartbeat class for EVERY ops state: a working state renews, everything else does not', () => {
    for (const state of LANE_OPS_STATES) {
      const v = classify({ opsState: state });
      const working = HEARTBEAT_OPS_STATES.includes(state);
      expect(v.working, state).toBe(working);
      expect(v.renew, state).toBe(working);
      expect(v.reason, state).toBe(working ? null : `ops-state:${state}`);
      expect(v.keepAlive, state).toBe(working || state === 'suspended');
    }
    // The brief says "active/review"; the allowlist is wider (serial-gate and closing are still the worker's turn).
    const renewing = LANE_OPS_STATES.filter((s) => classify({ opsState: s }).renew).sort();
    expect(renewing).toEqual(['active', 'closing', 'review', 'serial-gate']);
  });

  it('an unknown ops word, or none, is neither renewed nor held — the reader\'s fail-closed answer', () => {
    for (const opsState of [null, undefined, 'dispatched', 'landed', '', 7]) {
      expect(classify({ opsState }), String(opsState)).toMatchObject({ working: false, renew: false, keepAlive: false, reason: 'ops-state:unknown', evidence: null });
    }
  });

  it('a finished lane (trailer complete, or supervisor DONE) is neither renewed nor held: its lease is leftover', () => {
    expect(classify({ opsState: 'closing', complete: true })).toMatchObject({ renew: false, keepAlive: false, reason: 'lane-complete' });
    expect(classify({ opsState: 'review', health: { health: 'done' } })).toMatchObject({ renew: false, keepAlive: false, reason: 'lane-state-done' });
    expect(classify({ opsState: 'suspended', complete: true }).keepAlive).toBe(false);
    expect(classify({ opsState: 'suspended', health: { health: 'done' } }).keepAlive).toBe(false);
  });

  it('a session known dead is neither renewed nor held: a heartbeat would be false evidence of liveness', () => {
    expect(classify({ sessionPresent: false })).toMatchObject({ renew: false, keepAlive: false, reason: 'session-absent' });
  });

  it('ADV-3: a suspended lane is HELD BACK from the report (protected) but never renewed — even with its session gone', () => {
    const v = classify({ opsState: 'suspended', sessionPresent: false, opsUpdatedAt: null });
    expect(v).toMatchObject({ working: false, renew: false, keepAlive: true, reason: 'ops-state:suspended' });
    expect(classify({ opsState: 'suspended' })).toMatchObject({ renew: false, keepAlive: true });
  });

  it('ADV-4: with no lock line (sessionPresent null) a lane is kept alive ONLY while lane-state activity is fresh', () => {
    expect(classify({ sessionPresent: null, opsUpdatedAt: fresh })).toMatchObject({ renew: true, keepAlive: true, reason: null, evidence: 'lane-state-fresh' });
    // exactly the window is still evidence; one millisecond past it is not
    expect(classify({ opsUpdatedAt: ago(LIMB_LEASE_TTL_MS) }).renew).toBe(true);
    expect(classify({ opsUpdatedAt: ago(LIMB_LEASE_TTL_MS + 1) })).toMatchObject({ renew: false, keepAlive: false, reason: 'no-liveness-evidence', evidence: null });
    for (const opsUpdatedAt of [null, undefined, '', 'yesterday', 7]) {
      expect(classify({ opsUpdatedAt }), String(opsUpdatedAt)).toMatchObject({ renew: false, keepAlive: false, reason: 'no-liveness-evidence' });
    }
  });

  it('ADV-4: a live lock pid is evidence on its own — the lane-state timestamp is not needed', () => {
    expect(classify({ sessionPresent: true, opsUpdatedAt: null })).toMatchObject({ renew: true, keepAlive: true, evidence: 'session-alive' });
    expect(classify({ sessionPresent: true, opsUpdatedAt: ago(99 * H) }).renew).toBe(true);
  });

  it('ADV-4: a timestamp from the future is evidence only within a minute of skew', () => {
    expect(classify({ opsUpdatedAt: new Date(NOW + 30_000).toISOString() }).renew).toBe(true);
    expect(classify({ opsUpdatedAt: new Date(NOW + 2 * H).toISOString() })).toMatchObject({ renew: false, reason: 'no-liveness-evidence' });
  });

  it('the evidence window is an option and defaults to the lease TTL; an unusable window falls back to it', () => {
    expect(LIVENESS_EVIDENCE_WINDOW_MS).toBe(LIMB_LEASE_TTL_MS);
    expect(classify({ opsUpdatedAt: ago(2 * H) }, { evidenceWindowMs: 3 * H }).renew).toBe(true);
    expect(classify({ opsUpdatedAt: ago(2 * H) }, { evidenceWindowMs: 1 * H }).renew).toBe(false);
    for (const bad of [0, -1, NaN, '1h', null]) {
      expect(classify({ opsUpdatedAt: ago(2 * H) }, { evidenceWindowMs: bad }).renew, String(bad)).toBe(true);
    }
  });

  it('with no usable clock there is no timestamp evidence, while a live pid still counts', () => {
    expect(classifyLaneLiveness(lane({ sessionPresent: null }), { nowMs: NaN }).renew).toBe(false);
    expect(classifyLaneLiveness(lane({ sessionPresent: null }), {}).renew).toBe(false);
    expect(classifyLaneLiveness(lane({ sessionPresent: true }), { nowMs: NaN }).renew).toBe(true);
  });

  it('is total on garbage', () => {
    for (const v of [null, undefined, 7, 'auth', []]) {
      expect(classifyLaneLiveness(v, { nowMs: NOW }), String(v)).toMatchObject({ renew: false, keepAlive: false });
    }
    expect(() => classifyLaneLiveness()).not.toThrow();
  });
});

describe('parseReclaimIds — the explicit list --apply-reclaim takes (ADV-1)', () => {
  it('accepts <mission>/<task> ids, keeps their order and drops duplicates', () => {
    expect(parseReclaimIds([idOf('auth'), idOf('billing'), idOf('auth')])).toEqual({ ok: true, ids: [idOf('auth'), idOf('billing')] });
  });

  it('accepts both mission id forms the store accepts, and a task id that itself contains a slash', () => {
    const ids = ['M-20260930-001/x', 'M-20260930-12345/x', `${MISSION}/a/b`];
    expect(parseReclaimIds(ids)).toEqual({ ok: true, ids });
  });

  it('refuses — and names the offender — on nothing, an empty list, a non-list, a bare task id, a bad mission id, an empty or spaced or comma task id', () => {
    for (const bad of [undefined, null, [], '', 'M-20260930-Sabcd1234/auth', 7, {}]) {
      expect(parseReclaimIds(bad), String(bad)).toMatchObject({ ok: false });
    }
    const offenders = ['auth', 'm-1/auth', 'M-2026093-001/auth', `${MISSION}/`, `${MISSION}/a b`, `${MISSION}/a,b`, '', 7, null];
    for (const bad of offenders) {
      const r = parseReclaimIds([idOf('auth'), bad]);
      expect(r, String(bad)).toMatchObject({ ok: false });
      expect(r.error, String(bad)).toContain(String(bad));
    }
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
    expect(r.liveIds).toEqual([idOf('billing')]);
    expect(r.candidates).toEqual([{
      id: idOf('auth'),
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
      [laneTask('auth', { heartbeat_at: '2026-09-30T05:00:00.000Z', heartbeat_source: LEASE_TICK_SOURCE })],
      { auth: lapsed('intruder') },
    );
    const [c] = findReclaimCandidates({ state, nowMs: T0 + 25 * H }).candidates;
    expect(c).toMatchObject({ owner: 'intruder', ownerIsLane: false, heartbeatSource: 'lease-tick' });
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
    expect(r.protected).toEqual([{ id: idOf('auth'), missionId: MISSION, taskId: 'auth', owner: 'auth', expiredForMs: H }]);
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
      { id: idOf('bad-date'), missionId: MISSION, taskId: 'bad-date', reason: 'bad-expires_at' },
      { id: idOf('bad-shape'), missionId: MISSION, taskId: 'bad-shape', reason: 'not-an-object' },
      { id: idOf('ghost'), missionId: MISSION, taskId: 'ghost', reason: 'no-task-node' },
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
    expect(r.candidates.map((c) => c.id)).toEqual([`${a}/q`, `${b}/m`, `${b}/z`]);
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

  it('a tick is distinguishable from the lane-state emitter: its own heartbeat source and ledger reason', () => {
    expect(LEASE_TICK_SOURCE).toBe('lease-tick');
    expect(LEASE_TICK_REASON).toBe('split.lease-tick');
    expect(LEASE_TICK_SOURCE).not.toBe('lane-heartbeat');
    expect(LEASE_TICK_REASON).not.toBe('split.lane-lease');
  });
});
