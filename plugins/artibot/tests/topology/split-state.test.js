/**
 * Tests for `lib/topology/split-state.js` and its sibling
 * `split-state-sources.js` (PRD T-46, Observe stage).
 *
 * The sources module is exercised THROUGH the public API: its normalizers are
 * reached by every read test, and testing them by their own export would pin
 * an internal seam the split just moved. The cost, stated not hidden — a
 * normalizer bug the merge masks would not be caught here.
 *
 * What these tests DO cover: the store -> run.json -> events priority applied
 * per worker, the `source` the read reports, `conflicts[]` as evidence,
 * the ops -> v1.1 conversion for ALL NINE ops words, the heartbeat priority
 * (`assessLane`'s rule, NOT `max`) and its `heartbeat_source` label,
 * `plan.json.affectedPaths` -> `owns[]`, that a write touches exactly one file
 * and stamps `projected_from`, the refusals, ledger-BEFORE-store ordering with
 * the store abandoned on a refusal, every skip reason, a strict clock port
 * that throws rather than falling back, and that every port is a no-op when
 * absent. Real files, real tmpdirs — no fs mocking.
 *
 * WHAT THEY DO NOT COVER (next to the gate, so the gate does not become the
 * next illusion — rules §9):
 *  - The StateStore, in the FIRST half of this file. It EXISTS
 *    (`lib/project-state/state-manager.js#createStateStore`), but every
 *    `storeReader` in the describes above the SH-11 block is a fixture this
 *    file wrote, so "store wins" there is proven about the priority code and
 *    about NOTHING on disk. The interlock against a real store — a seeded
 *    mission projected through `getProjection()` into `normalizeStore` and on
 *    into `readWorkerState` — is pinned in the sibling
 *    `split-state-sources.test.js`. The SH-11 block at the END of this file is
 *    the other half: a BOUND run against a real `createStateStore` in a
 *    tmpdir — the write (ledger -> one store commit -> run.json projection),
 *    its refusals, the CAS retry, the projection failure, the canonical read
 *    and the binding writer.
 *  - The real writer. The payload is checked against the SHIPPED
 *    `schemas/ledger-events.allowlist.json`, not against
 *    `event-writer.js#writeEvent` itself: `lib/topology` is L4 and the writer
 *    is L5, so these tests cannot import it any more than the module can. They
 *    prove the required keys and an allowed source are present; they do NOT
 *    prove a line ever lands in a ledger file. The envelope schema, the byte
 *    cap, redaction and the `mission_id` fallback are all unexercised.
 *  - The supervisor ledger, which is a DIFFERENT destination: its
 *    `contracts.js#validateEvent` rejects a dotted `type`, so routing there
 *    still needs the `event-types.js` alias nobody has written.
 *  - Crash-safety itself. "Ledger first" is verified by observing that
 *    `run.json` does not exist when the port is called. No test kills a
 *    process between the two steps, so `ledger ⊇ store` under a real crash is
 *    argued, not measured.
 *  - Concurrency. `writeWorkerState` is read-modify-write with no lock; two
 *    writers racing on one `run.json` are untested and unhandled here.
 *  - Scale. Fixtures hold 1-3 lanes; a live `/split` run.json is hundreds of
 *    free-form lines (Ontology, 2026-08-31). "Preserves other keys" is proven
 *    on a handful of keys, not on a live file.
 *  - Whether the heartbeat priority is the right liveness rule. These tests
 *    prove it matches `lane-monitor.js#assessLane` — one judge, not two — and
 *    nothing more. No live run has been measured against it, and a lane whose
 *    heartbeat emitter is dead (emitters: 0 today) will report a stale
 *    heartbeat while its commits move; that is the rule working as specified,
 *    and no test here can tell you whether it is the rule you want.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bindRunToMission,
  PROJECTION_MARK,
  readMissionBinding,
  readWorkerState,
  STATE_SOURCES,
  STORE_PROJECTION_MARK,
  workerTransitionIdempotencyKey,
  writeWorkerState,
} from '../../lib/topology/split-state.js';
import { createStateStore, readJournal } from '../../lib/project-state/state-manager.js';
import { LANE_OPS_STATES, LANE_OPS_TO_V11_STATUS, V11_STATUSES } from '../../lib/supervisor/contracts.js';
import { assessLane } from '../../lib/supervisor/lane-monitor.js';

/** The shipped allowlist, so the payload is checked against reality, not a copy. */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** @type {string[]} */
const tmpdirs = [];

/**
 * A `/split` run directory in the canonical `<root>/.artibot/split` layout, so
 * the reuse branch through `lib/git/split-run-file.js` is what the tests
 * exercise by default.
 *
 * @param {{ plan?: object, run?: object, canonical?: boolean }} [seed]
 * @returns {string} runDir
 */
function makeRunDir({ plan, run, canonical = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'split-state-'));
  tmpdirs.push(root);
  const dir = canonical ? path.join(root, '.artibot', 'split') : path.join(root, 'elsewhere');
  fs.mkdirSync(dir, { recursive: true });
  if (plan) fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan, null, 2));
  if (run) fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run, null, 2));
  return dir;
}

/**
 * @param {string} runDir
 * @returns {object}
 */
function readRun(runDir) {
  return JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf-8'));
}

afterEach(() => {
  while (tmpdirs.length) fs.rmSync(tmpdirs.pop(), { recursive: true, force: true });
});

describe('readWorkerState — three-source priority', () => {
  it('store wins over run.json and events for the same worker', () => {
    const runDir = makeRunDir({ run: { lanes: { alpha: { state: 'active' } } } });
    const out = readWorkerState({
      runDir,
      storeReader: () => ({ workers: { alpha: { status: 'reviewing' } } }),
      eventsReader: () => ({ lanes: { alpha: { state: 'DONE' } } }),
    });
    expect(out.workers.alpha.status).toBe('reviewing');
    expect(out.workers.alpha.source).toBe('store');
    expect(out.source).toBe('store');
  });

  it('run.json wins over events when the store is silent', () => {
    const runDir = makeRunDir({ run: { lanes: { alpha: { state: 'review' } } } });
    const out = readWorkerState({ runDir, eventsReader: () => ({ lanes: { alpha: { state: 'DONE' } } }) });
    expect(out.workers.alpha.status).toBe('reviewing');
    expect(out.workers.alpha.source).toBe('run.json');
    expect(out.source).toBe('run.json');
  });

  it('events answer when nothing else names the worker', () => {
    const runDir = makeRunDir({});
    const out = readWorkerState({ runDir, eventsReader: () => ({ lanes: { alpha: { state: 'RUNNING' } } }) });
    expect(out.workers.alpha.status).toBe('executing');
    expect(out.source).toBe('events');
  });

  it('priority is per worker, and `source` names the highest source that answered at all', () => {
    const runDir = makeRunDir({ run: { lanes: { beta: { state: 'active' } } } });
    const out = readWorkerState({
      runDir,
      storeReader: () => ({ workers: { alpha: { status: 'queued' } } }),
      eventsReader: () => ({ lanes: { gamma: { state: 'DONE' } } }),
    });
    expect(out.workers.alpha.source).toBe('store');
    expect(out.workers.beta.source).toBe('run.json');
    expect(out.workers.gamma.source).toBe('events');
    expect(out.source).toBe('store');
  });

  it('an empty run directory reads as no workers and no source (fail-closed, not a guess)', () => {
    const out = readWorkerState({ runDir: makeRunDir({}) });
    expect(out.workers).toEqual({});
    expect(out.source).toBeNull();
    expect(out.conflicts).toEqual([]);
  });

  it('reads a non-canonical run directory directly instead of refusing it', () => {
    const runDir = makeRunDir({ run: { lanes: { alpha: 'done' } }, canonical: false });
    expect(readWorkerState({ runDir }).workers.alpha.status).toBe('done');
  });

  it('a corrupt run.json throws rather than reading as an empty run', () => {
    const runDir = makeRunDir({});
    fs.writeFileSync(path.join(runDir, 'run.json'), '{ not json');
    expect(() => readWorkerState({ runDir })).toThrow();
  });

  it('requires runDir', () => {
    expect(() => readWorkerState({})).toThrow(/runDir is required/);
  });

  it('STATE_SOURCES states the priority order', () => {
    expect(STATE_SOURCES).toEqual(['store', 'run.json', 'events']);
  });
});

describe('readWorkerState — ops vocabulary conversion (all 9 words)', () => {
  it('converts every ops word exactly as LANE_OPS_TO_V11_STATUS says', () => {
    const lanes = Object.fromEntries(LANE_OPS_STATES.map((ops) => [`limb-${ops}`, { state: ops }]));
    const out = readWorkerState({ runDir: makeRunDir({ run: { lanes } }) });
    expect(Object.keys(out.workers)).toHaveLength(9);
    for (const ops of LANE_OPS_STATES) {
      const rec = out.workers[`limb-${ops}`];
      expect(rec.status, ops).toBe(LANE_OPS_TO_V11_STATUS[ops]);
      expect(V11_STATUSES).toContain(rec.status);
      // The ops word survives even where `status` collapses two of them.
      expect(rec.ops_state, ops).toBe(ops);
    }
    // The two documented collapses, asserted rather than described.
    expect(out.workers['limb-active'].status).toBe(out.workers['limb-closing'].status);
    expect(out.workers['limb-serial-gate'].status).toBe(out.workers['limb-suspended'].status);
  });

  it('accepts the bare-string lane shape as well as the object shape', () => {
    const runDir = makeRunDir({ run: { lanes: { alpha: 'active', beta: { state: 'active' } } } });
    const out = readWorkerState({ runDir });
    expect(out.workers.alpha.status).toBe('executing');
    expect(out.workers.beta.status).toBe('executing');
  });

  it('an ops word outside the allowlist reads as unknown, not as a guess', () => {
    const runDir = makeRunDir({ run: { lanes: { alpha: { state: 'wat' } } } });
    const out = readWorkerState({ runDir });
    expect(out.workers.alpha.status).toBeNull();
    expect(out.workers.alpha.ops_state).toBeUndefined();
  });

  it('derives blocked_by from the ops word, and an explicit list wins over it', () => {
    const runDir = makeRunDir({
      run: {
        lanes: {
          held: { state: 'suspended' },
          gated: { state: 'serial-gate' },
          explicit: { state: 'serial-gate', blocked_by: ['lane:alpha'] },
          running: { state: 'active' },
        },
      },
    });
    const out = readWorkerState({ runDir });
    expect(out.workers.held.blocked_by).toEqual(['human:suspend']);
    expect(out.workers.gated.blocked_by).toEqual(['gate:serial-gate']);
    expect(out.workers.explicit.blocked_by).toEqual(['lane:alpha']);
    expect(out.workers.running.blocked_by).toEqual([]);
  });

  it('maps lane words to v1.1 and leaves the four unmapped ones null', () => {
    const runDir = makeRunDir({});
    const out = readWorkerState({
      runDir,
      eventsReader: () => ({
        lanes: {
          a: { state: 'WAITING_INPUT' },
          b: { state: 'REVIEW_REQUIRED' },
          c: { state: 'CHECKPOINTING' },
          d: { state: 'FAILED_TERMINAL' },
        },
      }),
    });
    expect(out.workers.a.status).toBe('blocked');
    expect(out.workers.b.status).toBe('reviewing');
    expect(out.workers.c.status).toBeNull();
    expect(out.workers.c.lane_state).toBe('CHECKPOINTING');
    expect(out.workers.d.status).toBeNull();
  });

  it('preserves the extra keys each source carries', () => {
    const runDir = makeRunDir({ run: { lanes: { alpha: { state: 'active', window: 'w-1', note: 'why' } } } });
    const out = readWorkerState({ runDir });
    expect(out.workers.alpha.window).toBe('w-1');
    expect(out.workers.alpha.note).toBe('why');
  });
});

describe('readWorkerState — owns from plan.json', () => {
  const plan = { limbs: [{ limb: 'alpha', affectedPaths: ['lib/a/**', 'tests/a/**'] }, { limb: 'beta', affectedPaths: [] }] };

  it('projects plan.json affectedPaths onto owns[]', () => {
    const runDir = makeRunDir({ plan, run: { lanes: { alpha: { state: 'active' } } } });
    expect(readWorkerState({ runDir }).workers.alpha.owns).toEqual(['lib/a/**', 'tests/a/**']);
  });

  it('plan.json beats a source that claims different paths, and the disagreement is recorded', () => {
    const runDir = makeRunDir({ plan, run: { lanes: { alpha: { state: 'active' } } } });
    const out = readWorkerState({ runDir, storeReader: () => ({ workers: { alpha: { status: 'executing', owns: ['lib/other/**'] } } }) });
    expect(out.workers.alpha.owns).toEqual(['lib/a/**', 'tests/a/**']);
    const conflict = out.conflicts.find((c) => c.field === 'owns');
    expect(conflict.worker).toBe('alpha');
    expect(conflict.values.map((v) => v.source)).toEqual(['plan.json', 'store']);
  });

  it('falls back to the winning source when the plan does not list the limb', () => {
    const runDir = makeRunDir({ plan, run: {} });
    const out = readWorkerState({ runDir, eventsReader: () => ({ lanes: { gamma: { state: 'RUNNING', ownedPaths: ['lib/g/**'] } } }) });
    expect(out.workers.gamma.owns).toEqual(['lib/g/**']);
  });
});

describe('readWorkerState — conflicts are evidence, not a verdict', () => {
  it('records a status disagreement with every stating source, in priority order', () => {
    const runDir = makeRunDir({ run: { lanes: { alpha: { state: 'active' } } } });
    const out = readWorkerState({
      runDir,
      storeReader: () => ({ workers: { alpha: { status: 'reviewing' } } }),
      eventsReader: () => ({ lanes: { alpha: { state: 'DONE' } } }),
    });
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]).toMatchObject({ worker: 'alpha', field: 'status' });
    expect(out.conflicts[0].values).toEqual([
      { source: 'store', value: 'reviewing' },
      { source: 'run.json', value: 'executing' },
      { source: 'events', value: 'done' },
    ]);
    // Recorded, not resolved: the winner is still the priority answer.
    expect(out.workers.alpha.status).toBe('reviewing');
  });

  it('agreement across sources is not a conflict', () => {
    const runDir = makeRunDir({ run: { lanes: { alpha: { state: 'done' } } } });
    const out = readWorkerState({ runDir, eventsReader: () => ({ lanes: { alpha: { state: 'DONE' } } }) });
    expect(out.conflicts).toEqual([]);
  });

  it('a source that states nothing readable is a gap, not a disagreement', () => {
    const runDir = makeRunDir({ run: { lanes: { alpha: { state: 'active' } } } });
    const out = readWorkerState({ runDir, eventsReader: () => ({ lanes: { alpha: { state: 'FIXING' } } }) });
    expect(out.workers.alpha.status).toBe('executing');
    expect(out.conflicts).toEqual([]);
  });
});

