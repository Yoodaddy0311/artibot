/**
 * `scripts/split/task-feed.mjs` — the port binding, against a REAL StateStore.
 *
 * The pure merge is measured in `tests/topology/split-task-feed.test.js`; what
 * is measured here is everything a pure test cannot see: that the produced
 * graph survives `validateSnapshot`, that `task.upsert` and `lease.set` records
 * actually reach the journal (both were 0 on the live store, 2026-09-21), and
 * that every failure path degrades to `skipped:<reason>` instead of throwing
 * into `/split dispatch`.
 *
 * Every store here lives in a fresh `fs.mkdtempSync` directory. No live
 * `.artibot` state file is read or written by this file.
 *
 * What it cannot see (rules §9): whether the live leader session has a mission
 * row at all, and whether the resume reader consumes the lease. Both are live
 * observations.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStateStore } from '../../lib/project-state/state-manager.js';
import { LANE_OPS_TO_V11_STATUS } from '../../lib/supervisor/contracts.js';
import { readWorkerState, writeWorkerState } from '../../lib/topology/split-state.js';
import { LIMB_LEASE_TTL_MS } from '../../lib/topology/split-task-feed.js';
import { selectMissionForSession } from '../../scripts/hooks/post-compact-rehydrate.js';
import { syncLaneLease } from '../../scripts/split/lane-lease.mjs';
import {
  FEED_REASON, feedLimb, missionBindingEnabled, openFeedStore, readShippedConfigSync, resolveRunMission,
  selectLegacyMission, sessionIdFromEnv,
} from '../../scripts/split/task-feed.mjs';

const SESSION = 'abcd1234-ef56-7890-1234-567890abcdef';
const MISSION = 'M-20260921-Sabcd1234';
const PLAN = {
  limbs: [
    { limb: 'auth', affectedPaths: ['lib/auth/**', 'tests/auth/**'] },
    { limb: 'billing', affectedPaths: ['lib/billing.js'] },
  ],
};

let root;
/** @type {object[]} */ let ledger;

/** A store rooted at the tmp dir, with a capturing ledger port. */
function makeStore(sessionId = SESSION) {
  return createStateStore({
    projectRoot: root,
    sessionId,
    renderProjectionFile: false,
    appendEvent: (e) => { ledger.push(e); },
  });
}

/** Seed a mission row the way UserPromptSubmit would have. */
function seedMission(store, missionId = MISSION) {
  const r = store.updateMission(missionId, () => ({
    status: 'executing',
    intent: { path: '.artibot/intent.md', revision: 1 },
    plan: { path: '.artibot/plan.md', revision: 1 },
  }), { reason: 'test.seed' });
  expect(r.ok).toBe(true);
  return r;
}

/** Records of one kind in the journal file. */
function journalKinds() {
  const file = path.join(root, '.artibot', 'runtime', 'project-state.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-task-feed-'));
  ledger = [];
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('feedLimb — the happy path against a real store', () => {
  it('seeds the limb task with file_ownership and claims its lease', () => {
    const store = makeStore();
    seedMission(store);
    const before = journalKinds().filter((r) => r.kind === 'task.upsert').length;
    expect(before).toBe(0);

    const r = feedLimb({ parentRoot: root, plan: PLAN, limb: 'auth', sessionId: SESSION }, { openStore: () => store });

    expect(r.fed).toBe(true);
    expect(r.skipped).toBe(null);
    expect(r.missionId).toBe(MISSION);
    expect(r.taskId).toBe('auth');
    expect(r.added).toEqual(['auth', 'billing']);
    expect(r.claim).toBe('claimed');

    const graph = store.getTaskGraph(MISSION);
    const auth = graph.tasks.find((t) => t.id === 'auth');
    expect(auth.file_ownership).toEqual(['lib/auth/**', 'tests/auth/**']);
    expect(auth.status).toBe('claimed');
    expect(auth.owner).toBe('auth');
    // The sibling limb is seeded but NOT claimed — one dispatch, one claim.
    expect(graph.tasks.find((t) => t.id === 'billing').status).toBe('queued');

    const lease = store.getLease(MISSION, 'auth');
    expect(lease).not.toBe(null);
    expect(lease.owner).toBe('auth');
    expect(Date.parse(lease.expires_at) - Date.now()).toBeGreaterThan(LIMB_LEASE_TTL_MS / 2);
    expect(store.getLease(MISSION, 'billing')).toBe(null);

    const kinds = journalKinds().map((x) => x.kind);
    expect(kinds).toContain('task.upsert');
    expect(kinds).toContain('lease.set');
    expect(kinds).toContain('graph.upsert');
    expect(journalKinds().some((x) => x.kind === 'graph.upsert' && x.graph.tasks.length === 2)).toBe(true);

    // COUNTED, not merely contained: a first dispatch costs exactly two
    // ledger rows under the feed reason — the graph upsert and the claim.
    // The `toContain` assertions above still pass if a third write creeps in
    // and makes every `/split dispatch` pay a redundant store round-trip,
    // which is the regression the unchanged-merge skip further down guards.
    expect(ledger.filter((e) => e.data?.reason === FEED_REASON)).toHaveLength(2);
  });

  it('a limb with no affectedPaths gets an empty ownership list, not a missing key', () => {
    const store = makeStore();
    seedMission(store);
    feedLimb({ parentRoot: root, plan: { limbs: [{ limb: 'solo' }] }, limb: 'solo', sessionId: SESSION }, { openStore: () => store });
    expect(store.getTaskGraph(MISSION).tasks[0].file_ownership).toEqual([]);
  });

  it('the write carries the feed reason, so the ledger row is attributable', () => {
    const store = makeStore();
    seedMission(store);
    ledger.length = 0;
    feedLimb({ parentRoot: root, plan: PLAN, limb: 'auth', sessionId: SESSION }, { openStore: () => store });
    expect(ledger.map((e) => e.data?.reason)).toContain(FEED_REASON);
  });

  it('a sibling limb costs one feed row, and --dry-run costs none', () => {
    const store = makeStore();
    seedMission(store);
    feedLimb({ parentRoot: root, plan: PLAN, limb: 'auth', sessionId: SESSION }, { openStore: () => store });

    // `auth` already seeded BOTH tasks, so dispatching `billing` changes no
    // graph field: the merge is unchanged, the graph write is skipped, and
    // the claim is the only row. Two rows here would mean the feeder rewrites
    // the whole graph once per limb.
    ledger.length = 0;
    feedLimb({ parentRoot: root, plan: PLAN, limb: 'billing', sessionId: SESSION }, { openStore: () => store });
    expect(ledger.filter((e) => e.data?.reason === FEED_REASON)).toHaveLength(1);
    expect(store.getTaskGraph(MISSION).tasks.find((t) => t.id === 'billing').status).toBe('claimed');

    // A dry run is not a cheaper write, it is no write: zero rows of ANY
    // reason, not just zero feed rows.
    ledger.length = 0;
    feedLimb({ parentRoot: root, plan: PLAN, limb: 'auth', sessionId: SESSION, dryRun: true }, { openStore: () => store });
    expect(ledger).toHaveLength(0);
  });
});

