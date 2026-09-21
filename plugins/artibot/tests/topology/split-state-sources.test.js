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
 * ── What this file still does NOT prove (rules §9, next to the gate) ───────
 *  - It does NOT prove that `writeWorkerState` can write to the store. It
 *    cannot today, and the three reasons are measured, not argued: the split
 *    surface has no `M-YYYYMMDD-…` mission id the store requires
 *    (`lib/project-state/validate.js#MISSION_ID_PATTERN`), a worker row is a
 *    five-field projection of ONE task with nowhere to put the ops keys
 *    (`lib/project-state/projection.js#projectWorker`, pinned below), and the
 *    only production caller of the write cannot supply the `appendEvent` and
 *    `sessionId` that `createStateStore` requires. No port is added here.
 *  - It does NOT prove any `/split` run has ever used a store. Zero callers
 *    pass `storeReader` in production; the interlock below is the contract a
 *    future port must satisfy, measured, not a description of live traffic.
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

import { validateTask } from '../../lib/project-state/validate.js';
import { LANE_STATES } from '../../lib/supervisor/contracts.js';
import { readWorkerState } from '../../lib/topology/split-state.js';
import {
  isPlainObject,
  LANE_STATE_TO_V11,
  normalizeEvents,
  normalizeRunJson,
  normalizeStore,
  OPS_IMPLIED_BLOCKED_BY,
  ownsFromPlan,
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
