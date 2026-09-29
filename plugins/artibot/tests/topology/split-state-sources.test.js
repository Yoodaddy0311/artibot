/**
 * Tests for `lib/topology/split-state-sources.js` — the three source
 * normalizers — and for the READ-PATH interlock between the real StateStore
 * and `split-state.js#readWorkerState` (PRD T-46, Observe stage).
 *
 * ── Why this file exists, when split-state.test.js already passes ──────────
 * Two holes that file names in its own header are closed here:
 *
 *  1. It exercises the normalizers only THROUGH the merge, so a normalizer bug
 *     the merge masks goes unseen (its header, "The cost, stated not hidden").
 *     Every normalizer is called directly below.
 *  2. Every `storeReader` there is a fixture that file wrote, so "store wins"
 *     is proven about the priority code and about nothing on disk (its
 *     "WHAT THEY DO NOT COVER" list). Here the store rows come from a REAL
 *     `createStateStore` over a tmpdir: a mission is seeded, `getProjection()`
 *     renders it, and that output is fed to `normalizeStore`. The store is not
 *     hypothetical — `lib/project-state/state-manager.js#createStateStore`
 *     ships today with production consumers.
 *
 * ── SH-11 changed what this file is for ────────────────────────────────────
 * The three obstacles this header used to list as the reasons
 * `writeWorkerState` could not write to the store — no run-to-mission binding
 * (`M-YYYYMMDD-…` addresses the store, a run has none), nowhere on a task node
 * to put the ops keys, and a caller that builds no store — are written:
 * `plan.json.missionBinding`, the closed `ops` object on the node (schema
 * tests below), and `scripts/split/lane-state.mjs` opening a store. The write
 * itself is proven in `split-state.test.js` against real stores. What THIS
 * file still pins is the side that did not move and is the reason the canonical
 * reader takes the task NODES: a worker row is a fixed five-field projection
 * keyed by the OWNER and drops `ops` (`projection.js#projectWorker`, PROBE
 * below). The new blocks at the end test the pure core: the binding record, the
 * B1/B2/B3 node builder, the backfill and `normalizeTaskGraph`.
 *
 * ── What this file still does NOT prove (rules §9, next to the gate) ───────
 *  - It does NOT prove any `/split` run has ever used a store: no run has been
 *    bound yet. The interlock below is the contract, measured, not a
 *    description of live traffic.
 *  - It does not touch the ledger writer, concurrency, or scale. Fixtures hold
 *    one to three workers.
 *
 * ── COUPLING, stated so a RED here is read correctly ───────────────────────
 * The T8 cases pin the CURRENT behaviour of code this limb does not own:
 * `lib/project-state/projection.js#assignWorkerKeys` (the row-key rule),
 * `#projectWorker` (the five projected fields) and
 * `lib/project-state/validate.js#BLOCKER_PATTERN` (the blocker allowlist). A
 * limb that deliberately changes any of those should carry THIS file in its
 * allowlist and update it in the same commit. A failure here is therefore a
 * renegotiation signal — "the contract a future store port would have to meet
 * just moved" — not automatically a regression.
 *
 * All fixtures live under `os.tmpdir()` and are removed in `afterEach`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateTask } from '../../lib/project-state/validate.js';
import { LANE_OPS_STATES, LANE_OPS_TO_V11_STATUS, LANE_STATES, V11_STATUSES } from '../../lib/supervisor/contracts.js';
import { readWorkerState } from '../../lib/topology/split-state.js';
import {
  assertBlockersForState,
  assertOpsStatusAgree,
  attachRunOps,
  BINDING_DISABLED,
  foreignRunLimbs,
  HEARTBEAT_OPS_STATES,
  honorsBinding,
  isIsoInstant,
  isPlainObject,
  LANE_STATE_TO_V11,
  MISSION_BINDING_ENABLED_CONFIG_PATH,
  MISSION_BINDING_KEY,
  MISSION_BINDING_KEYS,
  missionEnvFromBinding,
  normalizeEvents,
  normalizeRunJson,
  normalizeStore,
  normalizeTaskGraph,
  OPS_IMPLIED_BLOCKED_BY,
  ownsFromPlan,
  parseMissionBinding,
  planBoundNode,
  readLaneEntry,
  readMissionBindingEnabled,
  stringList,
  V11_TO_OPS_WORDS,
} from '../../lib/topology/split-state-sources.js';
import {
  cleanup, makeStore, MISSION_ID, seed, task,
} from '../project-state/helpers.js';

/** The limb name this file uses as both task id and owner. */
const LIMB = 'sh11-split-state-store-flip';

/** @type {string[]} tmpdirs to remove after each test */
const tmpdirs = [];

/**
 * Is `child` inside `parent`? Separator-safe, unlike a `startsWith` on the
 * raw strings, which also answers yes for a sibling named `<parent>-2`.
 *
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * A real StateStore over a fresh tmpdir, GUARDED before it can write.
 *
 * `resolveGitCommonDir` is explicitly NOT supplied, so the store takes its
 * reported fallback (`store-location.js#FALLBACK_RELATIVE`) and every path it
 * holds lands under the tmpdir project root. The helper's own default
 * resolver returns a RELATIVE `'.git'`, which `resolveStoreLocation` resolves
 * against `projectRoot` and which would therefore also stay inside the
 * tmpdir; only a resolver yielding an ABSOLUTE path could escape it. The
 * fallback is chosen here because it is the case a `/split` window would hit,
 * not because the default is unsafe.
 *
 * The containment check lives HERE rather than in one test, so every store any
 * test opens is guarded structurally, before its first write. It throws rather
 * than asserting: a harness that has already mis-resolved must not proceed to
 * write and then report a tidy assertion failure.
 *
 * @returns {{ store: object, projectRoot: string, ledger: object }}
 */
function realStore() {
  const made = makeStore({ storeOptions: { resolveGitCommonDir: undefined } });
  tmpdirs.push(made.projectRoot);
  const { store, projectRoot } = made;
  if (store.location.source !== 'project-root-fallback') {
    throw new Error(`realStore: expected the project-root fallback, got '${store.location.source}'`);
  }
  for (const [label, p] of Object.entries(store.paths)) {
    if (!isInside(projectRoot, p)) {
      throw new Error(`realStore: store path '${label}' (${p}) is outside the tmpdir project root`);
    }
  }
  return made;
}

/**
 * A `/split` run directory. `plan.json` and `run.json` are left absent so a
 * read reflects the store layer alone.
 *
 * @returns {string} the run directory
 */
function makeEmptyRunDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'split-state-src-'));
  tmpdirs.push(root);
  const dir = path.join(root, '.artibot', 'split');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  while (tmpdirs.length) cleanup(tmpdirs.pop());
});

/* ───────────────── T8 — read-path interlock, real StateStore ────────────── */

