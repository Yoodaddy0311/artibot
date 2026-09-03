import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CAS_SKIPPED_WARNING,
  createStateStore,
  emptySnapshot,
  FALLBACK_RELATIVE,
  readJournal,
  reduceProjectState,
  resolveStoreLocation,
} from '../../lib/project-state/state-manager.js';
import {
  cleanup, graph, makeStore, mission, MISSION_ID, seed, T0, task,
} from './helpers.js';

const roots = [];
const store$ = (overrides) => {
  const made = makeStore(overrides);
  roots.push(made.projectRoot);
  return made;
};

afterEach(() => {
  while (roots.length > 0) cleanup(roots.pop());
});

describe('store location — decision F3', () => {
  it('puts the store under the git common dir', () => {
    const out = resolveStoreLocation({ projectRoot: '/repo', gitCommonDir: '/repo/.git' });
    expect(out.source).toBe('git-common-dir');
    expect(out.dir).toBe(path.resolve('/repo/.git/artibot'));
    expect(out.reason).toBeNull();
  });

  it('resolves a RELATIVE common dir against projectRoot', () => {
    // Measured on git 2.54.0.windows.1: `--git-common-dir` prints '.git' in a
    // main checkout. Treating it as absolute would put the store at the CWD.
    const out = resolveStoreLocation({ projectRoot: '/repo', gitCommonDir: '.git' });
    expect(out.dir).toBe(path.resolve('/repo/.git/artibot'));
  });

  it('falls back to .artibot/runtime and states the reason', () => {
    const out = resolveStoreLocation({ projectRoot: '/repo', gitCommonDir: null });
    expect(out.source).toBe('project-root-fallback');
    expect(out.dir).toBe(path.join('/repo', FALLBACK_RELATIVE));
    expect(out.reason).toMatch(/per-worktree/);
  });

  it('falls back when the injected git port throws', () => {
    const { store } = store$({
      storeOptions: { resolveGitCommonDir: () => { throw new Error('git missing'); } },
    });
    expect(store.location.source).toBe('project-root-fallback');
  });

  it('falls back when no git port is injected at all', () => {
    const { store } = store$({ storeOptions: { resolveGitCommonDir: undefined } });
    expect(store.location.source).toBe('project-root-fallback');
    expect(store.location.reason).toBeTruthy();
  });

  it('requires projectRoot', () => {
    expect(() => resolveStoreLocation({ projectRoot: '' })).toThrow(/projectRoot/);
  });
});

describe('construction', () => {
  it('requires the appendEvent port — L2 may not import the L5 writer', () => {
    expect(() => createStateStore({ projectRoot: '/repo', sessionId: 's' }))
      .toThrow(/appendEvent port is required/);
  });

  it('requires a sessionId, because the ledger envelope requires one', () => {
    expect(() => createStateStore({ projectRoot: '/repo', appendEvent: () => {} }))
      .toThrow(/sessionId is required/);
  });

  it('starts at state_version 0, below the projection floor of 1', () => {
    const { store } = store$();
    expect(store.getState().state_version).toBe(0);
    expect(emptySnapshot('x').state_version).toBe(0);
  });
});

describe('the clock port is judged, not trusted', () => {
  // Adopted from `lib/core/clock.js#readClock` (T-34) rather than calling
  // `ctx.now().toISOString()` directly. An unguarded call turns a
  // misconfigured port into a `ts` of `undefined` or `"Invalid Date"` that is
  // written durably to the journal AND the paired ledger event, then found
  // much later. The shared judge fails at the boundary instead.
  it.each([
    ['a number instead of a function', 1234],
    ['a Date instead of a function', new Date()],
  ])('rejects %s', (_label, bad) => {
    const { store } = store$({ storeOptions: { now: bad } });
    expect(() => seed(store)).toThrow(/state-manager: now must be a function/);
  });

  it.each([
    ['epoch ms', () => 1234],
    ['an ISO string', () => '2026-09-03T00:00:00.000Z'],
  ])('rejects a port returning %s', (_label, bad) => {
    const { store } = store$({ storeOptions: { now: bad } });
    expect(() => seed(store)).toThrow(/state-manager: now\(\) must return a Date/);
  });

  it('rejects an Invalid Date', () => {
    const { store } = store$({ storeOptions: { now: () => new Date('nope') } });
    expect(() => seed(store)).toThrow(/state-manager: now\(\) returned an Invalid Date/);
  });

  it('stamps the injected instant on both the journal and the paired event', () => {
    const { store, ledger } = store$();
    seed(store);
    const { records } = readJournal(store.paths.journal);
    expect(records[0].ts).toBe(new Date(T0).toISOString());
    expect(ledger.events[0].ts).toBe(new Date(T0).toISOString());
  });
});