describe('readWorkerState — heartbeat derivation', () => {
  const hb = '2026-09-02T10:00:00.000Z';
  const older = '2026-09-02T09:00:00.000Z';
  const newer = '2026-09-02T11:00:00.000Z';

  it('keeps the lane heartbeat even when the commit is NEWER (assessLane priority, not max)', () => {
    const runDir = makeRunDir({ run: { lanes: { alpha: { state: 'active' } } } });
    const out = readWorkerState({
      runDir,
      storeReader: () => ({ workers: { alpha: { status: 'executing', heartbeat_at: hb } } }),
      commitReader: () => newer,
    });
    expect(out.workers.alpha.heartbeat_at).toBe(hb);
    expect(out.workers.alpha.heartbeat_source).toBe('lane-heartbeat');
  });

  it('keeps the lane heartbeat when it is newer', () => {
    const runDir = makeRunDir({ run: { lanes: { alpha: { state: 'active' } } } });
    const out = readWorkerState({
      runDir,
      storeReader: () => ({ workers: { alpha: { status: 'executing', heartbeat_at: hb } } }),
      commitReader: () => older,
    });
    expect(out.workers.alpha.heartbeat_at).toBe(hb);
    expect(out.workers.alpha.heartbeat_source).toBe('lane-heartbeat');
  });

  it('falls through to the commit when the heartbeat is unparseable, as assessLane does', () => {
    const runDir = makeRunDir({ run: { lanes: { alpha: { state: 'active' } } } });
    const out = readWorkerState({
      runDir,
      storeReader: () => ({ workers: { alpha: { status: 'executing', heartbeat_at: 'not-a-date' } } }),
      commitReader: () => older,
    });
    expect(out.workers.alpha.heartbeat_at).toBe(older);
    expect(out.workers.alpha.heartbeat_source).toBe('last-commit');
  });

  it('agrees with lane-monitor#assessLane on which signal it used, for every heartbeat/commit pair', () => {
    const pairs = [
      [hb, newer], [hb, older], [hb, null], [null, newer], [null, null], ['not-a-date', older],
    ];
    for (const [heartbeat, commit] of pairs) {
      const runDir = makeRunDir({ run: { lanes: { alpha: { state: 'active' } } } });
      const mine = readWorkerState({
        runDir,
        storeReader: () => ({ workers: { alpha: { status: 'executing', heartbeat_at: heartbeat } } }),
        commitReader: () => commit,
      }).workers.alpha;
      const theirs = assessLane({
        lane: { state: 'RUNNING', lastHeartbeatAt: heartbeat },
        gitEvidence: { lastCommitAt: commit },
        nowMs: Date.parse('2026-09-02T12:00:00.000Z'),
      });
      const expected = { heartbeat: 'lane-heartbeat', commit: 'last-commit', none: null }[theirs.signal];
      expect(mine.heartbeat_source, `heartbeat=${heartbeat} commit=${commit}`).toBe(expected);
    }
  });

  it('uses the commit alone when run.json wins the record (run.json carries no heartbeat)', () => {
    const runDir = makeRunDir({ run: { lanes: { alpha: { state: 'active', since: older } } } });
    const out = readWorkerState({ runDir, commitReader: (worker) => (worker === 'alpha' ? newer : null) });
    expect(out.workers.alpha.heartbeat_at).toBe(newer);
    expect(out.workers.alpha.heartbeat_source).toBe('last-commit');
    // `since` is a state-change time and must never be read as liveness.
    expect(out.workers.alpha.since).toBe(older);
  });

  it('takes the lane-heartbeat component from a lower-priority source when the winner has none', () => {
    const runDir = makeRunDir({ run: { lanes: { alpha: { state: 'active' } } } });
    const out = readWorkerState({ runDir, eventsReader: () => ({ lanes: { alpha: { state: 'RUNNING', lastHeartbeatAt: hb } } }) });
    expect(out.workers.alpha.source).toBe('run.json');
    expect(out.workers.alpha.heartbeat_at).toBe(hb);
    expect(out.workers.alpha.heartbeat_source).toBe('lane-heartbeat');
  });

  it('keeps a store-declared heartbeat_source instead of relabelling it', () => {
    const runDir = makeRunDir({});
    const out = readWorkerState({
      runDir,
      storeReader: () => ({ workers: { alpha: { status: 'executing', heartbeat_at: hb, heartbeat_source: 'commit' } } }),
    });
    expect(out.workers.alpha.heartbeat_source).toBe('commit');
  });

  it('is null with no signal at all, and an unparseable timestamp never wins', () => {
    const runDir = makeRunDir({ run: { lanes: { alpha: { state: 'active' }, beta: { state: 'active' } } } });
    const out = readWorkerState({ runDir, commitReader: (w) => (w === 'beta' ? 'not-a-date' : null) });
    expect(out.workers.alpha.heartbeat_at).toBeNull();
    expect(out.workers.alpha.heartbeat_source).toBeNull();
    expect(out.workers.beta.heartbeat_at).toBeNull();
  });
});

describe('readWorkerState — ports are no-ops when absent', () => {
  it('reads run.json alone with no port supplied', () => {
    const runDir = makeRunDir({ run: { lanes: { alpha: { state: 'active' } } } });
    const out = readWorkerState({ runDir });
    expect(out.source).toBe('run.json');
    expect(out.workers.alpha.heartbeat_at).toBeNull();
  });

  it('tolerates ports that return null or a non-object', () => {
    const runDir = makeRunDir({ run: { lanes: { alpha: { state: 'active' } } } });
    const out = readWorkerState({ runDir, storeReader: () => null, eventsReader: () => 'nope', commitReader: () => undefined });
    expect(out.source).toBe('run.json');
    expect(Object.keys(out.workers)).toEqual(['alpha']);
  });

  it('passes the resolved runDir to the readers', () => {
    const runDir = makeRunDir({});
    let seen = null;
    readWorkerState({ runDir, storeReader: (ctx) => { seen = ctx.runDir; return null; } });
    expect(seen).toBe(path.resolve(runDir));
  });
});

describe('writeWorkerState — one destination, marked as a projection', () => {
  it('writes run.json.lanes[worker] and nothing else in the directory', () => {
    const runDir = makeRunDir({ plan: { limbs: [{ limb: 'alpha', affectedPaths: ['lib/a/**'] }] } });
    const before = fs.readFileSync(path.join(runDir, 'plan.json'), 'utf-8');
    const res = writeWorkerState({ runDir, worker: 'alpha', patch: { status: 'executing' }, now: () => new Date('2026-09-02T12:00:00.000Z') });

    expect(res.ok).toBe(true);
    expect(res.path).toBe(path.join(runDir, 'run.json'));
    expect(res.opsState).toBe('active');
    expect(res.status).toBe('executing');
    expect(readRun(runDir).lanes.alpha).toMatchObject({
      state: 'active',
      since: '2026-09-02T12:00:00.000Z',
      updated_at: '2026-09-02T12:00:00.000Z',
      projected_from: PROJECTION_MARK,
    });
    expect(fs.readdirSync(runDir).sort()).toEqual(['plan.json', 'run.json']);
    expect(fs.readFileSync(path.join(runDir, 'plan.json'), 'utf-8')).toBe(before);
  });

  it('does not write the v1.1 status word beside the ops word', () => {
    const runDir = makeRunDir({});
    writeWorkerState({ runDir, worker: 'alpha', patch: { status: 'reviewing' } });
    expect(readRun(runDir).lanes.alpha.status).toBeUndefined();
    expect(readRun(runDir).lanes.alpha.state).toBe('review');
  });

  it('preserves every other run.json key and every other lane', () => {
    const runDir = makeRunDir({ run: { runId: 'r-1', metrics: { lanes: 3 }, lanes: { beta: { state: 'done', note: 'kept' } } } });
    writeWorkerState({ runDir, worker: 'alpha', patch: { status: 'queued' } });
    const run = readRun(runDir);
    expect(run.runId).toBe('r-1');
    expect(run.metrics).toEqual({ lanes: 3 });
    expect(run.lanes.beta).toEqual({ state: 'done', note: 'kept' });
    expect(run.lanes.alpha.state).toBe('pending');
  });

  it('keeps `since` when the state is re-asserted and moves it when the state changes', () => {
    const runDir = makeRunDir({});
    writeWorkerState({ runDir, worker: 'alpha', patch: { status: 'executing' }, now: () => new Date('2026-09-02T12:00:00.000Z') });
    writeWorkerState({ runDir, worker: 'alpha', patch: { status: 'executing', note: 'still going' }, now: () => new Date('2026-09-02T13:00:00.000Z') });
    expect(readRun(runDir).lanes.alpha).toMatchObject({ since: '2026-09-02T12:00:00.000Z', updated_at: '2026-09-02T13:00:00.000Z', note: 'still going' });

    writeWorkerState({ runDir, worker: 'alpha', patch: { status: 'reviewing' }, now: () => new Date('2026-09-02T14:00:00.000Z') });
    expect(readRun(runDir).lanes.alpha.since).toBe('2026-09-02T14:00:00.000Z');
  });

  it('round-trips a blocked reason that the ops word alone would lose', () => {
    const runDir = makeRunDir({});
    writeWorkerState({ runDir, worker: 'alpha', patch: { status: 'blocked', blocked_by: ['human:suspend'] } });
    expect(readRun(runDir).lanes.alpha.state).toBe('suspended');

    const back = readWorkerState({ runDir }).workers.alpha;
    expect(back.status).toBe('blocked');
    expect(back.blocked_by).toEqual(['human:suspend']);
    expect(back.ops_state).toBe('suspended');
  });

  it('chooses serial-gate for a blocked worker with no human reason', () => {
    const runDir = makeRunDir({});
    writeWorkerState({ runDir, worker: 'alpha', patch: { status: 'blocked', blocked_by: ['lane:beta'] } });
    expect(readRun(runDir).lanes.alpha.state).toBe('serial-gate');
    expect(readWorkerState({ runDir }).workers.alpha.blocked_by).toEqual(['lane:beta']);
  });

  it('reaches `closing` only through an explicit ops_state', () => {
    const runDir = makeRunDir({});
    writeWorkerState({ runDir, worker: 'alpha', patch: { status: 'executing' } });
    expect(readRun(runDir).lanes.alpha.state).toBe('active');
    writeWorkerState({ runDir, worker: 'alpha', patch: { ops_state: 'closing' } });
    expect(readRun(runDir).lanes.alpha.state).toBe('closing');
  });

  it('writes into a non-canonical run directory too', () => {
    const runDir = makeRunDir({ canonical: false });
    writeWorkerState({ runDir, worker: 'alpha', patch: { status: 'done' } });
    expect(readRun(runDir).lanes.alpha.state).toBe('done');
  });
});

describe('writeWorkerState — refusals are fail-closed', () => {
  it('refuses a status outside the v1.1 vocabulary', () => {
    const runDir = makeRunDir({});
    expect(() => writeWorkerState({ runDir, worker: 'alpha', patch: { status: 'active' } })).toThrow(/not a v1.1 status/);
    expect(fs.existsSync(path.join(runDir, 'run.json'))).toBe(false);
  });

  it('refuses `cancelled`, which has no ops word, instead of writing a wrong one', () => {
    const runDir = makeRunDir({});
    expect(() => writeWorkerState({ runDir, worker: 'alpha', patch: { status: 'cancelled' } })).toThrow(/has no ops word/);
    expect(fs.existsSync(path.join(runDir, 'run.json'))).toBe(false);
  });

  it('refuses an ops_state outside the allowlist', () => {
    const runDir = makeRunDir({});
    expect(() => writeWorkerState({ runDir, worker: 'alpha', patch: { ops_state: 'wat' } })).toThrow(/ops allowlist/);
  });

  it('refuses an ops_state that contradicts the status given with it', () => {
    const runDir = makeRunDir({});
    expect(() => writeWorkerState({ runDir, worker: 'alpha', patch: { status: 'done', ops_state: 'active' } }))
      .toThrow(/not the given status/);
  });

  it('refuses a missing worker or a non-object patch', () => {
    const runDir = makeRunDir({});
    expect(() => writeWorkerState({ runDir })).toThrow(/worker is required/);
    expect(() => writeWorkerState({ runDir, worker: 'alpha', patch: [] })).toThrow(/plain object/);
  });
});

