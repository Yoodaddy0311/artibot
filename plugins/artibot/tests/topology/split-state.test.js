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
 *  - The StateStore. It does not exist (T-21). Every `storeReader` here is a
 *    fixture this file wrote, so "store wins" is proven about the priority
 *    code and about NOTHING on disk.
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
  PROJECTION_MARK,
  readWorkerState,
  STATE_SOURCES,
  writeWorkerState,
} from '../../lib/topology/split-state.js';
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
