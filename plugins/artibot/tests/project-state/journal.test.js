import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  emptySnapshot,
  readJournal,
  reduceProjectState,
  STORE_ONLY_FIELD,
  STORE_ONLY_RECORD_KINDS,
  STORE_RECORD_KINDS,
  storeOnlyVersions,
} from '../../lib/project-state/journal.js';

const MID = 'M-20260902-001';
const rec = (kind, extra) => ({ v: 1, ts: '2026-09-02T00:00:00.000Z', state_version: 1, kind, mission_id: MID, ...extra });
const mission = () => ({ status: 'executing', intent: { path: 'i', revision: 1 }, plan: { path: 'p', revision: 1 } });
const graph = (tasks = []) => ({ schema_version: 1, mission_id: MID, tasks });
const task = (id, extra) => ({ id, mission_id: MID, status: 'queued', ...extra });
const lease = {
  owner: 'w', acquired_at: '2026-09-02T00:00:00.000Z',
  expires_at: '2026-09-02T00:30:00.000Z', heartbeat_at: '2026-09-02T00:00:00.000Z',
};

const dirs = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'artibot-journal-'));
  dirs.push(d);
  return d;
};
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true }); });

describe('the record vocabulary is a closed set', () => {
  it('holds exactly the eight kinds the store writes', () => {
    expect([...STORE_RECORD_KINDS]).toEqual([
      'mission.upsert', 'mission.remove', 'graph.upsert',
      'task.upsert', 'task.remove', 'lease.set', 'lease.clear', 'meta.upsert',
    ]);
  });
});

describe('emptySnapshot', () => {
  it('starts below the projection floor, with every collection present', () => {
    const s = emptySnapshot('artibot');
    expect(s.state_version).toBe(0);
    expect(s.updated_at).toBeNull();
    expect(s).toMatchObject({
      active_missions: {}, task_graphs: {}, task_leases: {}, project_meta: { missions: {} },
    });
  });
});

describe('reduceProjectState — every record kind', () => {
  it('applies mission.upsert then mission.remove', () => {
    const { state } = reduceProjectState([
      rec('mission.upsert', { mission: mission() }),
      rec('graph.upsert', { graph: graph() }),
      rec('mission.remove', { state_version: 2 }),
    ]);
    expect(state.active_missions).toEqual({});
    expect(state.task_graphs).toEqual({});
    expect(state.state_version).toBe(2);
  });

  it('adds then replaces a task in place, keeping its position', () => {
    const { state } = reduceProjectState([
      rec('mission.upsert', { mission: mission() }),
      rec('graph.upsert', { graph: graph([task('T-1'), task('T-2')]) }),
      rec('task.upsert', { task: task('T-1', { status: 'done' }), state_version: 2 }),
    ]);
    expect(state.task_graphs[MID].tasks.map((t) => t.id)).toEqual(['T-1', 'T-2']);
    expect(state.task_graphs[MID].tasks[0].status).toBe('done');
  });

  it('appends a task the graph did not hold', () => {
    const { state } = reduceProjectState([
      rec('mission.upsert', { mission: mission() }),
      rec('graph.upsert', { graph: graph() }),
      rec('task.upsert', { task: task('T-9'), state_version: 2 }),
    ]);
    expect(state.task_graphs[MID].tasks.map((t) => t.id)).toEqual(['T-9']);
  });

  it('removes a task and its lease together', () => {
    const { state } = reduceProjectState([
      rec('mission.upsert', { mission: mission() }),
      rec('graph.upsert', { graph: graph([task('T-1')]) }),
      rec('lease.set', { task_id: 'T-1', lease, state_version: 2 }),
      rec('task.remove', { task_id: 'T-1', state_version: 3 }),
    ]);
    expect(state.task_graphs[MID].tasks).toEqual([]);
    expect(state.task_leases[MID]['T-1']).toBeUndefined();
  });

  it('tolerates task.remove for a mission with no graph', () => {
    const { state } = reduceProjectState([rec('task.remove', { task_id: 'T-1' })]);
    expect(state.task_graphs).toEqual({});
  });

  it('sets and clears a lease', () => {
    const { state } = reduceProjectState([
      rec('lease.set', { task_id: 'T-1', lease }),
      rec('lease.clear', { task_id: 'T-1', state_version: 2 }),
    ]);
    expect(state.task_leases[MID]).toEqual({});
  });

  it('tolerates lease.clear on a mission that holds no leases', () => {
    expect(reduceProjectState([rec('lease.clear', { task_id: 'T-1' })]).warnings).toEqual([]);
  });

  it('stores project_meta separately from the mission', () => {
    const { state } = reduceProjectState([
      rec('mission.upsert', { mission: mission() }),
      rec('meta.upsert', { meta: { owners: { humans: ['user-001'] } }, state_version: 2 }),
    ]);
    expect(state.project_meta.missions[MID].owners.humans).toEqual(['user-001']);
    expect(state.active_missions[MID].owners).toBeUndefined();
  });

  it('deep-copies, so mutating the input cannot reach the folded state', () => {
    const source = mission();
    const { state } = reduceProjectState([rec('mission.upsert', { mission: source })]);
    source.status = 'failed';
    expect(state.active_missions[MID].status).toBe('executing');
  });
});

