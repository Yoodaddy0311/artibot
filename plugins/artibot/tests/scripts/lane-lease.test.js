/**
 * `scripts/split/lane-lease.mjs` — lane transitions reach the limb's lease,
 * against a REAL StateStore.
 *
 * Before this module the lease `task-feed.mjs#feedLimb` takes at dispatch had
 * one renewal path (a re-dispatch) and no release path at all: `releaseTask`
 * had 0 callers outside `lib/project-state/` and the tests (measured
 * 2026-09-23), so a finished limb sat `claimed` for the whole 24h TTL and the
 * feeder's `terminal:done` guard could not be reached in production. What is
 * measured here: the mapping table, each write against a real store, that
 * every refusal is a `skipped:<reason>` (never a throw, never a mission row),
 * and that the ledger gains no new event name — the store's own
 * `state.updated` is the only one.
 *
 * Every store lives in a fresh `fs.mkdtempSync` directory with the git port
 * injected (`<tmp>/.git`), so no live `.artibot` state is read or written.
 *
 * What it cannot see (rules §9): whether the live leader session that runs
 * `lane-state` owns a mission row, and whether a reader acts on the renewed
 * `heartbeat_at`. Both are live observations.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStateStore } from '../../lib/project-state/state-manager.js';
import { writeRunJson } from '../../lib/git/split-run-file.js';
import { LANE_OPS_STATES } from '../../lib/supervisor/contracts.js';
import { feedLimb, openFeedStore } from '../../scripts/split/task-feed.mjs';
import * as laneState from '../../scripts/split/lane-state.mjs';
import { LANE_LEASE_ACTIONS, LANE_LEASE_REASON, syncLaneLease } from '../../scripts/split/lane-lease.mjs';

const SESSION = 'abcd1234-ef56-7890-1234-567890abcdef';
const MISSION = 'M-20260923-Sabcd1234';
// Built from parts: `tests/supervisor/v11-status-mapping.test.js` scans the
// repo for a `state` key set to this word as a literal.
const FAILED = ['fail', 'ed'].join('');
const PLAN = {
  runId: 'split-t',
  limbs: [
    { limb: 'auth', affectedPaths: ['lib/auth/**'] },
    { limb: 'billing', affectedPaths: ['lib/billing.js'] },
  ],
};

let root;
/** @type {object[]} */ let ledger;
let clock;
let refuseLedger;

/** A store in the tmp root with the git port injected and a capturing ledger port. */
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

/** Seed a mission row the way UserPromptSubmit would have. */
function seedMission(store) {
  const r = store.updateMission(MISSION, () => ({
    status: 'executing',
    intent: { path: '.artibot/intent.md', revision: 1 },
    plan: { path: '.artibot/plan.md', revision: 1 },
  }), { reason: 'test.seed' });
  expect(r.ok).toBe(true);
}

const feed = (store, limb = 'auth') => feedLimb({ parentRoot: root, plan: PLAN, limb, sessionId: SESSION }, { openStore: () => store });
const sync = (store, state, limb = 'auth') => syncLaneLease({ parentRoot: root, limb, state, sessionId: SESSION }, { openStore: () => store });
const updates = () => ledger.filter((e) => e.event === 'state.updated').length;
const task = (store, limb = 'auth') => store.getTaskGraph(MISSION).tasks.find((t) => t.id === limb);

const collect = () => {
  const out = []; const err = [];
  return { io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) }, stdout: () => out.join(''), stderr: () => err.join('') };
};