describe('feedLimb — re-dispatch is idempotent and never walks a task backwards', () => {
  it('a second feed of the same limb renews rather than re-claims, and adds nothing', () => {
    const store = makeStore();
    seedMission(store);
    feedLimb({ parentRoot: root, plan: PLAN, limb: 'auth', sessionId: SESSION }, { openStore: () => store });
    const versionAfterFirst = store.getState().state_version;

    const second = feedLimb({ parentRoot: root, plan: PLAN, limb: 'auth', sessionId: SESSION }, { openStore: () => store });
    expect(second.fed).toBe(true);
    expect(second.added).toEqual([]);
    expect(second.refreshed).toEqual([]);
    expect(second.claim).toBe('renewed');
    const auth = store.getTaskGraph(MISSION).tasks.find((t) => t.id === 'auth');
    expect(auth.status).toBe('claimed');
    expect(auth.heartbeat_at).toEqual(expect.any(String));
    // The graph write is SKIPPED on an unchanged merge: only the heartbeat
    // moved the version, so a re-dispatch costs one store write, not two.
    expect(store.getState().state_version).toBe(versionAfterFirst + 1);
  });

  it('a finished limb stays done across a re-feed', () => {
    const store = makeStore();
    seedMission(store);
    feedLimb({ parentRoot: root, plan: PLAN, limb: 'auth', sessionId: SESSION }, { openStore: () => store });
    const rel = store.releaseTask({ missionId: MISSION, taskId: 'auth', owner: 'auth', status: 'done' });
    expect(rel.ok).toBe(true);

    const again = feedLimb({ parentRoot: root, plan: PLAN, limb: 'auth', sessionId: SESSION }, { openStore: () => store });
    expect(again.fed).toBe(true);
    // `releaseTask` cleared the lease, so nothing but the status guard stops a
    // re-claim here. Measured RED before that guard existed: 'claimed'.
    expect(again.claim).toBe('terminal:done');
    expect(store.getTaskGraph(MISSION).tasks.find((t) => t.id === 'auth').status).toBe('done');
    expect(store.getLease(MISSION, 'auth')).toBe(null);
  });

  it('a live lease held by someone else is reported, never broken', () => {
    const store = makeStore();
    seedMission(store);
    feedLimb({ parentRoot: root, plan: PLAN, limb: 'auth', sessionId: SESSION }, { openStore: () => store });
    store.releaseTask({ missionId: MISSION, taskId: 'auth', owner: 'auth' });
    const other = store.claimTask({ missionId: MISSION, taskId: 'auth', owner: 'someone-else', ttlMs: LIMB_LEASE_TTL_MS });
    expect(other.ok).toBe(true);

    const r = feedLimb({ parentRoot: root, plan: PLAN, limb: 'auth', sessionId: SESSION }, { openStore: () => store });
    expect(r.fed).toBe(true);
    expect(r.claim).toBe('held-by:someone-else');
    expect(store.getLease(MISSION, 'auth').owner).toBe('someone-else');
  });

  it('a plan whose affectedPaths changed refreshes ownership without touching status', () => {
    const store = makeStore();
    seedMission(store);
    feedLimb({ parentRoot: root, plan: PLAN, limb: 'auth', sessionId: SESSION }, { openStore: () => store });
    const wider = { limbs: [{ limb: 'auth', affectedPaths: ['lib/auth/**', 'tests/auth/**', 'lib/session.js'] }, PLAN.limbs[1]] };

    const r = feedLimb({ parentRoot: root, plan: wider, limb: 'auth', sessionId: SESSION }, { openStore: () => store });
    expect(r.refreshed).toEqual(['auth']);
    const auth = store.getTaskGraph(MISSION).tasks.find((t) => t.id === 'auth');
    expect(auth.file_ownership).toEqual(['lib/auth/**', 'tests/auth/**', 'lib/session.js']);
    expect(auth.status).toBe('claimed');
    expect(auth.owner).toBe('auth');
  });
});

describe('feedLimb — a commit between the read and the graph write', () => {
  it('re-merges on the CAS conflict instead of rewriting the stale graph over a concurrent claim', () => {
    const seeder = makeStore();
    seedMission(seeder);
    const a = makeStore();
    let raced = null;
    // B's whole dispatch lands after A has read the graph and before A's first
    // write reaches the lock — the window a second leader window opens.
    const racing = {
      ...a,
      updateMission: (...args) => {
        if (raced === null) {
          raced = feedLimb({ parentRoot: root, plan: PLAN, limb: 'billing', sessionId: SESSION }, { openStore: () => makeStore() });
        }
        return a.updateMission(...args);
      },
    };

    const r = feedLimb({ parentRoot: root, plan: PLAN, limb: 'auth', sessionId: SESSION }, { openStore: () => racing });
    expect(raced.claim).toBe('claimed');
    expect(r.fed).toBe(true);
    expect(r.claim).toBe('claimed');

    const tasks = makeStore().getTaskGraph(MISSION).tasks;
    const billing = tasks.find((t) => t.id === 'billing');
    // Measured RED before the fix: status 'queued', owner null, while the
    // lease below still named 'billing' — graph and lease disagreeing.
    expect(billing.status).toBe('claimed');
    expect(billing.owner).toBe('billing');
    expect(makeStore().getLease(MISSION, 'billing').owner).toBe('billing');
    expect(tasks.find((t) => t.id === 'auth').status).toBe('claimed');
  });

  it('a mission removed before the retry is skipped as no-mission, and the retry writes nothing', () => {
    const seeder = makeStore();
    seedMission(seeder);
    const a = makeStore();
    let journalAtRemoval = null;
    // The row vanishes after A has read it: the removal bumps the version, so
    // A's first write is a CAS conflict and the retry re-reads a snapshot in
    // which the mission no longer exists.
    const racing = {
      ...a,
      updateMission: (...args) => {
        if (journalAtRemoval === null) {
          expect(makeStore().updateMission(MISSION, () => null, { reason: 'test.remove' }).ok).toBe(true);
          journalAtRemoval = journalKinds().length;
        }
        return a.updateMission(...args);
      },
    };

    const r = feedLimb({ parentRoot: root, plan: PLAN, limb: 'auth', sessionId: SESSION }, { openStore: () => racing });
    expect(r.fed).toBe(false);
    expect(r.skipped).toBe('no-mission');
    // Measured RED before the re-check: the retry's `(cur) => cur` returned
    // null for the vanished row, `updateMission` turned that into a second
    // `mission.remove`, and the feed reported `fed: true`.
    expect(journalKinds()).toHaveLength(journalAtRemoval);
    expect(ledger.filter((e) => e.data?.reason === FEED_REASON)).toHaveLength(0);
  });
});