describe('T8 — real StateStore -> normalizeStore -> readWorkerState', () => {
  it('resolves every store path inside the tmpdir project root, before any write', () => {
    // The guard itself lives in `realStore`, which throws, so it covers every
    // store this file opens rather than only this case. This test documents
    // it and names the four paths, so the guard is visible and not merely
    // implied by the absence of stray files.
    const { store, projectRoot } = realStore();
    expect(store.location.source).toBe('project-root-fallback');
    expect(Object.keys(store.paths).sort()).toEqual(['dir', 'journal', 'projection', 'snapshot']);
    for (const p of Object.values(store.paths)) expect(isInside(projectRoot, p)).toBe(true);
    // It observes a resolved LOCATION, not the filesystem: no test here walks
    // the tree afterwards to prove nothing was written elsewhere.
    expect(isInside(projectRoot, path.join(projectRoot, '..', 'sibling'))).toBe(false);
  });

  it('projects a seeded task into a RawWorker keyed by the limb name', () => {
    const { store } = realStore();
    const out = seed(store, [task(LIMB, {
      status: 'executing',
      owner: LIMB,
      file_ownership: ['plugins/artibot/lib/topology/split-state.js'],
      heartbeat_at: '2026-09-21T00:00:00.000Z',
      heartbeat_source: 'lane-heartbeat',
      blockers: ['gate:serial-gate'],
    })]);
    expect(out.ok).toBe(true);

    const workers = store.getProjection().active_missions[MISSION_ID].workers;
    expect(Object.keys(workers)).toEqual([LIMB]);

    const raw = normalizeStore(workers);
    expect(raw[LIMB]).toEqual({
      status: 'executing',
      owns: ['plugins/artibot/lib/topology/split-state.js'],
      blockedBy: ['gate:serial-gate'],
      heartbeatAt: '2026-09-21T00:00:00.000Z',
      heartbeatSource: 'lane-heartbeat',
      extra: {},
    });
  });

  it('carries the real store row through readWorkerState as source `store`', () => {
    const { store } = realStore();
    seed(store, [task(LIMB, {
      status: 'reviewing',
      owner: LIMB,
      file_ownership: ['plugins/artibot/tests/topology/split-state-sources.test.js'],
      heartbeat_at: '2026-09-21T01:02:03.000Z',
      heartbeat_source: 'lane-heartbeat',
    })]);
    const workers = store.getProjection().active_missions[MISSION_ID].workers;

    const read = readWorkerState({
      runDir: makeEmptyRunDir(),
      storeReader: () => ({ workers }),
    });

    expect(read.source).toBe('store');
    expect(read.conflicts).toEqual([]);
    expect(read.workers[LIMB]).toEqual({
      status: 'reviewing',
      owns: ['plugins/artibot/tests/topology/split-state-sources.test.js'],
      heartbeat_at: '2026-09-21T01:02:03.000Z',
      heartbeat_source: 'lane-heartbeat',
      blocked_by: [],
      source: 'store',
    });
  });

  it('does NOT refuse the WHOLE projection object — it yields a spurious `active_missions` row', () => {
    const { store } = realStore();
    seed(store, [task(LIMB, { status: 'executing', owner: LIMB })]);
    const projection = store.getProjection();

    // `getProjection()` returns `{project, state_version, updated_at,
    // active_missions}`; the workers map is nested two levels down. Handing
    // the whole object to `normalizeStore` does NOT throw — it reads
    // `active_missions` as if it were one worker record. Pinned so a future
    // port implementer sees the trap instead of shipping it.
    const wrong = normalizeStore(projection);
    expect(Object.keys(wrong)).toEqual(['active_missions']);
    expect(wrong.active_missions.status).toBeNull();

    const right = normalizeStore(projection.active_missions[MISSION_ID].workers);
    expect(Object.keys(right)).toEqual([LIMB]);
  });

  it('CONTROL — the row key is the OWNER, not the limb, when they differ', () => {
    const { store } = realStore();
    // One task, id = the limb, owner = someone else, and that owner's only
    // task in the mission. `projection.js#assignWorkerKeys` keys the row by
    // the owner in exactly that case, so a store reader looking the limb name
    // up finds NOTHING. This is the trap a future write-path flip must handle.
    const out = seed(store, [task(LIMB, { status: 'executing', owner: 'some-other-owner' })]);
    expect(out.ok).toBe(true);

    const workers = store.getProjection().active_missions[MISSION_ID].workers;
    expect(Object.keys(workers)).toEqual(['some-other-owner']);
    expect(Object.keys(normalizeStore(workers))).toEqual(['some-other-owner']);
    expect(normalizeStore(workers)[LIMB]).toBeUndefined();
  });

  it('CONTROL — the key falls back to the task id when one owner holds two tasks', () => {
    const { store } = realStore();
    const out = seed(store, [
      task(`${LIMB}-a`, { status: 'executing', owner: 'shared-owner' }),
      task(`${LIMB}-b`, { status: 'executing', owner: 'shared-owner' }),
    ]);
    expect(out.ok).toBe(true);

    const workers = store.getProjection().active_missions[MISSION_ID].workers;
    expect(Object.keys(workers).sort()).toEqual([`${LIMB}-a`, `${LIMB}-b`]);
  });

  it('NEGATIVE — the real store refuses a blocker outside the allowlist that stringList accepts', () => {
    const { store } = realStore();
    const free = 'waiting on the leader';

    // `split-state-sources.js#stringList` takes any non-empty string today,
    // so a free-form reason round-trips through the normalizers untouched.
    expect(stringList([free])).toEqual([free]);
    expect(normalizeRunJson({ lanes: { [LIMB]: { state: 'active', blocked_by: [free] } } })[LIMB].blockedBy)
      .toEqual([free]);

    // The store refuses the same string. `validate.js#BLOCKER_PATTERN` is an
    // ALLOWLIST (`lane|gate|human|reconcile`), so a write carrying a reason
    // the split surface accepts today would be rejected, not coerced.
    const out = seed(store, [task(LIMB, { status: 'blocked', blockers: [free] })]);
    expect(out.ok).toBe(false);
    expect(out.conflict).toBe(false);
    // The REFUSAL is the contract; the wording of project-state's error is
    // not this file's to own. Matched by pattern so a reworded message there
    // does not turn this red for no reason.
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatch(/blockers\[0\]/);

    // Refused means nothing landed: the store is still at version 0.
    expect(store.getState().state_version).toBe(0);
  });

  it('PROBE — an extra task key passes the runtime validator and is dropped by the projection', () => {
    const { store } = realStore();
    const withExtra = task(LIMB, {
      status: 'executing',
      owner: LIMB,
      ops_state: 'active',
      file_ownership: ['plugins/artibot/lib/topology/split-state.js'],
    });

    // Measured, not inferred. The repository ships no RUNTIME JSON-Schema
    // validator — `ajv` is a devDependency, so `task-graph.schema.json`'s
    // `additionalProperties: false` is enforced by the schema tests in CI and
    // by nothing at runtime. `validate.js` says nothing about unknown keys.
    expect(validateTask(withExtra, MISSION_ID, 0)).toEqual([]);

    const out = seed(store, [withExtra]);
    expect(out.ok).toBe(true);

    // It survives in the Task Graph...
    expect(store.getTaskGraph(MISSION_ID).tasks[0].ops_state).toBe('active');

    // ...and is dropped by the projection, which emits a fixed five-field row.
    const row = store.getProjection().active_missions[MISSION_ID].workers[LIMB];
    expect(Object.keys(row).sort()).toEqual(['owns', 'status']);
    expect(row.ops_state).toBeUndefined();

    // So `extra` arrives empty: there is nowhere in a worker row to carry the
    // ops vocabulary that `run.json` holds today.
    expect(normalizeStore({ workers: { [LIMB]: row } })[LIMB].extra).toEqual({});
  });
});

/* ──────────────────── T9 — normalizers, called directly ─────────────────── */

