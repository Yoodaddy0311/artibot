/**
 * `lib/project-state/task-update.js` and the two store calls it serves —
 * `store.updateTask` (SH-11 pre-flip condition 2) and the `status` argument of
 * `store.claimTask` (pre-flip condition 1).
 *
 * WHY THESE EXIST. A `/split` run bound to a mission writes one Task Graph node
 * per lane write. Until now the only door was `updateMission(..., { graph })`,
 * which replaces the WHOLE graph: every bound write journalled a `mission.upsert`
 * plus a `graph.upsert` carrying every other node, and the lease calls
 * (`claimTask` / `releaseTask` / `heartbeatWorker`) could not be combined with
 * it, because `claimTask` forced `status: 'claimed'` over the node's own ops
 * state. `updateTask` is the single-node door (one `task.upsert`, ops carried
 * through); `claimTask({ status })` lets a lease be taken WITHOUT moving the
 * node's status, so the lease record can sit beside a node that has an `ops`.
 *
 * Every store here is a REAL `createStateStore` over a tmpdir (helpers.js), with
 * a recording ledger port and a hand-cranked clock — the journal is read back
 * from the file the store wrote, so "one record" is counted, not assumed.
 *
 * WHAT THIS FILE CANNOT SEE (rules §9): two PROCESSES racing one store (the CAS
 * cases are a stale version argument, not a second process — the lock itself is
 * measured in tests/core/file-lock-contention.test.js), the live store's size
 * (journal lines here number in the tens), and any caller — the bound lane
 * write and the bound feed that use these calls are measured in
 * tests/topology/split-state.test.js and tests/scripts/task-feed.test.js.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { readJournal } from '../../lib/project-state/state-manager.js';
import { claimStatusError, planTaskUpdate } from '../../lib/project-state/task-update.js';
import { cleanup, graph, makeStore, MISSION_ID, seed, task } from './helpers.js';

const roots = [];
const store$ = (overrides) => {
  const made = makeStore(overrides);
  roots.push(made.projectRoot);
  return made;
};
afterEach(() => {
  while (roots.length > 0) cleanup(roots.pop());
});

/** An ops record, as a bound /split node carries it (`schemas/task-graph.schema.json` task.ops). */
const OPS = { state: 'active', since: '2026-09-02T00:00:00.000Z', run_id: 'split-t' };
const journalOf = (store) => readJournal(store.paths.journal).records;
const journalText = (store) => readFileSync(store.paths.journal, 'utf-8');