describe('reduceProjectState — fail-safe rules', () => {
  it('rejects a non-array argument with a warning, not a throw', () => {
    const { state, warnings } = reduceProjectState('nope');
    expect(warnings).toEqual(['records must be an array']);
    expect(state.state_version).toBe(0);
  });

  it('skips a non-object record', () => {
    expect(reduceProjectState([null, 42]).warnings).toHaveLength(2);
  });

  it('takes updated_at from the last record carrying one', () => {
    const { state } = reduceProjectState([
      rec('mission.upsert', { mission: mission() }),
      rec('mission.upsert', { mission: mission(), ts: '2026-09-03T00:00:00.000Z', state_version: 2 }),
    ]);
    expect(state.updated_at).toBe('2026-09-03T00:00:00.000Z');
  });

  it('adopts a project name a record carries', () => {
    expect(reduceProjectState([rec('meta.upsert', { meta: {}, project: 'renamed' })]).state.project)
      .toBe('renamed');
  });

  it('is deterministic — the same array folds to a deep-equal snapshot', () => {
    const records = [
      rec('mission.upsert', { mission: mission() }),
      rec('graph.upsert', { graph: graph([task('T-1')]) }),
    ];
    expect(reduceProjectState(records)).toEqual(reduceProjectState(records));
  });

  it('applies records in array order, not sorted order', () => {
    const { state } = reduceProjectState([
      rec('mission.upsert', { mission: mission(), state_version: 2 }),
      rec('mission.upsert', { mission: { ...mission(), status: 'blocked' }, state_version: 1 }),
    ]);
    expect(state.active_missions[MID].status).toBe('blocked');
    expect(state.state_version).toBe(2);
  });
});

describe('readJournal', () => {
  it('reads nothing from a file that does not exist', () => {
    expect(readJournal(path.join(tmp(), 'absent.jsonl'))).toEqual({ records: [], torn: 0 });
  });

  it('ignores blank lines', () => {
    const file = path.join(tmp(), 'j.jsonl');
    writeFileSync(file, '\n{"kind":"mission.remove"}\n\n');
    expect(readJournal(file)).toEqual({ records: [{ kind: 'mission.remove' }], torn: 0 });
  });

  it('counts a torn tail instead of refusing to open the store', () => {
    const file = path.join(tmp(), 'j.jsonl');
    writeFileSync(file, '{"kind":"mission.remove"}\n{"kind":"mission.up');
    const out = readJournal(file);
    expect(out.records).toHaveLength(1);
    expect(out.torn).toBe(1);
  });
});