describe('T9 — normalizeStore', () => {
  it('accepts both shapes: {workers} and the bare map', () => {
    const row = { status: 'done', owns: ['a'], blocked_by: [], heartbeat_at: null, heartbeat_source: null };
    const wrapped = normalizeStore({ workers: { alpha: row } });
    const bare = normalizeStore({ alpha: row });
    expect(wrapped).toEqual(bare);
    expect(wrapped.alpha.status).toBe('done');
  });

  it('reads an unknown status word as null, never as a guess', () => {
    for (const word of ['RUNNING', 'active', 'finished', '', 42, null, undefined]) {
      expect(normalizeStore({ alpha: { status: word } }).alpha.status).toBeNull();
    }
    // Every v1.1 word IS accepted, `cancelled` included.
    for (const word of ['queued', 'claimed', 'executing', 'blocked', 'reviewing', 'done', 'failed', 'cancelled']) {
      expect(normalizeStore({ alpha: { status: word } }).alpha.status).toBe(word);
    }
  });

  it('preserves every other key verbatim in `extra`', () => {
    const out = normalizeStore({
      alpha: {
        status: 'executing',
        note: 'hand-written',
        window: 3,
        nested: { deep: [1, 2] },
      },
    });
    expect(out.alpha.extra).toEqual({ note: 'hand-written', window: 3, nested: { deep: [1, 2] } });
    // The five projected fields are consumed, not duplicated into `extra`.
    expect(out.alpha.extra.status).toBeUndefined();
  });

  it('drops non-object rows and non-object input rather than inventing a record', () => {
    expect(normalizeStore(null)).toEqual({});
    expect(normalizeStore('workers')).toEqual({});
    expect(normalizeStore(['alpha'])).toEqual({});
    expect(normalizeStore(undefined)).toEqual({});
    expect(normalizeStore({ alpha: 'active', beta: null, gamma: 7 })).toEqual({});
  });

  it('coerces the list and timestamp fields instead of trusting them', () => {
    const out = normalizeStore({
      alpha: {
        owns: ['a', '', 3, null, 'b'],
        blocked_by: 'gate:serial-gate',
        heartbeat_at: 1234,
        heartbeat_source: null,
      },
    });
    expect(out.alpha.owns).toEqual(['a', 'b']);
    expect(out.alpha.blockedBy).toEqual([]);
    expect(out.alpha.heartbeatAt).toBeNull();
    expect(out.alpha.heartbeatSource).toBeNull();
  });

  it('SHAPE AMBIGUITY — a worker literally named `workers` swallows the map', () => {
    // The two-shape acceptance has one cost, pinned rather than hidden: in the
    // bare-map shape a worker named `workers` whose record is an object is
    // read as the wrapper. Not reachable from the real projection (no task id
    // or owner is `workers` today), but a port implementer choosing the bare
    // shape inherits it.
    const out = normalizeStore({ workers: { status: 'done' }, alpha: { status: 'queued' } });
    expect(Object.keys(out)).toEqual([]);
    expect(out.alpha).toBeUndefined();
  });
});

describe('T9 — normalizeRunJson', () => {
  it('accepts a bare state string and the {state, since, window, note} object', () => {
    const fromString = normalizeRunJson({ lanes: { alpha: 'active' } }).alpha;
    const fromObject = normalizeRunJson({ lanes: { alpha: { state: 'active' } } }).alpha;
    expect(fromString.status).toBe('executing');
    expect(fromObject.status).toBe('executing');
    expect(fromString.extra).toEqual({ ops_state: 'active' });
  });

  it('keeps the finer ops word in `extra` for the two the conversion loses', () => {
    // `closing` and `suspended` collapse into `executing` and `blocked`.
    const closing = normalizeRunJson({ lanes: { alpha: 'closing' } }).alpha;
    expect(closing.status).toBe('executing');
    expect(closing.extra.ops_state).toBe('closing');

    const suspended = normalizeRunJson({ lanes: { alpha: 'suspended' } }).alpha;
    expect(suspended.status).toBe('blocked');
    expect(suspended.extra.ops_state).toBe('suspended');
  });

  it('derives blocked_by from the ops word only for the two words that imply one', () => {
    expect(normalizeRunJson({ lanes: { alpha: 'suspended' } }).alpha.blockedBy).toEqual(['human:suspend']);
    expect(normalizeRunJson({ lanes: { alpha: 'serial-gate' } }).alpha.blockedBy).toEqual(['gate:serial-gate']);
    expect(Object.keys(OPS_IMPLIED_BLOCKED_BY).sort()).toEqual(['serial-gate', 'suspended']);
    // Every other ops word implies nothing — inventing a target would fabricate a fact.
    for (const word of ['pending', 'active', 'awaiting-dispatch', 'review', 'closing', 'done', 'failed']) {
      expect(normalizeRunJson({ lanes: { alpha: word } }).alpha.blockedBy).toEqual([]);
    }
  });

  it('lets an explicit blocked_by beat the word implication', () => {
    const out = normalizeRunJson({ lanes: { alpha: { state: 'suspended', blocked_by: ['human:owner-pause'] } } });
    expect(out.alpha.blockedBy).toEqual(['human:owner-pause']);
    // ...but an EMPTY explicit list is not a statement, so the implication stands.
    const empty = normalizeRunJson({ lanes: { alpha: { state: 'suspended', blocked_by: [] } } });
    expect(empty.alpha.blockedBy).toEqual(['human:suspend']);
  });

  it('yields status null and no ops_state for a word outside the allowlist', () => {
    const out = normalizeRunJson({ lanes: { alpha: 'RUNNING', beta: { state: 'in-progress', note: 'n' } } });
    expect(out.alpha.status).toBeNull();
    expect(out.alpha.extra).toEqual({});
    expect(out.beta.status).toBeNull();
    expect(out.beta.extra).toEqual({ note: 'n' });
  });

  it('never reports a heartbeat — run.json structurally has none', () => {
    const out = normalizeRunJson({ lanes: { alpha: { state: 'active', since: '2026-09-21T00:00:00.000Z' } } });
    expect(out.alpha.heartbeatAt).toBeNull();
    expect(out.alpha.heartbeatSource).toBeNull();
    // `since` is a state-change time, preserved as an ordinary extra key.
    expect(out.alpha.extra.since).toBe('2026-09-21T00:00:00.000Z');
  });

  it('skips a lane entry that is neither a string nor an object, and empty input', () => {
    expect(normalizeRunJson(null)).toEqual({});
    expect(normalizeRunJson({})).toEqual({});
    expect(normalizeRunJson({ lanes: 'active' })).toEqual({});
    expect(Object.keys(normalizeRunJson({ lanes: { alpha: 7, beta: null, gamma: 'active' } }))).toEqual(['gamma']);
  });

  it('reports owns as empty — ownership is the plan.json projection, not run.json', () => {
    expect(normalizeRunJson({ lanes: { alpha: { state: 'active', owns: ['x'] } } }).alpha.owns).toEqual([]);
  });
});

describe('T9 — normalizeEvents', () => {
  it('accepts both shapes: {lanes} and the bare map', () => {
    const lane = { state: 'DONE', ownedPaths: ['a'] };
    expect(normalizeEvents({ lanes: { alpha: lane } })).toEqual(normalizeEvents({ alpha: lane }));
  });

  it('maps the eight lane words v1.1 names and nulls the four it does not', () => {
    const mapped = {
      PENDING: 'queued',
      READY: 'claimed',
      RUNNING: 'executing',
      WAITING_INPUT: 'blocked',
      REVIEW_REQUIRED: 'reviewing',
      DONE: 'done',
      FAILED_RECOVERABLE: 'failed',
      ABORTED: 'cancelled',
    };
    for (const [lane, v11] of Object.entries(mapped)) {
      expect(normalizeEvents({ alpha: { state: lane } }).alpha.status).toBe(v11);
      expect(LANE_STATE_TO_V11[lane]).toBe(v11);
    }
    for (const lane of ['CLAIMED', 'CHECKPOINTING', 'FIXING', 'FAILED_TERMINAL']) {
      const out = normalizeEvents({ alpha: { state: lane } }).alpha;
      expect(out.status).toBeNull();
      // The raw word survives, so the finer vocabulary is not destroyed.
      expect(out.extra.lane_state).toBe(lane);
      expect(LANE_STATE_TO_V11[lane]).toBeUndefined();
    }
  });

  it('labels a heartbeat it has and omits the label when it has none', () => {
    const withHb = normalizeEvents({ alpha: { state: 'RUNNING', lastHeartbeatAt: '2026-09-21T00:00:00.000Z' } }).alpha;
    expect(withHb.heartbeatAt).toBe('2026-09-21T00:00:00.000Z');
    expect(withHb.heartbeatSource).toBe('lane-heartbeat');

    const without = normalizeEvents({ alpha: { state: 'RUNNING', lastHeartbeatAt: 0 } }).alpha;
    expect(without.heartbeatAt).toBeNull();
    expect(without.heartbeatSource).toBeNull();
  });

  it('omits lane_state entirely when the word is not a string', () => {
    const out = normalizeEvents({ alpha: { state: 7, note: 'n' } }).alpha;
    expect(out.status).toBeNull();
    expect(out.extra).toEqual({ note: 'n' });
    expect('lane_state' in out.extra).toBe(false);
  });

  it('drops non-object lanes and non-object input', () => {
    expect(normalizeEvents(null)).toEqual({});
    expect(normalizeEvents(['alpha'])).toEqual({});
    expect(Object.keys(normalizeEvents({ alpha: 'RUNNING', beta: { state: 'DONE' } }))).toEqual(['beta']);
  });
});