describe('writeWorkerState — ledger payload matches the event-writer contract', () => {
  const plan = { limbs: [{ limb: 'alpha', affectedPaths: ['lib/a/**'] }] };
  const claimLedger = { session_id: 's-1', mission_id: 'M-20260902-001', agent_type: 'artibot:backend-developer', model_tier: 'opus' };

  it('builds a worker.claimed envelope the writer would accept', () => {
    const runDir = makeRunDir({ plan });
    const events = [];
    const res = writeWorkerState({
      runDir, worker: 'alpha', patch: { status: 'claimed' }, ledger: claimLedger, appendEvent: (e) => events.push(e),
    });
    expect(events).toEqual([{
      event: 'worker.claimed',
      session_id: 's-1',
      mission_id: 'M-20260902-001',
      source: 'supervisor',
      worker: 'alpha',
      data: { agent_type: 'artibot:backend-developer', model_tier: 'opus', owns: ['lib/a/**'] },
    }]);
    expect(res.ledger).toBe('appended');
    expect(res.event).toEqual(events[0]);
  });

  it('satisfies the allowlist for both events: required data keys, required envelope, and an allowed source', () => {
    const allowlist = JSON.parse(fs.readFileSync(path.join(repoRoot, 'schemas/ledger-events.allowlist.json'), 'utf-8')).events;
    const seen = {};

    const claimDir = makeRunDir({ plan });
    writeWorkerState({ runDir: claimDir, worker: 'alpha', patch: { status: 'claimed' }, ledger: claimLedger, appendEvent: (e) => { seen['worker.claimed'] = e; } });
    const relDir = makeRunDir({ plan });
    writeWorkerState({ runDir: relDir, worker: 'alpha', patch: { status: 'done' }, ledger: { session_id: 's-1' }, appendEvent: (e) => { seen['task.released'] = e; } });

    for (const [name, envelope] of Object.entries(seen)) {
      const spec = allowlist[name];
      expect(spec, name).toBeTruthy();
      expect(spec.sources, `${name} source`).toContain(envelope.source);
      for (const key of spec.required ?? []) {
        expect(Object.prototype.hasOwnProperty.call(envelope.data, key), `${name} data.${key}`).toBe(true);
      }
      for (const key of spec.required_envelope ?? []) {
        expect(envelope[key], `${name} envelope.${key}`).toBeDefined();
      }
      // The writer assembles these; a caller that sends them invents a field.
      for (const key of ['v', 'ts', 'pid', 'seq']) expect(envelope[key], `${name} ${key}`).toBeUndefined();
    }
  });

  it('defaults task.released `owner` to the limb name and lets the caller override it', () => {
    const seen = [];
    writeWorkerState({ runDir: makeRunDir({ plan }), worker: 'alpha', patch: { status: 'done' }, ledger: { session_id: 's-1' }, appendEvent: (e) => seen.push(e) });
    writeWorkerState({ runDir: makeRunDir({ plan }), worker: 'alpha', patch: { status: 'done' }, ledger: { session_id: 's-1', owner: 'agent-7' }, appendEvent: (e) => seen.push(e) });
    expect(seen.map((e) => e.data.owner)).toEqual(['alpha', 'agent-7']);
  });

  it('omits mission_id when the caller has none, leaving the writer its own fallback', () => {
    const seen = [];
    writeWorkerState({ runDir: makeRunDir({ plan }), worker: 'alpha', patch: { status: 'done' }, ledger: { session_id: 's-1' }, appendEvent: (e) => seen.push(e) });
    expect(Object.prototype.hasOwnProperty.call(seen[0], 'mission_id')).toBe(false);
  });

  it('keeps ledger identity out of the lane record', () => {
    const runDir = makeRunDir({ plan });
    writeWorkerState({ runDir, worker: 'alpha', patch: { status: 'claimed' }, ledger: claimLedger, appendEvent: () => ({}) });
    const record = readRun(runDir).lanes.alpha;
    for (const key of ['session_id', 'mission_id', 'agent_type', 'model_tier']) {
      expect(record[key], key).toBeUndefined();
    }
  });

  it('owes an event only on the two transitions', () => {
    const runDir = makeRunDir({ plan });
    const events = [];
    for (const status of ['queued', 'executing', 'blocked', 'reviewing']) {
      const res = writeWorkerState({ runDir, worker: 'alpha', patch: { status }, ledger: claimLedger, appendEvent: (e) => events.push(e) });
      expect(res.ledger, status).toBe('skipped:no-event');
    }
    expect(events).toEqual([]);
  });

  it('owes nothing when the state is re-asserted', () => {
    const runDir = makeRunDir({ plan });
    const events = [];
    writeWorkerState({ runDir, worker: 'alpha', patch: { status: 'claimed' }, ledger: claimLedger, appendEvent: (e) => events.push(e) });
    const again = writeWorkerState({ runDir, worker: 'alpha', patch: { status: 'claimed' }, ledger: claimLedger, appendEvent: (e) => events.push(e) });
    expect(events).toHaveLength(1);
    expect(again.ledger).toBe('skipped:no-event');
  });
});

describe('writeWorkerState — idempotency_key names the transition', () => {
  const plan = { runId: 'run-7', limbs: [{ limb: 'alpha', affectedPaths: ['lib/a/**'] }] };
  const claimLedger = { session_id: 's-1', agent_type: 'artibot:backend-developer', model_tier: 'opus' };
  const at = (iso) => () => new Date(iso);

  /** Write through a port that records what it receives. */
  function write(runDir, status, events, extra = {}) {
    return writeWorkerState({
      runDir, worker: 'alpha', patch: { status }, ledger: claimLedger,
      appendEvent: (e) => { events.push(e); return { appended: true }; }, ...extra,
    });
  }

  it('reaches the envelope the port receives, non-empty, for both events', () => {
    const runDir = makeRunDir({ plan });
    const events = [];
    write(runDir, 'claimed', events, { now: at('2026-09-23T01:00:00.000Z') });
    write(runDir, 'done', events, { now: at('2026-09-23T02:00:00.000Z') });
    expect(events.map((e) => e.event)).toEqual(['worker.claimed', 'task.released']);
    expect(events.map((e) => e.idempotency_key)).toEqual([
      'worker.claimed:run-7:alpha:none:awaiting-dispatch:none',
      'task.released:run-7:alpha:awaiting-dispatch:done:2026-09-23T01:00:00.000Z',
    ]);
  });

  it('a retry of the same transition reuses the key, whatever the retry clock says', () => {
    const seed = { lanes: { alpha: { state: 'done', since: '2026-09-22T10:00:00.000Z' } } };
    const runDir = makeRunDir({ plan, run: seed });
    const before = fs.readFileSync(path.join(runDir, 'run.json'), 'utf-8');
    const events = [];
    // Crash between the two halves: the line is appended, run.json never moves.
    write(runDir, 'claimed', events, { now: at('2026-09-23T01:00:00.000Z') });
    fs.writeFileSync(path.join(runDir, 'run.json'), before);
    write(runDir, 'claimed', events, { now: at('2026-09-23T05:00:00.000Z') });
    expect(events).toHaveLength(2);
    expect(events[0].idempotency_key).toMatch(/^worker\.claimed:run-7:alpha:\S+$/);
    expect(events[1].idempotency_key).toBe(events[0].idempotency_key);
  });

  it('a retry after a refused append reuses the key', () => {
    const runDir = makeRunDir({ plan, run: { lanes: { alpha: { state: 'pending', since: '2026-09-22T10:00:00.000Z' } } } });
    const events = [];
    const refused = writeWorkerState({
      runDir, worker: 'alpha', patch: { status: 'claimed' }, ledger: claimLedger,
      appendEvent: (e) => { events.push(e); return { ok: false, reason: 'busy' }; },
      now: at('2026-09-23T01:00:00.000Z'),
    });
    expect(refused.ok).toBe(false);
    write(runDir, 'claimed', events, { now: at('2026-09-23T01:00:09.000Z') });
    expect(events).toHaveLength(2);
    expect(events[0].idempotency_key).toMatch(/^worker\.claimed:run-7:alpha:\S+$/);
    expect(events[1].idempotency_key).toBe(events[0].idempotency_key);
  });

  it('a re-dispatch after a release is a new claim with a new key', () => {
    const runDir = makeRunDir({ plan });
    const events = [];
    write(runDir, 'claimed', events, { now: at('2026-09-23T01:00:00.000Z') });
    write(runDir, 'executing', events, { now: at('2026-09-23T02:00:00.000Z') });
    write(runDir, 'done', events, { now: at('2026-09-23T03:00:00.000Z') });
    write(runDir, 'claimed', events, { now: at('2026-09-23T04:00:00.000Z') });
    const claims = events.filter((e) => e.event === 'worker.claimed');
    expect(claims).toHaveLength(2);
    expect(claims[1].idempotency_key).not.toBe(claims[0].idempotency_key);
    expect(claims[1].idempotency_key).toBe('worker.claimed:run-7:alpha:done:awaiting-dispatch:2026-09-23T03:00:00.000Z');
  });

  it('two releases from one state to different ends are different facts', () => {
    const seed = { lanes: { alpha: { state: 'active', since: '2026-09-22T10:00:00.000Z' } } };
    const events = [];
    // `failed` arrives as a v1.1 status, so the ops word is derived, not spelled.
    for (const status of ['done', 'failed']) write(makeRunDir({ plan, run: seed }), status, events);
    expect(events.map((e) => e.event)).toEqual(['task.released', 'task.released']);
    expect(events[1].idempotency_key).not.toBe(events[0].idempotency_key);
  });

  it('the same limb in another run gets another key', () => {
    const events = [];
    write(makeRunDir({ plan }), 'claimed', events);
    write(makeRunDir({ plan: { ...plan, runId: 'run-8' } }), 'claimed', events);
    expect(events[1].idempotency_key).not.toBe(events[0].idempotency_key);
  });

  it('falls back to run.json runId when plan.json has none', () => {
    const events = [];
    write(makeRunDir({ plan: { limbs: plan.limbs }, run: { runId: 'run-9' } }), 'claimed', events);
    expect(events[0].idempotency_key).toBe('worker.claimed:run-9:alpha:none:awaiting-dispatch:none');
  });

  it('takes the plan.json runId when run.json names a different one', () => {
    const events = [];
    write(makeRunDir({ plan, run: { runId: 'run-other' } }), 'claimed', events);
    expect(events[0].idempotency_key).toBe('worker.claimed:run-7:alpha:none:awaiting-dispatch:none');
  });

  it('omits the key, never an empty string, when no run id exists anywhere', () => {
    const events = [];
    write(makeRunDir({ plan: { limbs: plan.limbs } }), 'claimed', events);
    expect(events).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(events[0], 'idempotency_key')).toBe(false);
  });

  it('keeps the key out of the lane record', () => {
    const runDir = makeRunDir({ plan });
    write(runDir, 'claimed', []);
    expect(readRun(runDir).lanes.alpha.idempotency_key).toBeUndefined();
  });
});

describe('workerTransitionIdempotencyKey', () => {
  const base = { eventName: 'worker.claimed', runId: 'run-7', worker: 'alpha', prevOps: 'done', nextOps: 'awaiting-dispatch', prevSince: '2026-09-23T03:00:00.000Z' };

  it('is deterministic and names every component', () => {
    expect(workerTransitionIdempotencyKey(base)).toBe(workerTransitionIdempotencyKey({ ...base }));
    expect(workerTransitionIdempotencyKey(base)).toBe('worker.claimed:run-7:alpha:done:awaiting-dispatch:2026-09-23T03:00:00.000Z');
  });

  it('changes when any identity component changes', () => {
    const variants = [
      { eventName: 'task.released', nextOps: 'done' },
      { runId: 'run-8' }, { worker: 'beta' }, { prevOps: 'blocked' }, { prevSince: '2026-09-23T03:00:00.001Z' },
    ];
    const keys = new Set([base, ...variants.map((v) => ({ ...base, ...v }))].map(workerTransitionIdempotencyKey));
    expect(keys.size).toBe(variants.length + 1);
  });

  it('is null — not an empty string — without a run id, event or worker', () => {
    for (const miss of [{ runId: undefined }, { runId: '' }, { eventName: null }, { worker: '' }, { nextOps: null }]) {
      expect(workerTransitionIdempotencyKey({ ...base, ...miss }), JSON.stringify(miss)).toBeNull();
    }
  });
});