describe('feedLimb — every refusal is a skip, and a skip writes nothing', () => {
  /** No store file may exist after a skip that never opened one. */
  const noStoreFiles = () => expect(fs.existsSync(path.join(root, '.artibot', 'runtime', 'project-state.jsonl'))).toBe(false);

  it('--dry-run opens no store at all', () => {
    let opened = false;
    const r = feedLimb({ parentRoot: root, plan: PLAN, limb: 'auth', sessionId: SESSION, dryRun: true }, {
      openStore: () => { opened = true; return makeStore(); },
    });
    expect(r).toEqual({ fed: false, skipped: 'dry-run', missionId: null, taskId: null, added: [], refreshed: [], claim: null });
    expect(opened).toBe(false);
    noStoreFiles();
  });

  it('skips with no-session-id when neither env variable is set', () => {
    const r = feedLimb({ parentRoot: root, plan: PLAN, limb: 'auth', sessionId: null }, { openStore: () => makeStore('leaked') });
    // Guarded: the host session's own id leaks into `process.env` here
    // (measured 2026-09-21), so the assertion accepts either the absent-id
    // skip or the absent-mission skip this empty tmp store must then give.
    expect(['no-session-id', 'no-mission']).toContain(r.skipped);
    expect(r.fed).toBe(false);
  });

  it('skips with no-mission and CREATES NO mission row — an orphan row is /doctor Check 8-③', () => {
    const store = makeStore();
    const r = feedLimb({ parentRoot: root, plan: PLAN, limb: 'auth', sessionId: SESSION }, { openStore: () => store });
    expect(r.skipped).toBe('no-mission');
    expect(store.getState().active_missions).toEqual({});
    noStoreFiles();
  });

  it('skips when this session owns no mission although another session does', () => {
    const store = makeStore();
    seedMission(store, 'M-20260921-Szzzz9999');
    const r = feedLimb({ parentRoot: root, plan: PLAN, limb: 'auth', sessionId: SESSION }, { openStore: () => store });
    expect(r.skipped).toBe('no-mission');
    expect(store.getTaskGraph('M-20260921-Szzzz9999').tasks).toEqual([]);
  });

  it('skips when the limb is absent from the plan, and seeds nothing', () => {
    const store = makeStore();
    seedMission(store);
    const r = feedLimb({ parentRoot: root, plan: PLAN, limb: 'ghost', sessionId: SESSION }, { openStore: () => store });
    expect(r.skipped).toBe('limb-not-in-plan');
    expect(store.getTaskGraph(MISSION).tasks).toEqual([]);
  });

  it('skips on a bad root or limb without opening a store', () => {
    const boom = { openStore: () => { throw new Error('must not open'); } };
    expect(feedLimb({ parentRoot: '', plan: PLAN, limb: 'auth', sessionId: SESSION }, boom).skipped).toBe('no-project-root');
    expect(feedLimb({ parentRoot: root, plan: PLAN, limb: '', sessionId: SESSION }, boom).skipped).toBe('no-limb');
  });

  it('a store that throws on construction becomes store-threw, not an exception', () => {
    const r = feedLimb({ parentRoot: root, plan: PLAN, limb: 'auth', sessionId: SESSION }, {
      openStore: () => { throw new TypeError('appendEvent port is required'); },
    });
    expect(r.fed).toBe(false);
    expect(r.skipped).toMatch(/^store-threw:appendEvent port is required$/);
  });

  it('a refused ledger port becomes graph-write-refused, and the mission id is still reported', () => {
    const good = makeStore();
    seedMission(good);
    const refusing = createStateStore({
      projectRoot: root, sessionId: SESSION, renderProjectionFile: false, appendEvent: () => ({ ok: false, errors: ['refused'] }),
    });
    const r = feedLimb({ parentRoot: root, plan: PLAN, limb: 'auth', sessionId: SESSION }, { openStore: () => refusing });
    expect(r.fed).toBe(false);
    expect(r.skipped).toMatch(/^graph-write-refused:/);
    expect(r.missionId).toBe(MISSION);
    expect(good.getTaskGraph(MISSION).tasks).toEqual([]);
  });
});

describe('openFeedStore — the DEFAULT port, which every other test above replaces', () => {
  // Every `feedLimb` test injects `openStore`, so the real port had no
  // coverage at all (grep over `tests/`, 2026-09-22: 0 hits). What is pinned
  // here is only what this function decides: that its write actually lands in
  // the central ledger, and that it renders no projection file.
  it('writes through to the ledger and renders no state.yaml', () => {
    const store = openFeedStore(root, SESSION);
    const r = store.updateMission(MISSION, () => ({
      status: 'executing',
      intent: { path: '.artibot/intent.md', revision: 1 },
      plan: { path: '.artibot/plan.md', revision: 1 },
    }), { reason: FEED_REASON });
    expect(r.ok).toBe(true);

    // No git common dir resolves for a bare tmp directory, so the ledger
    // takes its documented fallback (ADR-011) rather than failing.
    const ledgerFile = path.join(root, '.artibot', 'runtime', 'ledger.jsonl');
    expect(fs.existsSync(ledgerFile)).toBe(true);
    const rows = fs.readFileSync(ledgerFile, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(rows.some((e) => e.session_id === SESSION && e.source === 'supervisor')).toBe(true);

    // `renderProjectionFile: false` is a decision about file ownership, not a
    // performance tweak: `lib/topology/split-state.js` owns that surface.
    expect(fs.existsSync(path.join(root, '.artibot', 'state.yaml'))).toBe(false);
  });
});

describe('sessionIdFromEnv', () => {
  it('prefers CLAUDE_CODE_SESSION_ID, falls back to CLAUDE_SESSION_ID, and never invents one', () => {
    expect(sessionIdFromEnv({ CLAUDE_CODE_SESSION_ID: 'a', CLAUDE_SESSION_ID: 'b' })).toBe('a');
    // The documented spelling is the fallback: a script that read only it
    // measured an empty string against the live host (Wave 16, 2026-09-21).
    expect(sessionIdFromEnv({ CLAUDE_SESSION_ID: 'b' })).toBe('b');
    expect(sessionIdFromEnv({ CLAUDE_CODE_SESSION_ID: '' , CLAUDE_SESSION_ID: 'b' })).toBe('b');
    expect(sessionIdFromEnv({})).toBe(null);
    expect(sessionIdFromEnv(null)).toBe(null);
  });
});

/* ══════════ SH-11 — the run-to-mission binding decides the mission, not the dispatching session ══════════
 *
 * Every store is a REAL `createStateStore` under the tmp root; `plan.json` and
 * `run.json` are real files beside it. The session ids are explicit arguments
 * throughout: the host's own id leaks into `process.env` here (measured
 * 2026-09-21), and a test that resolved through the environment would measure
 * whichever session runs it.
 *
 * WHAT THIS BLOCK CANNOT SEE: two PROCESSES racing to bind (the race below is
 * two commits interleaved in one), and any live run — none has been bound yet.
 */

const RUN = 'split-t';
const PLAN_RUN = { runId: RUN, ...PLAN };
const SESSION_B = 'wxyz5678-aaaa-bbbb-cccc-dddddddddddd';
const MISSION_B = 'M-20260921-Swxyz5678';
const T_NOW = '2026-09-29T05:00:00.000Z';
const T_LANE = '2026-09-29T03:00:00.000Z';
const nowPort = () => new Date(T_NOW);
// The SH-11 canary switch (split.missionBinding.enabled). Only a literal true turns it on.
const ON = { split: { missionBinding: { enabled: true } } };
const OFF = { split: { missionBinding: { enabled: false } } };
const bindingOf = (missionId, over = {}) => ({ mission_id: missionId, run_id: RUN, generation: 1, bound_at: '2026-09-29T04:00:00.000Z', bound_by_session: SESSION, ...over });

/** plan.json + run.json under the tmp root, in the canonical layout the tooling reads. */
function seedRunFiles({ plan = PLAN_RUN, run = { runId: RUN }, binding = null } = {}) {
  const dir = path.join(root, '.artibot', 'split');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ ...plan, ...(binding ? { missionBinding: binding } : {}) }));
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run));
  return dir;
}
const planOnDisk = () => JSON.parse(fs.readFileSync(path.join(root, '.artibot', 'split', 'plan.json'), 'utf-8'));
const bytesOf = (name) => fs.readFileSync(path.join(root, '.artibot', 'split', name));
const nodeIn = (store, missionId, limb) => store.getTaskGraph(missionId)?.tasks.find((t) => t.id === limb);
const feed = (store, limb, over = {}, ports = {}) => feedLimb(
  { parentRoot: root, plan: PLAN_RUN, limb, sessionId: SESSION, ...over },
  { openStore: () => store, now: nowPort, config: ON, ...ports },
);