describe('committed writes', () => {
  it('creates a mission and bumps the version to 1', () => {
    const { store } = store$();
    const out = seed(store);
    expect(out.ok).toBe(true);
    expect(out.state_version).toBe(1);
    expect(store.getMission(MISSION_ID).status).toBe('executing');
  });

  it('creates an empty Task Graph alongside a new mission', () => {
    const { store } = store$();
    seed(store);
    expect(store.getTaskGraph(MISSION_ID)).toEqual(graph([]));
  });

  it('writes journal and snapshot under the store dir, not the project root', () => {
    const { store, projectRoot } = store$();
    seed(store);
    expect(store.paths.journal.startsWith(path.join(projectRoot, '.git', 'artibot'))).toBe(true);
    expect(existsSync(store.paths.journal)).toBe(true);
    expect(existsSync(store.paths.snapshot)).toBe(true);
  });

  it('stamps every journal record with the same version and timestamp', () => {
    const { store } = store$();
    seed(store, [task('W-1')]);
    const { records } = readJournal(store.paths.journal);
    expect(records.every((r) => r.state_version === 1)).toBe(true);
    expect(new Set(records.map((r) => r.ts)).size).toBe(1);
  });

  it('removes a mission and its graph and leases together', () => {
    const { store } = store$();
    seed(store, [task('W-1')]);
    store.updateMission(MISSION_ID, () => null, { reason: 'archive' });
    expect(store.getMission(MISSION_ID)).toBeNull();
    expect(store.getTaskGraph(MISSION_ID)).toBeNull();
  });

  it('rejects an id that matches neither mission id form', () => {
    const { store } = store$();
    const out = store.updateMission('M-2026-1', () => mission(), { reason: 'x' });
    expect(out.ok).toBe(false);
    expect(out.errors[0]).toMatch(/matches neither/);
  });

  it('accepts the session fallback id form', () => {
    const { store } = store$();
    const id = 'M-20260902-Sabc12345';
    const out = store.updateMission(id, () => ({
      status: 'queued',
      intent: { path: 'i.md', revision: 1 },
      plan: { path: 'p.md', revision: 1 },
    }), { reason: 'fallback' });
    expect(out.ok).toBe(true);
  });
});

describe('validation is fail-closed — nothing is written on a violation', () => {
  it('refuses a mission with an unknown status', () => {
    const { store, ledger } = store$();
    const out = store.updateMission(MISSION_ID, () => mission({ status: 'running' }), { reason: 'x' });
    expect(out.ok).toBe(false);
    expect(out.errors[0]).toMatch(/status 'running' is not one of/);
    expect(store.getState().state_version).toBe(0);
    expect(ledger.events).toHaveLength(0);
    expect(existsSync(store.paths.journal)).toBe(false);
  });

  it('refuses duplicate task ids', () => {
    const { store } = store$();
    const out = seed(store, [task('W-1'), task('W-1')]);
    expect(out.ok).toBe(false);
    expect(out.errors.join(' ')).toMatch(/duplicate task id 'W-1'/);
  });

  it('refuses a dangling dependency', () => {
    const { store } = store$();
    const out = seed(store, [task('W-1', { dependencies: ['W-9'] })]);
    expect(out.errors.join(' ')).toMatch(/depends on 'W-9', which is not a node/);
  });

  it('refuses a self-dependency', () => {
    const { store } = store$();
    const out = seed(store, [task('W-1', { dependencies: ['W-1'] })]);
    expect(out.errors.join(' ')).toMatch(/depends on itself/);
  });

  it('refuses a task whose mission_id disagrees with its graph', () => {
    const { store } = store$();
    const out = seed(store, [task('W-1', { mission_id: 'M-20260902-002' })]);
    expect(out.errors.join(' ')).toMatch(/!== graph mission_id/);
  });

  it('refuses claimed/executing/reviewing without an owner', () => {
    const { store } = store$();
    expect(seed(store, [task('W-1', { status: 'executing' })]).errors.join(' '))
      .toMatch(/requires a non-empty owner/);
  });

  it('refuses blocked without a blocker', () => {
    const { store } = store$();
    expect(seed(store, [task('W-1', { status: 'blocked' })]).errors.join(' '))
      .toMatch(/requires at least one blocker/);
  });

  it('refuses a blocker outside the lane|gate|human|reconcile allowlist', () => {
    const { store } = store$();
    const out = seed(store, [task('W-1', { status: 'blocked', blockers: ['waiting'] })]);
    expect(out.errors.join(' ')).toMatch(/must match lane:\|gate:\|human:\|reconcile:/);
  });

  it('refuses a controller without a lease', () => {
    const { store } = store$();
    const out = store.updateMission(
      MISSION_ID, () => mission({ controller: { session_id: 's1' } }), { reason: 'x' },
    );
    expect(out.errors.join(' ')).toMatch(/controller\.lease must be an object/);
  });

  it('accepts a controller carrying a full lease', () => {
    const { store } = store$();
    const out = store.updateMission(MISSION_ID, () => mission({
      controller: {
        session_id: 's1',
        lease: {
          owner: 's1',
          acquired_at: '2026-09-02T00:00:00.000Z',
          expires_at: '2026-09-02T00:30:00.000Z',
          heartbeat_at: '2026-09-02T00:00:00.000Z',
        },
      },
    }), { reason: 'controller' });
    expect(out.ok).toBe(true);
  });
});