describe('writeWorkerState — ledger first, store second', () => {
  const plan = { limbs: [{ limb: 'alpha', affectedPaths: ['lib/a/**'] }] };
  const claimLedger = { session_id: 's-1', agent_type: 'artibot:backend-developer', model_tier: 'opus' };

  it('abandons the run.json write when the port returns {appended:false}', () => {
    const runDir = makeRunDir({ plan });
    const res = writeWorkerState({
      runDir, worker: 'alpha', patch: { status: 'claimed' }, ledger: claimLedger,
      appendEvent: () => ({ appended: false, errors: ['source-not-allowed:worker'] }),
    });
    expect(res.ok).toBe(false);
    expect(res.ledger).toBe('refused');
    expect(res.reason).toMatch(/source-not-allowed:worker/);
    expect(fs.existsSync(path.join(runDir, 'run.json'))).toBe(false);
  });

  it('abandons the write when the port returns {ok:false}, which is what writeEvent returns on a rejection', () => {
    const runDir = makeRunDir({ plan });
    const res = writeWorkerState({
      runDir, worker: 'alpha', patch: { status: 'claimed' }, ledger: claimLedger,
      appendEvent: () => ({ ok: false, reason: 'no-project-root' }),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no-project-root/);
    expect(fs.existsSync(path.join(runDir, 'run.json'))).toBe(false);
  });

  it('abandons the write when the port throws', () => {
    const runDir = makeRunDir({ plan });
    const res = writeWorkerState({
      runDir, worker: 'alpha', patch: { status: 'claimed' }, ledger: claimLedger,
      appendEvent: () => { throw new Error('disk full'); },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/disk full/);
    expect(fs.existsSync(path.join(runDir, 'run.json'))).toBe(false);
  });

  it('leaves an EXISTING lane untouched when the port refuses', () => {
    const runDir = makeRunDir({ plan, run: { lanes: { alpha: { state: 'pending', since: '2026-09-01T00:00:00.000Z' } } } });
    const res = writeWorkerState({
      runDir, worker: 'alpha', patch: { status: 'claimed' }, ledger: claimLedger, appendEvent: () => ({ appended: false }),
    });
    expect(res.ok).toBe(false);
    expect(readRun(runDir).lanes.alpha).toEqual({ state: 'pending', since: '2026-09-01T00:00:00.000Z' });
  });

  it('appends before it writes — the port sees no run.json yet', () => {
    const runDir = makeRunDir({ plan });
    let existedAtAppend = null;
    writeWorkerState({
      runDir, worker: 'alpha', patch: { status: 'claimed' }, ledger: claimLedger,
      appendEvent: () => { existedAtAppend = fs.existsSync(path.join(runDir, 'run.json')); return { appended: true }; },
    });
    expect(existedAtAppend).toBe(false);
    expect(readRun(runDir).lanes.alpha.state).toBe('awaiting-dispatch');
  });

  it('an accepted append lets the write proceed', () => {
    const runDir = makeRunDir({ plan });
    const res = writeWorkerState({
      runDir, worker: 'alpha', patch: { status: 'claimed' }, ledger: claimLedger, appendEvent: () => ({ appended: true, ok: true }),
    });
    expect(res.ok).toBe(true);
    expect(res.ledger).toBe('appended');
    expect(readRun(runDir).lanes.alpha.state).toBe('awaiting-dispatch');
  });
});

describe('writeWorkerState — skips are reported, never silent', () => {
  const plan = { limbs: [{ limb: 'alpha', affectedPaths: ['lib/a/**'] }] };
  const claimLedger = { session_id: 's-1', agent_type: 'artibot:backend-developer', model_tier: 'opus' };

  it('no port: writes, reports skipped:no-port, and still shows the envelope it would have sent', () => {
    const runDir = makeRunDir({ plan });
    const res = writeWorkerState({ runDir, worker: 'alpha', patch: { status: 'claimed' }, ledger: claimLedger });
    expect(res.ok).toBe(true);
    expect(res.ledger).toBe('skipped:no-port');
    expect(res.event.event).toBe('worker.claimed');
    expect(readRun(runDir).lanes.alpha.state).toBe('awaiting-dispatch');
  });

  it('names the missing key rather than inventing a value', () => {
    const cases = [
      [{ agent_type: 'a', model_tier: 'opus' }, 'skipped:missing:session_id'],
      [{ session_id: 's-1', model_tier: 'opus' }, 'skipped:missing:agent_type'],
      [{ session_id: 's-1', agent_type: 'a' }, 'skipped:missing:model_tier'],
    ];
    for (const [ledger, expected] of cases) {
      const runDir = makeRunDir({ plan });
      const res = writeWorkerState({ runDir, worker: 'alpha', patch: { status: 'claimed' }, ledger, appendEvent: () => ({ appended: true }) });
      expect(res.ledger, expected).toBe(expected);
      expect(res.event).toBeNull();
      // A skip is not a refusal: the store write still happens.
      expect(readRun(runDir).lanes.alpha.state).toBe('awaiting-dispatch');
    }
  });

  it('skips on owns when the plan does not list the limb, but sends [] when the plan says it owns nothing', () => {
    const absent = makeRunDir({ plan: { limbs: [{ limb: 'beta', affectedPaths: ['lib/b/**'] }] } });
    const resAbsent = writeWorkerState({ runDir: absent, worker: 'alpha', patch: { status: 'claimed' }, ledger: claimLedger, appendEvent: () => ({ appended: true }) });
    expect(resAbsent.ledger).toBe('skipped:missing:owns');

    const empty = makeRunDir({ plan: { limbs: [{ limb: 'alpha', affectedPaths: [] }] } });
    const seen = [];
    const resEmpty = writeWorkerState({ runDir: empty, worker: 'alpha', patch: { status: 'claimed' }, ledger: claimLedger, appendEvent: (e) => { seen.push(e); return { appended: true }; } });
    expect(resEmpty.ledger).toBe('appended');
    expect(seen[0].data.owns).toEqual([]);
  });

  it('task.released needs no plan entry — only session_id', () => {
    const runDir = makeRunDir({});
    const res = writeWorkerState({ runDir, worker: 'alpha', patch: { status: 'done' }, ledger: { session_id: 's-1' }, appendEvent: () => ({ appended: true }) });
    expect(res.ledger).toBe('appended');
  });
});

/**
 * The rule belongs to `core/clock.js#readClock`, imported not copied (one
 * judge, not two). These prove delegation and the label, not its logic.
 * `unified-verifier` below is that helper's DEFAULT label, not a module path:
 * asserting its absence catches a dropped label argument.
 */
describe('writeWorkerState — clock port is strict', () => {
  it('takes a Date, the same contract as state-manager', () => {
    const runDir = makeRunDir({});
    writeWorkerState({ runDir, worker: 'alpha', patch: { status: 'executing' }, now: () => new Date('2026-09-02T12:00:00.000Z') });
    expect(readRun(runDir).lanes.alpha.updated_at).toBe('2026-09-02T12:00:00.000Z');
  });

  it('omitting it means the wall clock, and the timestamp parses', () => {
    const runDir = makeRunDir({});
    writeWorkerState({ runDir, worker: 'alpha', patch: { status: 'executing' } });
    expect(Number.isFinite(Date.parse(readRun(runDir).lanes.alpha.updated_at))).toBe(true);
  });

  it('names writeWorkerState in the error, not the module it borrows the rule from', () => {
    const runDir = makeRunDir({});
    let err = null;
    try { writeWorkerState({ runDir, worker: 'alpha', patch: { status: 'executing' }, now: () => 0 }); } catch (e) { err = e; }
    expect(err.message).toMatch(/^writeWorkerState: /);
    expect(err.message).not.toMatch(/unified-verifier/);
  });

  it('rejects a clock returning epoch ms instead of falling back silently', () => {
    const runDir = makeRunDir({});
    expect(() => writeWorkerState({ runDir, worker: 'alpha', patch: { status: 'executing' }, now: () => 1788350400000 }))
      .toThrow(TypeError);
    expect(() => writeWorkerState({ runDir, worker: 'alpha', patch: { status: 'executing' }, now: () => 1788350400000 }))
      .toThrow(/now\(\) must return a Date, received number/);
    expect(fs.existsSync(path.join(runDir, 'run.json'))).toBe(false);
  });

  it('rejects a clock returning an ISO string', () => {
    const runDir = makeRunDir({});
    expect(() => writeWorkerState({ runDir, worker: 'alpha', patch: { status: 'executing' }, now: () => '2026-09-02T12:00:00.000Z' }))
      .toThrow(/now\(\) must return a Date, received string/);
    expect(fs.existsSync(path.join(runDir, 'run.json'))).toBe(false);
  });

  it('rejects a non-function clock and an Invalid Date', () => {
    const runDir = makeRunDir({});
    expect(() => writeWorkerState({ runDir, worker: 'alpha', patch: { status: 'executing' }, now: new Date() }))
      .toThrow(/now must be a function returning a Date, received object/);
    expect(() => writeWorkerState({ runDir, worker: 'alpha', patch: { status: 'executing' }, now: null }))
      .toThrow(/received null/);
    expect(() => writeWorkerState({ runDir, worker: 'alpha', patch: { status: 'executing' }, now: () => new Date('nope') }))
      .toThrow(/returned an Invalid Date/);
  });

  it('throws before the ledger port is called — a bad clock reaches no destination', () => {
    const runDir = makeRunDir({ plan: { limbs: [{ limb: 'alpha', affectedPaths: ['lib/a/**'] }] } });
    let called = 0;
    expect(() => writeWorkerState({
      runDir, worker: 'alpha', patch: { status: 'claimed' },
      ledger: { session_id: 's-1', agent_type: 'a', model_tier: 'opus' },
      appendEvent: () => { called += 1; return { appended: true }; },
      now: () => '2026-09-02T12:00:00.000Z',
    })).toThrow(TypeError);
    expect(called).toBe(0);
  });
});

/* ══════════════ SH-11 — a BOUND run: the StateStore is canonical, run.json its projection ══════════════
 *
 * Every store below is a REAL `createStateStore` over a tmpdir (no store fake
 * stands in for the contract under test), rooted beside a canonical run
 * directory. WHAT THIS BLOCK CANNOT SEE (rules §9): concurrency between two
 * PROCESSES (the CAS races here are two commits interleaved in one), the live
 * store's size, and whether any live run has ever been bound — the bind is
 * measured, the traffic is not.
 */

const RUN_ID = 'split-abc123';
const MISSION = 'M-20260929-Sabcd1234';
const OTHER_MISSION = 'M-20260929-Szzzz9999';
const SID = 'abcd1234-ef56-7890-1234-567890abcdef';
const utc = (h, m = 0) => new Date(Date.UTC(2026, 8, 29, h, m, 0));
const iso = (h, m = 0) => utc(h, m).toISOString();
const BINDING = { mission_id: MISSION, run_id: RUN_ID, generation: 1, bound_at: iso(4), bound_by_session: SID };
const BOUND_PLAN = {
  runId: RUN_ID,
  limbs: [
    { limb: 'alpha', affectedPaths: ['lib/a/**'] },
    { limb: 'beta', affectedPaths: ['lib/b/**'] },
  ],
};
const SEED_MISSION = () => ({ status: 'executing', intent: { path: 'i.md', revision: 1 }, plan: { path: 'p.md', revision: 1 } });

/**
 * A canonical run directory plus a real StateStore rooted beside it, with one
 * mission row per id in `missions` (the row is the precondition — creating it
 * is the prompt pipeline's job, never the split tooling's).
 *
 * @param {{ binding?: object|null, missions?: string[], run?: object, planOver?: object }} [o]
 */
function makeBoundWorld({ binding = BINDING, missions = [MISSION], run = {}, planOver = {} } = {}) {
  const runDir = makeRunDir({
    plan: { ...BOUND_PLAN, ...planOver, ...(binding ? { missionBinding: binding } : {}) },
    run: { runId: RUN_ID, ...run },
  });
  const root = path.dirname(path.dirname(runDir));
  const flags = { refuse: false, onEvent: null };
  const ledger = [];
  const store = createStateStore({
    projectRoot: root,
    sessionId: SID,
    renderProjectionFile: false,
    appendEvent: (e) => {
      if (flags.refuse) return { ok: false, reason: 'port-down' };
      flags.onEvent?.(e);
      ledger.push(e);
      return { ok: true };
    },
  });
  for (const id of missions) expect(store.updateMission(id, SEED_MISSION, { reason: 'test.seed' }).ok).toBe(true);
  return { runDir, root, store, ledger, flags };
}

const boundWrite = (w, worker, patch, extra = {}) => writeWorkerState({ runDir: w.runDir, worker, patch, store: w.store, honorBinding: true, now: () => utc(5), ...extra });
const nodeOf = (w, limb, mission = MISSION) => w.store.getTaskGraph(mission)?.tasks.find((t) => t.id === limb);
const laneOf = (w, limb) => readRun(w.runDir).lanes?.[limb];
const runBytes = (w) => fs.readFileSync(path.join(w.runDir, 'run.json'));
const storeVersion = (w) => w.store.getState().state_version;

/**
 * A store whose first `times` commits lose a race to another writer (a real CAS conflict, not a stub).
 * The bound write commits through `updateTask` (SH-11 pre-flip condition 2), so that is the call raced.
 */
function racingStore(w, times) {
  let calls = 0;
  return {
    calls: () => calls,
    store: {
      ...w.store,
      updateTask: (...args) => {
        calls += 1;
        if (calls <= times) w.store.updateMission(MISSION, (cur) => cur, { reason: 'test.race' });
        return w.store.updateTask(...args);
      },
    },
  };
}

describe('SH-11 bound writeWorkerState — the store commit is the write, run.json is projected from it', () => {
  it('commits ONE store version, then stamps the lane projected_from:store', () => {
    const w = makeBoundWorld();
    const v0 = storeVersion(w);
    const res = boundWrite(w, 'alpha', { ops_state: 'active', window: 'w-1', note: 'go' });

    expect(res.ok).toBe(true);
    expect(res).toMatchObject({
      source: 'store', missionId: MISSION, opsState: 'active', status: 'executing',
      changed: true, previousOps: null, projection: 'written', stateVersion: v0 + 1,
    });
    expect(storeVersion(w)).toBe(v0 + 1);

    const node = nodeOf(w, 'alpha');
    expect(node).toMatchObject({
      id: 'alpha', status: 'executing', owner: 'alpha', file_ownership: ['lib/a/**'],
      heartbeat_at: iso(5), heartbeat_source: 'lane-heartbeat',
    });
    expect(node.ops).toEqual({ state: 'active', since: iso(5), run_id: RUN_ID, window: 'w-1', note: 'go' });

    expect(STORE_PROJECTION_MARK).toBe('store');
    expect(laneOf(w, 'alpha')).toMatchObject({
      state: 'active', since: iso(5), window: 'w-1', note: 'go', projected_from: STORE_PROJECTION_MARK, updated_at: iso(5),
    });
    expect(readRun(w.runDir).runId).toBe(RUN_ID); // every other run.json key survives
  });

  it('orders the effects: ledger event -> store commit -> run.json projection', () => {
    const w = makeBoundWorld();
    const seen = [];
    w.flags.onEvent = (e) => seen.push({ at: 'store', event: e.event, lane: laneOf(w, 'alpha') ?? null });
    const res = writeWorkerState({
      runDir: w.runDir, worker: 'alpha', patch: { ops_state: 'awaiting-dispatch' }, store: w.store, honorBinding: true, now: () => utc(5),
      ledger: { session_id: SID, agent_type: 'artibot:backend-developer', model_tier: 'opus' },
      appendEvent: (e) => { seen.push({ at: 'ledger', event: e.event, version: storeVersion(w), lane: laneOf(w, 'alpha') ?? null }); return { ok: true }; },
    });
    expect(res.ok).toBe(true);
    expect(res.ledger).toBe('appended');
    expect(seen.map((s) => `${s.at}:${s.event}`)).toEqual(['ledger:worker.claimed', 'store:state.updated']);
    expect(seen[0]).toMatchObject({ version: 1, lane: null }); // the store was still at its seed version
    expect(seen[1].lane).toBeNull(); // and run.json had no lane when the store's own event went out
    expect(laneOf(w, 'alpha')).toMatchObject({ state: 'awaiting-dispatch', projected_from: STORE_PROJECTION_MARK });
  });

  it('writes only to the bound mission, whichever other missions the store holds', () => {
    const w = makeBoundWorld({ missions: [MISSION, OTHER_MISSION] });
    const other = w.store.getTaskGraph(OTHER_MISSION);
    boundWrite(w, 'alpha', { ops_state: 'active' });
    expect(w.store.getTaskGraph(OTHER_MISSION)).toEqual(other);
    expect(nodeOf(w, 'alpha')).toBeDefined();
    expect(nodeOf(w, 'alpha', OTHER_MISSION)).toBeUndefined();
  });

  it('B3 and the lease fold: a re-assert keeps since and re-stamps the heartbeat; done releases the owner and leaves the last heartbeat', () => {
    const w = makeBoundWorld();
    boundWrite(w, 'alpha', { ops_state: 'active' });
    boundWrite(w, 'alpha', { ops_state: 'active' }, { now: () => utc(6) });
    expect(nodeOf(w, 'alpha').ops.since).toBe(iso(5));
    expect(nodeOf(w, 'alpha').heartbeat_at).toBe(iso(6));
    expect(laneOf(w, 'alpha').since).toBe(iso(5));

    boundWrite(w, 'alpha', { ops_state: 'done' }, { now: () => utc(7) });
    const done = nodeOf(w, 'alpha');
    expect(done).toMatchObject({ status: 'done', owner: null, heartbeat_at: iso(6) });
    expect(done.ops.since).toBe(iso(7));
  });

  it('keeps hand-added lane keys and puts only window and note into the node\'s closed ops record', () => {
    const w = makeBoundWorld({ run: { lanes: { alpha: { state: 'active', since: iso(3), pr: 220, inspector: 'r2' } } } });
    boundWrite(w, 'alpha', { ops_state: 'review', pr: 221 });
    expect(laneOf(w, 'alpha')).toMatchObject({ state: 'review', pr: 221, inspector: 'r2' });
    expect(nodeOf(w, 'alpha').ops).toEqual({ state: 'review', since: iso(5), run_id: RUN_ID });
    expect(JSON.stringify(nodeOf(w, 'alpha'))).not.toContain('inspector');
  });

  it('T8: backfills from the run.json lane when the node has no ops — the lane\'s since survives a state-less patch', () => {
    const w = makeBoundWorld({ run: { lanes: { alpha: { state: 'review', since: iso(3), window: 'w-a' } } } });
    const ledgerBefore = w.ledger.length;
    const owed = [];
    const res = boundWrite(w, 'alpha', { note: 'more' }, {
      ledger: { session_id: SID, agent_type: 'a', model_tier: 'opus' }, appendEvent: (e) => { owed.push(e); return { ok: true }; },
    });
    expect(res).toMatchObject({ ok: true, previousOps: 'review', changed: false, opsState: 'review' });
    expect(nodeOf(w, 'alpha')).toMatchObject({ status: 'reviewing', owner: 'alpha' });
    expect(nodeOf(w, 'alpha').ops).toEqual({ state: 'review', since: iso(3), run_id: RUN_ID, window: 'w-a', note: 'more' });
    expect(w.ledger.length).toBe(ledgerBefore + 1); // exactly one state.updated
    expect(owed).toEqual([]); // and no worker.claimed / task.released: nothing changed state
  });

  it('a limb the plan does not list still gets a node, with an empty ownership list', () => {
    const w = makeBoundWorld();
    boundWrite(w, 'gamma', { ops_state: 'active' });
    expect(nodeOf(w, 'gamma').file_ownership).toEqual([]);
  });

  it('keys the transition by the NODE\'s since, not by a stale run.json lane', () => {
    const w = makeBoundWorld();
    boundWrite(w, 'alpha', { ops_state: 'pending' }, { now: () => utc(3) });
    // Skew the projection the way it really happens: the commit lands and the run.json
    // projection fails, so the lane still claims an older word and since than the node.
    // (Editing the lane by hand is no longer this case: a sealed lane edited by hand is
    // drift, and the stale guard refuses it — see the pre-flip condition 4 block below.)
    expect(boundWrite(w, 'alpha', { ops_state: 'active' }, { projectRunJson: () => { throw new Error('disk full'); } }).projection).toMatch(/^failed/);
    expect(laneOf(w, 'alpha')).toMatchObject({ state: 'pending', since: iso(3) });
    expect(nodeOf(w, 'alpha').ops.since).toBe(iso(5));

    const events = [];
    const res = boundWrite(w, 'alpha', { ops_state: 'done' }, {
      now: () => utc(7), ledger: { session_id: SID }, appendEvent: (e) => { events.push(e); return { ok: true }; },
    });
    expect(res.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('task.released');
    expect(events[0].idempotency_key).toBe(`task.released:${RUN_ID}:alpha:active:done:${iso(5)}`);
  });

  it('a retry after a refused append reuses that key and leaves the store where it was', () => {
    const w = makeBoundWorld();
    boundWrite(w, 'alpha', { ops_state: 'active' });
    const events = [];
    const v = storeVersion(w);
    const refused = boundWrite(w, 'alpha', { ops_state: 'done' }, {
      now: () => utc(7), ledger: { session_id: SID }, appendEvent: (e) => { events.push(e); return { ok: false, reason: 'busy' }; },
    });
    expect(refused).toMatchObject({ ok: false, ledger: 'refused' });
    expect(storeVersion(w)).toBe(v);
    expect(nodeOf(w, 'alpha').ops.state).toBe('active');
    expect(laneOf(w, 'alpha').state).toBe('active');
    boundWrite(w, 'alpha', { ops_state: 'done' }, {
      now: () => utc(8), ledger: { session_id: SID }, appendEvent: (e) => { events.push(e); return { ok: true }; },
    });
    expect(events).toHaveLength(2);
    expect(events[1].idempotency_key).toBe(events[0].idempotency_key);
    expect(nodeOf(w, 'alpha')).toMatchObject({ status: 'done', owner: null });
  });

  it('CONTROL — an UNBOUND run ignores the store entirely and writes run.json as before', () => {
    const w = makeBoundWorld({ binding: null });
    const v = storeVersion(w);
    let opened = 0;
    const res = writeWorkerState({
      runDir: w.runDir, worker: 'alpha', patch: { ops_state: 'active' }, store: w.store, openStore: () => { opened += 1; return w.store; }, now: () => utc(5),
    });
    expect(res.ok).toBe(true);
    expect(res.source).toBeUndefined();
    expect(laneOf(w, 'alpha').projected_from).toBe(PROJECTION_MARK);
    expect(storeVersion(w)).toBe(v);
    expect(w.store.getTaskGraph(MISSION).tasks).toEqual([]);
    expect(opened).toBe(0);
  });
});

/* ══════════ SH-11 pre-flip condition (2) — a bound lane write is ONE single-node store write ══════════
 *
 * The bound write used to go through `updateMission(…, { graph })`, which replaces the WHOLE graph:
 * every lane write journalled a `mission.upsert` (the row, unchanged) and a `graph.upsert` carrying
 * every sibling node, to change one. It now goes through `store.updateTask` — one `task.upsert`, the
 * node as the write planned it, `ops` included. WHAT THIS CANNOT SEE: the live store's journal size
 * (the fixtures hold two nodes), and two PROCESSES racing one store.
 */
describe('SH-11 pre-flip (2) — the bound write is one task.upsert', () => {
  const journal = (w) => readJournal(w.store.paths.journal).records;

  it('journals exactly ONE task.upsert per bound write; the mission row and the sibling nodes are not rewritten', () => {
    const w = makeBoundWorld();
    expect(boundWrite(w, 'alpha', { ops_state: 'active' }).ok).toBe(true);
    expect(boundWrite(w, 'beta', { ops_state: 'review' }).ok).toBe(true);
    const before = journal(w).length;

    expect(boundWrite(w, 'alpha', { ops_state: 'review' }, { now: () => utc(6) }).ok).toBe(true);

    const added = journal(w).slice(before);
    expect(added.map((r) => r.kind)).toEqual(['task.upsert']);
    expect(added[0].task).toMatchObject({
      id: 'alpha', status: 'reviewing', owner: 'alpha', ops: { state: 'review', since: iso(6), run_id: RUN_ID },
    });
  });

  it('the FIRST write of a limb costs one record too — the node is created, not the graph replaced', () => {
    const w = makeBoundWorld();
    const before = journal(w).length;
    expect(boundWrite(w, 'alpha', { ops_state: 'active' }).ok).toBe(true);
    expect(journal(w).slice(before).map((r) => r.kind)).toEqual(['task.upsert']);
    expect(nodeOf(w, 'alpha')).toMatchObject({ id: 'alpha', file_ownership: ['lib/a/**'], status: 'executing' });
  });

  it('a sibling node is byte-identical after a write to its neighbour, and keeps its place in the graph', () => {
    const w = makeBoundWorld();
    boundWrite(w, 'alpha', { ops_state: 'active' });
    boundWrite(w, 'beta', { ops_state: 'review' });
    const beta = JSON.stringify(nodeOf(w, 'beta'));
    boundWrite(w, 'alpha', { ops_state: 'done' }, { now: () => utc(7) });
    expect(JSON.stringify(nodeOf(w, 'beta'))).toBe(beta);
    expect(w.store.getTaskGraph(MISSION).tasks.map((t) => t.id)).toEqual(['alpha', 'beta']);
  });

  it('the paired ledger row is unchanged: one state.updated carrying the split.lane-state reason', () => {
    const w = makeBoundWorld();
    const rows = w.ledger.length;
    boundWrite(w, 'alpha', { ops_state: 'active' });
    expect(w.ledger.slice(rows).map((e) => [e.event, e.data.reason])).toEqual([['state.updated', 'split.lane-state']]);
  });

  it('the node the write planned is the node the store holds — nothing the mutator ignored sneaks in from the graph', () => {
    const w = makeBoundWorld();
    boundWrite(w, 'alpha', { ops_state: 'active', window: 'w-1' });
    const written = journal(w).at(-1).task;
    expect(nodeOf(w, 'alpha')).toEqual(written);
  });
});

describe('SH-11 T3 — a binding that cannot be honoured REJECTS; there is no run.json fallback', () => {
  it('a dangling binding (mission not in the store) rejects with run.json byte-identical, even when another live mission exists', () => {
    const w = makeBoundWorld({ missions: [OTHER_MISSION] });
    const before = runBytes(w);
    const v = storeVersion(w);
    const res = boundWrite(w, 'alpha', { ops_state: 'active' });
    expect(res).toMatchObject({ ok: false, reason: 'binding-dangling', worker: 'alpha' });
    expect(res.detail).toMatch(new RegExp(MISSION));
    expect(runBytes(w)).toEqual(before);
    expect(storeVersion(w)).toBe(v);
    expect(w.store.getTaskGraph(OTHER_MISSION).tasks).toEqual([]);
  });

  it('a mission removed AFTER the bind is dangling too', () => {
    const w = makeBoundWorld();
    expect(boundWrite(w, 'alpha', { ops_state: 'active' }).ok).toBe(true);
    expect(w.store.updateMission(MISSION, () => null, { reason: 'test.archive' }).ok).toBe(true);
    const before = runBytes(w);
    expect(boundWrite(w, 'alpha', { ops_state: 'review' })).toMatchObject({ ok: false, reason: 'binding-dangling' });
    expect(runBytes(w)).toEqual(before);
  });

  it('a malformed binding rejects, naming the field', () => {
    const w = makeBoundWorld({ binding: { ...BINDING, generation: 0 } });
    const before = runBytes(w);
    expect(boundWrite(w, 'alpha', { ops_state: 'active' })).toMatchObject({ ok: false, reason: 'binding-invalid:generation' });
    expect(runBytes(w)).toEqual(before);
    expect(storeVersion(w)).toBe(1);
  });

  it('a binding for another run rejects (I1: one run, one mission)', () => {
    const w = makeBoundWorld({ binding: { ...BINDING, run_id: 'split-other' } });
    expect(boundWrite(w, 'alpha', { ops_state: 'active' })).toMatchObject({ ok: false, reason: 'binding-run-mismatch' });
  });

  it('F3: plan.json and run.json naming different runs rejects, whatever the binding says', () => {
    const w = makeBoundWorld({ run: { runId: 'split-zzz' } });
    const before = runBytes(w);
    expect(boundWrite(w, 'alpha', { ops_state: 'active' })).toMatchObject({ ok: false, reason: 'run-id-mismatch' });
    expect(runBytes(w)).toEqual(before);
  });

  it('with no store to write, a bound run rejects rather than falling back — a missing port, a null thunk and a throwing thunk alike', () => {
    const w = makeBoundWorld();
    const before = runBytes(w);
    const base = { runDir: w.runDir, worker: 'alpha', patch: { ops_state: 'active' }, honorBinding: true, now: () => utc(5) };
    expect(writeWorkerState(base)).toMatchObject({ ok: false, reason: 'store-unavailable' });
    expect(writeWorkerState({ ...base, openStore: () => null })).toMatchObject({ ok: false, reason: 'store-unavailable' });
    const thrown = writeWorkerState({ ...base, openStore: () => { throw new TypeError('sessionId is required'); } });
    expect(thrown).toMatchObject({ ok: false, reason: 'store-unavailable' });
    expect(thrown.detail).toMatch(/sessionId is required/);
    expect(runBytes(w)).toEqual(before);
  });

  it('a store with no updateTask is not a usable port: the bound write rejects instead of falling back to the graph door', () => {
    const w = makeBoundWorld();
    const before = runBytes(w);
    const v = storeVersion(w);
    const oldShape = { getState: w.store.getState, updateMission: w.store.updateMission }; // what a bound write needed before pre-flip condition 2
    const res = boundWrite(w, 'alpha', { ops_state: 'active' }, { store: oldShape });
    expect(res).toMatchObject({ ok: false, reason: 'store-unavailable', worker: 'alpha' });
    expect(runBytes(w)).toEqual(before);
    expect(storeVersion(w)).toBe(v);
  });

  it('another run\'s node is refused, not overwritten (I2)', () => {
    const w = makeBoundWorld();
    const foreign = {
      schema_version: 1, mission_id: MISSION,
      tasks: [{ id: 'alpha', mission_id: MISSION, status: 'done', owner: null, ops: { state: 'done', since: iso(2), run_id: 'split-other' } }],
    };
    expect(w.store.updateMission(MISSION, (cur) => cur, { graph: foreign, reason: 'test.foreign' }).ok).toBe(true);
    const before = runBytes(w);
    expect(boundWrite(w, 'alpha', { ops_state: 'active' })).toMatchObject({ ok: false, reason: 'task-run-mismatch' });
    expect(nodeOf(w, 'alpha').ops.run_id).toBe('split-other');
    expect(runBytes(w)).toEqual(before);
  });
});

describe('SH-11 T4 — B1/B2 refuse by THROWING, before any effect', () => {
  /** A bound world whose alpha node was left `claimed` by a lease call after its ops said `active`. */
  function skewedWorld() {
    const w = makeBoundWorld();
    boundWrite(w, 'alpha', { ops_state: 'active' });
    expect(w.store.releaseTask({ missionId: MISSION, taskId: 'alpha', status: 'claimed', reason: 'test.skew' }).ok).toBe(true);
    expect(nodeOf(w, 'alpha')).toMatchObject({ status: 'claimed' });
    expect(nodeOf(w, 'alpha').ops.state).toBe('active');
    return w;
  }

  it('a state-less patch on a node whose ops and status disagree throws; state_version, run.json and the ledger stay put', () => {
    const w = skewedWorld();
    const v = storeVersion(w);
    const before = runBytes(w);
    const events = [];
    expect(() => boundWrite(w, 'alpha', { note: 'x' }, { ledger: { session_id: SID }, appendEvent: (e) => { events.push(e); return { ok: true }; } }))
      .toThrow(/ops.state 'active' projects to status 'executing' but the node says 'claimed'/);
    expect(storeVersion(w)).toBe(v);
    expect(runBytes(w)).toEqual(before);
    expect(events).toEqual([]);
  });

  it('an explicit state rewrites both fields and repairs the skew', () => {
    const w = skewedWorld();
    expect(boundWrite(w, 'alpha', { ops_state: 'active' }, { now: () => utc(6) }).ok).toBe(true);
    expect(nodeOf(w, 'alpha')).toMatchObject({ status: 'executing', owner: 'alpha' });
    expect(nodeOf(w, 'alpha').ops.since).toBe(iso(5)); // same state: the clock did not restart
  });

  it('B2: a suspended lane needs a human: reason, a working lane takes no blockers, a free-form reason is refused', () => {
    const w = makeBoundWorld();
    const v = storeVersion(w);
    const events = [];
    const io = { ledger: { session_id: SID }, appendEvent: (e) => { events.push(e); return { ok: true }; } };
    expect(() => boundWrite(w, 'alpha', { ops_state: 'suspended', blocked_by: ['gate:x'] }, io)).toThrow(/human:/);
    expect(() => boundWrite(w, 'alpha', { ops_state: 'active', blocked_by: ['lane:beta'] }, io)).toThrow(/only .*blocked/);
    expect(() => boundWrite(w, 'alpha', { ops_state: 'serial-gate', blocked_by: ['waiting on the leader'] }, io)).toThrow(/lane\|gate\|human\|reconcile/);
    expect(storeVersion(w)).toBe(v);
    expect(events).toEqual([]);
    expect(fs.readFileSync(path.join(w.runDir, 'run.json'), 'utf-8')).not.toContain('alpha');
  });

  it('B2: the blocked states round-trip their reason through the node', () => {
    const w = makeBoundWorld();
    boundWrite(w, 'alpha', { ops_state: 'suspended' });
    expect(nodeOf(w, 'alpha')).toMatchObject({ status: 'blocked', owner: null, blockers: ['human:suspend'] });
    boundWrite(w, 'beta', { ops_state: 'serial-gate', blocked_by: ['lane:alpha'] });
    expect(nodeOf(w, 'beta').blockers).toEqual(['lane:alpha']);
    expect(laneOf(w, 'beta')).toMatchObject({ state: 'serial-gate', blocked_by: ['lane:alpha'] });
    boundWrite(w, 'beta', { ops_state: 'active' });
    expect(Object.hasOwn(nodeOf(w, 'beta'), 'blockers')).toBe(false);
  });

  it('a worker with no state anywhere throws instead of inventing one', () => {
    const w = makeBoundWorld();
    expect(() => boundWrite(w, 'alpha', { note: 'x' })).toThrow(/needs a state/);
    expect(storeVersion(w)).toBe(1);
  });
});

describe('SH-11 T5 — F5: a CAS conflict is retried ONCE, then rejected', () => {
  it('a lost race is re-derived from a fresh snapshot and succeeds on the retry', () => {
    const w = makeBoundWorld();
    const racing = racingStore(w, 1);
    const res = writeWorkerState({ runDir: w.runDir, worker: 'alpha', patch: { ops_state: 'active' }, store: racing.store, honorBinding: true, now: () => utc(5) });
    expect(res.ok).toBe(true);
    expect(racing.calls()).toBe(2);
    expect(nodeOf(w, 'alpha').ops.state).toBe('active');
    expect(laneOf(w, 'alpha').projected_from).toBe(STORE_PROJECTION_MARK);
  });

  it('a second conflict rejects with cas-conflict and never touches run.json', () => {
    const w = makeBoundWorld();
    const before = runBytes(w);
    const racing = racingStore(w, 2);
    const res = writeWorkerState({ runDir: w.runDir, worker: 'alpha', patch: { ops_state: 'active' }, store: racing.store, honorBinding: true, now: () => utc(5) });
    expect(res).toMatchObject({ ok: false, reason: 'cas-conflict', worker: 'alpha' });
    expect(racing.calls()).toBe(2);
    expect(runBytes(w)).toEqual(before);
    expect(nodeOf(w, 'alpha')).toBeUndefined();
  });

  it('a store that refuses the commit (its own ledger port said no) rejects with store-refused and writes nothing', () => {
    const w = makeBoundWorld();
    const before = runBytes(w);
    const v = storeVersion(w);
    w.flags.refuse = true;
    const res = boundWrite(w, 'alpha', { ops_state: 'active' });
    expect(res).toMatchObject({ ok: false, reason: 'store-refused' });
    expect(res.detail).toMatch(/ledger refused/);
    expect(runBytes(w)).toEqual(before);
    w.flags.refuse = false;
    expect(storeVersion(w)).toBe(v);
  });
});

describe('SH-11 T6 — the store commit is the truth even when the projection fails', () => {
  it('a projection that throws does not undo the commit: the write reports it, and the next read answers from the store with the disagreement as evidence', () => {
    const w = makeBoundWorld();
    boundWrite(w, 'alpha', { ops_state: 'pending' });
    const stale = runBytes(w);

    const res = boundWrite(w, 'alpha', { ops_state: 'active' }, { projectRunJson: () => { throw new Error('disk full'); } });
    expect(res.ok).toBe(true);
    expect(res.projection).toMatch(/^failed:disk full/);
    expect(nodeOf(w, 'alpha')).toMatchObject({ status: 'executing' });
    expect(runBytes(w)).toEqual(stale);

    const read = readWorkerState({ runDir: w.runDir, store: w.store, honorBinding: true });
    expect(read.source).toBe('store');
    expect(read.workers.alpha).toMatchObject({ status: 'executing', source: 'store', ops_state: 'active' });
    expect(read.conflicts).toEqual([{
      worker: 'alpha',
      field: 'status',
      values: [{ source: 'store', value: 'executing' }, { source: 'run.json', value: 'queued' }],
    }]);

    // The next successful write heals the projection, and the evidence goes away.
    expect(boundWrite(w, 'alpha', { ops_state: 'active' }, { now: () => utc(6) }).projection).toBe('written');
    expect(readWorkerState({ runDir: w.runDir, store: w.store, honorBinding: true }).conflicts).toEqual([]);
  });
});

describe('SH-11 bound readWorkerState — canonical reads take the store from the binding only', () => {
  it('reads the bound mission\'s nodes keyed by limb and reports the binding', () => {
    const w = makeBoundWorld();
    boundWrite(w, 'alpha', { ops_state: 'active', window: 'w-1' });
    boundWrite(w, 'beta', { ops_state: 'review' });
    const read = readWorkerState({ runDir: w.runDir, store: w.store, honorBinding: true });
    expect(read.source).toBe('store');
    expect(read.binding).toEqual({ status: 'bound', mission_id: MISSION, run_id: RUN_ID, generation: 1 });
    expect(Object.keys(read.workers).sort()).toEqual(['alpha', 'beta']);
    expect(read.workers.alpha).toMatchObject({ status: 'executing', owns: ['lib/a/**'], ops_state: 'active', since: iso(5), window: 'w-1', source: 'store', heartbeat_source: 'lane-heartbeat' });
    expect(read.workers.beta.status).toBe('reviewing');
    expect(read.conflicts).toEqual([]);
  });

  it('ignores a caller-supplied storeReader on a bound run — one canonical source, not two', () => {
    const w = makeBoundWorld();
    boundWrite(w, 'alpha', { ops_state: 'active' });
    const read = readWorkerState({ runDir: w.runDir, store: w.store, honorBinding: true, storeReader: () => ({ workers: { alpha: { status: 'done' } } }) });
    expect(read.workers.alpha.status).toBe('executing');
  });

  it('a bound run read with no store answers from run.json and says the store was not read', () => {
    const w = makeBoundWorld({ run: { lanes: { alpha: { state: 'review', since: iso(3) } } } });
    const read = readWorkerState({ runDir: w.runDir, honorBinding: true });
    expect(read.source).toBe('run.json');
    expect(read.binding).toEqual({ status: 'unread', mission_id: MISSION, run_id: RUN_ID, generation: 1 });
  });

  it('a dangling binding contributes no store layer, and the read says so', () => {
    const w = makeBoundWorld({ missions: [OTHER_MISSION], run: { lanes: { alpha: { state: 'review', since: iso(3) } } } });
    const read = readWorkerState({ runDir: w.runDir, store: w.store, honorBinding: true });
    expect(read.binding).toEqual({ status: 'dangling', mission_id: MISSION, run_id: RUN_ID, generation: 1 });
    expect(read.source).toBe('run.json');
    expect(read.workers.alpha.status).toBe('reviewing');
  });

  it('an invalid binding is reported and the store is not consulted', () => {
    const w = makeBoundWorld({ binding: { ...BINDING, mission_id: 'nope' } });
    let asked = 0;
    const read = readWorkerState({ runDir: w.runDir, honorBinding: true, store: { getState: () => { asked += 1; return {}; } } });
    expect(read.binding).toEqual({ status: 'invalid', reason: 'binding-invalid:mission_id' });
    expect(asked).toBe(0);
  });

  it('F4: a limb also present in ANOTHER mission is evidence in conflicts[], never a second answer', () => {
    const w = makeBoundWorld({ missions: [MISSION, OTHER_MISSION] });
    boundWrite(w, 'alpha', { ops_state: 'active' });
    const legacy = { schema_version: 1, mission_id: OTHER_MISSION, tasks: [{ id: 'alpha', mission_id: OTHER_MISSION, status: 'done', owner: null }] };
    expect(w.store.updateMission(OTHER_MISSION, (cur) => cur, { graph: legacy, reason: 'test.residue' }).ok).toBe(true);

    const read = readWorkerState({ runDir: w.runDir, store: w.store, honorBinding: true });
    expect(read.workers.alpha).toMatchObject({ status: 'executing', source: 'store' });
    const c = read.conflicts.find((x) => x.worker === 'alpha' && x.field === 'status');
    expect(c.values).toEqual(expect.arrayContaining([
      { source: 'store', value: 'executing' },
      { source: `store:${OTHER_MISSION}`, value: 'done' },
    ]));
    // and the reader wrote nothing
    expect(w.store.getTaskGraph(OTHER_MISSION).tasks).toHaveLength(1);
  });

  it('a limb in another mission that AGREES is not a conflict', () => {
    const w = makeBoundWorld({ missions: [MISSION, OTHER_MISSION] });
    boundWrite(w, 'alpha', { ops_state: 'active' });
    const same = { schema_version: 1, mission_id: OTHER_MISSION, tasks: [{ id: 'alpha', mission_id: OTHER_MISSION, status: 'executing', owner: 'alpha' }] };
    w.store.updateMission(OTHER_MISSION, (cur) => cur, { graph: same, reason: 'test.residue' });
    const read = readWorkerState({ runDir: w.runDir, store: w.store, honorBinding: true });
    expect(read.workers.alpha).toMatchObject({ status: 'executing', source: 'store' });
    expect(read.conflicts).toEqual([]);
  });

  it('a node whose ops and status disagree at rest is reported as a conflict, not silently trusted', () => {
    const w = makeBoundWorld();
    boundWrite(w, 'alpha', { ops_state: 'active' });
    w.store.releaseTask({ missionId: MISSION, taskId: 'alpha', status: 'claimed', reason: 'test.skew' });
    const read = readWorkerState({ runDir: w.runDir, store: w.store, honorBinding: true });
    const c = read.conflicts.find((x) => x.worker === 'alpha' && x.field === 'status');
    expect(c.values).toEqual(expect.arrayContaining([{ source: 'store', value: 'claimed' }, { source: 'store:ops', value: 'executing' }]));
  });

  it('CONTROL — an unbound read has no binding key and still honours storeReader', () => {
    const w = makeBoundWorld({ binding: null });
    const read = readWorkerState({ runDir: w.runDir, storeReader: () => ({ workers: { alpha: { status: 'reviewing' } } }) });
    expect(Object.hasOwn(read, 'binding')).toBe(false);
    expect(read.workers.alpha).toMatchObject({ status: 'reviewing', source: 'store' });
  });
});

describe('SH-11 readMissionBinding', () => {
  it('reads none, bound, and every way a binding can be wrong', () => {
    expect(readMissionBinding({ runDir: makeBoundWorld({ binding: null }).runDir })).toEqual({ status: 'none' });
    const bound = readMissionBinding({ runDir: makeBoundWorld().runDir });
    expect(bound).toMatchObject({ status: 'bound', runId: RUN_ID });
    expect(bound.binding).toEqual(BINDING);
    expect(readMissionBinding({ runDir: makeBoundWorld({ binding: { ...BINDING, extra: 1 } }).runDir }))
      .toEqual({ status: 'invalid', reason: 'binding-invalid:unknown-key:extra' });
    expect(readMissionBinding({ runDir: makeBoundWorld({ binding: null, planOver: { missionBinding: null } }).runDir }))
      .toEqual({ status: 'invalid', reason: 'binding-invalid:not-an-object' });
    expect(readMissionBinding({ runDir: makeBoundWorld({ binding: { ...BINDING, run_id: 'split-other' } }).runDir }))
      .toEqual({ status: 'invalid', reason: 'binding-run-mismatch' });
    expect(readMissionBinding({ runDir: makeBoundWorld({ run: { runId: 'split-zzz' } }).runDir }))
      .toEqual({ status: 'invalid', reason: 'run-id-mismatch' });
  });

  it('a plan with no runId cannot carry a binding, and a missing plan or a run.json with no runId is not a mismatch', () => {
    expect(readMissionBinding({ runDir: makeBoundWorld({ planOver: { runId: undefined } }).runDir }))
      .toEqual({ status: 'invalid', reason: 'binding-run-mismatch' });
    expect(readMissionBinding({ runDir: makeRunDir({}) })).toEqual({ status: 'none' });
    expect(readMissionBinding({ runDir: makeBoundWorld({ run: { runId: undefined } }).runDir }).status).toBe('bound');
  });

  it('a corrupt plan.json throws rather than reading as unbound', () => {
    const w = makeBoundWorld();
    expect(readMissionBinding({ runDir: w.runDir }).status).toBe('bound'); // the same directory, intact
    fs.writeFileSync(path.join(w.runDir, 'plan.json'), '{ not json');
    expect(() => readMissionBinding({ runDir: w.runDir })).toThrow(SyntaxError);
  });

  it('requires runDir', () => {
    expect(() => readMissionBinding({})).toThrow(/runDir is required/);
  });
});

describe('SH-11 bindRunToMission — the writer of the binding', () => {
  const bind = (w, over = {}) => bindRunToMission({ runDir: w.runDir, missionId: MISSION, sessionId: SID, now: () => utc(4), store: w.store, ...over });
  const planText = (w) => fs.readFileSync(path.join(w.runDir, 'plan.json'), 'utf-8');

  it('writes generation 1 into plan.json, keeps every other plan key, and reports bound:true', () => {
    const w = makeBoundWorld({ binding: null });
    const res = bind(w);
    expect(res).toMatchObject({ ok: true, bound: true });
    expect(res.binding).toEqual(BINDING);
    const plan = JSON.parse(planText(w));
    expect(plan.missionBinding).toEqual(BINDING);
    expect(plan.runId).toBe(RUN_ID);
    expect(plan.limbs).toEqual(BOUND_PLAN.limbs);
    expect(readMissionBinding({ runDir: w.runDir }).status).toBe('bound');
  });

  it('binds ONCE: a second call, even naming another mission, reuses the record and leaves plan.json byte-identical (I1)', () => {
    const w = makeBoundWorld({ binding: null, missions: [MISSION, OTHER_MISSION] });
    bind(w);
    const before = planText(w);
    const again = bind(w, { missionId: OTHER_MISSION, sessionId: 'other-session-0001', now: () => utc(9) });
    expect(again).toMatchObject({ ok: true, bound: false });
    expect(again.binding).toEqual(BINDING);
    expect(planText(w)).toBe(before);
  });

  it('never creates a mission row: an absent mission is refused and the store does not move', () => {
    const w = makeBoundWorld({ binding: null, missions: [OTHER_MISSION] });
    const v = storeVersion(w);
    const before = planText(w);
    expect(bind(w)).toEqual({ ok: false, reason: 'mission-missing' });
    expect(storeVersion(w)).toBe(v);
    expect(Object.keys(w.store.getState().active_missions)).toEqual([OTHER_MISSION]);
    expect(planText(w)).toBe(before);
  });

  it('refuses what it cannot bind, each with plan.json untouched', () => {
    const cases = [
      [{ binding: null, planOver: { runId: undefined } }, {}, 'plan-run-id-missing'],
      [{ binding: null, run: { runId: 'split-zzz' } }, {}, 'run-id-mismatch'],
      [{ binding: null }, { missionId: 'M-2026-1' }, 'binding-invalid:mission_id'],
      [{ binding: null }, { sessionId: '' }, 'binding-invalid:bound_by_session'],
      [{ binding: { ...BINDING, generation: 0 } }, {}, 'binding-invalid:generation'],
    ];
    for (const [worldOver, callOver, reason] of cases) {
      const w = makeBoundWorld(worldOver);
      const before = planText(w);
      expect(bind(w, callOver), reason).toEqual({ ok: false, reason });
      expect(planText(w), reason).toBe(before);
    }
  });

  it('a run with no plan.json yet is refused as plan-missing', () => {
    const runDir = makeRunDir({});
    expect(bindRunToMission({ runDir, missionId: MISSION, sessionId: SID, now: () => utc(4) })).toEqual({ ok: false, reason: 'plan-missing' });
    expect(fs.existsSync(path.join(runDir, 'plan.json'))).toBe(false);
  });

  it('works without a store port (the caller has already checked the row) and in a non-canonical directory', () => {
    const runDir = makeRunDir({ plan: BOUND_PLAN, run: { runId: RUN_ID }, canonical: false });
    const res = bindRunToMission({ runDir, missionId: MISSION, sessionId: SID, now: () => utc(4) });
    expect(res).toMatchObject({ ok: true, bound: true });
    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'plan.json'), 'utf-8')).missionBinding).toEqual(BINDING);
  });

  it('takes the strict clock like every other writer here', () => {
    const w = makeBoundWorld({ binding: null });
    expect(() => bind(w, { now: () => 1788350400000 })).toThrow(/bindRunToMission: now\(\) must return a Date, received number/);
    expect(JSON.parse(planText(w)).missionBinding).toBeUndefined();
    expect(bind(w).ok).toBe(true); // the same call with a real clock binds
  });

  it('M1: a binding that lands between the probe and the write wins — the caller gets the winner, and plan.json keeps it', () => {
    const w = makeBoundWorld({ binding: null, missions: [MISSION, OTHER_MISSION] });
    const theirs = { ...BINDING, mission_id: OTHER_MISSION, bound_by_session: 'other-session-0001', bound_at: iso(3) };
    // The store port is consulted AFTER the probe and BEFORE the write, so it is
    // where a competing binder lands: before `updatePlanJson` takes the plan.json
    // lock, where its `fn` finds the record. A binder that lands INSIDE the
    // read-modify-write is another process, and that one is measured in
    // split-state-bind-race.test.js (the lock itself: tests/git/split-run-file.test.js).
    const racy = {
      getState: () => {
        const plan = JSON.parse(planText(w));
        plan.missionBinding = theirs;
        fs.writeFileSync(path.join(w.runDir, 'plan.json'), JSON.stringify(plan));
        return w.store.getState();
      },
    };
    const res = bind(w, { store: racy });
    expect(res).toMatchObject({ ok: true, bound: false });
    expect(res.binding).toEqual(theirs);
    expect(JSON.parse(planText(w)).missionBinding).toEqual(theirs);
  });

  it('M1: what it reports as bound is what plan.json holds afterwards', () => {
    const w = makeBoundWorld({ binding: null });
    const res = bind(w);
    expect(res).toMatchObject({ ok: true, bound: true });
    expect(JSON.parse(planText(w)).missionBinding).toEqual(res.binding);
  });
});