describe('planTaskUpdate — the records of a single-node write (pure)', () => {
  const snapshot = (tasks, { withGraph = true } = {}) => ({
    active_missions: { [MISSION_ID]: { status: 'executing' } },
    task_graphs: withGraph ? { [MISSION_ID]: graph(tasks) } : {},
  });

  it('is ONE task.upsert carrying the whole node after the mutation, ops included', () => {
    const snap = snapshot([task('a', { status: 'executing', owner: 'a', ops: { ...OPS } }), task('b')]);
    const out = planTaskUpdate(snap, {
      missionId: MISSION_ID, taskId: 'a', mutate: (cur) => ({ ...cur, title: 'renamed' }),
    });
    expect(out.errors).toBeUndefined();
    expect(out.records).toEqual([{
      kind: 'task.upsert',
      mission_id: MISSION_ID,
      task: task('a', { status: 'executing', owner: 'a', ops: { ...OPS }, title: 'renamed' }),
    }]);
  });

  it('hands the mutator a CLONE: editing it in place does not reach the snapshot', () => {
    const snap = snapshot([task('a', { ops: { ...OPS } })]);
    planTaskUpdate(snap, {
      missionId: MISSION_ID, taskId: 'a', mutate: (cur) => { cur.ops.state = 'done'; cur.title = 'x'; return cur; },
    });
    expect(snap.task_graphs[MISSION_ID].tasks[0]).toEqual(task('a', { ops: { ...OPS } }));
  });

  it('hands the mutator null for an absent node — the write then creates it', () => {
    let seen = 'unset';
    const out = planTaskUpdate(snapshot([task('b')]), {
      missionId: MISSION_ID, taskId: 'a', mutate: (cur) => { seen = cur; return task('a'); },
    });
    expect(seen).toBeNull();
    expect(out.records).toEqual([{ kind: 'task.upsert', mission_id: MISSION_ID, task: task('a') }]);
  });

  it('a mission row with no graph gets an empty graph in the same commit, so the node is not ignored', () => {
    const out = planTaskUpdate(snapshot([], { withGraph: false }), {
      missionId: MISSION_ID, taskId: 'a', mutate: () => task('a'),
    });
    expect(out.records).toEqual([
      { kind: 'graph.upsert', mission_id: MISSION_ID, graph: { schema_version: 1, mission_id: MISSION_ID, tasks: [] } },
      { kind: 'task.upsert', mission_id: MISSION_ID, task: task('a') },
    ]);
  });

  it('a mutator that returns undefined says "no change": no records', () => {
    const out = planTaskUpdate(snapshot([task('a')]), { missionId: MISSION_ID, taskId: 'a', mutate: () => undefined });
    expect(out).toEqual({ records: [] });
  });

  it.each([
    ['null', () => null],
    ['an array', () => [task('a')]],
    ['a string', () => 'a'],
    ['a node with another id', () => task('zzz')],
    ['a node with no id', () => ({ mission_id: MISSION_ID, status: 'queued' })],
  ])('refuses a mutator that returns %s, naming the task', (_label, mutate) => {
    const out = planTaskUpdate(snapshot([task('a')]), { missionId: MISSION_ID, taskId: 'a', mutate });
    expect(out.records).toBeUndefined();
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatch(/updateTask: .*'a'/);
  });

  it('refuses a mission that is not in the snapshot', () => {
    const out = planTaskUpdate(snapshot([task('a')]), { missionId: 'M-20260902-999', taskId: 'a', mutate: (c) => c });
    expect(out.errors).toEqual([expect.stringMatching(/updateTask: no mission 'M-20260902-999'/)]);
  });
});