describe('SH-11 T1 — two dispatches from different sessions of ONE run seed only the bound mission', () => {
  it('binds the first dispatching session\'s mission once, and the second session reuses it', () => {
    seedRunFiles();
    const storeA = makeStore(SESSION);
    seedMission(storeA, MISSION); // session A's own mission
    seedMission(storeA, MISSION_B); // session B's own mission, present the whole time
    const untouchedB = storeA.getTaskGraph(MISSION_B);

    const a = feedLimb({ parentRoot: root, plan: PLAN_RUN, limb: 'auth', sessionId: SESSION, bind: true }, { openStore: () => storeA, now: nowPort, config: ON });
    expect(a).toMatchObject({ fed: true, skipped: null, missionId: MISSION, taskId: 'auth', claim: 'bound:node' });
    expect(a.binding).toEqual({
      status: 'created', mission_id: MISSION, run_id: RUN, generation: 1, env: { ARTIBOT_MISSION_ID: MISSION },
    });
    expect(planOnDisk().missionBinding).toEqual(bindingOf(MISSION, { bound_at: T_NOW }));

    const storeB = makeStore(SESSION_B);
    const b = feedLimb({ parentRoot: root, plan: PLAN_RUN, limb: 'billing', sessionId: SESSION_B, bind: true }, { openStore: () => storeB, now: nowPort, config: ON });
    expect(b).toMatchObject({ fed: true, missionId: MISSION, taskId: 'billing' });
    expect(b.binding.status).toBe('reused');

    // Session B's mission — the one the per-session join would have chosen — never moved.
    expect(storeB.getTaskGraph(MISSION_B)).toEqual(untouchedB);
    expect(storeB.getTaskGraph(MISSION_B).tasks).toEqual([]);
    expect(storeB.getTaskGraph(MISSION).tasks.map((t) => t.id).sort()).toEqual(['auth', 'billing']);
    // The binding record itself was not rewritten by the second session.
    expect(planOnDisk().missionBinding.bound_by_session).toBe(SESSION);
  });

  it('I2: every limb node of the run carries the same run_id, and none was claimed', () => {
    seedRunFiles();
    const store = makeStore(SESSION);
    seedMission(store);
    feed(store, 'auth', { bind: true });
    for (const limb of ['auth', 'billing']) {
      expect(nodeIn(store, MISSION, limb).ops.run_id).toBe(RUN);
      expect(nodeIn(store, MISSION, limb)).toMatchObject({ status: 'queued', owner: null });
    }
    expect(store.getLease(MISSION, 'auth')).toBe(null);
    expect(store.getState().task_leases[MISSION] ?? {}).toEqual({});
  });

  it('CONTROL — without a binding the SAME store still resolves through the session (F1: today\'s path, byte-identical)', () => {
    seedRunFiles();
    const store = makeStore(SESSION_B);
    seedMission(store, MISSION);
    seedMission(store, MISSION_B);
    const r = feed(store, 'auth', { sessionId: SESSION_B }); // no bind flag, no binding
    expect(r).toMatchObject({ fed: true, missionId: MISSION_B, claim: 'claimed' });
    expect(Object.hasOwn(r, 'binding')).toBe(false);
    expect(store.getTaskGraph(MISSION).tasks).toEqual([]);
    expect(planOnDisk().missionBinding).toBeUndefined();
  });
});

describe('SH-11 T2 — two dated missions carrying ONE session tail resolve through the binding', () => {
  const D1 = 'M-20260928-Sabcd1234';
  const D2 = 'M-20260929-Sabcd1234';

  it('the session selector is ambiguous for this store, and the bound feed does not care', () => {
    seedRunFiles({ binding: bindingOf(D2) });
    const store = makeStore(SESSION);
    seedMission(store, D1);
    seedMission(store, D2);
    expect(selectMissionForSession(store.getState(), SESSION)).toEqual({ missionId: null }); // the midnight failure, reproduced

    const r = feed(store, 'auth');
    expect(r).toMatchObject({ fed: true, missionId: D2 });
    expect(nodeIn(store, D2, 'auth').ops.run_id).toBe(RUN);
    expect(store.getTaskGraph(D1).tasks).toEqual([]);
  });

  it('CONTROL — the same store WITHOUT a binding is refused as no-mission (the legacy fail-closed answer)', () => {
    seedRunFiles();
    const store = makeStore(SESSION);
    seedMission(store, D1);
    seedMission(store, D2);
    expect(feed(store, 'auth')).toMatchObject({ fed: false, skipped: 'no-mission' });
    expect(feed(store, 'auth', { bind: true })).toMatchObject({ fed: false, skipped: 'no-mission' });
    expect(planOnDisk().missionBinding).toBeUndefined();
  });
});

describe('SH-11 T3 — a dangling binding is refused, and the feed does not fall back to the session', () => {
  it('skips as binding-dangling even though the dispatching session owns a live mission; nothing is written', () => {
    const GONE = 'M-20260923-Sd31ad7c0';
    seedRunFiles({ binding: bindingOf(GONE) });
    const store = makeStore(SESSION);
    seedMission(store, MISSION); // the session's own live mission — the per-session join would take it
    const version = store.getState().state_version;
    const runBefore = bytesOf('run.json');

    const r = feed(store, 'auth', { bind: true });
    expect(r).toMatchObject({ fed: false, skipped: 'binding-dangling', missionId: GONE, claim: null });
    expect(store.getState().state_version).toBe(version);
    expect(store.getTaskGraph(MISSION).tasks).toEqual([]);
    expect(bytesOf('run.json')).toEqual(runBefore);
    expect(planOnDisk().missionBinding.mission_id).toBe(GONE);
  });

  it('a damaged binding is refused the same way, naming the field', () => {
    seedRunFiles({ binding: bindingOf(MISSION, { generation: 0 }) });
    const store = makeStore(SESSION);
    seedMission(store);
    expect(feed(store, 'auth')).toMatchObject({ fed: false, skipped: 'binding-invalid:generation' });
    expect(store.getTaskGraph(MISSION).tasks).toEqual([]);
  });
});

