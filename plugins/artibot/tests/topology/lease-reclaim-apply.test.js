/**
 * `lib/topology/lease-reclaim.js#reclaimExpiredLaneLeases` against a REAL
 * StateStore in a tmp dir with a fake clock — the CA-09 reclaim, report-only
 * unless `apply` is the literal `true` AND an explicit id list names what to
 * release.
 *
 * What is measured: report mode writes nothing (version, journal bytes,
 * ledger) and never reaches a write port; apply without a usable list is
 * refused before the store is touched; only the LISTED ids are ever released
 * (ADV-1: never a rescan-and-release-all); every listed id gets an answer; a
 * renewal or an unrelated write between the report and the release is honoured
 * (`not-expired` / `conflict`); a release lets a re-dispatch claim the limb
 * again. The pure arithmetic is in `lease-reclaim.test.js`.
 *
 * What it cannot see (rules §9): a live `/split` run, and how the scan behaves
 * on a store with thousands of journal records (every `getState()` re-parses
 * the whole journal).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStateStore } from '../../lib/project-state/state-manager.js';
import { LIMB_LEASE_TTL_MS } from '../../lib/topology/split-task-feed.js';
import { LEASE_RECLAIM_REASON, reclaimExpiredLaneLeases } from '../../lib/topology/lease-reclaim.js';
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
/** The id `--apply-reclaim` takes for a lane of the fixture mission. */
const idOf = (task) => `${MISSION}/${task}`;