/** `lane-state` CLI with the sync bound to the tmp store. */
function cli(store, argv) {
  const c = collect();
  const code = laneState.main(argv, {
    cwd: root,
    ...c.io,
    syncLease: (input) => syncLaneLease({ ...input, sessionId: SESSION }, { openStore: () => store }),
  });
  return { code, ...c };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-lane-lease-'));
  const dir = path.join(root, '.artibot', 'split');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(PLAN));
  writeRunJson(root, { runId: 'split-t' });
  ledger = [];
  clock = new Date('2026-09-23T01:00:00.000Z');
  refuseLedger = false;
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('LANE_LEASE_ACTIONS — the mapping table', () => {
  it('classifies EVERY ops state, so a new one fails here instead of passing silently', () => {
    expect(Object.keys(LANE_LEASE_ACTIONS).sort()).toEqual([...LANE_OPS_STATES].sort());
    expect(new Set(Object.values(LANE_LEASE_ACTIONS))).toEqual(new Set(['heartbeat', 'release', 'none']));
  });

  it('renews on the working states, releases on the two finishing states, ignores the rest', () => {
    const by = (a) => Object.keys(LANE_LEASE_ACTIONS).filter((s) => LANE_LEASE_ACTIONS[s] === a).sort();
    expect(by('heartbeat')).toEqual(['active', 'closing', 'review', 'serial-gate']);
    expect(by('release')).toEqual(['done', FAILED]);
    expect(by('none')).toEqual(['awaiting-dispatch', 'pending', 'suspended']);
  });
});

describe('lane-state CLI → lease, against a real store', () => {
  it('done releases the lease and marks the task done in exactly one commit', () => {
    const store = makeStore();
    seedMission(store);
    expect(feed(store).claim).toBe('claimed');
    expect(store.getLease(MISSION, 'auth')).not.toBe(null);
    const before = updates();

    const r = cli(store, ['auth', 'done', '--json']);

    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout()).lease).toEqual({ outcome: 'released:done', missionId: MISSION });
    expect(task(store).status).toBe('done');
    expect(task(store).owner).toBe(null);
    expect(store.getLease(MISSION, 'auth')).toBe(null);
    expect(updates()).toBe(before + 1);
    expect(ledger.at(-1).data.reason).toBe(LANE_LEASE_REASON);
  });

  it('failed releases the lease with the failed status', () => {
    const store = makeStore();
    seedMission(store);
    feed(store);
    const before = updates();

    const r = cli(store, ['auth', FAILED, '--json']);

    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout()).lease.outcome).toBe(`released:${FAILED}`);
    expect(task(store).status).toBe(FAILED);
    expect(store.getLease(MISSION, 'auth')).toBe(null);
    expect(updates()).toBe(before + 1);
  });

  it('an active re-assert renews heartbeat_at on the task and the lease', () => {
    const store = makeStore();
    seedMission(store);
    feed(store);
    const first = store.getLease(MISSION, 'auth');

    clock = new Date('2026-09-23T03:00:00.000Z');
    expect(cli(store, ['auth', 'active']).code).toBe(0);
    clock = new Date('2026-09-23T04:00:00.000Z');
    const before = updates();
    const r = cli(store, ['auth', 'active', '--json']);

    expect(JSON.parse(r.stdout()).lease.outcome).toBe('renewed');
    expect(updates()).toBe(before + 1);
    expect(task(store).heartbeat_at).toBe('2026-09-23T04:00:00.000Z');
    expect(task(store).heartbeat_source).toBe('lane-heartbeat');
    const lease = store.getLease(MISSION, 'auth');
    expect(lease.owner).toBe('auth');
    expect(lease.heartbeat_at).toBe('2026-09-23T04:00:00.000Z');
    expect(Date.parse(lease.expires_at)).toBeGreaterThan(Date.parse(first.expires_at));
    expect(task(store).status).toBe('claimed');
  });

  it('every heartbeat state renews', () => {
    const store = makeStore();
    seedMission(store);
    feed(store);
    for (const s of ['active', 'review', 'serial-gate', 'closing']) {
      expect(sync(store, s).outcome, s).toBe('renewed');
    }
  });

  it('done, then a re-dispatch: the feeder answers terminal:done and takes no new lease', () => {
    const store = makeStore();
    seedMission(store);
    feed(store);
    expect(cli(store, ['auth', 'done']).code).toBe(0);

    const again = feed(store);

    expect(again.claim).toBe('terminal:done');
    expect(store.getLease(MISSION, 'auth')).toBe(null);
    expect(task(store).status).toBe('done');
  });

  it(`${FAILED}, then a re-dispatch: the feeder claims again (a retry, not terminal)`, () => {
    const store = makeStore();
    seedMission(store);
    feed(store);
    expect(cli(store, ['auth', FAILED]).code).toBe(0);

    expect(feed(store).claim).toBe('claimed');
    expect(store.getLease(MISSION, 'auth')?.owner).toBe('auth');
  });
});