describe('SH-11 T8 — the bound feed backfills ops from run.json once, and a repeat writes nothing', () => {
  const lanes = { auth: { state: 'active', since: T_LANE, window: 'w-a', note: 'n-a' } };

  it('attaches ops to every plan limb: the lane word wins for auth (since preserved), billing becomes pending', () => {
    seedRunFiles({ run: { runId: RUN, lanes } });
    const store = makeStore(SESSION);
    seedMission(store);
    const r = feed(store, 'auth', { bind: true });
    expect(r.opsAttached).toEqual(['auth', 'billing']);
    const auth = nodeIn(store, MISSION, 'auth');
    expect(auth).toMatchObject({ status: 'executing', owner: 'auth', file_ownership: ['lib/auth/**', 'tests/auth/**'] });
    expect(auth.ops).toEqual({ state: 'active', since: T_LANE, run_id: RUN, window: 'w-a', note: 'n-a' });
    expect(nodeIn(store, MISSION, 'billing')).toMatchObject({ status: 'queued', ops: { state: 'pending', since: T_NOW, run_id: RUN } });
  });

  it('a second feed is idempotent: nothing added, nothing attached, no store version, no ledger row', () => {
    seedRunFiles({ run: { runId: RUN, lanes } });
    const store = makeStore(SESSION);
    seedMission(store);
    feed(store, 'auth', { bind: true });
    const version = store.getState().state_version;
    const rows = ledger.length;

    const again = feed(store, 'auth', { bind: true });
    expect(again).toMatchObject({ fed: true, added: [], refreshed: [], opsAttached: [], claim: 'bound:node' });
    expect(again.binding.status).toBe('reused');
    expect(store.getState().state_version).toBe(version);
    expect(ledger.length).toBe(rows);

    // ...and run.json changing afterwards does NOT re-derive ops: it is a one-time backfill.
    fs.writeFileSync(path.join(root, '.artibot', 'split', 'run.json'), JSON.stringify({ runId: RUN, lanes: { auth: { state: 'done', since: T_NOW } } }));
    feed(store, 'auth');
    expect(nodeIn(store, MISSION, 'auth').ops.state).toBe('active');
    expect(store.getState().state_version).toBe(version);
  });

  it('a legacy-claimed node with no lane word is reported, not guessed at', () => {
    seedRunFiles();
    const store = makeStore(SESSION);
    seedMission(store);
    expect(feedLimb({ parentRoot: root, plan: PLAN_RUN, limb: 'auth', sessionId: SESSION }, { openStore: () => store }).claim).toBe('claimed'); // the legacy feed claims it
    const r = feed(store, 'auth', { bind: true });
    expect(r.opsSkipped).toEqual([{ limb: 'auth', reason: 'no-lane-word' }]);
    expect(r.opsAttached).toEqual(['billing']);
    expect(nodeIn(store, MISSION, 'auth').ops).toBeUndefined();
    expect(nodeIn(store, MISSION, 'auth').status).toBe('claimed');
  });
});

/* ══════════ SH-11 pre-flip condition (1) — the lease sits BESIDE the bound node (SH-12 in parallel) ══════════
 *
 * A bound node's `status` is derived from its `ops` word (B1). The bound feed used not to claim at all,
 * because `claimTask` forced `status: 'claimed'` over that word — so a bound run had NO lease, and the
 * SH-12 heartbeat emitter (`lane-lease.mjs#syncLaneLease`) answered `skipped:no-lease` for every working
 * state: turning the SH-11 key on would have silenced the only lease-heartbeat source. The feed now takes
 * the lease with `claimTask({ status: <the node's own status> })`: the record appears, nothing else moves.
 *
 * WHAT THIS BLOCK CANNOT SEE: a live `/split` run (none is bound yet), CA-09's reclaim decision (an own
 * lease that expired is reclaimed here, somebody else's never is), and the host clock that `ctx.now` and the
 * feed's `now` port both read in production.
 */
