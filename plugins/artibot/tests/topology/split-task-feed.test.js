/**
 * `lib/topology/split-task-feed.js` — the pure plan-limb -> Task Graph mapping.
 *
 * The defect this file exists to catch is the one the whole-graph write makes
 * easy: `updateMission({graph})` REPLACES the graph, so a feeder that rebuilds
 * from `plan.json` silently resets a claimed or finished limb to `queued` on
 * the next dispatch. Every merge case below is therefore stated as "what must
 * survive", not only as "what is produced".
 *
 * What this file cannot see (rules §9): whether the produced graph is accepted
 * by the real `validateSnapshot`, and whether a store write happens at all.
 * Both are store behaviour and are measured in `tests/scripts/task-feed.test.js`
 * against a real `createStateStore`.
 */

import { describe, expect, it } from 'vitest';
import {
  LIMB_LEASE_TTL_MS, mergeLimbTasks, SEED_TASK_STATUS,
} from '../../lib/topology/split-task-feed.js';

const MISSION = 'M-20260921-S1234abcd';
const NOW = new Date('2026-09-21T10:00:00.000Z');

const planWith = (limbs) => ({ limbs });

describe('mergeLimbTasks — seeding', () => {
  it('maps every limb to a queued task whose file_ownership is affectedPaths', () => {
    const r = mergeLimbTasks({
      graph: null,
      plan: planWith([
        { limb: 'auth', affectedPaths: ['lib/auth/**', 'tests/auth/**'] },
        { limb: 'billing', affectedPaths: ['lib/billing.js'] },
      ]),
      missionId: MISSION,
      now: NOW,
    });

    expect(r.added).toEqual(['auth', 'billing']);
    expect(r.refreshed).toEqual([]);
    expect(r.unchanged).toBe(false);
    expect(r.graph).toEqual({
      schema_version: 1,
      mission_id: MISSION,
      updated_at: '2026-09-21T10:00:00.000Z',
      tasks: [
        {
          id: 'auth',
          mission_id: MISSION,
          title: '/split limb auth',
          status: 'queued',
          owner: null,
          file_ownership: ['lib/auth/**', 'tests/auth/**'],
          created_at: '2026-09-21T10:00:00.000Z',
        },
        {
          id: 'billing',
          mission_id: MISSION,
          title: '/split limb billing',
          status: 'queued',
          owner: null,
          file_ownership: ['lib/billing.js'],
          created_at: '2026-09-21T10:00:00.000Z',
        },
      ],
    });
    expect(SEED_TASK_STATUS).toBe('queued');
  });

  it('a limb without affectedPaths gets [], not a missing key', () => {
    const r = mergeLimbTasks({ graph: null, plan: planWith([{ limb: 'solo' }]), missionId: MISSION, now: NOW });
    expect(r.graph.tasks[0].file_ownership).toEqual([]);
  });

  it('drops non-string and empty entries, and limbs with no usable id', () => {
    const r = mergeLimbTasks({
      graph: null,
      plan: planWith([
        { limb: 'auth', affectedPaths: ['a.js', 42, '', null, 'b.js'] },
        { limb: '' },
        { limb: 7 },
        null,
      ]),
      missionId: MISSION,
      now: NOW,
    });
    expect(r.added).toEqual(['auth']);
    expect(r.graph.tasks[0].file_ownership).toEqual(['a.js', 'b.js']);
  });

  it('is total: a missing, null or malformed plan yields an empty graph and no write', () => {
    for (const plan of [null, undefined, {}, { limbs: 'nope' }, 5]) {
      const r = mergeLimbTasks({ graph: null, plan, missionId: MISSION, now: NOW });
      expect(r.graph.tasks).toEqual([]);
      expect(r.unchanged).toBe(true);
    }
  });
});