/* ══════════ SH-11 canary switch (③) — with the key OFF a bound run is written and read by the legacy path ══════════
 *
 * `lib/topology` is L4 and never reads config: the caller injects an
 * `honorBinding` port (`true`, or a function returning `true`). It is
 * FAIL-CLOSED — an absent port, `'true'`, `1` and a port that throws are all
 * "off" — so a caller that forgets it gets the legacy behaviour, never a
 * silent store write. WHAT THIS CANNOT SEE: the three CLIs' own reading of the
 * key (`tests/scripts/*.test.js` measure that) and the shipped value
 * (`tests/firewall/split-config-firewall.test.js`).
 */
describe('SH-11 switch (③) — the key OFF reverts a bound run', () => {
  const legacyWrite = (w, patch, extra = {}) => writeWorkerState({ runDir: w.runDir, worker: 'alpha', patch, store: w.store, now: () => utc(5), ...extra });

  it('the DEFAULT is off: with no honorBinding port the write goes to run.json only, the store is untouched, and the result says disabled', () => {
    const w = makeBoundWorld();
    const v = storeVersion(w);
    const res = legacyWrite(w, { ops_state: 'active' });
    expect(res.ok).toBe(true);
    expect(res.source).toBeUndefined();
    expect(res.binding).toEqual({ status: 'disabled' });
    expect(laneOf(w, 'alpha')).toMatchObject({ state: 'active', since: iso(5), projected_from: PROJECTION_MARK });
    expect(storeVersion(w)).toBe(v);
    expect(w.store.getTaskGraph(MISSION).tasks).toEqual([]);
  });

  it('an explicit false, a port that says false and every non-literal value revert the same way', () => {
    for (const port of [false, () => false, 'true', 1, {}, () => 'yes', () => { throw new Error('config unreadable'); }]) {
      const w = makeBoundWorld();
      const res = legacyWrite(w, { ops_state: 'active' }, { honorBinding: port });
      expect(res.binding, String(port)).toEqual({ status: 'disabled' });
      expect(laneOf(w, 'alpha').projected_from, String(port)).toBe(PROJECTION_MARK);
      expect(storeVersion(w), String(port)).toBe(1);
    }
  });

  it('CONTROL — the literal true (or a function returning it) is what turns the store write on', () => {
    for (const port of [true, () => true]) {
      const w = makeBoundWorld();
      const res = legacyWrite(w, { ops_state: 'active' }, { honorBinding: port });
      expect(res).toMatchObject({ ok: true, source: 'store' });
      expect(Object.hasOwn(res, 'binding')).toBe(false);
      expect(laneOf(w, 'alpha').projected_from).toBe(STORE_PROJECTION_MARK);
    }
  });

  it('the port is asked lazily: never for a run that carries no binding, once for one that does', () => {
    let asked = 0;
    const port = () => { asked += 1; return true; };
    legacyWrite(makeBoundWorld({ binding: null }), { ops_state: 'active' }, { honorBinding: port });
    expect(asked).toBe(0);
    legacyWrite(makeBoundWorld(), { ops_state: 'active' }, { honorBinding: port });
    expect(asked).toBe(1);
  });

  it('a DAMAGED binding is not judged while the switch is off, and rejects when it is on', () => {
    const w = makeBoundWorld({ binding: { ...BINDING, generation: 0 } });
    const off = legacyWrite(w, { ops_state: 'active' }, { honorBinding: false });
    expect(off.ok).toBe(true);
    expect(off.binding).toEqual({ status: 'disabled' });
    const before = runBytes(w);
    expect(legacyWrite(w, { ops_state: 'review' }, { honorBinding: true })).toMatchObject({ ok: false, reason: 'binding-invalid:generation' });
    expect(runBytes(w)).toEqual(before);
  });

  it('the opener is never called while the switch is off (a session id is needed only to open a store)', () => {
    const w = makeBoundWorld();
    let opened = 0;
    legacyWrite(w, { ops_state: 'active' }, { store: undefined, openStore: () => { opened += 1; return w.store; } });
    expect(opened).toBe(0);
  });

  it('an unbound run\'s result never carries a binding key: the annotation is only for a run that HAS a record', () => {
    for (const port of [undefined, true, false]) {
      const res = legacyWrite(makeBoundWorld({ binding: null }), { ops_state: 'active' }, { honorBinding: port });
      expect(res.ok, String(port)).toBe(true);
      expect(Object.hasOwn(res, 'binding'), String(port)).toBe(false);
    }
  });

  it('the ledger-refusal shape carries the annotation too', () => {
    const w = makeBoundWorld();
    const res = legacyWrite(w, { ops_state: 'done' }, { ledger: { session_id: SID }, appendEvent: () => ({ ok: false, reason: 'busy' }) });
    expect(res).toMatchObject({ ok: false, ledger: 'refused', binding: { status: 'disabled' } });
  });

  it('reads: with the key off the legacy storeReader answers, the store port is never consulted, and the result says disabled', () => {
    const w = makeBoundWorld({ run: { lanes: { alpha: { state: 'review', since: iso(3) } } } });
    let asked = 0;
    const store = { getState: () => { asked += 1; return {}; } };
    const read = readWorkerState({ runDir: w.runDir, store, storeReader: () => ({ workers: { alpha: { status: 'done' } } }) });
    expect(asked).toBe(0);
    expect(read.binding).toEqual({ status: 'disabled' });
    expect(read.workers.alpha).toMatchObject({ status: 'done', source: 'store' }); // the legacy store layer
  });

  it('reads: a damaged binding reads as disabled while off, invalid while on', () => {
    const w = makeBoundWorld({ binding: { ...BINDING, mission_id: 'nope' } });
    expect(readWorkerState({ runDir: w.runDir }).binding).toEqual({ status: 'disabled' });
    expect(readWorkerState({ runDir: w.runDir, honorBinding: true }).binding).toEqual({ status: 'invalid', reason: 'binding-invalid:mission_id' });
  });
});

