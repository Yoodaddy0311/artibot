/**
 * `scripts/split/lease-tick.mjs` — the lane-lease WRITER: the heartbeat that
 * keeps a live lane's lease alive (SH-12) and the release of ids a human
 * confirmed (CA-09). `watch.mjs` stays S0 and only lists.
 *
 * Root cause this closes: a `/split` lane lease (`task-feed.mjs` claims it at
 * dispatch, 24h TTL) was renewed only at a moment the leader declares —
 * `lane-state` (`lane-lease.mjs#syncLaneLease`) and a re-dispatch
 * (`task-feed.mjs#claimLimb`) — never on a clock, and a lapsed lease was never
 * looked at.
 *
 * What is measured, against a REAL StateStore in a tmp dir with a fake clock:
 *  - cadence: no write before min(ttl/3, 45 min), one at it, a renewal
 *    restarts the clock, 48h of polls every 15 minutes renew exactly 64 times
 *    and the lease never lapses, the TTL does not grow (SP-05), and a poll is
 *    not a write — the ledger gains a row per RENEWAL only;
 *  - a tick is distinguishable from the lane-state emitter: its own
 *    `heartbeat_source` (`lease-tick`) and ledger reason (`split.lease-tick`);
 *  - who is renewed: only a lane with POSITIVE liveness evidence (ADV-4 — a
 *    live lock pid, or lane-state activity inside the TTL window); a lane that
 *    ages out stops being renewed and its lease lapses into the report; a
 *    suspended lane is held back, not renewed (ADV-3); `done` is never
 *    RELEASED from here;
 *  - `--apply-reclaim` takes EXPLICIT ids (ADV-1): no list, or one bad id,
 *    refuses the whole run (exit 1, nothing read or written); only the listed
 *    ids are released, never a rescan-and-release-all;
 *  - fail-open and transparent: no session id, a throwing store, a foreign
 *    holder, no lease — each is an outcome string, never an exception.
 *
 * The real wiring (a locked worktree, child processes, the real ledger writer)
 * is in `lease-tick-wiring.test.js`.
 *
 * What it cannot see (rules §9): a live leader session (the legacy mission
 * rule is per session, so a leader restart reads `skipped:no-mission` — ADV-1b,
 * reported, not fixed), pid reuse, a wall-clock wait, a bound run (SH-11 canary
 * ON: the bound feeder never claims, so the honest outcome there is
 * `skipped:no-lease`). Fixtures hold a few lanes; a store with thousands of
 * journal records is not exercised.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStateStore } from '../../lib/project-state/state-manager.js';
import {
  classifyLaneLiveness,
  findReclaimCandidates,
  HEARTBEAT_MAX_INTERVAL_MS,
  LEASE_RECLAIM_REASON,
  LEASE_TICK_REASON,
  LEASE_TICK_SOURCE,
} from '../../lib/topology/lease-reclaim.js';
import { LIMB_LEASE_TTL_MS } from '../../lib/topology/split-task-feed.js';
import { LANE_LEASE_REASON, syncLaneLease } from '../../scripts/split/lane-lease.mjs';
import { feedLimb } from '../../scripts/split/task-feed.mjs';
import {
  applyLeaseReclaim,
  main,
  parseArgs,
  renderTickLines,
  renewLaneHeartbeats,
  tick,
} from '../../scripts/split/lease-tick.mjs';
import { usePatientRename } from '../helpers/patient-rename.js';

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
    { limb: 'carol', affectedPaths: ['lib/carol.js'] },
  ],
};
const idOf = (task) => `${MISSION}/${task}`;
const iso = (ms) => new Date(ms).toISOString();

/** A `watch.mjs#collect` lane; the default is a working lane with a live lock pid. */
const lane = (over = {}) => ({
  limb: 'auth', opsState: 'active', complete: false, sessionPresent: true, health: { health: 'unknown' }, opsUpdatedAt: null, ...over,
});

// Hundreds of real store commits in tight loops: wait out the Windows EPERM-on-rename that outlasts core's ~150ms retry (tests/helpers/patient-rename.js).
usePatientRename();