describe('storeOnlyVersions — the versions a ledger comparison may leave out (design D11)', () => {
  // A heartbeat renewal commits two records, a `task.upsert` and a `lease.set`, under ONE
  // state_version. The rule is an ALLOWLIST read per version: every record at the version
  // must carry the mark AND be one of those two kinds, or the version is not exempt.
  const marked = (version, kind, extra) => rec(kind, { state_version: version, [STORE_ONLY_FIELD]: true, ...extra });
  const beat = (version) => [
    marked(version, 'task.upsert', { task: task('T-1') }),
    marked(version, 'lease.set', { task_id: 'T-1', lease }),
  ];

  it('names the mark and the two record kinds a heartbeat renewal writes', () => {
    expect(STORE_ONLY_FIELD).toBe('store_only');
    expect([...STORE_ONLY_RECORD_KINDS]).toEqual(['task.upsert', 'lease.set']);
  });

  it('lists a version whose every record is marked and heartbeat-shaped', () => {
    expect(storeOnlyVersions(beat(3))).toEqual([3]);
  });

  it('returns sorted distinct versions, however the records are ordered', () => {
    expect(storeOnlyVersions([...beat(7), ...beat(3), ...beat(5)])).toEqual([3, 5, 7]);
  });

  it('is empty for an ordinary journal, an empty one and input that is not an array', () => {
    expect(storeOnlyVersions([
      rec('mission.upsert', { mission: mission() }),
      rec('graph.upsert', { graph: graph() }),
    ])).toEqual([]);
    expect(storeOnlyVersions([])).toEqual([]);
    for (const bad of [undefined, null, 'x', 7, {}]) expect(storeOnlyVersions(bad)).toEqual([]);
  });

  it.each([
    ['mission.upsert', { mission: mission() }],
    ['graph.upsert', { graph: graph() }],
    ['mission.remove', {}],
    ['task.remove', { task_id: 'T-1' }],
    ['lease.clear', { task_id: 'T-1' }],
    ['meta.upsert', { meta: {} }],
    ['an unknown kind', {}],
  ])('does NOT exempt a marked %s: the mark alone is not the rule', (kind, extra) => {
    const name = kind === 'an unknown kind' ? 'mission.teleport' : kind;
    expect(storeOnlyVersions([marked(2, name, extra)])).toEqual([]);
  });

  it('does NOT exempt a version where one record is unmarked, or one is a disallowed kind', () => {
    expect(storeOnlyVersions([beat(2)[0], rec('lease.set', { state_version: 2, task_id: 'T-1', lease })])).toEqual([]);
    expect(storeOnlyVersions([...beat(2), marked(2, 'mission.upsert', { mission: mission() })])).toEqual([]);
    // The neighbour version is judged on its own records, not on the failed one's.
    expect(storeOnlyVersions([...beat(2), rec('lease.set', { state_version: 2, task_id: 'T-1', lease }), ...beat(3)])).toEqual([3]);
  });

  it('reads the mark strictly: only the boolean true counts', () => {
    for (const mark of ['true', 1, {}, [], null, false, 'store_only']) {
      expect(storeOnlyVersions([
        rec('task.upsert', { state_version: 4, [STORE_ONLY_FIELD]: mark, task: task('T-1') }),
        rec('lease.set', { state_version: 4, [STORE_ONLY_FIELD]: mark, task_id: 'T-1', lease }),
      ]), JSON.stringify(mark)).toEqual([]);
    }
  });

  it('ignores records that carry no integer state_version, and non-object entries', () => {
    expect(storeOnlyVersions([
      null, 7, 'x',
      { kind: 'task.upsert', [STORE_ONLY_FIELD]: true },
      { kind: 'task.upsert', [STORE_ONLY_FIELD]: true, state_version: '3' },
      { kind: 'task.upsert', [STORE_ONLY_FIELD]: true, state_version: 3.5 },
    ])).toEqual([]);
  });

  it('is not fooled by the mark sitting on a version that also has an unmarked twin elsewhere in the file', () => {
    // A version reused by two commits (the CAS slot claimed twice): one exempt run does not make the other exempt.
    expect(storeOnlyVersions([...beat(6), rec('mission.upsert', { state_version: 6, mission: mission() })])).toEqual([]);
  });

  it('does not change the fold: a marked record folds exactly like an unmarked one', () => {
    const plain = [
      rec('mission.upsert', { mission: mission() }),
      rec('graph.upsert', { graph: graph([task('T-1')]) }),
      rec('task.upsert', { state_version: 2, task: task('T-1', { heartbeat_source: 'lease-tick' }) }),
      rec('lease.set', { state_version: 2, task_id: 'T-1', lease }),
    ];
    const withMarks = plain.map((r) => (r.state_version === 2 ? { ...r, [STORE_ONLY_FIELD]: true } : r));
    expect(reduceProjectState(withMarks)).toEqual(reduceProjectState(plain));
  });
});