describe('compare-and-set', () => {
  it('accepts a write whose expectedVersion matches', () => {
    const { store } = store$();
    seed(store);
    const out = store.updateMission(MISSION_ID, (m) => ({ ...m, status: 'reviewing' }), {
      expectedVersion: 1, reason: 'advance',
    });
    expect(out.ok).toBe(true);
    expect(out.state_version).toBe(2);
  });

  it('refuses a stale write and reports the current version', () => {
    const { store, ledger } = store$();
    seed(store);
    const out = store.updateMission(MISSION_ID, (m) => ({ ...m, status: 'reviewing' }), {
      expectedVersion: 0, reason: 'stale',
    });
    expect(out.ok).toBe(false);
    expect(out.conflict).toBe(true);
    expect(out.currentVersion).toBe(1);
    expect(store.getMission(MISSION_ID).status).toBe('executing');
    expect(ledger.events).toHaveLength(1);
  });

  it('a retry at the reported version succeeds', () => {
    const { store } = store$();
    seed(store);
    const stale = store.updateMission(MISSION_ID, (m) => ({ ...m, status: 'reviewing' }), {
      expectedVersion: 0, reason: 'stale',
    });
    const retry = store.updateMission(MISSION_ID, (m) => ({ ...m, status: 'reviewing' }), {
      expectedVersion: stale.currentVersion, reason: 'retry',
    });
    expect(retry.ok).toBe(true);
    expect(store.getMission(MISSION_ID).status).toBe('reviewing');
  });

  it('skips the check when expectedVersion is omitted', () => {
    const { store } = store$();
    seed(store);
    expect(store.updateMission(MISSION_ID, (m) => m, { reason: 'blind' }).ok).toBe(true);
  });

  it('an unguarded write says so in warnings[], a guarded one does not', () => {
    // CAS is opt-in during Observe, so an omitted expectedVersion means
    // last-writer-wins. Both halves are asserted together because the flag is
    // only meaningful as a difference: a warning that is always present, or
    // always absent, tells a caller nothing about which contract it got.
    const { store } = store$();

    const unguarded = seed(store);
    expect(unguarded.ok).toBe(true);
    expect(unguarded.warnings).toContain(CAS_SKIPPED_WARNING);

    const guarded = store.updateMission(MISSION_ID, (m) => ({ ...m, status: 'reviewing' }), {
      expectedVersion: unguarded.state_version, reason: 'guarded',
    });
    expect(guarded.ok).toBe(true);
    expect(guarded.warnings).not.toContain(CAS_SKIPPED_WARNING);

    // A rejected guarded write must not be labelled unguarded either.
    const conflicted = store.updateMission(MISSION_ID, (m) => m, {
      expectedVersion: 0, reason: 'stale',
    });
    expect(conflicted.conflict).toBe(true);
    expect(conflicted.warnings).not.toContain(CAS_SKIPPED_WARNING);
  });
});