describe('store.updateTask — the single-node door', () => {
  const seeded = (extra = {}) => {
    const made = store$(extra);
    const a = task('a', { status: 'executing', owner: 'a', ops: { ...OPS } });
    const b = task('b', { file_ownership: ['lib/b/**'] });
    expect(seed(made.store, [a, b]).ok).toBe(true);
    return { ...made, a, b };
  };

  it('is on the store', () => {
    expect(typeof store$().store.updateTask).toBe('function');
  });

  it('writes exactly ONE journal record — a task.upsert — and ONE paired state.updated; every other node is untouched', () => {
    const { store, ledger, b } = seeded();
    const journalBefore = journalOf(store).length;
    const ledgerBefore = ledger.events.length;
    const v0 = store.getState().state_version;

    const res = store.updateTask({
      missionId: MISSION_ID, taskId: 'a', reason: 'test.single',
      mutate: (cur) => ({ ...cur, heartbeat_at: '2026-09-02T01:00:00.000Z' }),
    });

    expect(res).toMatchObject({ ok: true, state_version: v0 + 1 });
    const added = journalOf(store).slice(journalBefore);
    expect(added.map((r) => r.kind)).toEqual(['task.upsert']);
    expect(ledger.events.length - ledgerBefore).toBe(1);
    expect(ledger.events.at(-1)).toMatchObject({ event: 'state.updated', data: { state_version: v0 + 1, reason: 'test.single' } });

    const after = store.getTaskGraph(MISSION_ID);
    expect(after.tasks.map((t) => t.id)).toEqual(['a', 'b']);
    expect(after.tasks[1]).toEqual(b);
    expect(after.tasks[0]).toMatchObject({ status: 'executing', owner: 'a', heartbeat_at: '2026-09-02T01:00:00.000Z' });
    expect(after.tasks[0].ops).toEqual(OPS); // ops survives the write
  });

  it('CONTROL — the same change through the graph door costs mission.upsert + graph.upsert, carrying every node', () => {
    const { store, a } = seeded();
    const before = journalOf(store).length;
    const graphNow = store.getTaskGraph(MISSION_ID);
    const tasks = graphNow.tasks.map((t) => (t.id === 'a' ? { ...a, heartbeat_at: '2026-09-02T01:00:00.000Z' } : t));
    expect(store.updateMission(MISSION_ID, (cur) => cur, { graph: { ...graphNow, tasks }, reason: 'test.graph' }).ok).toBe(true);
    const added = journalOf(store).slice(before);
    expect(added.map((r) => r.kind)).toEqual(['mission.upsert', 'graph.upsert']);
    expect(added[1].graph.tasks).toHaveLength(2);
  });

  it('defaults the reason to task.update:<id>', () => {
    const { store, ledger } = seeded();
    store.updateTask({ missionId: MISSION_ID, taskId: 'b', mutate: (cur) => ({ ...cur, title: 't' }) });
    expect(ledger.events.at(-1).data.reason).toBe('task.update:b');
  });

  it('creates the node when it is absent, and the store keeps the order of the others', () => {
    const { store } = seeded();
    const res = store.updateTask({ missionId: MISSION_ID, taskId: 'c', mutate: (cur) => { expect(cur).toBeNull(); return task('c'); } });
    expect(res.ok).toBe(true);
    expect(store.getTaskGraph(MISSION_ID).tasks.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('a mutator that returns undefined commits nothing: no version, no journal line, no ledger row', () => {
    const { store, ledger } = seeded();
    const v = store.getState().state_version;
    const text = journalText(store);
    const rows = ledger.events.length;
    const res = store.updateTask({ missionId: MISSION_ID, taskId: 'a', mutate: () => undefined });
    expect(res).toMatchObject({ ok: true, unchanged: true, state_version: v });
    expect(journalText(store)).toBe(text);
    expect(ledger.events.length).toBe(rows);
  });

  describe('the version guard', () => {
    it('a stale expectedVersion is a returned conflict and writes nothing', () => {
      const { store, ledger } = seeded();
      const v = store.getState().state_version;
      const text = journalText(store);
      const rows = ledger.events.length;
      const res = store.updateTask({ missionId: MISSION_ID, taskId: 'a', expectedVersion: v - 1, mutate: (c) => ({ ...c, title: 'x' }) });
      expect(res).toMatchObject({ ok: false, conflict: true, currentVersion: v, expectedVersion: v - 1 });
      expect(journalText(store)).toBe(text);
      expect(ledger.events.length).toBe(rows);
    });

    it('the current expectedVersion commits', () => {
      const { store } = seeded();
      const v = store.getState().state_version;
      const res = store.updateTask({ missionId: MISSION_ID, taskId: 'a', expectedVersion: v, mutate: (c) => ({ ...c, title: 'x' }) });
      expect(res).toMatchObject({ ok: true, state_version: v + 1 });
      expect(res.warnings).not.toContain('cas:skipped');
    });

    it('with no expectedVersion the write is last-writer-wins and says so', () => {
      const { store } = seeded();
      const res = store.updateTask({ missionId: MISSION_ID, taskId: 'a', mutate: (c) => ({ ...c, title: 'x' }) });
      expect(res.warnings).toContain('cas:skipped');
    });
  });

  describe('refusals leave the store exactly as it was', () => {
    const untouched = (made, call) => {
      const text = journalText(made.store);
      const rows = made.ledger.events.length;
      const v = made.store.getState().state_version;
      const res = call();
      expect(journalText(made.store)).toBe(text);
      expect(made.ledger.events.length).toBe(rows);
      expect(made.store.getState().state_version).toBe(v);
      return res;
    };

    it('an unknown mission, a malformed mission id and a missing task id', () => {
      const made = seeded();
      const mutate = (c) => c ?? task('a');
      expect(untouched(made, () => made.store.updateTask({ missionId: 'M-20260902-999', taskId: 'a', mutate })))
        .toMatchObject({ ok: false, conflict: false, errors: [expect.stringMatching(/no mission/)] });
      expect(untouched(made, () => made.store.updateTask({ missionId: 'nope', taskId: 'a', mutate })))
        .toMatchObject({ ok: false, errors: [expect.stringMatching(/mission_id/)] });
      expect(untouched(made, () => made.store.updateTask({ missionId: MISSION_ID, taskId: '', mutate })))
        .toMatchObject({ ok: false, errors: [expect.stringMatching(/taskId/)] });
    });

    it('a node the store would refuse (wrong mission_id, a status outside the vocabulary, an owned status with no owner)', () => {
      const made = seeded();
      const bad = [
        { ...task('a'), mission_id: 'M-20260902-999' },
        { ...task('a'), status: 'bogus' },
        { ...task('a'), status: 'executing', owner: null },
      ];
      for (const node of bad) {
        const res = untouched(made, () => made.store.updateTask({ missionId: MISSION_ID, taskId: 'a', mutate: () => node }));
        expect(res, JSON.stringify(node)).toMatchObject({ ok: false, conflict: false });
        expect(res.errors.length).toBeGreaterThan(0);
      }
    });

    it('a ledger port that says no abandons the store write', () => {
      const made = seeded();
      made.ledger.state.refuse = true;
      const res = untouched(made, () => made.store.updateTask({ missionId: MISSION_ID, taskId: 'a', mutate: (c) => ({ ...c, title: 'x' }) }));
      expect(res).toMatchObject({ ok: false });
      expect(res.errors.join(' ')).toMatch(/ledger refused/);
    });

    it('a mutator that is not a function is a programmer error and throws', () => {
      const { store } = seeded();
      expect(() => store.updateTask({ missionId: MISSION_ID, taskId: 'a' })).toThrow(TypeError);
      expect(() => store.updateTask({ missionId: MISSION_ID, taskId: 'a', mutate: 'x' })).toThrow(/mutate must be a function/);
    });

    it('a mutator that throws propagates and releases the lock (the next write goes through)', () => {
      const made = seeded();
      expect(() => made.store.updateTask({ missionId: MISSION_ID, taskId: 'a', mutate: () => { throw new Error('mutator-boom'); } })).toThrow('mutator-boom');
      expect(made.store.updateTask({ missionId: MISSION_ID, taskId: 'a', mutate: (c) => ({ ...c, title: 'ok' }) }).ok).toBe(true);
    });
  });

  it('the journal replays to the same snapshot (the record is a whole entity, so rebuild == live)', () => {
    const { store } = seeded();
    store.updateTask({ missionId: MISSION_ID, taskId: 'a', mutate: (c) => ({ ...c, title: 'one' }) });
    store.updateTask({ missionId: MISSION_ID, taskId: 'c', mutate: () => task('c', { title: 'new' }) });
    const live = store.getTaskGraph(MISSION_ID);
    // Drop the derived snapshot: loadSnapshot then rebuilds from the journal alone
    // (`paths.snapshot` is a cache by contract — state-manager.js header).
    expect(existsSync(store.paths.snapshot)).toBe(true);
    rmSync(store.paths.snapshot);
    expect(store.getTaskGraph(MISSION_ID)).toEqual(live);
  });
});

describe('store.claimTask({ status }) — a lease beside a node that already has a status (SH-11 pre-flip condition 1)', () => {
  const seededOps = () => {
    const made = store$();
    expect(seed(made.store, [task('a', { status: 'executing', owner: 'a', ops: { ...OPS } })]).ok).toBe(true);
    return made;
  };
  const claim = (store, over = {}) => store.claimTask({ missionId: MISSION_ID, taskId: 'a', owner: 'a', ttlMs: 60_000, ...over });

  it('takes the lease and keeps the status it is told to keep; the node\'s ops and every other field survive', () => {
    const { store } = seededOps();
    const res = claim(store, { status: 'executing' });
    expect(res).toMatchObject({ ok: true, reclaimed: false });
    expect(res.lease).toMatchObject({ owner: 'a' });
    expect(store.getLease(MISSION_ID, 'a')).toMatchObject({ owner: 'a' });
    const node = store.getTaskGraph(MISSION_ID).tasks[0];
    expect(node).toMatchObject({ id: 'a', status: 'executing', owner: 'a' });
    expect(node.ops).toEqual(OPS);
  });

  it.each(['claimed', 'executing', 'reviewing'])('accepts the owned status %s and writes it', (status) => {
    const { store } = seededOps();
    expect(claim(store, { status }).ok).toBe(true);
    expect(store.getTaskGraph(MISSION_ID).tasks[0].status).toBe(status);
  });

  it('DEFAULT — with no status the node becomes claimed, exactly as before the argument existed (byte-identical records)', () => {
    const { store } = seededOps();
    const before = journalOf(store).length;
    claim(store);
    const added = journalOf(store).slice(before);
    expect(added.map((r) => r.kind)).toEqual(['task.upsert', 'lease.set']);
    expect(added[0].task).toEqual({ id: 'a', mission_id: MISSION_ID, status: 'claimed', owner: 'a', ops: { ...OPS } });
    // and the key order the journal line carries is the pre-argument one
    expect(Object.keys(added[0].task)).toEqual(['id', 'mission_id', 'status', 'owner', 'ops']);
  });

  it.each([
    ['queued', 'queued'], ['blocked', 'blocked'], ['done', 'done'], ['failed', 'failed'], ['cancelled', 'cancelled'],
    ['an empty string', ''], ['null', null], ['a number', 42], ['an unknown word', 'bogus'],
  ])('refuses %s: a claim names an owner, and only claimed/executing/reviewing may have one — nothing is written', (_label, status) => {
    const { store, ledger } = seededOps();
    const text = journalText(store);
    const rows = ledger.events.length;
    const res = claim(store, { status });
    expect(res).toMatchObject({ ok: false, conflict: false });
    expect(res.errors[0]).toMatch(/claimTask: status/);
    expect(journalText(store)).toBe(text);
    expect(ledger.events.length).toBe(rows);
    expect(store.getLease(MISSION_ID, 'a')).toBeNull();
  });

  it('claimStatusError is the one judge: null for an owned status, a reason for anything else', () => {
    expect(claimStatusError('claimed')).toBeNull();
    expect(claimStatusError('executing')).toBeNull();
    expect(claimStatusError('reviewing')).toBeNull();
    expect(claimStatusError('queued')).toMatch(/claimTask: status 'queued'/);
    expect(claimStatusError(undefined)).toMatch(/claimTask: status/);
  });

  it('an expired lease is reclaimed with the status argument too', () => {
    const { store, clock } = seededOps();
    expect(claim(store, { status: 'executing', ttlMs: 1000 }).ok).toBe(true);
    clock.advance(5000);
    const res = claim(store, { status: 'reviewing', ttlMs: 1000 });
    expect(res).toMatchObject({ ok: true, reclaimed: true });
    expect(store.getTaskGraph(MISSION_ID).tasks[0].status).toBe('reviewing');
  });

  it('a live lease still refuses a second claim, whatever status is asked for', () => {
    const { store } = seededOps();
    expect(claim(store, { status: 'executing' }).ok).toBe(true);
    const again = claim(store, { status: 'executing', owner: 'b' });
    expect(again).toMatchObject({ ok: false });
    expect(again.errors[0]).toMatch(/held by 'a'/);
  });
});