describe('reclaimExpiredLaneLeases — against a real StateStore', () => {
  let root;
  /** @type {object[]} */ let ledger;
  let clock;
  let refuseLedger;

  const PLAN_5 = { runId: 'split-lr5', limbs: ['l1', 'l2', 'l3', 'l4', 'l5', 'carol'].map((limb) => ({ limb, affectedPaths: [`lib/${limb}.js`] })) };

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

  const feed = (store, limb = 'auth', plan = PLAN) => feedLimb({ parentRoot: root, plan, limb, sessionId: SESSION }, { openStore: () => store, config: OFF });
  const updates = () => ledger.filter((e) => e.event === 'state.updated');
  const reclaimRows = () => updates().filter((e) => e.data.reason === LEASE_RECLAIM_REASON);
  const task = (store, limb = 'auth') => store.getTaskGraph(MISSION).tasks.find((t) => t.id === limb);
  const journal = (store) => fs.readFileSync(store.paths.journal, 'utf-8');

  /** A store whose lanes were claimed at T0 and whose clock now reads T0 + 25h. Returns the store and "now". */
  function lapsedStore(limbs = ['auth'], plan = PLAN) {
    const store = makeStore();
    seedMission(store);
    clock = new Date(T0);
    for (const l of limbs) expect(feed(store, l, plan).claim).toBe('claimed');
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
    expect(out.candidates[0]).toMatchObject({ id: idOf('auth'), missionId: MISSION, taskId: 'auth', owner: 'auth', status: 'claimed', action: 'release-to-queued', expiredForMs: H });
    expect(store.getState().state_version).toBe(version);
    expect(journal(store)).toBe(before);
    expect(ledger.length).toBe(events);
    expect(store.getLease(MISSION, 'auth')?.owner).toBe('auth');
    expect(task(store).status).toBe('claimed');
  });

  it('report mode never reaches a store write port (every writer throws if touched), with or without an id list', () => {
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
    // A list without the apply switch is still only a report: naming an id is not a confirmation.
    expect(reclaimExpiredLaneLeases({ store: guarded, nowMs, apply: false, ids: [idOf('auth')] })).toMatchObject({ mode: 'report', applied: false, results: [] });
    for (const name of ['updateMission', 'claimTask', 'releaseTask', 'heartbeatWorker', 'appendEvent']) {
      expect(guarded[name], name).not.toHaveBeenCalled();
    }
  });

  it('only the literal `true` applies — truthy look-alikes stay report-only, even with a list', () => {
    const { store, nowMs } = lapsedStore();
    const version = store.getState().state_version;
    for (const apply of ['true', 'yes', 1, {}, [], 'apply', 'false']) {
      const out = reclaimExpiredLaneLeases({ store, nowMs, apply, ids: [idOf('auth')] });
      expect(out.mode, String(apply)).toBe('report');
      expect(out.applied).toBe(false);
    }
    expect(store.getState().state_version).toBe(version);
    expect(store.getLease(MISSION, 'auth')).not.toBe(null);
  });

  it('ADV-1: apply:true WITHOUT a usable list is refused before the store is touched — there is no release-all', () => {
    const tripped = new Proxy({}, { get: (_t, name) => () => { throw new Error(`${String(name)} touched`); } });
    const badLists = [undefined, null, [], [''], ['auth'], [`${MISSION}/`], 'M-20260930-Sabcd1234/auth', 7, {}];
    for (const ids of badLists) {
      const out = reclaimExpiredLaneLeases({ store: tripped, nowMs: T0, apply: true, ids });
      expect(out, JSON.stringify(ids)).toMatchObject({ mode: 'refused', applied: false, results: [], candidates: [] });
      expect(out.reason, JSON.stringify(ids)).toMatch(/id/);
    }
    // One bad id refuses the WHOLE call: a half-applied list is the surprise a confirmation must not have.
    const { store, nowMs } = lapsedStore();
    const version = store.getState().state_version;
    const mixed = reclaimExpiredLaneLeases({ store, nowMs, apply: true, ids: [idOf('auth'), 'not-an-id'] });
    expect(mixed).toMatchObject({ mode: 'refused', applied: false });
    expect(store.getState().state_version).toBe(version);
    expect(store.getLease(MISSION, 'auth')).not.toBe(null);
  });

  it('ADV-1: apply releases ONLY the listed lease — its lapsed sibling is reported and left alone', () => {
    const { store, nowMs } = lapsedStore(['auth', 'billing']);
    const before = updates().length;

    const out = reclaimExpiredLaneLeases({ store, nowMs, apply: true, ids: [idOf('auth')] });

    expect(out.mode).toBe('apply');
    expect(out.applied).toBe(true);
    expect(out.results).toEqual([{ id: idOf('auth'), missionId: MISSION, taskId: 'auth', outcome: 'reclaimed:queued' }]);
    expect(out.candidates.map((c) => c.id)).toEqual([idOf('auth'), idOf('billing')]); // both reported...
    expect(store.getLease(MISSION, 'auth')).toBe(null); //                              ...one released
    expect(store.getLease(MISSION, 'billing')?.owner).toBe('billing');
    expect(task(store, 'billing').status).toBe('claimed');
    expect(updates().length).toBe(before + 1);
  });

  it('ADV-1: never a rescan-and-release-all — six lapsed lanes, two listed, exactly those two are released', () => {
    const { store, nowMs } = lapsedStore(['l1', 'l2', 'l3', 'l4', 'l5', 'carol'], PLAN_5);
    const out = reclaimExpiredLaneLeases({ store, nowMs, apply: true, ids: [idOf('l4'), idOf('l2')] });
    expect(out.candidates).toHaveLength(6);
    expect(out.results.map((r) => [r.taskId, r.outcome])).toEqual([['l4', 'reclaimed:queued'], ['l2', 'reclaimed:queued']]); // requested order
    expect(reclaimRows()).toHaveLength(2);
    for (const l of ['l1', 'l3', 'l5', 'carol']) expect(store.getLease(MISSION, l)?.owner, l).toBe(l);
    for (const l of ['l2', 'l4']) expect(store.getLease(MISSION, l), l).toBe(null);
  });

  it('every listed id gets an answer: not expired, protected, unknown — and a duplicate is processed once', () => {
    const store = makeStore();
    seedMission(store);
    clock = new Date(T0);
    expect(feed(store, 'l1', PLAN_5).claim).toBe('claimed');
    expect(feed(store, 'l2', PLAN_5).claim).toBe('claimed');
    clock = new Date(T0 + 20 * H);
    expect(feed(store, 'carol', PLAN_5).claim).toBe('claimed'); // expires T0 + 44h: live at T0 + 25h
    clock = new Date(T0 + 25 * H);
    const ids = [idOf('carol'), idOf('l2'), `${MISSION}/ghost`, idOf('l1'), idOf('l1')];

    const out = reclaimExpiredLaneLeases({ store, nowMs: T0 + 25 * H, apply: true, keepAlive: ['l2'], ids });

    expect(out.results.map((r) => [r.taskId, r.outcome])).toEqual([
      ['carol', 'skipped:not-expired'],
      ['l2', 'skipped:protected'],
      ['ghost', 'skipped:not-a-candidate'],
      ['l1', 'reclaimed:queued'],
    ]);
    expect(reclaimRows()).toHaveLength(1);
    expect(store.getLease(MISSION, 'l2')?.owner).toBe('l2');
    expect(store.getLease(MISSION, 'carol')?.owner).toBe('carol');
  });

  it('apply:true + ids releases the lease and returns the owned node to queued in ONE commit, reason split.lease-reclaim', () => {
    const { store, nowMs } = lapsedStore();
    const before = updates().length;

    const out = reclaimExpiredLaneLeases({ store, nowMs, apply: true, ids: [idOf('auth')] });

    expect(out.results).toEqual([{ id: idOf('auth'), missionId: MISSION, taskId: 'auth', outcome: 'reclaimed:queued' }]);
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
    expect(reclaimExpiredLaneLeases({ store, nowMs, apply: true, ids: [idOf('auth')] }).applied).toBe(true);

    expect(feed(store).claim).toBe('claimed');
    const lease = store.getLease(MISSION, 'auth');
    expect(Date.parse(lease.acquired_at)).toBe(nowMs);
    expect(Date.parse(lease.expires_at)).toBe(nowMs + LIMB_LEASE_TTL_MS);
    expect(task(store).status).toBe('claimed');
  });

  it('a second apply of the same list finds nothing: it is idempotent and writes no second commit', () => {
    const { store, nowMs } = lapsedStore();
    expect(reclaimExpiredLaneLeases({ store, nowMs, apply: true, ids: [idOf('auth')] }).applied).toBe(true);
    const version = store.getState().state_version;
    const again = reclaimExpiredLaneLeases({ store, nowMs, apply: true, ids: [idOf('auth')] });
    expect(again.candidates).toEqual([]);
    expect(again.results.map((r) => r.outcome)).toEqual(['skipped:not-a-candidate']);
    expect(again.applied).toBe(false);
    expect(store.getState().state_version).toBe(version);
  });

  it('a live lease is left alone even when it is listed', () => {
    const store = makeStore();
    seedMission(store);
    feed(store, 'auth');
    clock = new Date(T0 + 23 * H);
    const version = store.getState().state_version;
    const out = reclaimExpiredLaneLeases({ store, nowMs: T0 + 23 * H, apply: true, ids: [idOf('auth')] });
    expect(out.candidates).toEqual([]);
    expect(out.live).toBe(1);
    expect(out.results.map((r) => r.outcome)).toEqual(['skipped:not-expired']);
    expect(out.applied).toBe(false);
    expect(store.getState().state_version).toBe(version);
    expect(store.getLease(MISSION, 'auth')).not.toBe(null);
  });

  it('a keep-alive lane survives apply even when listed; its listed sibling does not', () => {
    const { store, nowMs } = lapsedStore(['auth', 'billing']);
    const out = reclaimExpiredLaneLeases({ store, nowMs, apply: true, keepAlive: ['auth'], ids: [idOf('auth'), idOf('billing')] });
    expect(out.protected.map((p) => p.taskId)).toEqual(['auth']);
    expect(out.results.map((r) => [r.taskId, r.outcome])).toEqual([['auth', 'skipped:protected'], ['billing', 'reclaimed:queued']]);
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

    const out = reclaimExpiredLaneLeases({ store: racing, nowMs, apply: true, ids: [idOf('auth')] });

    expect(out.candidates).toHaveLength(1);
    expect(out.results).toEqual([{ id: idOf('auth'), missionId: MISSION, taskId: 'auth', outcome: 'skipped:not-expired' }]);
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

    const out = reclaimExpiredLaneLeases({ store: racing, nowMs, apply: true, ids: [idOf('auth')] });

    expect(out.results).toEqual([{ id: idOf('auth'), missionId: MISSION, taskId: 'auth', outcome: 'skipped:conflict' }]);
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
    const out = reclaimExpiredLaneLeases({ store: swapped, nowMs: nowMs + 2 * 60_000, apply: true, ids: [idOf('auth')] });
    // The report (read #1) saw owner 'auth'; the re-read saw 'rescuer'.
    expect(out.results).toEqual([{ id: idOf('auth'), missionId: MISSION, taskId: 'auth', outcome: 'skipped:lease-changed' }]);
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

    const out = reclaimExpiredLaneLeases({ store, nowMs, apply: true, ids: [idOf('auth')] });

    expect(out.results).toEqual([{ id: idOf('auth'), missionId: MISSION, taskId: 'auth', outcome: 'reclaimed:done' }]);
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

    const out = reclaimExpiredLaneLeases({ store, nowMs, apply: true, ids: [idOf('auth')] });

    expect(out.results).toEqual([{ id: idOf('auth'), missionId: MISSION, taskId: 'auth', outcome: 'reclaimed:executing' }]);
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

    const out = reclaimExpiredLaneLeases({ store, nowMs: T0 + 25 * H, apply: true, ids: [idOf('auth')] });

    expect(out.results[0].outcome).toBe('reclaimed:queued');
    expect(store.getLease(MISSION, 'auth')).toBe(null);
  });

  it('a refused ledger port abandons the write and is reported as refused; the lease stays', () => {
    const { store, nowMs } = lapsedStore();
    refuseLedger = true;
    const out = reclaimExpiredLaneLeases({ store, nowMs, apply: true, ids: [idOf('auth')] });
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
    const out = reclaimExpiredLaneLeases({ store: flaky, nowMs, apply: true, ids: [idOf('auth'), idOf('billing')] });
    expect(out.results.map((r) => [r.taskId, r.outcome])).toEqual([
      ['auth', 'refused:threw:lock timeout'],
      ['billing', 'reclaimed:queued'],
    ]);
    expect(out.applied).toBe(true);
  });
});