describe('leases', () => {
  it('claims a task, sets owner and status, and stores the lease outside the graph', () => {
    const { store } = store$();
    seed(store, [task('W-1')]);
    const out = store.claimTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'worker-a' });
    expect(out.ok).toBe(true);
    expect(out.lease.owner).toBe('worker-a');
    expect(store.getTaskGraph(MISSION_ID).tasks[0]).toMatchObject({ owner: 'worker-a', status: 'claimed' });
    expect(store.getTaskGraph(MISSION_ID).tasks[0].lease).toBeUndefined();
    expect(store.getLease(MISSION_ID, 'W-1').owner).toBe('worker-a');
  });

  it('refuses a second claim while the lease is live', () => {
    const { store } = store$();
    seed(store, [task('W-1')]);
    store.claimTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'worker-a' });
    const out = store.claimTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'worker-b' });
    expect(out.ok).toBe(false);
    expect(out.errors[0]).toMatch(/held by 'worker-a'/);
  });

  it('allows a reclaim once the lease has expired, and says it was reclaimed', () => {
    const { store, clock } = store$();
    seed(store, [task('W-1')]);
    store.claimTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'worker-a', ttlMs: 1000 });
    clock.advance(1001);
    const out = store.claimTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'worker-b' });
    expect(out.ok).toBe(true);
    expect(out.reclaimed).toBe(true);
  });

  it('refuses to claim a task that does not exist', () => {
    const { store } = store$();
    seed(store, []);
    expect(store.claimTask({ missionId: MISSION_ID, taskId: 'W-9', owner: 'a' }).errors[0])
      .toMatch(/no task 'W-9'/);
  });

  it('releases a task, clears the lease and drops the owner', () => {
    const { store } = store$();
    seed(store, [task('W-1')]);
    const claim = store.claimTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a', token: 'tok' });
    const out = store.releaseTask({
      missionId: MISSION_ID, taskId: 'W-1', owner: 'a', token: 'tok', status: 'done',
    });
    expect(out.ok).toBe(true);
    expect(claim.lease.token).toBe('tok');
    expect(store.getLease(MISSION_ID, 'W-1')).toBeNull();
    expect(store.getTaskGraph(MISSION_ID).tasks[0]).toMatchObject({ status: 'done', owner: null });
  });

  it('refuses a release whose token does not match the held lease', () => {
    const { store } = store$();
    seed(store, [task('W-1')]);
    store.claimTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a', token: 'tok' });
    const out = store.releaseTask({ missionId: MISSION_ID, taskId: 'W-1', token: 'other' });
    expect(out.errors[0]).toMatch(/token mismatch/);
  });

  it('refuses a release by the wrong owner', () => {
    const { store } = store$();
    seed(store, [task('W-1')]);
    store.claimTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a' });
    expect(store.releaseTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'b' }).errors[0])
      .toMatch(/held by 'a', not 'b'/);
  });

  it('keeps the owner when releasing into a status that requires one', () => {
    const { store } = store$();
    seed(store, [task('W-1')]);
    store.claimTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a' });
    const out = store.releaseTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a', status: 'reviewing' });
    expect(out.ok).toBe(true);
    expect(store.getTaskGraph(MISSION_ID).tasks[0].owner).toBe('a');
  });
});