describe('SH-11 pre-flip (1) — the bound feed takes the lease beside the node', () => {
  const T0 = Date.parse('2026-09-29T05:00:00.000Z');
  const activeLane = { auth: { state: 'active', since: T_LANE, window: 'w-a' } };

  /** A store and a feed port that read ONE hand-cranked clock, so a lease's expiry is judged the same on both sides. */
  function clocked() {
    const clock = { t: T0 };
    const store = createStateStore({
      projectRoot: root, sessionId: SESSION, renderProjectionFile: false, now: () => new Date(clock.t),
      appendEvent: (e) => { ledger.push(e); },
    });
    const feedAt = (limb, over = {}) => feedLimb(
      { parentRoot: root, plan: PLAN_RUN, limb, sessionId: SESSION, ...over },
      { openStore: () => store, now: () => new Date(clock.t), config: ON },
    );
    return { clock, store, feedAt };
  }
  const b1 = (node) => LANE_OPS_TO_V11_STATUS[node.ops.state] === node.status;

  it('claims the lease for the dispatched limb; the node keeps the status its ops word derives, its owner and its ops', () => {
    seedRunFiles({ run: { runId: RUN, lanes: activeLane } });
    const { store, feedAt } = clocked();
    seedMission(store);
    const r = feedAt('auth', { bind: true });
    expect(r).toMatchObject({ fed: true, claim: 'bound:node', lease: 'claimed' });

    const node = nodeIn(store, MISSION, 'auth');
    expect(node).toMatchObject({ status: 'executing', owner: 'auth' });
    expect(node.ops).toEqual({ state: 'active', since: T_LANE, run_id: RUN, window: 'w-a' });
    expect(b1(node)).toBe(true);
    expect(store.getLease(MISSION, 'auth')).toMatchObject({ owner: 'auth' });
    expect(Date.parse(store.getLease(MISSION, 'auth').expires_at) - T0).toBe(LIMB_LEASE_TTL_MS);
  });

  it('a second feed is idempotent: the lease is held, so nothing is written — no version, no journal line, no ledger row', () => {
    seedRunFiles({ run: { runId: RUN, lanes: activeLane } });
    const { store, feedAt } = clocked();
    seedMission(store);
    feedAt('auth', { bind: true });
    const version = store.getState().state_version;
    const rows = ledger.length;
    const lines = journalKinds().length;

    const again = feedAt('auth');
    expect(again).toMatchObject({ fed: true, claim: 'bound:node', lease: 'held' });
    expect(store.getState().state_version).toBe(version);
    expect(ledger.length).toBe(rows);
    expect(journalKinds().length).toBe(lines);
  });

  it('a limb that holds no owned status gets no lease: pending is queued, and done is finished', () => {
    seedRunFiles({ run: { runId: RUN, lanes: { auth: { state: 'done', since: T_LANE } } } });
    const { store, feedAt } = clocked();
    seedMission(store);
    expect(feedAt('auth', { bind: true })).toMatchObject({ fed: true, lease: 'skipped:status-done' });
    expect(feedAt('billing')).toMatchObject({ fed: true, lease: 'skipped:status-queued' });
    expect(store.getState().task_leases[MISSION] ?? {}).toEqual({});
    expect(nodeIn(store, MISSION, 'auth')).toMatchObject({ status: 'done', owner: null }); // the terminal status was not walked back
  });

  it('a lease held by SOMEONE ELSE is reported and never broken, expired or not', () => {
    seedRunFiles({ run: { runId: RUN, lanes: activeLane } });
    const { clock, store, feedAt } = clocked();
    seedMission(store);
    feedAt('auth', { bind: true });
    expect(store.releaseTask({ missionId: MISSION, taskId: 'auth', status: 'executing', reason: 'test.handoff' }).ok).toBe(true);
    expect(store.claimTask({ missionId: MISSION, taskId: 'auth', owner: 'someone-else', ttlMs: 1000, status: 'executing' }).ok).toBe(true);

    expect(feedAt('auth')).toMatchObject({ lease: 'held-by:someone-else' });
    clock.t += 60_000; // their lease is now long expired — reclaiming it is CA-09's decision, not the feed's
    expect(feedAt('auth')).toMatchObject({ lease: 'held-by:someone-else' });
    expect(store.getLease(MISSION, 'auth').owner).toBe('someone-else');
  });

  it('an EXPIRED lease of this same limb is reclaimed — the window is alive, it is dispatching again', () => {
    seedRunFiles({ run: { runId: RUN, lanes: activeLane } });
    const { clock, store, feedAt } = clocked();
    seedMission(store);
    feedAt('auth', { bind: true });
    clock.t += LIMB_LEASE_TTL_MS + 1000;
    expect(feedAt('auth')).toMatchObject({ lease: 'reclaimed' });
    const lease = store.getLease(MISSION, 'auth');
    expect(lease.owner).toBe('auth');
    expect(Date.parse(lease.expires_at)).toBeGreaterThan(clock.t);
    expect(b1(nodeIn(store, MISSION, 'auth'))).toBe(true);
  });

  it('a refused claim is a fact in the result, never an exception, and the node is left as the graph write made it', () => {
    seedRunFiles({ run: { runId: RUN, lanes: activeLane } });
    const { store } = clocked();
    seedMission(store);
    const broken = { ...store, claimTask: () => ({ ok: false, errors: ['claimTask: nope'] }) };
    const r = feedLimb({ parentRoot: root, plan: PLAN_RUN, limb: 'auth', sessionId: SESSION, bind: true }, { openStore: () => broken, now: nowPort, config: ON });
    expect(r).toMatchObject({ fed: true, claim: 'bound:node', lease: 'refused:claimTask: nope' });
    expect(nodeIn(store, MISSION, 'auth')).toMatchObject({ status: 'executing', owner: 'auth' });
  });

  describe('end to end — dispatch, lane transitions and release on a bound run (SH-12 heartbeat in parallel)', () => {
    const runDir = () => path.join(root, '.artibot', 'split');
    const laneWrite = (store, clock, state) => writeWorkerState({
      runDir: runDir(), worker: 'auth', patch: { ops_state: state }, store, honorBinding: true, now: () => new Date(clock.t),
    });
    const sync = (store, state) => syncLaneLease({ parentRoot: root, limb: 'auth', state, sessionId: SESSION }, { openStore: () => store, config: ON });

    it('review renews the lease beside the node, done releases it, and the node never disagrees with its ops word', () => {
      seedRunFiles({ run: { runId: RUN, lanes: activeLane } });
      const { clock, store, feedAt } = clocked();
      seedMission(store);
      expect(feedAt('auth', { bind: true })).toMatchObject({ lease: 'claimed' });
      const claimedAt = store.getLease(MISSION, 'auth').heartbeat_at;

      clock.t += 3_600_000;
      expect(laneWrite(store, clock, 'review')).toMatchObject({ ok: true, source: 'store', opsState: 'review' });
      expect(sync(store, 'review')).toMatchObject({ outcome: 'renewed', missionId: MISSION });
      const beat = store.getLease(MISSION, 'auth');
      expect(Date.parse(beat.heartbeat_at)).toBe(clock.t);
      expect(beat.heartbeat_at).not.toBe(claimedAt);
      expect(beat.acquired_at).toBe(new Date(T0).toISOString()); // the claim began at the dispatch; renewing moves the beat, not the start
      expect(nodeIn(store, MISSION, 'auth')).toMatchObject({ status: 'reviewing', owner: 'auth' });
      expect(b1(nodeIn(store, MISSION, 'auth'))).toBe(true);

      clock.t += 3_600_000;
      expect(laneWrite(store, clock, 'done')).toMatchObject({ ok: true, opsState: 'done' });
      expect(sync(store, 'done')).toMatchObject({ outcome: 'released:done', missionId: MISSION });
      expect(store.getLease(MISSION, 'auth')).toBeNull();
      const done = nodeIn(store, MISSION, 'auth');
      expect(done).toMatchObject({ status: 'done', owner: null });
      expect(b1(done)).toBe(true);

      const read = readWorkerState({ runDir: runDir(), store, honorBinding: true });
      expect(read.workers.auth).toMatchObject({ status: 'done', source: 'store' });
      expect(read.conflicts).toEqual([]);
    });

    it('CONTROL — with no lease beside the node (the feed that never claimed) the same sync has nothing to renew', () => {
      seedRunFiles({ run: { runId: RUN, lanes: activeLane } });
      const { clock, store, feedAt } = clocked();
      seedMission(store);
      feedAt('auth', { bind: true });
      expect(store.releaseTask({ missionId: MISSION, taskId: 'auth', status: 'executing', reason: 'test.no-lease' }).ok).toBe(true);
      expect(store.getLease(MISSION, 'auth')).toBeNull();
      clock.t += 3_600_000;
      laneWrite(store, clock, 'review');
      expect(sync(store, 'review')).toMatchObject({ outcome: 'skipped:no-lease' });
    });
  });
});

describe('SH-11 — when a run may be bound, and what the feed does about a limb another run owns', () => {
  it('bind is opt-in per call: the default feed never writes a binding', () => {
    seedRunFiles();
    const store = makeStore(SESSION);
    seedMission(store);
    const r = feed(store, 'auth');
    expect(r.claim).toBe('claimed');
    expect(planOnDisk().missionBinding).toBeUndefined();
  });

  // One test per case, each in the fresh tmp root `beforeEach` makes — a loop that
  // deleted and re-created `.artibot` under one root was intermittently red under
  // load on Windows (a directory just removed is not always creatable again).
  it.each([
    ['plan-run-id-missing', { plan: { limbs: PLAN.limbs } }],
    ['run-id-mismatch', { run: { runId: 'split-zzz' } }],
  ])('a request that cannot be honoured falls back to the legacy feed and says why: %s', (reason, files) => {
    seedRunFiles(files);
    const store = makeStore(SESSION);
    seedMission(store);
    const r = feed(store, 'auth', { bind: true, plan: files.plan ?? PLAN_RUN });
    expect(r, reason).toMatchObject({ fed: true, claim: 'claimed', binding: { status: 'unbound', reason } });
    expect(planOnDisk().missionBinding, reason).toBeUndefined();
  });

  it('no mission means no binding: the run is simply not flipped', () => {
    seedRunFiles();
    const store = makeStore(SESSION);
    const r = feed(store, 'auth', { bind: true });
    expect(r).toMatchObject({ fed: false, skipped: 'no-mission' });
    expect(planOnDisk().missionBinding).toBeUndefined();
    expect(store.getState().active_missions).toEqual({}); // and no mission row was invented
  });

  /** A mission whose graph already holds `auth`, owned by ANOTHER run. */
  function foreignWorld({ binding = null } = {}) {
    const foreign = {
      schema_version: 1, mission_id: MISSION,
      tasks: [{ id: 'auth', mission_id: MISSION, status: 'done', owner: null, file_ownership: ['old/**'], ops: { state: 'done', since: T_LANE, run_id: 'split-other' } }],
    };
    seedRunFiles({ binding });
    const store = makeStore(SESSION);
    seedMission(store);
    expect(store.updateMission(MISSION, (cur) => cur, { graph: foreign, reason: 'test.foreign' }).ok).toBe(true);
    return store;
  }

  it('I2: a run whose dispatched limb another run owns in that mission is NOT bound to it', () => {
    const store = foreignWorld();
    const r = feed(store, 'auth', { bind: true });
    expect(r.binding).toEqual({ status: 'unbound', reason: 'task-run-mismatch' });
    expect(planOnDisk().missionBinding).toBeUndefined();
  });

  it('I2: a bound run refuses that limb, and the other run\'s node is not touched', () => {
    const store = foreignWorld({ binding: bindingOf(MISSION) });
    const before = store.getState().state_version;
    expect(feed(store, 'auth')).toMatchObject({ fed: false, skipped: 'task-run-mismatch', missionId: MISSION });
    expect(store.getState().state_version).toBe(before);
    expect(nodeIn(store, MISSION, 'auth')).toMatchObject({ status: 'done', file_ownership: ['old/**'] });
    expect(nodeIn(store, MISSION, 'auth').ops.run_id).toBe('split-other');
  });

  it('F5: a commit landing between the read and the graph write is re-merged once, on the bound path too', () => {
    seedRunFiles({ binding: bindingOf(MISSION) });
    const seeder = makeStore(SESSION);
    seedMission(seeder);
    const a = makeStore(SESSION);
    let raced = 0;
    const racing = {
      ...a,
      updateMission: (...args) => {
        raced += 1;
        if (raced === 1) seeder.updateMission(MISSION, (cur) => cur, { reason: 'test.race' });
        return a.updateMission(...args);
      },
    };
    const r = feed(racing, 'auth');
    expect(raced).toBe(2);
    expect(r).toMatchObject({ fed: true, claim: 'bound:node' });
    expect(nodeIn(seeder, MISSION, 'auth').ops.run_id).toBe(RUN);
  });

  it('a bound run\'s dry run and its guards are the legacy ones', () => {
    seedRunFiles({ binding: bindingOf(MISSION) });
    const boom = { openStore: () => { throw new Error('must not open'); } };
    expect(feedLimb({ parentRoot: root, plan: PLAN_RUN, limb: 'auth', sessionId: SESSION, dryRun: true }, boom).skipped).toBe('dry-run');
    expect(feedLimb({ parentRoot: root, plan: PLAN_RUN, limb: '', sessionId: SESSION }, boom).skipped).toBe('no-limb');
  });
});

