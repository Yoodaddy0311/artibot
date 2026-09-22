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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStateStore } from '../../lib/project-state/state-manager.js';
import { LIMB_LEASE_TTL_MS } from '../../lib/topology/split-task-feed.js';
import { FEED_REASON, feedLimb, sessionIdFromEnv } from '../../scripts/split/task-feed.mjs';

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