describe('parseArgs — the flags of a writer are strict', () => {
  it('defaults: cwd as the parent, no ids (so no apply)', () => {
    const a = parseArgs([]);
    expect(a).toMatchObject({ json: false, runId: null, storeDir: undefined });
    expect(a.parent).toBe(path.resolve(process.cwd()));
    expect('applyIds' in a).toBe(false);
  });

  it('takes the watch flags', () => {
    const a = parseArgs(['--json', '--run-id', 'r1', '--parent', 'C:/p', '--store-dir', 'C:/s']);
    expect(a).toMatchObject({ json: true, runId: 'r1', parent: path.resolve('C:/p'), storeDir: path.resolve('C:/s') });
  });

  it('ADV-1: --apply-reclaim takes a comma list and may repeat; ids are validated, deduplicated, in order', () => {
    expect(parseArgs(['--apply-reclaim', `${idOf('auth')},${idOf('billing')}`]).applyIds).toEqual([idOf('auth'), idOf('billing')]);
    expect(parseArgs(['--apply-reclaim', idOf('auth'), '--apply-reclaim', `${idOf('billing')},${idOf('auth')}`]).applyIds).toEqual([idOf('auth'), idOf('billing')]);
    expect(parseArgs(['--apply-reclaim', ` ${idOf('auth')} , `]).applyIds).toEqual([idOf('auth')]);
  });

  it('ADV-1: --apply-reclaim with no list, an empty list, another flag as its value, or one bad id is REFUSED — no release-all', () => {
    expect(() => parseArgs(['--apply-reclaim'])).toThrow(/requires/);
    expect(() => parseArgs(['--apply-reclaim', '--json'])).toThrow(/requires/);
    expect(() => parseArgs(['--apply-reclaim', ''])).toThrow(/non-empty list/);
    expect(() => parseArgs(['--apply-reclaim', ',,'])).toThrow(/non-empty list/);
    expect(() => parseArgs(['--apply-reclaim', `${idOf('auth')},auth`])).toThrow(/not a <mission>\/<task> id: auth/);
    expect(() => parseArgs(['--apply-reclaim', 'all'])).toThrow(/not a <mission>\/<task> id: all/);
  });

  it('refuses an unknown option, a positional, and a flag missing its value (an action tool does not guess)', () => {
    expect(() => parseArgs(['--force'])).toThrow(/unknown option: --force/);
    expect(() => parseArgs(['--no-heartbeat'])).toThrow(/unknown option/); // a tick IS the heartbeat
    expect(() => parseArgs(['auth'])).toThrow(/unexpected argument/);
    expect(() => parseArgs(['--parent'])).toThrow(/requires a value/);
    expect(() => parseArgs(['--run-id', '--json'])).toThrow(/requires a value/);
  });

  it('--help', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });
});

