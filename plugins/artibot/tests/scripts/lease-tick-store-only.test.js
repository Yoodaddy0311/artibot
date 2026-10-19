/**
 * `scripts/split/lease-tick.mjs` — the tick is STORE-ONLY (design D11, backlog follow-up c) and
 * a snapshot that cannot be written no longer reads as a failed renewal (follow-up b).
 *
 * The canon: heartbeats update the store only; the central ledger gets `task.claimed/released`
 * and nothing for a renewal. Until `heartbeatWorker({storeOnly})` existed, a tick cost one
 * `state.updated` row (`split.lease-tick`), at most 32 per lane-day — and a no-op ledger port
 * was not an option, because `/doctor` Check 8 read a store version with no row as a lost update.
 *
 * What is measured, against a REAL StateStore in a tmpdir with a fake clock and a ledger port
 * that records what it is handed (the same fixture shape as lease-tick.test.js):
 *  - ONE TICK LEAVES 0 ROWS IN THE LEDGER — the done condition of follow-up c — while the
 *    store still takes a version, the lease and the node move, and the journal marks the commit;
 *  - the lane-state emitter beside it is unchanged (it still pairs: it is the leader's
 *    declaration, not a clock), and so is a reclaim (a release is not a heartbeat);
 *  - the whole `tick()` path, the way `main` runs it, adds no ledger event;
 *  - Check 8 reads the store a run of ticks left behind as healthy — the false-positive the
 *    exemption exists to prevent — and the SAME journal with its marks stripped as lost updates;
 *  - a snapshot rename that never lands: the renewal still reads `renewed` (the journal took
 *    it), where it used to read `skipped:store-threw:EPERM …`.
 *
 * Not wrapped in `usePatientRename()` on purpose: that helper exists to absorb the very
 * failure follow-up b removes, and the snapshot-failure case needs a rename that FAILS fast.
 *
 * What it cannot see (rules §9): the real ledger writer and child processes (that is
 * lease-tick-wiring.test.js), a live leader session, a host that holds the rename for
 * longer than the store's ~150ms retry on a real tick, and how many ticks a real wave runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkLedgerStateParity, CheckStatus } from '../../lib/project-state/doctor-checks.js';
import { storeOnlyVersions } from '../../lib/project-state/journal.js';
import { createStateStore, readJournal } from '../../lib/project-state/state-manager.js';
import { LEASE_RECLAIM_REASON, LEASE_TICK_REASON, LEASE_TICK_SOURCE } from '../../lib/topology/lease-reclaim.js';
import { LANE_LEASE_REASON, syncLaneLease } from '../../scripts/split/lane-lease.mjs';
import { feedLimb } from '../../scripts/split/task-feed.mjs';
import { renewLaneHeartbeats, tick } from '../../scripts/split/lease-tick.mjs';

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
  ],
};
const iso = (ms) => new Date(ms).toISOString();
const lane = (over = {}) => ({
  limb: 'auth', opsState: 'active', complete: false, sessionPresent: true, health: { health: 'unknown' }, opsUpdatedAt: null, ...over,
});

describe('a tick is store-only: one renewal leaves the central ledger untouched', () => {
  let root;
  let storeDir;
  /** @type {object[]} */ let ledger;
  let clock;
  let store;

  const makeStore = () => createStateStore({
    projectRoot: root,
    sessionId: SESSION,
    renderProjectionFile: false,
    now: () => clock,
    resolveGitCommonDir: () => path.join(root, '.git'),
    appendEvent: (e) => void ledger.push(e),
  });
  const feed = (limb = 'auth') => feedLimb({ parentRoot: root, plan: PLAN, limb, sessionId: SESSION }, { openStore: () => store, config: OFF });
  const at = (ms) => { clock = new Date(ms); return ms; };
  const ports = (over = {}) => ({ openStore: () => store, sessionId: SESSION, config: OFF, ...over });
  const poll = (lanes = [lane()], over = {}) => renewLaneHeartbeats({ parent: root, lanes, nowMs: clock.getTime(), ports: ports(over) });
  const outcome = (r, limb = 'auth') => r.lanes.find((l) => l.limb === limb).outcome;
  const task = (limb = 'auth') => store.getTaskGraph(MISSION).tasks.find((t) => t.id === limb);
  const journal = () => readJournal(store.paths.journal).records;
  const check8 = (records = journal()) => checkLedgerStateParity({
    journal: records, events: ledger, projection: store.renderProjection(), project: path.basename(root),
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-lease-tick-so-'));
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-lease-tick-so-store-'));
    const dir = path.join(root, '.artibot', 'split');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(PLAN));
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ runId: 'split-lt' }));
    ledger = [];
    clock = new Date(T0);
    store = makeStore();
    expect(store.updateMission(MISSION, () => ({
      status: 'executing',
      intent: { path: '.artibot/intent.md', revision: 1 },
      plan: { path: '.artibot/plan.md', revision: 1 },
    }), { reason: 'test.seed' }).ok).toBe(true);
    expect(feed('auth').claim).toBe('claimed');
  });
  afterEach(() => {
    for (const d of [root, storeDir]) fs.rmSync(d, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('the fixture is what it claims: seed, the feeder\'s graph merge and the claim are the three ledger rows there are', () => {
    expect(ledger.map((e) => e.event)).toEqual(['state.updated', 'state.updated', 'state.updated']);
    expect(store.getState().state_version).toBe(3);
    expect(storeOnlyVersions(journal())).toEqual([]);
  });

  it('ONE TICK appends 0 rows to the ledger, yet the store takes a version and the lease and node move', () => {
    const rows = ledger.length;
    const version = store.getState().state_version;
    at(T0 + 45 * MIN);

    const r = poll();

    expect(outcome(r)).toBe('renewed');
    expect(ledger).toHaveLength(rows);
    expect(store.getState().state_version).toBe(version + 1);
    expect(store.getLease(MISSION, 'auth').heartbeat_at).toBe(iso(T0 + 45 * MIN));
    expect(task()).toMatchObject({ status: 'claimed', heartbeat_at: iso(T0 + 45 * MIN), heartbeat_source: LEASE_TICK_SOURCE });
    expect(journal().filter((x) => x.state_version === version + 1).map((x) => [x.kind, x.store_only, x.reason]))
      .toEqual([['task.upsert', true, LEASE_TICK_REASON], ['lease.set', true, LEASE_TICK_REASON]]);
  });

  it('a tick that is not due writes nothing anywhere, and a due one writes only the store', () => {
    const rows = ledger.length;
    const version = store.getState().state_version;
    at(T0 + 44 * MIN);
    expect(outcome(poll())).toBe('skipped:not-due');
    expect(store.getState().state_version).toBe(version);
    at(T0 + 45 * MIN);
    expect(outcome(poll())).toBe('renewed');
    expect(store.getState().state_version).toBe(version + 1);
    expect(ledger).toHaveLength(rows);
  });

  it('the lane-state emitter beside it is unchanged: it is the leader\'s declaration and still pairs', () => {
    at(T0 + 45 * MIN);
    expect(outcome(poll())).toBe('renewed');
    const rows = ledger.length;
    const version = store.getState().state_version;

    at(T0 + 50 * MIN);
    expect(syncLaneLease({ parentRoot: root, limb: 'auth', state: 'active', sessionId: SESSION }, { openStore: () => store, config: OFF }).outcome).toBe('renewed');

    expect(ledger).toHaveLength(rows + 1);
    expect(ledger.at(-1).data).toMatchObject({ reason: LANE_LEASE_REASON, state_version: version + 1 });
    expect(task().heartbeat_source).toBe('lane-heartbeat');
    expect(journal().filter((x) => x.state_version === version + 1).some((x) => 'store_only' in x)).toBe(false);
  });

  it('a reclaim is not a heartbeat: releasing a listed id still writes its paired row', async () => {
    expect(feed('billing').claim).toBe('claimed');
    at(T0 + 25 * H);
    fs.writeFileSync(path.join(root, '.artibot', 'split', 'run.json'), JSON.stringify({
      runId: 'split-lt', lanes: { auth: { state: 'active', since: iso(T0 + 25 * H), updated_at: iso(T0 + 25 * H) }, billing: { state: 'done' } },
    }));
    const rows = ledger.length;

    const r = await tick({ parent: root, runId: null, storeDir, nowMs: clock.getTime(), applyIds: [`${MISSION}/billing`], ports: ports() });

    expect(r.leases.reclaim.results.map((x) => x.outcome)).toEqual(['reclaimed:queued']);
    expect(ledger.slice(rows).map((e) => e.data.reason)).toEqual([LEASE_RECLAIM_REASON]);
  });

  it('the whole tick() path, the way main runs it, adds no ledger event for the renewal it makes', async () => {
    at(T0 + 25 * H);
    fs.writeFileSync(path.join(root, '.artibot', 'split', 'run.json'), JSON.stringify({
      runId: 'split-lt', lanes: { auth: { state: 'active', since: iso(T0 + 25 * H), updated_at: iso(T0 + 25 * H) } },
    }));
    const rows = ledger.length;
    const version = store.getState().state_version;

    const r = await tick({ parent: root, runId: null, storeDir, nowMs: clock.getTime(), ports: ports() });

    expect(r.leases.heartbeat).toMatchObject({ available: true, renewable: 1, renewed: 1 });
    expect(ledger).toHaveLength(rows);
    expect(store.getState().state_version).toBe(version + 1);
  });

  it('a run of renewals: N store versions declared store-only, 0 ledger rows beyond the fixture\'s', () => {
    const rows = ledger.length;
    const before = store.getState().state_version;
    for (let i = 1; i <= 6; i += 1) {
      at(T0 + i * 45 * MIN);
      expect(outcome(poll()), `tick ${i}`).toBe('renewed');
    }
    expect(ledger).toHaveLength(rows);
    expect(storeOnlyVersions(journal())).toEqual([before + 1, before + 2, before + 3, before + 4, before + 5, before + 6]);
  });

  it('/doctor Check 8 reads the store those ticks left as healthy — not as six lost updates', () => {
    for (let i = 1; i <= 6; i += 1) {
      at(T0 + i * 45 * MIN);
      expect(outcome(poll())).toBe('renewed');
    }

    const result = check8();

    expect(result.findings.map((f) => f.code)).not.toContain('ledger-subset-violation');
    expect(result.status).toBe(CheckStatus.PASS);
    expect(result.findings).toEqual([expect.objectContaining({ code: 'store-only-versions', count: 6, first: 4, last: 9 })]);
  });

  it('...and reads the SAME journal with its marks stripped as exactly those six lost updates', () => {
    for (let i = 1; i <= 6; i += 1) {
      at(T0 + i * 45 * MIN);
      poll();
    }
    const stripped = journal().map(({ store_only: _mark, ...rest }) => rest);

    const result = check8(stripped);

    expect(result.status).toBe(CheckStatus.FAIL);
    expect(result.findings.find((f) => f.code === 'ledger-subset-violation').versions).toEqual([4, 5, 6, 7, 8, 9]);
  });

  describe('a snapshot that never lands (follow-up b, through the caller that reported it)', () => {
    const blockSnapshot = () => {
      fs.rmSync(store.paths.snapshot, { force: true });
      fs.mkdirSync(store.paths.snapshot);
    };

    it('the renewal still reads `renewed`: the journal took it, only the cache failed', () => {
      at(T0 + 45 * MIN);
      blockSnapshot();

      const r = poll();

      expect(outcome(r)).toBe('renewed');
      expect(r.renewed).toBe(1);
      expect(store.getLease(MISSION, 'auth').heartbeat_at).toBe(iso(T0 + 45 * MIN));
      expect(task().heartbeat_source).toBe(LEASE_TICK_SOURCE);
    });

    it('the next tick is judged on the journal\'s lease, not on a stale cache: a renewal that landed is not repeated', () => {
      at(T0 + 45 * MIN);
      blockSnapshot();
      expect(outcome(poll())).toBe('renewed');
      at(T0 + 46 * MIN);
      expect(outcome(poll())).toBe('skipped:not-due');
    });
  });
});