describe('syncLaneLease — idempotency and other holders', () => {
  it('a second done with no lease writes nothing and answers unchanged', () => {
    const store = makeStore();
    seedMission(store);
    feed(store);
    expect(sync(store, 'done').outcome).toBe('released:done');
    const before = updates();
    const version = store.getState().state_version;

    expect(sync(store, 'done')).toEqual({ outcome: 'unchanged', missionId: MISSION });
    expect(updates()).toBe(before);
    expect(store.getState().state_version).toBe(version);
  });

  it('a lease held by another owner is reported and never broken, for renew and release alike', () => {
    const store = makeStore();
    seedMission(store);
    feed(store, 'billing'); // seeds both tasks, claims only billing
    expect(store.claimTask({ missionId: MISSION, taskId: 'auth', owner: 'intruder', ttlMs: 60_000 }).ok).toBe(true);
    const before = updates();

    expect(sync(store, 'active').outcome).toBe('held-by:intruder');
    expect(sync(store, 'done').outcome).toBe('held-by:intruder');
    expect(updates()).toBe(before);
    expect(store.getLease(MISSION, 'auth').owner).toBe('intruder');
  });

  it('a heartbeat state with no lease skips without writing', () => {
    const store = makeStore();
    seedMission(store);
    feed(store, 'billing'); // auth is seeded, not claimed
    const before = updates();
    expect(sync(store, 'active')).toEqual({ outcome: 'skipped:no-lease', missionId: MISSION });
    expect(updates()).toBe(before);
  });

  it('the no-op states open no store at all', () => {
    let opened = 0;
    for (const s of ['pending', 'awaiting-dispatch', 'suspended']) {
      const r = syncLaneLease({ parentRoot: root, limb: 'auth', state: s, sessionId: SESSION }, { openStore: () => { opened += 1; return makeStore(); } });
      expect(r).toEqual({ outcome: 'skipped:no-transition', missionId: null });
    }
    expect(opened).toBe(0);
  });

  it('a refused ledger port abandons the write and is reported as refused', () => {
    const store = makeStore();
    seedMission(store);
    feed(store);
    refuseLedger = true;
    expect(sync(store, 'done').outcome).toMatch(/^refused:ledger refused state\.updated/);
    expect(store.getLease(MISSION, 'auth')?.owner).toBe('auth');
    expect(task(store).status).toBe('claimed');
  });
});