describe('renewLaneHeartbeats — cadence with a fake clock, against a real store', () => {
  let root;
  /** @type {object[]} */ let ledger;
  let clock;
  let store;
  let opened;

  function makeStore() {
    return createStateStore({
      projectRoot: root,
      sessionId: SESSION,
      renderProjectionFile: false,
      now: () => clock,
      resolveGitCommonDir: () => path.join(root, '.git'),
      appendEvent: (e) => void ledger.push(e),
    });
  }

  function seedMission(s) {
    const r = s.updateMission(MISSION, () => ({
      status: 'executing',
      intent: { path: '.artibot/intent.md', revision: 1 },
      plan: { path: '.artibot/plan.md', revision: 1 },
    }), { reason: 'test.seed' });
    expect(r.ok).toBe(true);
  }

  const feed = (limb = 'auth') => feedLimb({ parentRoot: root, plan: PLAN, limb, sessionId: SESSION }, { openStore: () => store, config: OFF });
  const at = (ms) => { clock = new Date(ms); return ms; };
  const ports = (over = {}) => ({ openStore: () => { opened += 1; return store; }, sessionId: SESSION, config: OFF, ...over });
  const poll = (lanes = [lane()], over = {}) => renewLaneHeartbeats({ parent: root, lanes, nowMs: clock.getTime(), ports: ports(over) });
  const updates = () => ledger.filter((e) => e.event === 'state.updated');
  const task = (limb = 'auth') => store.getTaskGraph(MISSION).tasks.find((t) => t.id === limb);
  const outcome = (r, limb = 'auth') => r.lanes.find((l) => l.limb === limb).outcome;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-lease-tick-'));
    const dir = path.join(root, '.artibot', 'split');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(PLAN));
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ runId: 'split-lt' }));
    ledger = [];
    opened = 0;
    clock = new Date(T0);
    store = makeStore();
    seedMission(store);
    expect(feed('auth').claim).toBe('claimed');
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

  it('the fixture is what it claims: the real feeder took a 24h lease at T0 and nothing has renewed it', () => {
    const lease = store.getLease(MISSION, 'auth');
    expect(lease.heartbeat_at).toBe('2026-09-30T00:00:00.000Z');
    expect(Date.parse(lease.expires_at) - Date.parse(lease.heartbeat_at)).toBe(LIMB_LEASE_TTL_MS);
    expect(task().heartbeat_at).toBeUndefined();
    expect(HEARTBEAT_MAX_INTERVAL_MS).toBe(45 * MIN);
  });

  it('writes NOTHING before 45 minutes: polls at 15, 30 and 44m59s are skipped:not-due, with the numbers a human needs', () => {
    const before = store.getState().state_version;
    const events = ledger.length;
    for (const ms of [15 * MIN, 30 * MIN, 45 * MIN - 1]) {
      at(T0 + ms);
      const r = poll();
      expect(outcome(r), String(ms)).toBe('skipped:not-due');
      expect(r.lanes[0].detail).toMatchObject({ reason: 'fresh', ageMs: ms, intervalMs: 45 * MIN, ttlMs: 24 * H });
      expect(r.renewed).toBe(0);
    }
    expect(store.getState().state_version).toBe(before);
    expect(ledger.length).toBe(events);
  });

  it('renews at exactly 45 minutes through syncLaneLease: one commit, stamped as a tick — heartbeat_source lease-tick, reason split.lease-tick', () => {
    const events = updates().length;
    at(T0 + 45 * MIN);

    const r = poll();

    expect(outcome(r)).toBe('renewed');
    expect(r).toMatchObject({ available: true, renewable: 1, renewed: 1 });
    expect(r.lanes[0]).toMatchObject({ missionId: MISSION, working: true, renew: true, evidence: 'session-alive' });
    const lease = store.getLease(MISSION, 'auth');
    expect(lease.heartbeat_at).toBe(iso(T0 + 45 * MIN));
    expect(lease.expires_at).toBe(iso(T0 + 45 * MIN + 24 * H));
    expect(lease.acquired_at).toBe('2026-09-30T00:00:00.000Z');
    expect(task().heartbeat_at).toBe(iso(T0 + 45 * MIN));
    expect(task().heartbeat_source).toBe(LEASE_TICK_SOURCE);
    expect(task().heartbeat_source).toBe('lease-tick');
    expect(task().status).toBe('claimed');
    expect(updates().length).toBe(events + 1);
    expect(updates().at(-1).data.reason).toBe(LEASE_TICK_REASON);
    expect(new Set(ledger.map((e) => e.event))).toEqual(new Set(['state.updated'])); // no new event name
  });

  it('a tick is told apart from the lane-state emitter by BOTH the source and the ledger reason', () => {
    at(T0 + 45 * MIN);
    expect(outcome(poll())).toBe('renewed');
    expect(task().heartbeat_source).toBe('lease-tick');
    const tickRows = updates().filter((e) => e.data.reason === LEASE_TICK_REASON).length;

    // The lane-state path (lane-lease.mjs) still stamps what it always did.
    at(T0 + 50 * MIN);
    expect(syncLaneLease({ parentRoot: root, limb: 'auth', state: 'active', sessionId: SESSION }, { openStore: () => store, config: OFF }).outcome).toBe('renewed');
    expect(task().heartbeat_source).toBe('lane-heartbeat');
    expect(updates().at(-1).data.reason).toBe(LANE_LEASE_REASON);
    expect(updates().filter((e) => e.data.reason === LEASE_TICK_REASON)).toHaveLength(tickRows);
    expect(LANE_LEASE_REASON).not.toBe(LEASE_TICK_REASON);
  });

  it('a renewal restarts the clock: the next poll a minute on is not due, the next is due 45 minutes on', () => {
    at(T0 + 45 * MIN);
    expect(outcome(poll())).toBe('renewed');
    at(T0 + 46 * MIN);
    expect(outcome(poll())).toBe('skipped:not-due');
    at(T0 + 90 * MIN - 1);
    expect(outcome(poll())).toBe('skipped:not-due');
    at(T0 + 90 * MIN);
    expect(outcome(poll())).toBe('renewed');
  });

  it('48h of polls every 15 minutes: exactly 64 renewals, never a per-poll write, the lease never lapses, the TTL never grows', () => {
    const renewedAt = [];
    for (let i = 1; i <= 192; i += 1) {
      const now = at(T0 + i * 15 * MIN);
      if (outcome(poll()) === 'renewed') renewedAt.push((now - T0) / H);
      const lease = store.getLease(MISSION, 'auth');
      expect(Date.parse(lease.expires_at), `poll ${i}: the lease must still be live`).toBeGreaterThan(now);
      expect(Date.parse(lease.expires_at) - Date.parse(lease.heartbeat_at), `poll ${i}: ttl`).toBe(24 * H);
    }
    expect(renewedAt).toEqual(Array.from({ length: 64 }, (_, k) => (k + 1) * 0.75));
    // The fixture's own rows — mission seed, the feeder's graph merge, the claim — are not ticks; the tick rows are exactly the 64.
    expect(updates().filter((e) => e.data.reason === LEASE_TICK_REASON)).toHaveLength(64);
    expect(updates()).toHaveLength(3 + 64);
  });

  it('a lapsed lease on a lane with liveness evidence is renewed back, not left to lapse', () => {
    at(T0 + 30 * H); // six hours past expires_at
    const r = poll();
    expect(outcome(r)).toBe('renewed');
    expect(r.lanes[0].detail).toMatchObject({ expired: true });
    expect(store.getLease(MISSION, 'auth').heartbeat_at).toBe(iso(T0 + 30 * H));
  });

  it('every working state renews a due lease (closing and serial-gate included)', () => {
    for (const [i, state] of ['active', 'review', 'serial-gate', 'closing'].entries()) {
      at(T0 + (i + 1) * 45 * MIN);
      expect(outcome(poll([lane({ opsState: state })])), state).toBe('renewed');
    }
  });

  it('ADV-4: no lock line and no lane-state time — the word `active` alone is NOT evidence: no renewal, no store opened', () => {
    at(T0 + 2 * H);
    const before = store.getState().state_version;
    const r = poll([lane({ sessionPresent: null, opsUpdatedAt: null })]);
    expect(outcome(r)).toBe('skipped:no-liveness-evidence');
    expect(r.lanes[0]).toMatchObject({ working: true, renew: false, evidence: null });
    expect(r).toMatchObject({ renewable: 0, renewed: 0 });
    expect(store.getState().state_version).toBe(before);
    expect(opened).toBe(0);
  });

  it('ADV-4: fresh lane-state activity is evidence; the same lane with a stale stamp is not', () => {
    at(T0 + 2 * H);
    expect(outcome(poll([lane({ sessionPresent: null, opsUpdatedAt: iso(T0 + 1 * H) })]))).toBe('renewed');
    at(T0 + 4 * H);
    const stale = iso(T0 + 4 * H - LIMB_LEASE_TTL_MS - 1);
    expect(outcome(poll([lane({ sessionPresent: null, opsUpdatedAt: stale })]))).toBe('skipped:no-liveness-evidence');
  });

  it('ADV-4: a lane is renewed while the leader\'s last lane-state touch is inside the TTL window, then STOPS — and its lease lapses into the report', () => {
    const laneSeen = () => lane({ sessionPresent: null, opsUpdatedAt: iso(T0) }); // touched once at T0, never again
    let renewals = 0;
    let lastRenewalH = null;
    for (let i = 1; i <= 49 * 4; i += 1) {
      const now = at(T0 + i * 15 * MIN);
      if (outcome(poll([laneSeen()])) === 'renewed') { renewals += 1; lastRenewalH = (now - T0) / H; }
    }
    expect(renewals).toBe(32); // 45 min ... 24h, every 45 minutes
    expect(lastRenewalH).toBe(24); // the last multiple of 45 minutes inside the 24h window (age == window still counts)
    expect(store.getLease(MISSION, 'auth').heartbeat_at).toBe(iso(T0 + 24 * H));

    // T0 + 49h: renewed last at T0 + 24h with a 24h TTL, so the lease lapsed an hour ago.
    const nowMs = clock.getTime();
    expect(classifyLaneLiveness(laneSeen(), { nowMs })).toMatchObject({ renew: false, keepAlive: false, reason: 'no-liveness-evidence' });
    const report = findReclaimCandidates({ state: store.getState(), nowMs, keepAlive: [] });
    expect(report.candidates.map((c) => c.id)).toEqual([idOf('auth')]);
    expect(report.candidates[0]).toMatchObject({ expiredForMs: H, heartbeatSource: 'lease-tick' });
  });

  it('ADV-3: a suspended lane is not renewed (no store opened), its lease may lapse, and it is HELD BACK from the report', () => {
    at(T0 + 30 * H); // past expires_at
    const suspended = lane({ opsState: 'suspended', sessionPresent: false });
    const r = poll([suspended]);
    expect(outcome(r)).toBe('skipped:ops-state:suspended');
    expect(r.lanes[0]).toMatchObject({ working: false, renew: false });
    expect(opened).toBe(0);
    const nowMs = clock.getTime();
    const keep = classifyLaneLiveness(suspended, { nowMs }).keepAlive ? ['auth'] : [];
    const report = findReclaimCandidates({ state: store.getState(), nowMs, keepAlive: keep });
    expect(report.candidates).toEqual([]);
    expect(report.protected.map((p) => p.id)).toEqual([idOf('auth')]);
  });

  it('NOT renewed, and NOT released either: a non-working state with a due lease changes nothing (done is lane-state\'s release, not the tick\'s)', () => {
    at(T0 + 30 * H);
    const version = store.getState().state_version;
    const events = ledger.length;
    for (const state of ['pending', 'awaiting-dispatch', 'done', 'failed']) {
      const r = poll([lane({ opsState: state })]);
      expect(outcome(r), state).toBe(`skipped:ops-state:${state}`);
      expect(r.renewed).toBe(0);
    }
    expect(store.getState().state_version).toBe(version);
    expect(ledger.length).toBe(events);
    expect(store.getLease(MISSION, 'auth')?.owner).toBe('auth');
    expect(task().status).toBe('claimed');
    expect(opened, 'no renewable lane → no store opened at all').toBe(0);
  });

  it('a finished lane (trailer complete, supervisor DONE) and a dead session are not renewed; no store is opened', () => {
    at(T0 + 30 * H);
    const version = store.getState().state_version;
    const r = poll([
      lane({ limb: 'auth', opsState: 'closing', complete: true }),
      lane({ limb: 'billing', opsState: 'active', health: { health: 'done' } }),
      lane({ limb: 'third', opsState: 'active', sessionPresent: false }),
    ]);
    expect(r.lanes.map((l) => [l.limb, l.outcome])).toEqual([
      ['auth', 'skipped:lane-complete'],
      ['billing', 'skipped:lane-state-done'],
      ['third', 'skipped:session-absent'],
    ]);
    expect(r.renewable).toBe(0);
    expect(store.getState().state_version).toBe(version);
    expect(opened).toBe(0);
  });

  it('no lease → skipped:no-lease; a lease held by someone else is reported and never renewed', () => {
    // billing is claimed by the feeder, then its lease is dropped: a working lane that holds no lease.
    feed('billing');
    store.releaseTask({ missionId: MISSION, taskId: 'billing', owner: 'billing', status: 'queued' });
    at(T0 + 1 * H);
    expect(outcome(poll([lane({ limb: 'billing' })]), 'billing')).toBe('skipped:no-lease');

    store.releaseTask({ missionId: MISSION, taskId: 'auth', owner: 'auth', status: 'queued' });
    expect(store.claimTask({ missionId: MISSION, taskId: 'auth', owner: 'intruder', ttlMs: 24 * H }).ok).toBe(true);
    at(T0 + 3 * H);
    const before = store.getState().state_version;
    expect(outcome(poll())).toBe('held-by:intruder');
    expect(store.getState().state_version).toBe(before);
    expect(store.getLease(MISSION, 'auth').owner).toBe('intruder');
  });

  it('two due lanes are both renewed, one commit each', () => {
    feed('billing');
    const events = updates().length;
    at(T0 + 45 * MIN);
    const r = poll([lane({ limb: 'auth' }), lane({ limb: 'billing' })]);
    expect(r.lanes.map((l) => l.outcome)).toEqual(['renewed', 'renewed']);
    expect(r.renewed).toBe(2);
    expect(updates().length).toBe(events + 2);
  });

  it('no session id → available:false, the renewable lane says skipped:no-session-id, and no store is opened', () => {
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', '');
    vi.stubEnv('CLAUDE_SESSION_ID', '');
    at(T0 + 2 * H);
    const version = store.getState().state_version;
    const r = poll([lane()], { sessionId: '' });
    expect(r).toMatchObject({ available: false, reason: 'no-session-id', renewable: 1, renewed: 0 });
    expect(outcome(r)).toBe('skipped:no-session-id');
    expect(opened).toBe(0);
    expect(store.getState().state_version).toBe(version);
  });

  it('ADV-1b: after a leader restart (a new session id owns no mission row) the renewal says skipped:no-mission — reported, nothing written', () => {
    at(T0 + 2 * H);
    const before = store.getState().state_version;
    const r = poll([lane()], { sessionId: 'ffff0000-ef56-7890-1234-567890abcdef' });
    expect(outcome(r)).toBe('skipped:no-mission');
    expect(r.renewed).toBe(0);
    expect(store.getState().state_version).toBe(before);
  });

  it('a store that throws is an outcome, not an exception', () => {
    at(T0 + 2 * H);
    const r = poll([lane()], { openStore: () => { throw new TypeError('boom'); } });
    expect(outcome(r)).toBe('skipped:store-threw:boom');
    expect(r.renewed).toBe(0);
  });

  it('is total: no lanes, garbage lanes and a missing ports object never throw', () => {
    expect(renewLaneHeartbeats({ parent: root, lanes: [], nowMs: T0 })).toMatchObject({ renewable: 0, renewed: 0, lanes: [] });
    expect(() => renewLaneHeartbeats({ parent: root, lanes: [null, 7, {}], nowMs: T0, ports: ports() })).not.toThrow();
    expect(renewLaneHeartbeats({ parent: root, lanes: [null], nowMs: T0, ports: ports() }).renewable).toBe(0);
    expect(() => renewLaneHeartbeats()).not.toThrow();
  });
});