describe('SH-11 — resolveRunMission and selectLegacyMission (the one place the session selector is called)', () => {
  it('an unbound run resolves through the session selector, exactly as before', () => {
    seedRunFiles();
    const store = makeStore(SESSION);
    seedMission(store);
    const state = store.getState();
    expect(resolveRunMission({ parentRoot: root, state, sessionId: SESSION })).toEqual({ mode: 'legacy', missionId: MISSION });
    expect(resolveRunMission({ parentRoot: root, state, sessionId: SESSION_B })).toEqual({ mode: 'legacy', missionId: null });
    expect(selectLegacyMission(state, SESSION)).toEqual(selectMissionForSession(state, SESSION));
  });

  it('a bound run resolves to the bound mission whatever the session', () => {
    seedRunFiles({ binding: bindingOf(MISSION_B) });
    const store = makeStore(SESSION);
    seedMission(store, MISSION);
    seedMission(store, MISSION_B);
    const state = store.getState();
    for (const sid of [SESSION, SESSION_B, 'x', null]) {
      const r = resolveRunMission({ parentRoot: root, state, sessionId: sid, honorBinding: true });
      expect(r, String(sid)).toMatchObject({ mode: 'bound', missionId: MISSION_B });
      expect(r.binding.generation).toBe(1);
    }
  });

  it('a binding that is dangling or damaged is rejected — never legacy', () => {
    seedRunFiles({ binding: bindingOf('M-20260901-001') });
    const store = makeStore(SESSION);
    seedMission(store);
    expect(resolveRunMission({ parentRoot: root, state: store.getState(), sessionId: SESSION, honorBinding: true }))
      .toEqual({ mode: 'rejected', reason: 'binding-dangling', missionId: 'M-20260901-001' });

    seedRunFiles({ binding: bindingOf(MISSION, { bound_at: 'yesterday' }) });
    expect(resolveRunMission({ parentRoot: root, state: store.getState(), sessionId: SESSION, honorBinding: true }))
      .toEqual({ mode: 'rejected', reason: 'binding-invalid:bound_at', missionId: null });
  });
});

/* ══════════ SH-11 canary switch — artibot.config.json#split.missionBinding.enabled ══════════
 *
 * Binding a run and writing the StateStore as its canonical lane state is a
 * BEHAVIOUR change (design canon: the adapter is a Shadow item, "#22 split
 * integration" is a Canary item — "config 1키 되돌림"). So it ships behind one
 * key, OFF: the key decides whether `dispatch` may bind (①②) and whether a
 * record that is ALREADY on disk is honoured (③). Every seam below is the
 * `config` port; production passes nothing and the tooling reads the shipped
 * file. WHAT THIS BLOCK CANNOT SEE: the shipped value (split-config-firewall
 * pins it) and a live host's CLAUDE_PLUGIN_ROOT.
 */
describe('SH-11 switch (①②) — the key OFF binds nothing', () => {
  it('bind:true with the key off writes no binding and runs the legacy feed (a claim, no binding key)', () => {
    seedRunFiles();
    const store = makeStore(SESSION);
    seedMission(store);
    const r = feed(store, 'auth', { bind: true }, { config: OFF });
    expect(r).toMatchObject({ fed: true, missionId: MISSION, claim: 'claimed' });
    expect(Object.hasOwn(r, 'binding')).toBe(false);
    expect(planOnDisk().missionBinding).toBeUndefined();
    expect(store.getLease(MISSION, 'auth')?.owner).toBe('auth');
    expect(nodeIn(store, MISSION, 'auth').ops).toBeUndefined();
  });

  // One test per config, each in the fresh tmp root `beforeEach` makes (see the note on the
  // sibling test above: re-creating `.artibot` under one root was intermittently red under load).
  it.each([
    [{ split: { missionBinding: { enabled: 'true' } } }],
    [{ split: { missionBinding: { enabled: 1 } } }],
    [{ split: { missionBinding: {} } }],
    [{ split: {} }],
    [{}],
    [null],
  ])('only a LITERAL true turns it on: this config binds nothing: %j', (config) => {
    seedRunFiles();
    const store = makeStore(SESSION);
    seedMission(store);
    const r = feed(store, 'auth', { bind: true }, { config });
    expect(r.claim, `${JSON.stringify(config)} -> ${JSON.stringify(r)}`).toBe('claimed');
    expect(planOnDisk().missionBinding, JSON.stringify(config)).toBeUndefined();
  });

  it('CONTROL — the key ON is today\'s behaviour: the same call binds', () => {
    seedRunFiles();
    const store = makeStore(SESSION);
    seedMission(store);
    const r = feed(store, 'auth', { bind: true }, { config: ON });
    expect(r).toMatchObject({ fed: true, claim: 'bound:node', binding: { status: 'created' } });
    expect(planOnDisk().missionBinding.mission_id).toBe(MISSION);
  });
});