describe('heartbeat', () => {
  it('renews the lease and writes heartbeat_source next to heartbeat_at', () => {
    const { store, clock } = store$();
    seed(store, [task('W-1')]);
    store.claimTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a', ttlMs: 1000 });
    clock.advance(500);
    const out = store.heartbeatWorker({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a' });
    expect(out.ok).toBe(true);
    const node = store.getTaskGraph(MISSION_ID).tasks[0];
    expect(node.heartbeat_at).toBe(new Date(T0 + 500).toISOString());
    expect(node.heartbeat_source).toBe('lane-heartbeat');
    expect(store.getLease(MISSION_ID, 'W-1').expires_at).toBe(new Date(T0 + 1500).toISOString());
  });

  it('refuses a heartbeat on a task holding no lease', () => {
    const { store } = store$();
    seed(store, [task('W-1')]);
    expect(store.heartbeatWorker({ missionId: MISSION_ID, taskId: 'W-1' }).errors[0])
      .toMatch(/holds no lease/);
  });

  it('refuses a heartbeat from the wrong owner', () => {
    const { store } = store$();
    seed(store, [task('W-1')]);
    store.claimTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a' });
    expect(store.heartbeatWorker({ missionId: MISSION_ID, taskId: 'W-1', owner: 'b' }).errors[0])
      .toMatch(/held by 'a', not 'b'/);
  });

  it('records the derived source the caller names', () => {
    const { store } = store$();
    seed(store, [task('W-1')]);
    store.claimTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a' });
    store.heartbeatWorker({
      missionId: MISSION_ID, taskId: 'W-1', owner: 'a', heartbeatSource: 'last-commit',
    });
    expect(store.getTaskGraph(MISSION_ID).tasks[0].heartbeat_source).toBe('last-commit');
  });
});

describe('the journal is the record, the snapshot is its cache', () => {
  it('rebuilds a deleted snapshot from the journal', () => {
    const { store } = store$();
    seed(store, [task('W-1')]);
    store.claimTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a' });
    const before = store.getState();
    writeFileSync(store.paths.snapshot, '');
    expect(store.getState()).toEqual(before);
  });

  it('prefers the journal when the snapshot is behind', () => {
    const { store } = store$();
    seed(store);
    store.updateMission(MISSION_ID, (m) => ({ ...m, status: 'reviewing' }), { reason: 'advance' });
    const stale = { ...store.getState(), state_version: 1, active_missions: {} };
    writeFileSync(store.paths.snapshot, JSON.stringify(stale));
    expect(store.getState().state_version).toBe(2);
    expect(store.getMission(MISSION_ID).status).toBe('reviewing');
  });

  it('skips a torn journal line instead of refusing to open the store', () => {
    const { store } = store$();
    seed(store);
    const raw = readFileSync(store.paths.journal, 'utf-8');
    writeFileSync(store.paths.journal, raw + '{"kind":"mission.up');
    writeFileSync(store.paths.snapshot, '');
    expect(store.getState().state_version).toBe(1);
    expect(readJournal(store.paths.journal).torn).toBe(1);
  });

  it('folds the journal to exactly the committed snapshot', () => {
    const { store } = store$();
    seed(store, [task('W-1')]);
    store.claimTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a' });
    const { records } = readJournal(store.paths.journal);
    const { state } = reduceProjectState(records, { project: 'artibot' });
    expect(state).toEqual(store.getState());
  });

  it('warns rather than guesses on an unknown record kind', () => {
    const { warnings } = reduceProjectState([{ kind: 'mission.teleport', mission_id: MISSION_ID }]);
    expect(warnings[0]).toMatch(/unknown store record kind/);
  });

  it('warns when a task.upsert names a mission with no graph', () => {
    const { warnings } = reduceProjectState([
      { kind: 'task.upsert', mission_id: MISSION_ID, task: task('W-1'), state_version: 1 },
    ]);
    expect(warnings[0]).toMatch(/has no graph for mission/);
  });

  it('warns when state_version regresses', () => {
    const { warnings } = reduceProjectState([
      { kind: 'mission.upsert', mission_id: MISSION_ID, mission: mission(), state_version: 5 },
      { kind: 'mission.upsert', mission_id: MISSION_ID, mission: mission(), state_version: 2 },
    ]);
    expect(warnings.join(' ')).toMatch(/state_version regressed/);
  });
});

describe('reconcile', () => {
  it('reports no drift on a healthy store', () => {
    const { store } = store$();
    seed(store);
    expect(store.reconcile()).toMatchObject({ ok: true, drifted: false, applied: false });
  });

  it('reports drift without repairing it by default (Observe)', () => {
    const { store } = store$();
    seed(store);
    writeFileSync(store.paths.snapshot, JSON.stringify({ ...store.getState(), state_version: 99 }));
    const out = store.reconcile();
    expect(out.drifted).toBe(true);
    expect(out.applied).toBe(false);
    expect(JSON.parse(readFileSync(store.paths.snapshot, 'utf-8')).state_version).toBe(99);
  });

  it('repairs from the journal when asked', () => {
    const { store } = store$();
    seed(store);
    writeFileSync(store.paths.snapshot, JSON.stringify({ ...store.getState(), state_version: 99 }));
    const out = store.reconcile({ apply: true });
    expect(out.applied).toBe(true);
    expect(JSON.parse(readFileSync(store.paths.snapshot, 'utf-8')).state_version).toBe(1);
  });

  it('separates a ledger ahead of the store from a store ahead of the ledger', () => {
    const { store } = store$();
    seed(store);
    seed(store);
    const out = store.reconcile({ ledgerVersions: [1, 3] });
    // 3 is in the ledger only: a crash between the two appends. Invariant holds.
    expect(out.missingInStore).toEqual([3]);
    // 2 is in the store only: a write with no event. Invariant BROKEN.
    expect(out.extraInStore).toEqual([2]);
  });

  it('reports no gaps in a contiguous version sequence', () => {
    const { store } = store$();
    seed(store);
    seed(store);
    expect(store.reconcile().gaps).toEqual([]);
  });
});