/* ══════════ SH-11 stale guard (④) — writes made while the key was OFF leave node.ops behind run.json ══════════
 *
 * Turning the key off is safe; turning it on again is not free. The legacy path
 * writes run.json and never the node, so after off -> on the node's `ops`
 * describes a moment BEFORE the lane's last word. A bound write computes its
 * previous state, its `since` and its ledger key from that node, so it
 * REFUSES rather than build on it. Two judges, either refuses. The first reads
 * no clock (pre-flip condition 4, the nested block at the end): a bound write
 * seals the lane it projects, and a lane that says something other than its
 * seal was written by something other than the store's projection since. The
 * second is for a lane with no seal, and two clauses of it refuse: the lane's
 * `updated_at` is later than the node's, OR the lane's word differs from
 * `node.ops.state` and post-dates `node.ops.since` (the second exists because
 * the legacy feeder's ownership refresh also stamps `node.updated_at`, after
 * its own lane write, which hides the first). WHAT THIS CANNOT SEE: a legacy
 * write that leaves the sealed facts as they were, made with a clock behind the
 * node's, and a lane hand-edited to say what it said before.
 */
describe('SH-11 stale guard (④)', () => {
  /** alpha written to the store at 05:00, then — key OFF — to run.json at 06:00. */
  function flippedWorld() {
    const w = makeBoundWorld();
    expect(boundWrite(w, 'alpha', { ops_state: 'active' }).ok).toBe(true);
    const off = writeWorkerState({ runDir: w.runDir, worker: 'alpha', patch: { ops_state: 'review' }, store: w.store, honorBinding: false, now: () => utc(6) });
    expect(off.binding).toEqual({ status: 'disabled' });
    expect(laneOf(w, 'alpha')).toMatchObject({ state: 'review', projected_from: PROJECTION_MARK, updated_at: iso(6) });
    return w;
  }
  const tamperLane = (w, over) => {
    const run = readRun(w.runDir);
    run.lanes.alpha = { ...run.lanes.alpha, ...over };
    for (const [k, v] of Object.entries(over)) if (v === undefined) delete run.lanes.alpha[k];
    fs.writeFileSync(path.join(w.runDir, 'run.json'), JSON.stringify(run));
  };

  it('rejects a bound write with binding-stale; run.json, the store and the ledger port are untouched', () => {
    const w = flippedWorld();
    const before = runBytes(w);
    const v = storeVersion(w);
    const events = [];
    const res = boundWrite(w, 'alpha', { ops_state: 'done' }, {
      now: () => utc(7), ledger: { session_id: SID }, appendEvent: (e) => { events.push(e); return { ok: true }; },
    });
    expect(res).toMatchObject({ ok: false, reason: 'binding-stale', worker: 'alpha', ledger: 'not-attempted' });
    expect(res.detail).toMatch(/lanes\.alpha/);
    expect(res.detail).toMatch(/missionBinding/);
    expect(runBytes(w)).toEqual(before);
    expect(storeVersion(w)).toBe(v);
    expect(nodeOf(w, 'alpha').ops.state).toBe('active');
    expect(events).toEqual([]);
  });

  it('judges the record, not the request: a state-less patch is refused too', () => {
    const w = flippedWorld();
    expect(boundWrite(w, 'alpha', { note: 'x' }, { now: () => utc(7) })).toMatchObject({ ok: false, reason: 'binding-stale' });
  });

  it('a different limb of the same run is not affected — the guard is per node', () => {
    const w = flippedWorld();
    expect(boundWrite(w, 'beta', { ops_state: 'active' }, { now: () => utc(7) })).toMatchObject({ ok: true, source: 'store' });
  });

  it('the way out is deliberate: drop the stale lane entry and the same write goes through', () => {
    const w = flippedWorld();
    const run = readRun(w.runDir);
    delete run.lanes.alpha;
    fs.writeFileSync(path.join(w.runDir, 'run.json'), JSON.stringify(run));
    const res = boundWrite(w, 'alpha', { ops_state: 'done' }, { now: () => utc(7) });
    expect(res).toMatchObject({ ok: true, opsState: 'done', previousOps: 'active' });
    expect(laneOf(w, 'alpha')).toMatchObject({ state: 'done', projected_from: STORE_PROJECTION_MARK });
  });

  it('does not fire for what it can judge current: a lane the store projected, an older lane, an equal instant, no updated_at, a node with no ops', () => {
    const cases = {
      'store-projected lane, even with a later stamp': { projected_from: STORE_PROJECTION_MARK, updated_at: iso(9) },
      'legacy lane OLDER than the node': { projected_from: PROJECTION_MARK, updated_at: iso(4) },
      'legacy lane at the SAME instant': { projected_from: PROJECTION_MARK, updated_at: iso(5) },
      'legacy lane with no updated_at': { projected_from: PROJECTION_MARK, updated_at: undefined },
      'lane with no projected_from stamp and an unparseable updated_at': { projected_from: undefined, updated_at: 'soon' },
    };
    for (const [name, over] of Object.entries(cases)) {
      const w = makeBoundWorld();
      expect(boundWrite(w, 'alpha', { ops_state: 'active' }).ok, name).toBe(true);
      tamperLane(w, over);
      expect(boundWrite(w, 'alpha', { ops_state: 'review' }, { now: () => utc(10) }), name).toMatchObject({ ok: true, source: 'store' });
    }
  });

  it('a lane with a LATER updated_at and no store mark is stale, whoever wrote it — the store did not', () => {
    const w = makeBoundWorld();
    expect(boundWrite(w, 'alpha', { ops_state: 'active' }).ok).toBe(true);
    tamperLane(w, { projected_from: undefined, updated_at: iso(8) });
    expect(boundWrite(w, 'alpha', { ops_state: 'review' }, { now: () => utc(10) })).toMatchObject({ ok: false, reason: 'binding-stale' });
  });

  it('a node with no ops has nothing to be behind: the lane is its previous state (the backfill), whatever its stamp', () => {
    const w = makeBoundWorld({ run: { lanes: { alpha: { state: 'review', since: iso(3), projected_from: PROJECTION_MARK, updated_at: iso(8) } } } });
    const legacyNode = { schema_version: 1, mission_id: MISSION, tasks: [{ id: 'alpha', mission_id: MISSION, status: 'claimed', owner: 'alpha', updated_at: iso(1) }] };
    expect(w.store.updateMission(MISSION, (cur) => cur, { graph: legacyNode, reason: 'test.legacy' }).ok).toBe(true);
    expect(boundWrite(w, 'alpha', { note: 'x' }, { now: () => utc(10) })).toMatchObject({ ok: true, previousOps: 'review', changed: false });
  });

  /**
   * What the LEGACY feeder does to a node in the off period when the plan's
   * ownership changed: `mergeLimbTasks` rewrites `file_ownership` and stamps
   * `updated_at` — `ops` is left alone. (`claimTask` / `releaseTask` /
   * `heartbeatWorker` do NOT stamp `updated_at`; only this refresh does.)
   */
  const legacyRefresh = (w, at) => {
    const graph = w.store.getTaskGraph(MISSION);
    const tasks = graph.tasks.map((t) => (t.id === 'alpha' ? { ...t, file_ownership: ['src/moved/**'], updated_at: at } : t));
    expect(w.store.updateMission(MISSION, (cur) => cur, { graph: { ...graph, tasks }, reason: 'test.legacy-refresh' }).ok).toBe(true);
  };

  it('a legacy ownership refresh AFTER the legacy lane write moves node.updated_at past the lane — an UNSEALED lane is still stale: its word differs from ops and post-dates ops.since', () => {
    const w = flippedWorld(); // ops active since 05:00; lane review, run.json, 06:00
    // The seal is what sees this case first (next test), so take it off to keep timestamp clause (2) pinned
    // for the lanes that have none — a lane the projection never reached.
    tamperLane(w, { projection_seal: undefined });
    legacyRefresh(w, iso(6, 30)); // node.updated_at 06:30 > lane 06:00: the updated_at comparison alone cannot see the drift
    const before = runBytes(w);
    const v = storeVersion(w);
    const res = boundWrite(w, 'alpha', { ops_state: 'done' }, { now: () => utc(7) });
    expect(res).toMatchObject({ ok: false, reason: 'binding-stale', worker: 'alpha' });
    expect(res.detail).toMatch(/says 'review'/);
    expect(res.detail).toMatch(/ops says 'active'/);
    expect(runBytes(w)).toEqual(before);
    expect(storeVersion(w)).toBe(v);
    expect(nodeOf(w, 'alpha').ops.state).toBe('active');
  });

  it('the same refresh over a SEALED lane is stale by the seal, without reading a stamp', () => {
    const w = flippedWorld();
    legacyRefresh(w, iso(6, 30));
    const before = runBytes(w);
    const v = storeVersion(w);
    const res = boundWrite(w, 'alpha', { ops_state: 'done' }, { now: () => utc(7) });
    expect(res).toMatchObject({ ok: false, reason: 'binding-stale', worker: 'alpha' });
    expect(res.detail).toMatch(/projected/);
    expect(res.detail).toMatch(/state: "active" -> "review"/);
    expect(runBytes(w)).toEqual(before); // a refusal writes nothing: run.json and the store stay put
    expect(storeVersion(w)).toBe(v);
  });

  it('CONTROL — the same refresh over a lane that says what ops says is not stale: there is no drift to lose', () => {
    const w = makeBoundWorld();
    expect(boundWrite(w, 'alpha', { ops_state: 'active' }).ok).toBe(true);
    // A legacy re-assert of the SAME word at 06:00, then the refresh at 06:30.
    const off = writeWorkerState({ runDir: w.runDir, worker: 'alpha', patch: { ops_state: 'active' }, store: w.store, honorBinding: false, now: () => utc(6) });
    expect(off).toMatchObject({ ok: true, binding: { status: 'disabled' } });
    legacyRefresh(w, iso(6, 30));
    expect(boundWrite(w, 'alpha', { ops_state: 'review' }, { now: () => utc(7) })).toMatchObject({ ok: true, source: 'store', previousOps: 'active' });
  });

  it('CONTROL — a lane the projection left BEHIND the node is not stale: a real projection failure leaves it sealed at the last projection (the store is right)', () => {
    const w = makeBoundWorld();
    expect(boundWrite(w, 'alpha', { ops_state: 'active' }).ok).toBe(true);
    const cut = boundWrite(w, 'alpha', { ops_state: 'review' }, { now: () => utc(6), projectRunJson: () => { throw new Error('disk full'); } });
    expect(cut.projection).toMatch(/^failed:disk full/); // ops review since 06:00; the lane still says active
    expect(laneOf(w, 'alpha').state).toBe('active');
    expect(boundWrite(w, 'alpha', { ops_state: 'closing' }, { now: () => utc(7) })).toMatchObject({ ok: true, source: 'store', previousOps: 'review' });
  });

  it('CONTROL — the former tamper model of that case is only "behind" for a lane with no seal: older than the ops change, so not stale', () => {
    const w = makeBoundWorld();
    expect(boundWrite(w, 'alpha', { ops_state: 'active' }).ok).toBe(true);
    expect(boundWrite(w, 'alpha', { ops_state: 'review' }, { now: () => utc(6) }).ok).toBe(true); // ops review since 06:00
    // a lane that never caught up, no store stamp and no seal (the projection never reached it)
    tamperLane(w, { state: 'active', projected_from: PROJECTION_MARK, updated_at: iso(5, 30), projection_seal: undefined });
    expect(boundWrite(w, 'alpha', { ops_state: 'closing' }, { now: () => utc(7) })).toMatchObject({ ok: true, source: 'store', previousOps: 'review' });
  });

  describe('pre-flip condition (4) — the marker that does not read the clock', () => {
    /*
     * The clauses above compare `updated_at` stamps, so they inherit the clock's two blind spots: a legacy write
     * made with a clock BEHIND the node's reads as older than the node, and a lane edited by hand without touching
     * `updated_at` reads as untouched. A bound write now SEALS the lane it projects (`projection_seal`: the
     * facts it gave the lane — state, since, window, note, blocked_by). The legacy path spreads the lane it
     * rewrites, so the seal survives it while the facts do not: the lane saying something other than what the
     * store last projected into it is drift, judged by comparison, with no clock. A lane with no seal (never
     * projected) is still judged by the timestamp clauses.
     * WHAT THIS CANNOT SEE: a write that leaves the five facts as they were (a legacy re-assert of the same
     * word is not drift — the timestamp clauses still judge that one), and a lane hand-edited to say exactly
     * what it said before.
     */
    const editLane = (w, over) => {
      const run = readRun(w.runDir);
      run.lanes.alpha = { ...run.lanes.alpha, ...over };
      fs.writeFileSync(path.join(w.runDir, 'run.json'), JSON.stringify(run));
    };
    const legacyWrite = (w, state, hour) => writeWorkerState({
      runDir: w.runDir, worker: 'alpha', patch: { ops_state: state }, store: w.store, honorBinding: false, now: () => utc(hour),
    });

    it('a bound write seals the lane it projects with the facts it gave it', () => {
      const w = makeBoundWorld();
      boundWrite(w, 'alpha', { ops_state: 'active', window: 'w-1', note: 'go' });
      expect(laneOf(w, 'alpha').projection_seal).toEqual({ state: 'active', since: iso(5), window: 'w-1', note: 'go', blocked_by: null });
      boundWrite(w, 'beta', { ops_state: 'serial-gate', blocked_by: ['lane:alpha'] });
      expect(laneOf(w, 'beta').projection_seal).toEqual({ state: 'serial-gate', since: iso(5), window: null, note: null, blocked_by: ['lane:alpha'] });
    });

    it('the seal survives a legacy write untouched — that is what lets the guard see the write', () => {
      const w = makeBoundWorld();
      boundWrite(w, 'alpha', { ops_state: 'active', window: 'w-1' });
      const sealed = laneOf(w, 'alpha').projection_seal;
      expect(sealed).toMatchObject({ state: 'active', window: 'w-1' });
      expect(legacyWrite(w, 'review', 6).binding).toEqual({ status: 'disabled' });
      expect(laneOf(w, 'alpha')).toMatchObject({ state: 'review', projected_from: PROJECTION_MARK });
      expect(laneOf(w, 'alpha').projection_seal).toEqual(sealed);
    });

    it('the OFF path adds nothing: a lane the legacy path writes that was never sealed carries no seal key', () => {
      const w = makeBoundWorld();
      expect(legacyWrite(w, 'active', 5).ok).toBe(true);
      expect(Object.keys(laneOf(w, 'alpha')).sort()).toEqual(['projected_from', 'since', 'state', 'updated_at']);
    });

    it('a legacy write made with a clock BEHIND the node is stale — the word moved, whatever the stamps say', () => {
      const w = makeBoundWorld();
      expect(boundWrite(w, 'alpha', { ops_state: 'active' }).ok).toBe(true); // node ops: active since 05:00
      expect(legacyWrite(w, 'review', 4).binding).toEqual({ status: 'disabled' }); // key OFF, and that write's clock reads 04:00
      expect(laneOf(w, 'alpha')).toMatchObject({ state: 'review', updated_at: iso(4) });
      const before = runBytes(w);
      const v = storeVersion(w);
      const res = boundWrite(w, 'alpha', { ops_state: 'done' }, { now: () => utc(7) });
      expect(res).toMatchObject({ ok: false, reason: 'binding-stale', worker: 'alpha', ledger: 'not-attempted' });
      expect(res.detail).toMatch(/lanes\.alpha/);
      expect(res.detail).toMatch(/projected/);
      expect(res.detail).toMatch(/state: "active" -> "review"/);
      expect(res.detail).toMatch(/missionBinding/);
      expect(runBytes(w)).toEqual(before);
      expect(storeVersion(w)).toBe(v);
      expect(nodeOf(w, 'alpha').ops.state).toBe('active');
    });

    it('a projected lane edited by hand without touching its stamps is stale', () => {
      const w = makeBoundWorld();
      boundWrite(w, 'alpha', { ops_state: 'active', window: 'w-1' });
      editLane(w, { window: 'w-elsewhere' }); // projected_from is still "store" and updated_at is untouched
      expect(laneOf(w, 'alpha')).toMatchObject({ projected_from: STORE_PROJECTION_MARK, updated_at: iso(5) });
      const res = boundWrite(w, 'alpha', { ops_state: 'review' }, { now: () => utc(7) });
      expect(res).toMatchObject({ ok: false, reason: 'binding-stale' });
      expect(res.detail).toMatch(/window: "w-1" -> "w-elsewhere"/);
    });

    it.each([
      ['since', { since: iso(2) }],
      ['note', { note: 'added by hand' }],
      ['blocked_by', { blocked_by: ['human:paused'] }],
    ])('every fact counts: a changed %s is drift', (_name, over) => {
      const w = makeBoundWorld();
      boundWrite(w, 'alpha', { ops_state: 'active' });
      editLane(w, over);
      expect(boundWrite(w, 'alpha', { ops_state: 'review' }, { now: () => utc(7) })).toMatchObject({ ok: false, reason: 'binding-stale' });
    });

    it('CONTROL — a lane the projection never reached is NOT stale: it is sealed at the LAST projection, and the next write heals it', () => {
      const w = makeBoundWorld();
      boundWrite(w, 'alpha', { ops_state: 'pending' }, { now: () => utc(4) });
      const cut = boundWrite(w, 'alpha', { ops_state: 'active' }, { now: () => utc(5), projectRunJson: () => { throw new Error('disk full'); } });
      expect(cut).toMatchObject({ ok: true, opsState: 'active' });
      expect(cut.projection).toMatch(/^failed:disk full/);
      expect(laneOf(w, 'alpha')).toMatchObject({ state: 'pending', projected_from: STORE_PROJECTION_MARK }); // behind the node, and says so in its own seal
      const res = boundWrite(w, 'alpha', { ops_state: 'review' }, { now: () => utc(6) });
      expect(res).toMatchObject({ ok: true, previousOps: 'active' });
      expect(laneOf(w, 'alpha')).toMatchObject({ state: 'review', projected_from: STORE_PROJECTION_MARK });
      expect(laneOf(w, 'alpha').projection_seal.state).toBe('review');
    });

    it('CONTROL — a legacy re-assert of the SAME facts is not drift (no word moved)', () => {
      const w = makeBoundWorld();
      boundWrite(w, 'alpha', { ops_state: 'active' });
      expect(legacyWrite(w, 'active', 4).ok).toBe(true); // a clock behind the node, but nothing the lane says has changed
      expect(boundWrite(w, 'alpha', { ops_state: 'review' }, { now: () => utc(7) })).toMatchObject({ ok: true, source: 'store', previousOps: 'active' });
    });

    it('a lane with NO seal (never projected) is still judged by the timestamp clauses', () => {
      const w = flippedWorld(); // alpha active@05:00 in the store, review@06:00 in run.json — with a seal, as a bound write left it
      const run = readRun(w.runDir);
      delete run.lanes.alpha.projection_seal;
      fs.writeFileSync(path.join(w.runDir, 'run.json'), JSON.stringify(run));
      expect(boundWrite(w, 'alpha', { ops_state: 'done' }, { now: () => utc(7) })).toMatchObject({ ok: false, reason: 'binding-stale' });
    });

    it('a malformed seal is no seal: the timestamp clauses answer instead of a crash', () => {
      const w = makeBoundWorld();
      boundWrite(w, 'alpha', { ops_state: 'active' });
      editLane(w, { projection_seal: 'not-an-object' });
      expect(boundWrite(w, 'alpha', { ops_state: 'review' }, { now: () => utc(7) })).toMatchObject({ ok: true, source: 'store' });
    });
  });

  it('off -> on -> off -> on: each turn of the key is safe, and only the stale one refuses', () => {
    const w = makeBoundWorld();
    const write = (honorBinding, state, hour) => writeWorkerState({ runDir: w.runDir, worker: 'alpha', patch: { ops_state: state }, store: w.store, honorBinding, now: () => utc(hour) });
    expect(write(true, 'active', 5)).toMatchObject({ ok: true, source: 'store' });
    expect(write(true, 'review', 6)).toMatchObject({ ok: true, source: 'store' });
    expect(write(false, 'closing', 7)).toMatchObject({ ok: true, binding: { status: 'disabled' } });
    expect(write(false, 'done', 8)).toMatchObject({ ok: true, binding: { status: 'disabled' } });
    expect(write(true, 'done', 9)).toMatchObject({ ok: false, reason: 'binding-stale' });
    expect(nodeOf(w, 'alpha').ops.state).toBe('review'); // the store still says what it said at 06:00
    expect(laneOf(w, 'alpha').state).toBe('done'); // and run.json says what the operator last set
  });
});