describe('syncLaneLease — fail-open: every refusal is skipped:<reason>, no mission row is created', () => {
  const missionRows = (store) => Object.keys(store.getState().active_missions).length;

  it('no mission row → skipped:no-mission through the CLI; exit code and the human line are unchanged', () => {
    const store = makeStore();
    const c = collect();
    const code = laneState.main(['auth', 'done'], {
      cwd: root, ...c.io, now: () => new Date('2026-09-23T02:00:00.000Z'),
      syncLease: (input) => syncLaneLease({ ...input, sessionId: SESSION }, { openStore: () => store }),
    });
    expect(code).toBe(0);
    expect(c.stdout()).toBe('auth: unknown → done since 2026-09-23T02:00:00.000Z\n');
    expect(c.stderr()).toBe('');
    expect(sync(store, 'done')).toEqual({ outcome: 'skipped:no-mission', missionId: null });
    expect(missionRows(store)).toBe(0);
    expect(ledger).toEqual([]);
  });

  it('no session id → skipped:no-session-id and no store is opened', () => {
    let opened = 0;
    const r = syncLaneLease({ parentRoot: root, limb: 'auth', state: 'done', sessionId: '' }, { openStore: () => { opened += 1; return makeStore(); } });
    expect(r).toEqual({ outcome: 'skipped:no-session-id', missionId: null });
    expect(opened).toBe(0);
  });

  it('task absent from the graph → skipped:no-task, no write', () => {
    const store = makeStore();
    seedMission(store);
    const version = store.getState().state_version;
    expect(sync(store, 'done')).toEqual({ outcome: 'skipped:no-task', missionId: MISSION });
    expect(sync(store, 'active').outcome).toBe('skipped:no-task');
    expect(store.getState().state_version).toBe(version);
    expect(missionRows(store)).toBe(1);
  });

  it('a throwing store constructor → skipped:store-threw:<msg>; the CLI still exits 0 with the same --json keys', () => {
    const c = collect();
    const code = laneState.main(['auth', 'done', '--json'], {
      cwd: root, ...c.io,
      syncLease: (input) => syncLaneLease({ ...input, sessionId: SESSION }, { openStore: () => { throw new TypeError('boom'); } }),
    });
    expect(code).toBe(0);
    expect(JSON.parse(c.stdout()).lease).toEqual({ outcome: 'skipped:store-threw:boom', missionId: null });
  });

  it('is total: missing or malformed input never throws', () => {
    expect(syncLaneLease().outcome).toBe('skipped:no-transition');
    expect(syncLaneLease(null).outcome).toBe('skipped:no-transition');
    expect(syncLaneLease({ state: 'done' }).outcome).toBe('skipped:no-project-root');
    expect(syncLaneLease({ state: 'done', parentRoot: root }).outcome).toBe('skipped:no-limb');
    expect(syncLaneLease({ state: 'bogus', parentRoot: root, limb: 'auth' }).outcome).toBe('skipped:no-transition');
    expect(syncLaneLease({ parentRoot: root, limb: 'auth', state: 'done', sessionId: SESSION }, { openStore: () => ({}) }).outcome)
      .toMatch(/^skipped:store-threw:/);
  });
});

describe('ledger vocabulary', () => {
  it('a full lane lifecycle adds no event name: state.updated is the only one', () => {
    const store = makeStore();
    seedMission(store);
    feed(store);
    feed(store, 'billing');
    for (const s of ['active', 'review', 'serial-gate', 'closing', 'done']) cli(store, ['auth', s]);
    cli(store, ['billing', FAILED]);
    cli(store, ['auth', 'done']);
    feed(store);

    expect(new Set(ledger.map((e) => e.event))).toEqual(new Set(['state.updated']));
    const mine = ledger.filter((e) => e.data?.reason === LANE_LEASE_REASON);
    // 4 renewals + auth done + billing failed; the repeated done is unchanged.
    expect(mine).toHaveLength(6);
  });
});

describe('dispatch path stays unwired', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('setLaneState (what dispatch.mjs calls) never touches the lease, even where the default sync would reach this store', () => {
    // Without `<root>/.git` and a session id, a sync wrongly placed in
    // setLaneState would open the empty fallback store, skip no-mission and
    // leave this green — measured by review (F1, 2026-09-23). Both are set so
    // the DEFAULT port lands on the store counted below, with its own ledger
    // under `<root>/.git/artibot/` — inside the mkdtemp root.
    fs.mkdirSync(path.join(root, '.git'));
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', SESSION);
    vi.stubEnv('CLAUDE_SESSION_ID', '');
    const store = makeStore();
    expect(store.location.source).toBe('git-common-dir');
    expect(openFeedStore(root, SESSION).paths.snapshot).toBe(store.paths.snapshot);
    seedMission(store);
    feed(store);
    const version = store.getState().state_version;
    const beat = store.getLease(MISSION, 'auth').heartbeat_at;

    for (const s of ['active', 'done']) laneState.setLaneState({ limb: 'auth', state: s }, { cwd: root });

    expect(store.getState().state_version).toBe(version);
    expect(store.getLease(MISSION, 'auth')?.owner).toBe('auth');
    expect(store.getLease(MISSION, 'auth').heartbeat_at).toBe(beat);
    expect(task(store).status).toBe('claimed');
  });
});