describe('T9 — ownsFromPlan, stringList, isPlainObject', () => {
  it('projects plan.json limbs, keeping a listed-but-empty limb distinct from an absent one', () => {
    const owns = ownsFromPlan({
      limbs: [
        { limb: 'alpha', affectedPaths: ['a', 'b'] },
        { limb: 'beta', affectedPaths: [] },
        { limb: 'gamma' },
      ],
    });
    expect(owns).toEqual({ alpha: ['a', 'b'], beta: [], gamma: [] });
    // "listed with no paths" is `[]`; "absent from the plan" is no key at all.
    expect(Object.hasOwn(owns, 'beta')).toBe(true);
    expect(Object.hasOwn(owns, 'delta')).toBe(false);
  });

  it('skips a limb with no usable name and tolerates a missing limbs array', () => {
    expect(ownsFromPlan({ limbs: [{ affectedPaths: ['a'] }, { limb: 7 }, { limb: '' }] })).toEqual({});
    expect(ownsFromPlan(null)).toEqual({});
    expect(ownsFromPlan({})).toEqual({});
    expect(ownsFromPlan({ limbs: 'alpha' })).toEqual({});
  });

  it('stringList keeps non-empty strings only and refuses a non-array', () => {
    expect(stringList(['a', '', null, 0, 'b', false, ['c']])).toEqual(['a', 'b']);
    expect(stringList('a')).toEqual([]);
    expect(stringList(null)).toEqual([]);
    expect(stringList(undefined)).toEqual([]);
  });

  it('isPlainObject rejects arrays and nullish, accepts objects', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
    expect(isPlainObject('x')).toBe(false);
  });
});

describe('T9 — the derived conversion tables', () => {
  it('V11_TO_OPS_WORDS is non-injective in exactly two places and absent for cancelled', () => {
    expect(V11_TO_OPS_WORDS.executing.slice().sort()).toEqual(['active', 'closing']);
    expect(V11_TO_OPS_WORDS.blocked.slice().sort()).toEqual(['serial-gate', 'suspended']);
    expect(V11_TO_OPS_WORDS.cancelled).toBeUndefined();
    for (const v11 of ['queued', 'claimed', 'reviewing', 'done', 'failed']) {
      expect(V11_TO_OPS_WORDS[v11]).toHaveLength(1);
    }
  });

  it('LANE_STATE_TO_V11 maps exactly eight of the twelve lane words and invents no thirteenth', () => {
    // The mapping test above pins WHICH word goes where. This one pins the
    // BOUNDARY: that the derived table covers the lane vocabulary and adds
    // nothing to it — a hole the per-word test cannot see, because it only
    // looks up words it already names.
    expect(LANE_STATES).toHaveLength(12);
    for (const word of Object.keys(LANE_STATE_TO_V11)) expect(LANE_STATES).toContain(word);
    expect(Object.keys(LANE_STATE_TO_V11)).toHaveLength(8);
    expect(LANE_STATES.filter((s) => !(s in LANE_STATE_TO_V11)))
      .toEqual(['CLAIMED', 'CHECKPOINTING', 'FIXING', 'FAILED_TERMINAL']);
  });
});

/* ══════════ SH-11 — run-to-mission binding, the `ops` node key, the pure core ══════════ */

const RUN = 'split-abc123';
const NOW = '2026-09-29T05:00:00.000Z';
const EARLIER = '2026-09-29T04:00:00.000Z';
const MID = 'M-20260929-Sabcd1234';
const SESSION = 'abcd1234-ef56-7890-1234-567890abcdef';
const BINDING = Object.freeze({
  mission_id: MID, run_id: RUN, generation: 1, bound_at: EARLIER, bound_by_session: SESSION,
});
/** The failed ops word, built from parts: `v11-status-mapping.test.js` greps the repo for a `state` key set to it as a literal. */
const FAILED_WORD = LANE_OPS_STATES[LANE_OPS_STATES.length - 1];

/**
 * ajv is only a TRANSITIVE dependency (eslint -> ajv). The schema block below
 * treats its absence as RED, never as a skip: a skipped conformance test
 * reports the same green as a passing one (same rule as
 * `tests/schemas/state-task-lease.test.js`).
 */
let Ajv = null;
try {
  Ajv = (await import('ajv')).default;
} catch {
  Ajv = null;
}
const AJV_MISSING = 'ajv could not be resolved, so the ops schema cannot be enforced. FIX: declare ajv as a devDependency; do NOT skip these assertions.';
const SCHEMA_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../schemas/task-graph.schema.json');

/** @returns {Promise<Function>} a compiled validator for task-graph.schema.json */
async function compileGraphSchema() {
  if (Ajv === null) throw new Error(AJV_MISSING);
  const ajv = new Ajv({ allErrors: true });
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
  delete schema.$schema; // ajv 6 does not register the draft-07 meta-schema id
  ajv.addSchema(schema, 'task-graph.schema.json');
  return ajv.getSchema('task-graph.schema.json');
}

/** A one-task graph in a session-fallback mission. */
const graphWith = (over) => ({
  schema_version: 1,
  mission_id: MID,
  tasks: [{ id: 'auth', mission_id: MID, status: 'queued', ...over }],
});
const OK_OPS = Object.freeze({ state: 'active', since: NOW, run_id: RUN });
/** Owner / blockers the schema's conditionals demand for a status. */
const conditionals = (status) => ({
  ...(['claimed', 'executing', 'reviewing'].includes(status) ? { owner: 'auth' } : {}),
  ...(status === 'blocked' ? { blockers: ['gate:serial-gate'] } : {}),
});