describe('tick / applyLeaseReclaim / main — the writer end to end on a real store', () => {
  let root;
  let storeDir;
  /** @type {object[]} */ let ledger;
  let clock;
  let store;
  let opened;

  function makeStore() {
    return createStateStore({
      projectRoot: root,
      sessionId: SESSION,
      renderProjectionFile: false,
      now: () => clock,
      resolveGitCommonDir: () => path.join(root, '.git'),
      appendEvent: (e) => void ledger.push(e),
    });
  }

  function seedMission(s) {
    expect(s.updateMission(MISSION, () => ({
      status: 'executing',
      intent: { path: '.artibot/intent.md', revision: 1 },
      plan: { path: '.artibot/plan.md', revision: 1 },
    }), { reason: 'test.seed' }).ok).toBe(true);
  }

  /** @param {Record<string, unknown>} lanes */
  const writeRun = (lanes) => fs.writeFileSync(path.join(root, '.artibot', 'split', 'run.json'), JSON.stringify({ runId: 'split-lt', lanes }));
  /** lane-state activity at `ms` */
  const touched = (ms, state = 'active') => ({ state, since: iso(ms), updated_at: iso(ms) });
  const feed = (limb) => feedLimb({ parentRoot: root, plan: PLAN, limb, sessionId: SESSION }, { openStore: () => store, config: OFF });
  const ports = (over = {}) => ({ openStore: () => { opened += 1; return store; }, sessionId: SESSION, config: OFF, ...over });
  const run = (over = {}) => tick({ parent: root, runId: null, storeDir, nowMs: clock.getTime(), ports: ports(), ...over });
  const updates = () => ledger.filter((e) => e.event === 'state.updated');
  const collectOut = () => {
    const out = []; const err = [];
    return { io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) }, stdout: () => out.join(''), stderr: () => err.join('') };
  };
  const cli = async (argv, over = {}) => {
    const c = collectOut();
    const code = await main(['--parent', root, '--store-dir', storeDir, ...argv], { nowMs: clock.getTime(), ports: ports(), ...c.io, ...over });
    return { code, stdout: c.stdout(), stderr: c.stderr() };
  };

  /** auth is working (touched "now"); billing and carol are finished lanes whose leases lapsed an hour ago. */
  function lapsedRun() {
    clock = new Date(T0);
    for (const l of ['auth', 'billing', 'carol']) expect(feed(l).claim).toBe('claimed');
    clock = new Date(T0 + 25 * H);
    writeRun({ auth: touched(clock.getTime()), billing: { state: 'done' }, carol: { state: 'done' } });
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-lease-tick-e2e-'));
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-lease-tick-e2e-store-'));
    const dir = path.join(root, '.artibot', 'split');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(PLAN));
    writeRun({});
    ledger = [];
    opened = 0;
    clock = new Date(T0);
    store = makeStore();
    seedMission(store);
  });
  afterEach(() => {
    for (const d of [root, storeDir]) fs.rmSync(d, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('a tick renews what is due and reports what lapsed; with no list it releases NOTHING', async () => {
    lapsedRun();
    const before = updates().length;

    const r = await run();

    expect(r.leases.heartbeat).toMatchObject({ available: true, renewable: 1, renewed: 1 });
    expect(r.leases.heartbeat.lanes.find((l) => l.limb === 'auth')).toMatchObject({ outcome: 'renewed', evidence: 'lane-state-fresh' });
    expect(r.leases.reclaim).toMatchObject({ mode: 'report', applied: false, results: [] });
    expect(r.leases.reclaim.candidates.map((c) => c.id)).toEqual([idOf('billing'), idOf('carol')]);
    expect(r.leases.reclaim.candidates[0]).toMatchObject({ laneOps: 'done', action: 'release-to-queued' });
    expect(store.getLease(MISSION, 'billing')?.owner).toBe('billing');
    expect(store.getLease(MISSION, 'carol')?.owner).toBe('carol');
    expect(updates().length).toBe(before + 1); // the auth renewal only
    expect(r.at).toBe(iso(T0 + 25 * H));
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  it('ADV-1: applyIds releases ONLY the listed id — its lapsed sibling is reported and left alone', async () => {
    lapsedRun();
    const r = await run({ applyIds: [idOf('billing')] });
    expect(r.leases.reclaim).toMatchObject({ mode: 'apply', applied: true, available: true });
    expect(r.leases.reclaim.results).toEqual([{ id: idOf('billing'), missionId: MISSION, taskId: 'billing', outcome: 'reclaimed:queued' }]);
    expect(store.getLease(MISSION, 'billing')).toBe(null);
    expect(store.getLease(MISSION, 'carol')?.owner).toBe('carol'); // lapsed, reported, NOT listed -> untouched
    expect(updates().filter((e) => e.data.reason === LEASE_RECLAIM_REASON)).toHaveLength(1);
  });

  it('ADV-1: a listed id that is not a candidate is answered, not guessed at — live, unknown', async () => {
    lapsedRun();
    const r = await run({ applyIds: [idOf('auth'), `${MISSION}/ghost`] });
    // auth was renewed by THIS tick, so it is live; ghost is nothing.
    expect(r.leases.reclaim.results.map((x) => [x.taskId, x.outcome])).toEqual([['auth', 'skipped:not-expired'], ['ghost', 'skipped:not-a-candidate']]);
    expect(r.leases.reclaim.applied).toBe(false);
    expect(store.getLease(MISSION, 'billing')?.owner).toBe('billing');
  });

  it('ADV-3: a suspended lane\'s id is refused with skipped:protected even when it is listed', async () => {
    lapsedRun();
    writeRun({ auth: touched(clock.getTime()), billing: { state: 'suspended', updated_at: iso(T0) }, carol: { state: 'done' } });
    const r = await run({ applyIds: [idOf('billing'), idOf('carol')] });
    expect(r.leases.reclaim.results.map((x) => [x.taskId, x.outcome])).toEqual([['billing', 'skipped:protected'], ['carol', 'reclaimed:queued']]);
    expect(store.getLease(MISSION, 'billing')?.owner).toBe('billing');
    expect(r.leases.reclaim.protected.map((p) => p.id)).toEqual([idOf('billing')]);
  });

  it('ADV-4: a working lane with no lock line and a stale lane-state stamp is neither renewed nor held — it is a candidate', async () => {
    lapsedRun();
    writeRun({ auth: touched(T0 - 30 * H), billing: { state: 'done' }, carol: { state: 'done' } });
    const r = await run();
    expect(r.leases.heartbeat.lanes.find((l) => l.limb === 'auth')).toMatchObject({ outcome: 'skipped:no-liveness-evidence', working: true, renew: false });
    expect(r.leases.reclaim.candidates.map((c) => [c.taskId, c.laneOps])).toEqual([['auth', 'active'], ['billing', 'done'], ['carol', 'done']]);
  });

  it('with no session id applyLeaseReclaim says so and releases nothing', () => {
    lapsedRun();
    const out = applyLeaseReclaim({ parent: root, lanes: [], nowMs: clock.getTime(), ids: [idOf('billing')], ports: ports({ sessionId: '' }) });
    expect(out).toMatchObject({ mode: 'apply', available: false, reason: 'no-session-id', applied: false, results: [] });
    expect(store.getLease(MISSION, 'billing')).not.toBe(null);
  });

  it('applyLeaseReclaim with no usable ids is refused before the store is opened', () => {
    lapsedRun();
    const out = applyLeaseReclaim({ parent: root, lanes: [], nowMs: clock.getTime(), ids: [], ports: ports() });
    expect(out).toMatchObject({ mode: 'refused', applied: false, results: [] });
    expect(opened).toBe(0);
  });

  it('main: --apply-reclaim with no list is REFUSED — exit 1, a reason on stderr, nothing read or written', async () => {
    lapsedRun();
    const before = store.getState().state_version;
    for (const argv of [['--apply-reclaim'], ['--apply-reclaim', '--json'], ['--apply-reclaim', ''], ['--apply-reclaim', 'not-an-id'], ['--apply-reclaim', `${idOf('billing')},nope`]]) {
      const r = await cli(argv);
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.stderr, argv.join(' ')).toContain('lease-tick refused');
      expect(r.stdout, argv.join(' ')).toBe('');
    }
    expect(opened).toBe(0);
    expect(store.getState().state_version).toBe(before);
  });

  it('main: --apply-reclaim <id> prints what it released and exits 0; the human line names the id', async () => {
    lapsedRun();
    const r = await cli(['--apply-reclaim', idOf('billing')]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('lease reclaim [apply]: reclaimed 1 of 1 listed');
    expect(r.stdout).toContain(`${idOf('billing')}: reclaimed:queued`);
    expect(r.stdout).toContain(idOf('carol')); // reported as left untouched
    expect(store.getLease(MISSION, 'billing')).toBe(null);
    expect(store.getLease(MISSION, 'carol')?.owner).toBe('carol');
  });

  it('main: a plain run prints the heartbeat and the report-only listing; --json is valid JSON with both blocks', async () => {
    lapsedRun();
    const text = await cli([]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('lease heartbeat');
    expect(text.stdout).toContain('auth: renewed');
    expect(text.stdout).toContain('lease reclaim [report-only]: 2 expired lane lease(s)');
    expect(text.stdout).toContain(idOf('billing'));
    expect(text.stdout).toContain('--apply-reclaim');

    const json = await cli(['--json']);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.leases.heartbeat).toMatchObject({ available: true });
    expect(parsed.leases.reclaim).toMatchObject({ mode: 'report', available: true });
    expect(parsed.at).toBe(iso(T0 + 25 * H));
  });

  it('main: a store that throws never turns into a failing exit code; it says so', async () => {
    lapsedRun();
    const r = await cli([], { ports: ports({ openStore: () => { throw new TypeError('boom'); } }) });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('boom');
  });

  it('main: --help prints the usage and exits 0 without opening anything', async () => {
    const r = await cli(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--apply-reclaim');
    expect(opened).toBe(0);
  });
});

describe('renderTickLines — pure', () => {
  const heartbeat = (over = {}) => ({
    available: true, reason: null, divisor: 3, maxIntervalMs: 45 * MIN, renewable: 2, renewed: 1,
    lanes: [
      { limb: 'auth', opsState: 'active', working: true, renew: true, evidence: 'session-alive', outcome: 'renewed', missionId: MISSION, detail: { reason: 'due', ageMs: 50 * MIN, intervalMs: 45 * MIN, ttlMs: 24 * H, expired: false } },
      { limb: 'billing', opsState: 'active', working: true, renew: true, evidence: 'lane-state-fresh', outcome: 'skipped:not-due', missionId: MISSION, detail: { reason: 'fresh', ageMs: 20 * MIN, intervalMs: 45 * MIN, ttlMs: 24 * H, expired: false } },
      { limb: 'quiet', opsState: 'active', working: true, renew: false, evidence: null, outcome: 'skipped:no-liveness-evidence', missionId: null },
      { limb: 'done-lane', opsState: 'done', working: false, renew: false, evidence: null, outcome: 'skipped:ops-state:done', missionId: null },
    ],
    ...over,
  });
  const empty = { mode: 'report', available: true, reason: null, applied: false, candidates: [], protected: [], results: [] };

  it('prints one line per WORKING lane — the not-due one with its numbers, the evidence-less one with its reason — and none for finished lanes', () => {
    const text = renderTickLines({ heartbeat: heartbeat(), reclaim: empty }).join('\n');
    expect(text).toContain('lease heartbeat');
    expect(text).toContain('renewed 1 of 2 renewable');
    expect(text).toContain('min(ttl/3, 45m)');
    expect(text).toContain('auth: renewed');
    expect(text).toMatch(/billing: skipped:not-due.*20m.*45m/);
    expect(text).toContain('quiet: skipped:no-liveness-evidence');
    expect(text).not.toContain('done-lane');
  });

  it('is quiet when no lane is working and nothing lapsed', () => {
    expect(renderTickLines({ heartbeat: heartbeat({ renewable: 0, renewed: 0, lanes: [{ limb: 'x', working: false, outcome: 'skipped:ops-state:done' }] }), reclaim: empty })).toEqual([]);
  });

  it('says so when the heartbeat could not run', () => {
    const text = renderTickLines({ heartbeat: heartbeat({ available: false, reason: 'no-session-id', renewed: 0 }), reclaim: empty }).join('\n');
    expect(text).toContain('lease heartbeat: not run (no-session-id)');
  });

  it('apply mode prints the outcome of every LISTED id and counts what it left untouched; a refusal prints its reason', () => {
    const applied = renderTickLines({
      heartbeat: heartbeat({ renewable: 0, renewed: 0, lanes: [] }),
      reclaim: {
        ...empty, mode: 'apply', applied: true,
        candidates: [{ id: idOf('billing'), taskId: 'billing' }, { id: idOf('carol'), taskId: 'carol' }],
        results: [{ id: idOf('billing'), taskId: 'billing', outcome: 'reclaimed:queued' }],
      },
    }).join('\n');
    expect(applied).toContain('lease reclaim [apply]: reclaimed 1 of 1 listed');
    expect(applied).toContain(`${idOf('billing')}: reclaimed:queued`);
    expect(applied).toContain(`1 other expired lease(s) left untouched: ${idOf('carol')}`);

    const refused = renderTickLines({ heartbeat: heartbeat({ renewable: 0, renewed: 0, lanes: [] }), reclaim: { ...empty, mode: 'refused', reason: 'apply needs an explicit, non-empty list' } }).join('\n');
    expect(refused).toContain('lease reclaim [apply]: refused (apply needs an explicit, non-empty list');
    const unavailable = renderTickLines({ heartbeat: heartbeat({ renewable: 0, renewed: 0, lanes: [] }), reclaim: { ...empty, mode: 'apply', available: false, reason: 'no-session-id' } }).join('\n');
    expect(unavailable).toContain('lease reclaim [apply]: not run (no-session-id)');
  });

  it('report mode reuses the watch listing, ids first', () => {
    const text = renderTickLines({
      heartbeat: heartbeat({ renewable: 0, renewed: 0, lanes: [] }),
      reclaim: { ...empty, candidates: [{ id: idOf('gone'), owner: 'gone', status: 'claimed', laneOps: 'done', silentForMs: 27 * H, expiredForMs: 3 * H, action: 'release-to-queued' }] },
    }).join('\n');
    expect(text).toContain('lease reclaim [report-only]: 1 expired lane lease(s)');
    expect(text).toContain(`${idOf('gone')}  owner gone`);
    expect(text).toContain('--apply-reclaim <id[,id...]>');
  });

  it('is total on missing or malformed input', () => {
    for (const v of [undefined, null, {}, { heartbeat: null, reclaim: null }, 'x']) expect(() => renderTickLines(v)).not.toThrow();
    expect(renderTickLines(undefined)).toEqual([]);
  });
});