describe('mergeLimbTasks — merge must not walk a task backwards', () => {
  /** A graph whose `auth` limb is already claimed and running. */
  const running = {
    schema_version: 1,
    mission_id: MISSION,
    updated_at: '2026-09-20T00:00:00.000Z',
    tasks: [{
      id: 'auth',
      mission_id: MISSION,
      title: 'hand-edited title',
      status: 'executing',
      owner: 'auth',
      file_ownership: ['lib/auth/**'],
      heartbeat_at: '2026-09-20T23:00:00.000Z',
      heartbeat_source: 'lane-heartbeat',
      created_at: '2026-09-20T00:00:00.000Z',
    }],
  };

  it('re-seeding an identical plan changes nothing and reports unchanged', () => {
    const r = mergeLimbTasks({
      graph: running, plan: planWith([{ limb: 'auth', affectedPaths: ['lib/auth/**'] }]), missionId: MISSION, now: NOW,
    });
    expect(r).toEqual({ graph: running, added: [], refreshed: [], unchanged: true });
    // The stamp is NOT bumped — a no-op graph.upsert would still cost one
    // `state.updated` ledger row per dispatch.
    expect(r.graph.updated_at).toBe('2026-09-20T00:00:00.000Z');
  });

  it('preserves status, owner, title and heartbeat while refreshing file_ownership', () => {
    const r = mergeLimbTasks({
      graph: running,
      plan: planWith([{ limb: 'auth', affectedPaths: ['lib/auth/**', 'lib/session.js'] }]),
      missionId: MISSION,
      now: NOW,
    });
    expect(r.added).toEqual([]);
    expect(r.refreshed).toEqual(['auth']);
    expect(r.graph.tasks[0]).toEqual({
      ...running.tasks[0],
      file_ownership: ['lib/auth/**', 'lib/session.js'],
      updated_at: '2026-09-21T10:00:00.000Z',
    });
  });

  it('a done limb stays done when the plan still lists it', () => {
    const done = { ...running, tasks: [{ ...running.tasks[0], status: 'done', owner: null }] };
    const r = mergeLimbTasks({ graph: done, plan: planWith([{ limb: 'auth', affectedPaths: ['lib/auth/**'] }]), missionId: MISSION, now: NOW });
    expect(r.graph.tasks[0].status).toBe('done');
    expect(r.unchanged).toBe(true);
  });

  it('keeps tasks the plan does not name — /team TaskCreate shares this graph', () => {
    const mixed = {
      ...running,
      tasks: [...running.tasks, { id: 'T-14', mission_id: MISSION, status: 'reviewing', owner: 'reviewer' }],
    };
    const r = mergeLimbTasks({ graph: mixed, plan: planWith([{ limb: 'billing' }]), missionId: MISSION, now: NOW });
    expect(r.graph.tasks.map((t) => t.id)).toEqual(['auth', 'T-14', 'billing']);
    expect(r.graph.tasks[1]).toEqual(mixed.tasks[1]);
    expect(r.added).toEqual(['billing']);
  });

  it('a graph carrying a duplicate id is not multiplied by the merge', () => {
    const dup = {
      ...running,
      tasks: [running.tasks[0], { ...running.tasks[0], file_ownership: ['stale'] }],
    };
    const r = mergeLimbTasks({ graph: dup, plan: planWith([{ limb: 'auth', affectedPaths: ['lib/auth/**'] }]), missionId: MISSION, now: NOW });
    expect(r.graph.tasks).toHaveLength(2);
    expect(r.added).toEqual([]);
    // Only the FIRST occurrence is the one the plan owns; the second is left
    // untouched rather than "fixed", because the store, not this module,
    // rejects duplicate ids (`validate.js`).
    expect(r.graph.tasks[1].file_ownership).toEqual(['stale']);
  });

  it('does not mutate the graph or the plan it was given', () => {
    const before = JSON.stringify(running);
    const plan = planWith([{ limb: 'auth', affectedPaths: ['x'] }, { limb: 'new' }]);
    const planBefore = JSON.stringify(plan);
    mergeLimbTasks({ graph: running, plan, missionId: MISSION, now: NOW });
    expect(JSON.stringify(running)).toBe(before);
    expect(JSON.stringify(plan)).toBe(planBefore);
  });

  it('carries a graph schema_version forward and repairs a malformed one', () => {
    expect(mergeLimbTasks({ graph: { ...running, schema_version: 2 }, plan: planWith([{ limb: 'b' }]), missionId: MISSION, now: NOW })
      .graph.schema_version).toBe(2);
    expect(mergeLimbTasks({ graph: { ...running, schema_version: 'x' }, plan: planWith([{ limb: 'b' }]), missionId: MISSION, now: NOW })
      .graph.schema_version).toBe(1);
  });

  it('rewrites mission_id onto the graph it returns', () => {
    const r = mergeLimbTasks({ graph: { ...running, mission_id: 'M-20260101-001' }, plan: planWith([{ limb: 'b' }]), missionId: MISSION, now: NOW });
    expect(r.graph.mission_id).toBe(MISSION);
  });
});

describe('LIMB_LEASE_TTL_MS', () => {
  it('outlives a /split wave — no heartbeat emitter exists to renew it', () => {
    expect(LIMB_LEASE_TTL_MS).toBe(86400000);
    expect(LIMB_LEASE_TTL_MS).toBeGreaterThan(8 * 60 * 60 * 1000);
  });
});