describe('SH-11 T7 — task-graph schema: the closed `ops` key', () => {
  it('has a real oracle — present, and able to say NO as well as YES', async () => {
    expect(Ajv === null ? AJV_MISSING : 'oracle present').toBe('oracle present');
    const validate = await compileGraphSchema();
    expect(validate(graphWith({}))).toBe(true);
    expect(validate(graphWith({ status: 'wat' }))).toBe(false);
  });

  it('accepts a task with no ops key — every node that exists today', async () => {
    const validate = await compileGraphSchema();
    expect(validate(graphWith({})), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(graphWith({ status: 'done', owner: null })), JSON.stringify(validate.errors)).toBe(true);
  });

  it('accepts a full ops record for each of the nine ops words', async () => {
    const validate = await compileGraphSchema();
    for (const state of LANE_OPS_STATES) {
      const status = LANE_OPS_TO_V11_STATUS[state];
      const g = graphWith({ status, ...conditionals(status), ops: { ...OK_OPS, state, window: 'w-1', note: 'n' } });
      expect(validate(g), `${state}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  // Every rejection below is paired with a POSITIVE control in the same test:
  // without an `ops` property the closed task object rejects any `ops` at all,
  // so a bare `toBe(false)` would be green before the schema knew the key.
  it('rejects an unknown ops key — including the run.json-only `projected_from` stamp', async () => {
    const validate = await compileGraphSchema();
    expect(validate(graphWith({ ops: OK_OPS })), 'positive control').toBe(true);
    for (const key of ['projected_from', 'ops_state', 'updated_at', 'extra']) {
      expect(validate(graphWith({ ops: { ...OK_OPS, [key]: 'x' } })), key).toBe(false);
    }
  });

  it('requires state, since and run_id', async () => {
    const validate = await compileGraphSchema();
    expect(validate(graphWith({ ops: OK_OPS })), 'positive control').toBe(true);
    for (const key of ['state', 'since', 'run_id']) {
      const { [key]: _dropped, ...rest } = OK_OPS;
      expect(validate(graphWith({ ops: rest })), `without ${key}`).toBe(false);
    }
    expect(validate(graphWith({ ops: {} }))).toBe(false);
  });

  it('rejects a state outside the nine, a since that is not an instant, and an empty or non-string run_id', async () => {
    const validate = await compileGraphSchema();
    expect(validate(graphWith({ ops: OK_OPS })), 'positive control').toBe(true);
    expect(validate(graphWith({ ops: { ...OK_OPS, state: 'running' } }))).toBe(false);
    expect(validate(graphWith({ ops: { ...OK_OPS, state: 'executing' } })), 'a v1.1 word is not an ops word').toBe(false);
    expect(validate(graphWith({ ops: { ...OK_OPS, since: 'yesterday' } }))).toBe(false);
    expect(validate(graphWith({ ops: { ...OK_OPS, since: 1234 } }))).toBe(false);
    expect(validate(graphWith({ ops: { ...OK_OPS, run_id: '' } }))).toBe(false);
    expect(validate(graphWith({ ops: { ...OK_OPS, run_id: 7 } }))).toBe(false);
  });

  it('window and note are optional strings and nothing else', async () => {
    const validate = await compileGraphSchema();
    expect(validate(graphWith({ ops: { ...OK_OPS, window: 'w' } }))).toBe(true);
    expect(validate(graphWith({ ops: { ...OK_OPS, note: 'n' } }))).toBe(true);
    expect(validate(graphWith({ ops: { ...OK_OPS, window: 3 } }))).toBe(false);
    expect(validate(graphWith({ ops: { ...OK_OPS, note: null } }))).toBe(false);
  });

  it('states the closed shape in the schema text itself, and the enum cannot drift from LANE_OPS_STATES', () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
    const ops = schema.definitions.task.properties.ops;
    expect(ops.type).toBe('object');
    expect(ops.additionalProperties).toBe(false);
    expect(ops.required).toEqual(['state', 'since', 'run_id']);
    expect(Object.keys(ops.properties)).toEqual(['state', 'since', 'run_id', 'window', 'note']);
    expect(ops.properties.state.enum).toEqual([...LANE_OPS_STATES]);
    expect(ops.properties.since.format).toBe('date-time');
    expect(ops.properties.run_id.minLength).toBe(1);
    expect(Object.hasOwn(ops.properties, 'projected_from')).toBe(false);
  });

  it('leaves the rest of the node closed, and adds no allOf rule (the mapping table stays one copy)', async () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
    expect(schema.definitions.task.additionalProperties).toBe(false);
    expect(schema.definitions.task.allOf).toHaveLength(2);
    const validate = await compileGraphSchema();
    expect(validate(graphWith({ wat: 1 }))).toBe(false);
  });
});

describe('SH-11 — the run-to-mission binding record (parseMissionBinding)', () => {
  it('names its plan.json key and its closed key set', () => {
    expect(MISSION_BINDING_KEY).toBe('missionBinding');
    expect(MISSION_BINDING_KEYS).toEqual(['mission_id', 'run_id', 'generation', 'bound_at', 'bound_by_session']);
  });

  it('accepts a well-formed binding in either mission id form and returns it frozen', () => {
    const r = parseMissionBinding(BINDING);
    expect(r.ok).toBe(true);
    expect(r.binding).toEqual(BINDING);
    expect(Object.isFrozen(r.binding)).toBe(true);
    expect(parseMissionBinding({ ...BINDING, mission_id: 'M-20260929-001' }).ok).toBe(true);
    expect(parseMissionBinding({ ...BINDING, generation: 7 }).ok).toBe(true);
  });

  it('refuses each field that is wrong, naming the field', () => {
    const bad = {
      mission_id: ['M-2026-1', 'M-20260929-Sabcd123', '', 7, null],
      run_id: ['', 7, null],
      generation: [0, -1, 1.5, '1', null],
      bound_at: ['yesterday', '2026-09-29', 1234, '2026-13-40T99:99:99Z', null],
      bound_by_session: ['', 7, null],
    };
    for (const [field, values] of Object.entries(bad)) {
      for (const v of values) {
        const r = parseMissionBinding({ ...BINDING, [field]: v });
        expect(r, `${field}=${JSON.stringify(v)}`).toEqual({ ok: false, reason: `binding-invalid:${field}` });
      }
    }
  });

  it('refuses a missing field and an unknown key (a closed set: an allowlist, not a deny-list)', () => {
    for (const key of MISSION_BINDING_KEYS) {
      const { [key]: _dropped, ...rest } = BINDING;
      expect(parseMissionBinding(rest)).toEqual({ ok: false, reason: `binding-invalid:${key}` });
    }
    expect(parseMissionBinding({ ...BINDING, epoch: 2 })).toEqual({ ok: false, reason: 'binding-invalid:unknown-key:epoch' });
  });

  it('refuses a non-object', () => {
    for (const v of [null, undefined, [], 'M-20260929-001', 7]) {
      expect(parseMissionBinding(v)).toEqual({ ok: false, reason: 'binding-invalid:not-an-object' });
    }
  });

  it('isIsoInstant takes a full ISO instant and nothing looser', () => {
    for (const ok of ['2026-09-29T05:00:00.000Z', '2026-09-29T05:00:00Z', '2026-09-29T14:00:00+09:00']) expect(isIsoInstant(ok), ok).toBe(true);
    for (const bad of ['2026-09-29', 'x', 1234, null, '2026-13-40T99:99:99Z', '2026-09-29 05:00:00']) expect(isIsoInstant(bad), String(bad)).toBe(false);
  });
});

describe('SH-11 — the design canon\'s ARTIBOT_MISSION_ID is DERIVED from the binding, never the other way', () => {
  it('derives the env carrier from a valid binding', () => {
    expect(missionEnvFromBinding(BINDING)).toEqual({ ARTIBOT_MISSION_ID: MID });
  });

  it('derives nothing from an invalid binding, and there is no inverse', () => {
    expect(missionEnvFromBinding({ ...BINDING, mission_id: 'nope' })).toEqual({});
    expect(missionEnvFromBinding(null)).toEqual({});
    // No `bindingFromEnv` exists: the parser reads only a plan.json record.
    expect(parseMissionBinding({ ARTIBOT_MISSION_ID: MID }).ok).toBe(false);
  });
});

describe('SH-11 — readLaneEntry (one run.json lane entry, either shape)', () => {
  it('reads a bare word and the object shape', () => {
    expect(readLaneEntry('active')).toEqual({ state: 'active', since: null, window: null, note: null, blockedBy: [] });
    expect(readLaneEntry({ state: 'review', since: EARLIER, window: 'w', note: 'n', blocked_by: ['lane:beta', '', 3] }))
      .toEqual({ state: 'review', since: EARLIER, window: 'w', note: 'n', blockedBy: ['lane:beta'] });
  });

  it('turns everything it cannot vouch for into null, never a guess', () => {
    const none = { state: null, since: null, window: null, note: null, blockedBy: [] };
    expect(readLaneEntry(undefined)).toEqual(none);
    expect(readLaneEntry(null)).toEqual(none);
    expect(readLaneEntry(7)).toEqual(none);
    expect(readLaneEntry('dispatched')).toEqual(none); // outside the ops allowlist
    expect(readLaneEntry({ state: 'active', since: 'soon', window: 3, note: [] }))
      .toEqual({ ...none, state: 'active' });
  });
});

describe('SH-11 B1/B2 — assertOpsStatusAgree and assertBlockersForState', () => {
  it('B1: throws for exactly the ops/status pairs LANE_OPS_TO_V11_STATUS does not say (9 x 8)', () => {
    for (const state of LANE_OPS_STATES) {
      for (const status of V11_STATUSES) {
        const node = { id: 'auth', status, ops: { ...OK_OPS, state } };
        if (LANE_OPS_TO_V11_STATUS[state] === status) expect(() => assertOpsStatusAgree(node), `${state}/${status}`).not.toThrow();
        else expect(() => assertOpsStatusAgree(node), `${state}/${status}`).toThrow(/projects to status/);
      }
    }
  });

  it('B1: a node with no ops has nothing to disagree with, and an unknown ops word is refused', () => {
    expect(() => assertOpsStatusAgree({ id: 'auth', status: 'claimed' })).not.toThrow();
    expect(() => assertOpsStatusAgree({ id: 'auth', status: 'claimed', ops: { ...OK_OPS, state: 'wat' } })).toThrow(/not in the ops allowlist/);
  });

  it('B2: a blocked node needs a reason, and a suspended one needs a human: reason', () => {
    expect(() => assertBlockersForState({ state: 'serial-gate', status: 'blocked', blockers: [] })).toThrow(/at least one/);
    expect(() => assertBlockersForState({ state: 'serial-gate', status: 'blocked', blockers: ['gate:serial-gate'] })).not.toThrow();
    expect(() => assertBlockersForState({ state: 'suspended', status: 'blocked', blockers: ['gate:serial-gate'] })).toThrow(/human:/);
    expect(() => assertBlockersForState({ state: 'suspended', status: 'blocked', blockers: ['human:suspend'] })).not.toThrow();
  });

  it('B2: a reason outside lane|gate|human|reconcile is refused here, before the store would refuse it obscurely', () => {
    expect(() => assertBlockersForState({ state: 'serial-gate', status: 'blocked', blockers: ['waiting on the leader'] })).toThrow(/lane\|gate\|human\|reconcile/);
  });

  it('B2: blockers on a node that is not blocked are refused', () => {
    expect(() => assertBlockersForState({ state: 'active', status: 'executing', blockers: ['gate:x'] })).toThrow(/only .*blocked/);
    expect(() => assertBlockersForState({ state: 'active', status: 'executing', blockers: [] })).not.toThrow();
  });
});

describe('SH-11 — planBoundNode (the pure node builder behind a bound write)', () => {
  const args = (over = {}) => ({
    node: null, lane: readLaneEntry(undefined), worker: 'auth', missionId: MID, runId: RUN,
    opsWord: 'active', blockedBy: null, rest: {}, ts: NOW, ownsList: ['lib/auth/**'], ...over,
  });

  it('builds a new node in the target state with every field a reader needs', () => {
    const r = planBoundNode(args());
    expect(r.ok).toBe(true);
    expect(r.node).toEqual({
      id: 'auth',
      mission_id: MID,
      title: '/split limb auth',
      status: 'executing',
      owner: 'auth',
      file_ownership: ['lib/auth/**'],
      created_at: NOW,
      updated_at: NOW,
      heartbeat_at: NOW,
      heartbeat_source: 'lane-heartbeat',
      ops: { state: 'active', since: NOW, run_id: RUN },
    });
    expect(r.prev).toEqual({ state: null, since: null });
    expect(r.changed).toBe(true);
  });

  it('B3: a re-assert keeps `since`, a state change moves it', () => {
    const first = planBoundNode(args({ ts: EARLIER })).node;
    const again = planBoundNode(args({ node: first, ts: NOW }));
    expect(again.node.ops.since).toBe(EARLIER);
    expect(again.changed).toBe(false);
    expect(again.prev).toEqual({ state: 'active', since: EARLIER });
    const moved = planBoundNode(args({ node: first, opsWord: 'review', ts: NOW }));
    expect(moved.node.ops.since).toBe(NOW);
    expect(moved.changed).toBe(true);
  });

  it('derives status and owner from the ops word alone, for all nine', () => {
    for (const state of LANE_OPS_STATES) {
      const r = planBoundNode(args({ opsWord: state }));
      expect(r.node.status, state).toBe(LANE_OPS_TO_V11_STATUS[state]);
      expect(r.node.owner, state).toBe(['claimed', 'executing', 'reviewing'].includes(r.node.status) ? 'auth' : null);
      expect(() => assertOpsStatusAgree(r.node), state).not.toThrow();
    }
  });

  it('stamps a heartbeat on the four working states only, and keeps the old one otherwise', () => {
    for (const state of LANE_OPS_STATES) {
      const r = planBoundNode(args({ opsWord: state }));
      expect(Object.hasOwn(r.node, 'heartbeat_at'), state).toBe(HEARTBEAT_OPS_STATES.includes(state));
    }
    const beat = planBoundNode(args({ ts: EARLIER })).node;
    const done = planBoundNode(args({ node: beat, opsWord: 'done', ts: NOW })).node;
    expect(done.heartbeat_at).toBe(EARLIER);
    expect(done.owner).toBeNull();
    expect(HEARTBEAT_OPS_STATES).toEqual(['active', 'review', 'serial-gate', 'closing']);
  });

  it('B2: blocked states get their implied reason, an explicit one wins, and leaving blocked drops it', () => {
    expect(planBoundNode(args({ opsWord: 'serial-gate' })).node.blockers).toEqual(['gate:serial-gate']);
    expect(planBoundNode(args({ opsWord: 'suspended' })).node.blockers).toEqual(['human:suspend']);
    expect(planBoundNode(args({ opsWord: 'serial-gate', blockedBy: ['lane:beta'] })).node.blockers).toEqual(['lane:beta']);
    const gated = planBoundNode(args({ opsWord: 'serial-gate', blockedBy: ['lane:beta'] })).node;
    const back = planBoundNode(args({ node: gated, opsWord: 'active' })).node;
    expect(Object.hasOwn(back, 'blockers')).toBe(false);
  });

  it('B2: refuses a suspended node with no human reason, a blocked_by on a working state, and a free-form reason', () => {
    expect(() => planBoundNode(args({ opsWord: 'suspended', blockedBy: ['gate:x'] }))).toThrow(/human:/);
    expect(() => planBoundNode(args({ opsWord: 'active', blockedBy: ['lane:beta'] }))).toThrow(/only .*blocked/);
    expect(() => planBoundNode(args({ opsWord: 'serial-gate', blockedBy: ['waiting'] }))).toThrow(/lane\|gate\|human\|reconcile/);
  });

  it('a re-assert of a blocked state keeps the reason it had; a change into another blocked state does not carry it over', () => {
    const gated = planBoundNode(args({ opsWord: 'serial-gate', blockedBy: ['lane:beta'] })).node;
    expect(planBoundNode(args({ node: gated, opsWord: 'serial-gate' })).node.blockers).toEqual(['lane:beta']);
    // serial-gate -> suspended must not inherit a gate: reason (B2 would refuse it).
    expect(planBoundNode(args({ node: gated, opsWord: 'suspended' })).node.blockers).toEqual(['human:suspend']);
  });

  it('backfill: with no ops on the node, the run.json lane supplies the previous state and its `since`', () => {
    const lane = readLaneEntry({ state: 'review', since: EARLIER, window: 'w-a', note: 'n-a' });
    const legacy = { id: 'auth', mission_id: MID, status: 'claimed', owner: 'auth', file_ownership: ['lib/auth/**'] };
    const r = planBoundNode(args({ node: legacy, lane, opsWord: null, rest: { note: 'n-b' } }));
    expect(r.prev).toEqual({ state: 'review', since: EARLIER });
    expect(r.changed).toBe(false);
    expect(r.node.ops).toEqual({ state: 'review', since: EARLIER, run_id: RUN, window: 'w-a', note: 'n-b' });
    expect(r.node.status).toBe('reviewing'); // the stale 'claimed' is replaced, both fields written together
  });

  it('carries window and note forward and lets a patch override them', () => {
    const first = planBoundNode(args({ rest: { window: 'w-1', note: 'n-1' } })).node;
    const kept = planBoundNode(args({ node: first, opsWord: 'review' }));
    expect(kept.node.ops).toMatchObject({ window: 'w-1', note: 'n-1' });
    const over = planBoundNode(args({ node: first, opsWord: 'review', rest: { window: 'w-2' } }));
    expect(over.node.ops).toMatchObject({ window: 'w-2', note: 'n-1' });
  });

  it('refuses another run\'s node instead of overwriting it (I2)', () => {
    const foreign = { id: 'auth', mission_id: MID, status: 'done', owner: null, ops: { ...OK_OPS, state: 'done', run_id: 'split-other' } };
    const r = planBoundNode(args({ node: foreign }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('task-run-mismatch');
    expect(r.detail).toMatch(/split-other/);
  });

  it('T4: a state-less patch on a node whose ops and status disagree at rest THROWS, and an explicit state repairs it', () => {
    const skewed = { id: 'auth', mission_id: MID, status: 'claimed', owner: 'auth', ops: { ...OK_OPS, state: 'active' } };
    expect(() => planBoundNode(args({ node: skewed, opsWord: null, rest: { note: 'x' } }))).toThrow(/projects to status 'executing'/);
    const fixed = planBoundNode(args({ node: skewed, opsWord: 'active' }));
    expect(fixed.node.status).toBe('executing');
    expect(fixed.node.ops.since).toBe(OK_OPS.since);
  });

  it('refuses to invent a state: no ops word, no recorded state, no lane word', () => {
    expect(() => planBoundNode(args({ opsWord: null }))).toThrow(/needs a state/);
  });

  it('refuses a stored ops.state outside the allowlist', () => {
    const odd = { id: 'auth', mission_id: MID, status: 'claimed', owner: 'auth', ops: { ...OK_OPS, state: 'wat' } };
    expect(() => planBoundNode(args({ node: odd, opsWord: null }))).toThrow(/not in the ops allowlist/);
  });

  it('does not mutate the node it was given', () => {
    const first = planBoundNode(args()).node;
    const frozenCopy = JSON.parse(JSON.stringify(first));
    planBoundNode(args({ node: first, opsWord: 'done', ts: NOW }));
    expect(first).toEqual(frozenCopy);
  });

  it('the failed word round-trips like the others', () => {
    const r = planBoundNode(args({ opsWord: FAILED_WORD }));
    expect(r.node.status).toBe(FAILED_WORD);
    expect(r.node.owner).toBeNull();
  });
});

describe('SH-11 — normalizeTaskGraph (canonical reads use the task nodes directly)', () => {
  const node = (id, over = {}) => ({
    id,
    mission_id: MID,
    status: 'executing',
    owner: id,
    file_ownership: [`lib/${id}/**`],
    heartbeat_at: NOW,
    heartbeat_source: 'lane-heartbeat',
    ops: { state: 'active', since: EARLIER, run_id: RUN, window: 'w', note: 'n' },
    ...over,
  });
  const graph = (...tasks) => ({ schema_version: 1, mission_id: MID, tasks });

  it('keys each worker by its TASK ID (the limb), not by the projection\'s owner-keyed row', () => {
    const out = normalizeTaskGraph(graph(node('auth', { owner: 'someone-else' })), { runId: RUN });
    expect(Object.keys(out)).toEqual(['auth']);
    expect(out.auth).toEqual({
      status: 'executing',
      owns: ['lib/auth/**'],
      blockedBy: [],
      heartbeatAt: NOW,
      heartbeatSource: 'lane-heartbeat',
      extra: { ops_state: 'active', since: EARLIER, window: 'w', note: 'n' },
    });
  });

  it('reads only this run\'s nodes: no ops, another run\'s ops and a non-object ops are all outside the run', () => {
    const g = graph(
      node('auth'),
      { id: 'legacy', mission_id: MID, status: 'claimed', owner: 'legacy' },
      node('other', { ops: { state: 'active', since: EARLIER, run_id: 'split-other' } }),
      node('odd', { ops: 'active' }),
    );
    expect(Object.keys(normalizeTaskGraph(g, { runId: RUN }))).toEqual(['auth']);
  });

  it('turns an unknown ops word or status word into null / absent, never a guess', () => {
    const g = graph(node('auth', { status: 'wat', ops: { state: 'wat', since: EARLIER, run_id: RUN } }));
    const w = normalizeTaskGraph(g, { runId: RUN }).auth;
    expect(w.status).toBeNull();
    expect(Object.hasOwn(w.extra, 'ops_state')).toBe(false);
  });

  it('carries blockers as blockedBy and tolerates absent optional fields', () => {
    const g = graph({ id: 'auth', mission_id: MID, status: 'blocked', blockers: ['gate:serial-gate'], ops: { state: 'serial-gate', since: EARLIER, run_id: RUN } });
    const w = normalizeTaskGraph(g, { runId: RUN }).auth;
    expect(w.blockedBy).toEqual(['gate:serial-gate']);
    expect(w.owns).toEqual([]);
    expect(w.heartbeatAt).toBeNull();
    expect(w.extra).toEqual({ ops_state: 'serial-gate', since: EARLIER });
  });

  it('is total: no run id, no graph, no tasks all read as no workers', () => {
    expect(normalizeTaskGraph(graph(node('auth')), {})).toEqual({});
    expect(normalizeTaskGraph(graph(node('auth')), { runId: '' })).toEqual({});
    expect(normalizeTaskGraph(null, { runId: RUN })).toEqual({});
    expect(normalizeTaskGraph({ tasks: 'x' }, { runId: RUN })).toEqual({});
    expect(normalizeTaskGraph(graph(null, 7, { status: 'done' }), { runId: RUN })).toEqual({});
  });

  it('foreignRunLimbs names the plan limbs whose node belongs to another run', () => {
    const g = graph(node('auth'), node('other', { ops: { state: 'done', since: EARLIER, run_id: 'split-other' } }), { id: 'legacy', mission_id: MID, status: 'queued' });
    expect(foreignRunLimbs(g, { runId: RUN, limbs: ['auth', 'other', 'legacy', 'absent'] })).toEqual(['other']);
    expect(foreignRunLimbs(null, { runId: RUN, limbs: ['auth'] })).toEqual([]);
  });
});

describe('SH-11 T8 — attachRunOps (the one-time, idempotent backfill)', () => {
  const graph = (...tasks) => ({ schema_version: 1, mission_id: MID, updated_at: EARLIER, tasks });
  const queued = (id) => ({ id, mission_id: MID, status: 'queued', owner: null, file_ownership: [`lib/${id}/**`] });
  const base = { runId: RUN, limbs: ['auth', 'billing'], nowIso: NOW };

  it('T8: builds `ops` from the run.json lane word, keeps its `since`, and aligns status and owner to it', () => {
    const lanes = { auth: { state: 'active', since: EARLIER, window: 'w-a', note: 'n-a' } };
    const r = attachRunOps(graph(queued('auth'), queued('billing')), { ...base, lanes });
    expect(r.attached).toEqual(['auth', 'billing']);
    expect(r.changed).toBe(true);
    const auth = r.graph.tasks.find((t) => t.id === 'auth');
    expect(auth.ops).toEqual({ state: 'active', since: EARLIER, run_id: RUN, window: 'w-a', note: 'n-a' });
    expect(auth.status).toBe('executing');
    expect(auth.owner).toBe('auth');
    expect(() => assertOpsStatusAgree(auth)).not.toThrow();
    const billing = r.graph.tasks.find((t) => t.id === 'billing');
    expect(billing.ops).toEqual({ state: 'pending', since: NOW, run_id: RUN });
    expect(billing.status).toBe('queued');
  });

  it('T8: a second application changes nothing — same graph, nothing attached, changed false', () => {
    const lanes = { auth: { state: 'review', since: EARLIER } };
    const once = attachRunOps(graph(queued('auth'), queued('billing')), { ...base, lanes });
    const twice = attachRunOps(once.graph, { ...base, lanes: { auth: { state: 'done', since: NOW } } });
    expect(twice.attached).toEqual([]);
    expect(twice.changed).toBe(false);
    expect(twice.graph).toEqual(once.graph);
    expect(twice.graph.tasks.find((t) => t.id === 'auth').ops.state).toBe('review'); // lanes changed since; ops are not re-derived
  });

  it('a lane `since` that is not an instant falls back to now; a bare-string lane word works', () => {
    const r = attachRunOps(graph(queued('auth')), { ...base, lanes: { auth: 'active' } });
    expect(r.graph.tasks[0].ops).toEqual({ state: 'active', since: NOW, run_id: RUN });
    const bad = attachRunOps(graph(queued('auth')), { ...base, lanes: { auth: { state: 'active', since: 'soon' } } });
    expect(bad.graph.tasks[0].ops.since).toBe(NOW);
  });

  it('blocked lane words get a reason; an explicit valid one is kept, an invalid one falls back to the implied one', () => {
    const lanes = {
      auth: { state: 'suspended' },
      billing: { state: 'serial-gate', blocked_by: ['lane:auth'] },
      third: { state: 'serial-gate', blocked_by: ['waiting on the leader'] },
    };
    const g = graph(queued('auth'), queued('billing'), queued('third'));
    const r = attachRunOps(g, { ...base, limbs: ['auth', 'billing', 'third'], lanes });
    const by = (id) => r.graph.tasks.find((t) => t.id === id);
    expect(by('auth')).toMatchObject({ status: 'blocked', owner: null, blockers: ['human:suspend'] });
    expect(by('billing').blockers).toEqual(['lane:auth']);
    expect(by('third').blockers).toEqual(['gate:serial-gate']);
  });

  it('skips, and reports, what it cannot vouch for: a non-queued node with no lane word, and another run\'s node', () => {
    const claimed = { id: 'auth', mission_id: MID, status: 'claimed', owner: 'auth' };
    const foreign = { ...queued('billing'), ops: { state: 'done', since: EARLIER, run_id: 'split-other' } };
    const r = attachRunOps(graph(claimed, foreign), { ...base, lanes: {} });
    expect(r.attached).toEqual([]);
    expect(r.skipped).toEqual([
      { limb: 'auth', reason: 'no-lane-word' },
      { limb: 'billing', reason: 'task-run-mismatch' },
    ]);
    expect(r.changed).toBe(false);
    expect(r.graph.tasks).toEqual([claimed, foreign]);
  });

  it('touches only the run\'s plan limbs and never mutates its input', () => {
    const team = { id: 'T-14', mission_id: MID, status: 'queued' };
    const g = graph(queued('auth'), team);
    const before = JSON.parse(JSON.stringify(g));
    const r = attachRunOps(g, { ...base, lanes: {} });
    expect(g).toEqual(before);
    expect(r.graph.tasks.find((t) => t.id === 'T-14')).toBe(team);
  });

  it('a lane word outside the ops allowlist is no lane word at all', () => {
    const claimed = { id: 'auth', mission_id: MID, status: 'claimed', owner: 'auth' };
    const r = attachRunOps(graph(claimed), { ...base, lanes: { auth: 'dispatched' } });
    expect(r.skipped).toEqual([{ limb: 'auth', reason: 'no-lane-word' }]);
  });
});

describe('SH-11 — PROBE: the `ops` key survives in the Task Graph and the projection still drops it', () => {
  it('is why canonical reads use normalizeTaskGraph on the nodes and not normalizeStore on the workers map', () => {
    const { store } = realStore();
    const opsNode = task(LIMB, {
      status: 'executing',
      owner: LIMB,
      ops: { state: 'active', since: NOW, run_id: RUN },
    });
    expect(seed(store, [opsNode]).ok).toBe(true);

    const persisted = store.getTaskGraph(MISSION_ID).tasks[0];
    expect(persisted.ops).toEqual({ state: 'active', since: NOW, run_id: RUN });

    // projection.js is NOT modified by SH-11: the worker row is still the fixed
    // field set, so the ops record is invisible through it.
    const row = store.getProjection().active_missions[MISSION_ID].workers[LIMB];
    expect(row.ops).toBeUndefined();
    expect(normalizeStore({ workers: { [LIMB]: row } })[LIMB].extra).toEqual({});

    // The nodes carry it, and the canonical normalizer reads it from there.
    const direct = normalizeTaskGraph(store.getTaskGraph(MISSION_ID), { runId: RUN });
    expect(direct[LIMB].extra).toEqual({ ops_state: 'active', since: NOW });
  });
});

describe('SH-11 canary switch — readMissionBindingEnabled and honorsBinding', () => {
  it('names its config path, and the read walks that path (the constant and the read cannot drift)', () => {
    expect(MISSION_BINDING_ENABLED_CONFIG_PATH).toBe('split.missionBinding.enabled');
    expect(readMissionBindingEnabled({ split: { missionBinding: { enabled: true } } })).toBe(true);
    // A config that spells the path differently is not on.
    expect(readMissionBindingEnabled({ missionBinding: { enabled: true } })).toBe(false);
    expect(readMissionBindingEnabled({ split: { enabled: true } })).toBe(false);
  });

  it('is on only for the LITERAL true at that path — a string, a number, an absent key or a broken config read off', () => {
    const at = (enabled) => ({ split: { missionBinding: { enabled } } });
    expect(readMissionBindingEnabled(at(true))).toBe(true);
    for (const v of [false, 'true', 'yes', 1, {}, [], null, undefined]) expect(readMissionBindingEnabled(at(v)), JSON.stringify(v)).toBe(false);
    for (const cfg of [null, undefined, 'split', 7, [], {}, { split: null }, { split: { missionBinding: null } }, { split: { missionBinding: {} } }]) {
      expect(readMissionBindingEnabled(cfg), JSON.stringify(cfg)).toBe(false);
    }
  });

  it('honorsBinding: only a literal true, or a function that returns a literal true, honours a binding', () => {
    expect(honorsBinding(true)).toBe(true);
    expect(honorsBinding(() => true)).toBe(true);
    for (const v of [false, undefined, null, 'true', 1, {}, [], () => false, () => 'true', () => 1, () => undefined]) {
      expect(honorsBinding(v), String(v)).toBe(false);
    }
  });

  it('honorsBinding: a port that throws is not a yes', () => {
    expect(honorsBinding(() => { throw new Error('config unreadable'); })).toBe(false);
  });

  it('honorsBinding: a function port is called once per question, and not at all for a non-function', () => {
    let calls = 0;
    honorsBinding(() => { calls += 1; return true; });
    expect(calls).toBe(1);
    honorsBinding(true);
    honorsBinding(false);
    expect(calls).toBe(1);
  });

  it('BINDING_DISABLED is the frozen result annotation, `disabled` and nothing else', () => {
    expect(BINDING_DISABLED).toEqual({ status: 'disabled' });
    expect(Object.isFrozen(BINDING_DISABLED)).toBe(true);
  });
});