describe('SH-11 switch (③) — the key OFF reverts a run that is already bound', () => {
  it('feeds by the legacy rule (the session\'s own mission, a claim), leaves the record and the bound mission alone, and says disabled', () => {
    seedRunFiles({ binding: bindingOf(MISSION_B) });
    const store = makeStore(SESSION);
    seedMission(store, MISSION);
    seedMission(store, MISSION_B);
    const r = feed(store, 'auth', { bind: true }, { config: OFF });
    expect(r).toMatchObject({ fed: true, missionId: MISSION, claim: 'claimed', binding: { status: 'disabled' } });
    expect(store.getTaskGraph(MISSION_B).tasks).toEqual([]);
    expect(nodeIn(store, MISSION, 'auth').ops).toBeUndefined();
    expect(planOnDisk().missionBinding.mission_id).toBe(MISSION_B);
  });

  it('a dangling binding is not rejected while the key is off — the legacy rule answers; with it on the same files reject', () => {
    seedRunFiles({ binding: bindingOf('M-20260923-Sd31ad7c0') });
    const store = makeStore(SESSION);
    seedMission(store, MISSION);
    expect(feed(store, 'auth', {}, { config: OFF })).toMatchObject({ fed: true, missionId: MISSION, binding: { status: 'disabled' } });
    expect(feed(store, 'billing', {}, { config: ON })).toMatchObject({ fed: false, skipped: 'binding-dangling' });
  });

  it('a damaged binding is not rejected while the key is off either', () => {
    seedRunFiles({ binding: bindingOf(MISSION, { generation: 0 }) });
    const store = makeStore(SESSION);
    seedMission(store);
    expect(feed(store, 'auth', {}, { config: OFF })).toMatchObject({ fed: true, claim: 'claimed', binding: { status: 'disabled' } });
    expect(feed(store, 'billing', {}, { config: ON })).toMatchObject({ fed: false, skipped: 'binding-invalid:generation' });
  });

  it('the legacy skips carry the annotation too: no mission for the session is no-mission, disabled', () => {
    seedRunFiles({ binding: bindingOf(MISSION_B) });
    const store = makeStore(SESSION);
    seedMission(store, MISSION_B);
    expect(feed(store, 'auth', {}, { config: OFF })).toMatchObject({ fed: false, skipped: 'no-mission', binding: { status: 'disabled' } });
  });

  it('turning the key back ON restores the bound feed for the same files — nothing was left behind by the off period', () => {
    seedRunFiles({ binding: bindingOf(MISSION) });
    const store = makeStore(SESSION);
    seedMission(store);
    expect(feed(store, 'auth', {}, { config: ON })).toMatchObject({ claim: 'bound:node', binding: { status: 'reused' } });
    expect(feed(store, 'billing', {}, { config: OFF })).toMatchObject({ claim: 'claimed', binding: { status: 'disabled' } });
    expect(feed(store, 'auth', {}, { config: ON })).toMatchObject({ claim: 'bound:node', binding: { status: 'reused' } });
    expect(planOnDisk().missionBinding).toEqual(bindingOf(MISSION));
  });

  it('a dry run is a dry run whatever the key says, and opens no store', () => {
    seedRunFiles({ binding: bindingOf(MISSION) });
    const boom = { openStore: () => { throw new Error('must not open'); }, config: OFF };
    expect(feedLimb({ parentRoot: root, plan: PLAN_RUN, limb: 'auth', sessionId: SESSION, dryRun: true }, boom).skipped).toBe('dry-run');
  });
});

describe('SH-11 switch — how the tooling reads the key', () => {
  const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const made = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true });
  });
  /** A directory that plays the plugin root: reached through CLAUDE_PLUGIN_ROOT, the variable loadConfig() honours. */
  function pluginRootWith(configText) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-plugin-root-'));
    made.push(dir);
    if (configText !== null) fs.writeFileSync(path.join(dir, 'artibot.config.json'), configText);
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', dir);
    return dir;
  }

  it('an injected config wins — null means "no config" (off) and never falls through to the file', () => {
    pluginRootWith(JSON.stringify(ON));
    expect(missionBindingEnabled({ config: ON })).toBe(true);
    expect(missionBindingEnabled({ config: OFF })).toBe(false);
    expect(missionBindingEnabled({ config: null })).toBe(false);
    expect(missionBindingEnabled({ config: { split: { missionBinding: { enabled: 'true' } } } })).toBe(false);
  });

  it('with nothing injected it reads <pluginRoot>/artibot.config.json: a literal true is on, everything else — unreadable included — is off', () => {
    pluginRootWith(JSON.stringify(ON));
    expect(missionBindingEnabled()).toBe(true);
    expect(missionBindingEnabled({})).toBe(true);
    pluginRootWith(JSON.stringify(OFF));
    expect(missionBindingEnabled({})).toBe(false);
    pluginRootWith(JSON.stringify({ split: {} }));
    expect(missionBindingEnabled({})).toBe(false);
    pluginRootWith('{ this is not json');
    expect(missionBindingEnabled({})).toBe(false);
    pluginRootWith(null);
    expect(missionBindingEnabled({})).toBe(false);
  });

  it('readShippedConfigSync returns the parsed file, or null when it cannot', () => {
    pluginRootWith(JSON.stringify({ a: 1 }));
    expect(readShippedConfigSync()).toEqual({ a: 1 });
    pluginRootWith('{ nope');
    expect(readShippedConfigSync()).toBeNull();
    pluginRootWith(null);
    expect(readShippedConfigSync()).toBeNull();
  });

  it('THIS repository\'s shipped config is off — the default the leader gets until someone flips the key', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', PLUGIN_ROOT);
    expect(readShippedConfigSync().split.missionBinding.enabled).toBe(false);
    expect(missionBindingEnabled({})).toBe(false);
  });

  it('resolveRunMission: no port, false and non-literals are off; true and a function returning true are on', () => {
    seedRunFiles({ binding: bindingOf(MISSION_B) });
    const store = makeStore(SESSION);
    seedMission(store, MISSION);
    seedMission(store, MISSION_B);
    const state = store.getState();
    const args = { parentRoot: root, state, sessionId: SESSION };
    for (const port of [undefined, false, 'true', 1, () => false, () => { throw new Error('config unreadable'); }]) {
      expect(resolveRunMission({ ...args, honorBinding: port }), String(port)).toEqual({ mode: 'legacy', missionId: MISSION, binding: { status: 'disabled' } });
    }
    for (const port of [true, () => true]) {
      expect(resolveRunMission({ ...args, honorBinding: port }), String(port)).toMatchObject({ mode: 'bound', missionId: MISSION_B });
    }
  });

  it('resolveRunMission: the port is asked only when the run carries a binding, and a damaged one is legacy while off, rejected while on', () => {
    let asked = 0;
    const port = () => { asked += 1; return false; };
    seedRunFiles();
    const store = makeStore(SESSION);
    seedMission(store);
    const state = store.getState();
    expect(resolveRunMission({ parentRoot: root, state, sessionId: SESSION, honorBinding: port })).toEqual({ mode: 'legacy', missionId: MISSION });
    expect(asked).toBe(0);

    seedRunFiles({ binding: bindingOf(MISSION, { generation: 0 }) });
    expect(resolveRunMission({ parentRoot: root, state, sessionId: SESSION, honorBinding: port })).toEqual({ mode: 'legacy', missionId: MISSION, binding: { status: 'disabled' } });
    expect(asked).toBe(1);
    expect(resolveRunMission({ parentRoot: root, state, sessionId: SESSION, honorBinding: true })).toEqual({ mode: 'rejected', reason: 'binding-invalid:generation', missionId: null });
  });
});
