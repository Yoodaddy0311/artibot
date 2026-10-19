/**
 * `lane-state --list` answers through `lib/topology/split-state.js#readWorkerState`
 * (SH-11: the first production reader to take that door).
 *
 * Until now `--list` read the `run.json` PROJECTION of a bound run, so the one
 * table the leader looks at could say something other than the Task Graph node
 * that is canonical for that run (the window where a store commit succeeded and
 * the projection did not). Two halves are measured here:
 *
 *  - a BOUND run with the canary key ON is answered by the bound mission's node,
 *    and a binding that cannot be read is SAID (a footer line, a `source` per row)
 *    rather than shown as if the table were canonical;
 *  - everything else — an unbound run, and a run that carries a record while the
 *    key is OFF — reads exactly what the run.json-only reader read before. That
 *    half is pinned against a copy of the base tree's algorithm over every lane
 *    shape the reader accepts, so "the OFF path is unchanged" is measured.
 *
 * Every store is a real `createStateStore` under a tmpdir. `sessionId` and
 * `openStore` are explicit arguments: the host's own session id leaks into
 * `process.env` in this suite.
 *
 * WHAT THIS CANNOT SEE (rules section 9): whether a live `lane-state` child
 * process has the session id a store needs (a host fact, measured for a Bash tool
 * call on 2026-09-21 and not re-measured here), a live run that is bound (none
 * is), and two processes writing while `--list` reads.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listLaneStates, main, readLaneStates, setLaneState } from '../../scripts/split/lane-state.mjs';
import { readRunJson, windowForLimb, writeRunJson } from '../../lib/git/split-run-file.js';
import { createStateStore } from '../../lib/project-state/state-manager.js';
import { isLaneOpsState } from '../../lib/supervisor/contracts.js';

const SID = 'abcd1234-ef56-7890-1234-567890abcdef';
const MISSION = 'M-20261019-Sabcd1234';
const RUN = 'split-t';
const T1 = () => new Date('2026-10-19T05:00:00.000Z');
const T2 = () => new Date('2026-10-19T06:00:00.000Z');
// The SH-11 canary switch: only a literal true honours a binding.
const ON = { split: { missionBinding: { enabled: true } } };
const OFF = { split: { missionBinding: { enabled: false } } };

const tmpDirs = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const splitDir = (parent) => path.join(parent, '.artibot', 'split');

/** An unbound run: plan.json (one `{limb}` per name) and, unless `run` is null, run.json. */
function seed({ limbs = ['auth', 'billing'], run = { runId: RUN, windowReuse: { auth: 'w-a @ /p' } } } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-list-'));
  tmpDirs.push(parent);
  fs.mkdirSync(splitDir(parent), { recursive: true });
  fs.writeFileSync(path.join(splitDir(parent), 'plan.json'), JSON.stringify({ runId: RUN, limbs: limbs.map((limb) => ({ limb })) }));
  if (run !== null) writeRunJson(parent, run);
  return parent;
}

/** Bind `parent`'s plan to MISSION and return a real store beside it (the mission row exists unless `missionRow` is false). */
function bind(parent, { missionRow = true, binding = {} } = {}) {
  const planPath = path.join(splitDir(parent), 'plan.json');
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
  const record = { mission_id: MISSION, run_id: RUN, generation: 1, bound_at: '2026-10-19T04:00:00.000Z', bound_by_session: SID, ...binding };
  fs.writeFileSync(planPath, JSON.stringify({ ...plan, missionBinding: record }));
  const store = createStateStore({ projectRoot: parent, sessionId: SID, renderProjectionFile: false, appendEvent: () => ({ ok: true }) });
  if (missionRow) {
    const seeded = store.updateMission(MISSION, () => ({ status: 'executing', intent: { path: 'i.md', revision: 1 }, plan: { path: 'p.md', revision: 1 } }), { reason: 'test.seed' });
    expect(seeded.ok).toBe(true);
  }
  return store;
}

const collect = () => {
  const out = []; const err = [];
  return { io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) }, stdout: () => out.join(''), stderr: () => err.join('') };
};

/** A store opener that fails the test if it is ever called. */
const neverOpen = () => { throw new Error('the store must not be opened'); };

/**
 * The BASE TREE's `listLaneStates`, copied (scripts/split/lane-state.mjs at
 * 17122647: `currentEntry` + `listLaneStates`). The new reader must give the same
 * rows for every run that is not store-canonical; this is the reference it is
 * measured against, not a second implementation to keep.
 */
function legacyRows(parent) {
  const run = readRunJson(parent);
  const plan = JSON.parse(fs.readFileSync(path.join(splitDir(parent), 'plan.json'), 'utf-8'));
  return plan.limbs.map(({ limb }) => {
    const raw = run?.lanes && typeof run.lanes === 'object' ? run.lanes[limb] : undefined;
    let e = { state: null, since: null, window: null, note: null };
    if (typeof raw === 'string') e = { ...e, state: isLaneOpsState(raw) ? raw : null };
    else if (raw && typeof raw === 'object') {
      e = {
        state: isLaneOpsState(raw.state) ? raw.state : null,
        since: typeof raw.since === 'string' ? raw.since : null,
        window: typeof raw.window === 'string' ? raw.window : null,
        note: typeof raw.note === 'string' ? raw.note : null,
      };
    }
    return { limb, state: e.state ?? 'unknown', since: e.since, window: e.window ?? windowForLimb(run, limb), note: e.note };
  });
}

describe('--list on a run that is NOT store-canonical — the rows the run.json-only reader gave', () => {
  const CORPUS_LANES = {
    'bare-ok': 'review',
    'bare-bad': 'bogus',
    'full': { state: 'active', since: '2026-10-19T01:00:00.000Z', window: 'w-full', note: 'n', projected_from: 'run.json', updated_at: '2026-10-19T01:00:00.000Z' },
    'state-only': { state: 'done' },
    'bad-state': { state: 'bogus', since: '2026-10-19T01:00:00.000Z' },
    'odd-types': { state: 'active', since: 5, window: 7, note: ['x'] },
    'null-entry': null,
    'num-entry': 42,
    'arr-entry': ['active'],
    'empty-window': { state: 'active', window: '' },
    // A hand-added `ops_state` key beside a state the allowlist does not know must not read as that word.
    'leak': { state: 'bogus', ops_state: 'active' },
    'not-in-plan': { state: 'active' },
  };
  const LIMBS = ['bare-ok', 'bare-bad', 'full', 'state-only', 'bad-state', 'odd-types', 'null-entry', 'num-entry', 'arr-entry', 'empty-window', 'leak', 'absent', 'reuse-only'];
  const WINDOW_REUSE = { absent: 'w-absent @ /p', 'reuse-only': 'w-reuse @ /p', 'bare-ok': 'w-bare @ /p' };

  it('gives the legacy rows for every lane shape, with the window falling back to windowReuse exactly as before', () => {
    const parent = seed({ limbs: LIMBS, run: { runId: RUN, windowReuse: WINDOW_REUSE, lanes: CORPUS_LANES } });
    const rows = listLaneStates({ cwd: parent });
    expect(rows).toEqual(legacyRows(parent));
    // The fixture really exercises the branches (a corpus that all reads `unknown` proves nothing).
    expect(rows.find((r) => r.limb === 'full')).toMatchObject({ state: 'active', window: 'w-full', note: 'n' });
    expect(rows.find((r) => r.limb === 'bare-ok')).toMatchObject({ state: 'review', window: 'w-bare' });
    expect(rows.find((r) => r.limb === 'empty-window').window).toBe('');
    expect(rows.find((r) => r.limb === 'leak').state).toBe('unknown');
    expect(rows.find((r) => r.limb === 'reuse-only')).toMatchObject({ state: 'unknown', window: 'w-reuse' });
  });

  it('gives the legacy rows when run.json does not exist at all', () => {
    const parent = seed({ limbs: ['auth'], run: null });
    expect(listLaneStates({ cwd: parent })).toEqual(legacyRows(parent));
    expect(listLaneStates({ cwd: parent })).toEqual([{ limb: 'auth', state: 'unknown', since: null, window: null, note: null }]);
  });

  it('an unbound run never opens a store and never asks the canary key, and its rows carry exactly the five legacy keys', () => {
    const parent = seed({ run: { runId: RUN, lanes: { auth: { state: 'active', since: '2026-10-19T01:00:00.000Z' } } } });
    const rows = listLaneStates({ cwd: parent, sessionId: SID, openStore: neverOpen, config: ON });
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['limb', 'note', 'since', 'state', 'window']);
    const read = readLaneStates({ cwd: parent, sessionId: SID, openStore: neverOpen, config: ON });
    expect(read.binding).toBeNull();
  });

  it('the CLI output for an unbound run is the legacy table and the legacy JSON array, with no footer', () => {
    const parent = seed({ run: { runId: RUN, lanes: { auth: { state: 'review', since: '2026-10-19T01:00:00.000Z', window: 'w-a', note: 'hi' } } } });
    const j = collect();
    expect(main(['--list', '--json'], { cwd: parent, ...j.io })).toBe(0);
    expect(JSON.parse(j.stdout())).toEqual(legacyRows(parent));
    const t = collect();
    expect(main(['--list'], { cwd: parent, ...t.io })).toBe(0);
    const lines = t.stdout().trimEnd().split('\n');
    expect(lines[0]).toMatch(/^limb\s+state\s+since\s+window\s+note$/);
    expect(lines).toHaveLength(3); // header + two plan limbs, no binding footer
    expect(t.stderr()).toBe('');
  });
});

describe('--list on a BOUND run with the canary key ON — the node answers, not the projection', () => {
  /** A bound world where the store is one step AHEAD of run.json (the projection of the last write never happened). */
  function storeAheadOfProjection() {
    const parent = seed();
    const store = bind(parent);
    const opts = { cwd: parent, sessionId: SID, config: ON, openStore: () => store };
    setLaneState({ limb: 'auth', state: 'active' }, { ...opts, now: T1 });
    const projectedAtActive = readRunJson(parent);
    setLaneState({ limb: 'auth', state: 'review', note: 'ready' }, { ...opts, now: T2 });
    writeRunJson(parent, projectedAtActive); // the commit landed; the run.json rewrite did not
    expect(readRunJson(parent).lanes.auth.state).toBe('active');
    expect(store.getTaskGraph(MISSION).tasks.find((t) => t.id === 'auth').ops.state).toBe('review');
    return { parent, store, opts };
  }

  it('lists the node\'s state, since and note when run.json still shows the earlier projection', () => {
    const { opts } = storeAheadOfProjection();
    const row = listLaneStates(opts).find((r) => r.limb === 'auth');
    expect(row).toMatchObject({ state: 'review', since: '2026-10-19T06:00:00.000Z', window: 'w-a', note: 'ready' });
  });

  it('lists a limb that only the node knows, where the projection has no lane for it at all', () => {
    const { parent, opts } = storeAheadOfProjection();
    writeRunJson(parent, { ...readRunJson(parent), lanes: {} });
    expect(listLaneStates(opts).find((r) => r.limb === 'auth').state).toBe('review');
  });

  it('a plan limb with no node falls back to its own run.json lane, and to unknown when it has neither', () => {
    const parent = seed({ run: { runId: RUN, lanes: { billing: { state: 'serial-gate', since: '2026-10-19T01:00:00.000Z' } } } });
    const store = bind(parent);
    const rows = listLaneStates({ cwd: parent, sessionId: SID, config: ON, openStore: () => store });
    expect(rows.find((r) => r.limb === 'billing')).toMatchObject({ state: 'serial-gate', source: 'run.json' });
    expect(rows.find((r) => r.limb === 'auth')).toMatchObject({ state: 'unknown', source: null });
  });

  it('says where each row came from: `source` on every row of a bound run, and only there', () => {
    const { opts } = storeAheadOfProjection();
    const rows = listLaneStates(opts);
    expect(rows.find((r) => r.limb === 'auth').source).toBe('store');
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['limb', 'note', 'since', 'source', 'state', 'window']);
    const j = collect();
    expect(main(['--list', '--json'], { ...opts, ...j.io })).toBe(0);
    expect(JSON.parse(j.stdout()).find((r) => r.limb === 'auth')).toMatchObject({ state: 'review', source: 'store' });
    const t = collect();
    expect(main(['--list'], { ...opts, ...t.io })).toBe(0);
    expect(t.stdout().split('\n')[0]).toMatch(/^limb\s+state\s+since\s+window\s+note\s+source$/);
    expect(t.stdout()).not.toMatch(/^binding:/m); // a healthy binding needs no footer
  });

  it('the production opener (no store injected) reads the same store the writers use, and opening it for a read writes nothing', () => {
    const { parent } = storeAheadOfProjection();
    const runtimeDir = path.join(parent, '.artibot', 'runtime');
    const snap = () => ({ listing: fs.readdirSync(runtimeDir).sort(), journal: fs.readFileSync(path.join(runtimeDir, 'project-state.jsonl'), 'utf-8') });
    const before = snap();
    // `openStore` is left out: this is `task-feed.mjs#openFeedStore`, exactly what a CLI run uses.
    const row = listLaneStates({ cwd: parent, sessionId: SID, config: ON }).find((r) => r.limb === 'auth');
    expect(row).toMatchObject({ state: 'review', source: 'store' });
    expect(snap()).toEqual(before);
  });

  it('is a READ: run.json, plan.json, the store journal and both directory listings are identical afterwards', () => {
    const { parent, opts } = storeAheadOfProjection();
    const runtimeDir = path.join(parent, '.artibot', 'runtime');
    const files = [path.join(splitDir(parent), 'run.json'), path.join(splitDir(parent), 'plan.json'), path.join(runtimeDir, 'project-state.jsonl')];
    const snap = () => ({
      bytes: files.map((f) => fs.readFileSync(f, 'utf-8')),
      splitListing: fs.readdirSync(splitDir(parent)).sort(),
      runtimeListing: fs.readdirSync(runtimeDir).sort(),
    });
    const before = snap();
    expect(main(['--list'], { ...opts, ...collect().io })).toBe(0);
    expect(main(['--list', '--json'], { ...opts, ...collect().io })).toBe(0);
    expect(snap()).toEqual(before);
  });
});

describe('--list on a bound run whose binding cannot be read — the projection is shown AND the table says so', () => {
  const projected = (parent, store) => {
    setLaneState({ limb: 'auth', state: 'active' }, { cwd: parent, sessionId: SID, config: ON, openStore: () => store, now: T1 });
  };

  it('no session id to open a store with: `unread`, the run.json rows, a footer, exit 0', () => {
    const parent = seed();
    projected(parent, bind(parent));
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', '');
    vi.stubEnv('CLAUDE_SESSION_ID', '');
    const opts = { cwd: parent, config: ON, sessionId: '', openStore: neverOpen };
    const read = readLaneStates(opts);
    expect(read.binding).toMatchObject({ status: 'unread', mission_id: MISSION });
    expect(read.rows.find((r) => r.limb === 'auth')).toMatchObject({ state: 'active', source: 'run.json' });
    const t = collect();
    expect(main(['--list'], { ...opts, ...t.io })).toBe(0);
    expect(t.stdout()).toMatch(/^binding: unread \(.*session id.*\) - rows are the run\.json projection/m);
  });

  it('the opener throwing is `unread` too, with the message, not a crash', () => {
    const parent = seed();
    projected(parent, bind(parent));
    const opts = { cwd: parent, config: ON, sessionId: SID, openStore: () => { throw new Error('store constructor exploded'); } };
    const t = collect();
    expect(main(['--list'], { ...opts, ...t.io })).toBe(0);
    expect(t.stdout()).toMatch(/^binding: unread \(.*store constructor exploded.*\)/m);
  });

  it('a mission that is gone is `dangling`', () => {
    const parent = seed();
    const store = bind(parent, { missionRow: false });
    fs.writeFileSync(path.join(splitDir(parent), 'run.json'), JSON.stringify({ runId: RUN, lanes: { auth: { state: 'review' } } }));
    const opts = { cwd: parent, config: ON, sessionId: SID, openStore: () => store };
    expect(readLaneStates(opts).binding).toMatchObject({ status: 'dangling', mission_id: MISSION });
    const t = collect();
    expect(main(['--list'], { ...opts, ...t.io })).toBe(0);
    expect(t.stdout()).toMatch(/^binding: dangling \(.*\) - rows are the run\.json projection/m);
    expect(listLaneStates(opts).find((r) => r.limb === 'auth')).toMatchObject({ state: 'review', source: 'run.json' });
  });

  it('a store that throws when READ is `unread` with the message — the table still prints, from the projection', () => {
    const parent = seed();
    projected(parent, bind(parent));
    const broken = { getState: () => { throw new Error('journal is locked'); } };
    const opts = { cwd: parent, config: ON, sessionId: SID, openStore: () => broken };
    const read = readLaneStates(opts);
    expect(read.binding).toMatchObject({ status: 'unread', mission_id: MISSION });
    expect(read.unread).toMatch(/reading the StateStore threw: journal is locked/);
    expect(read.rows.find((r) => r.limb === 'auth')).toMatchObject({ state: 'active', source: 'run.json' });
    const t = collect();
    expect(main(['--list'], { ...opts, ...t.io })).toBe(0);
    expect(t.stdout()).toMatch(/^binding: unread \(reading the StateStore threw: journal is locked\)/m);
  });

  it('a throw that is NOT the store\'s (a damaged run.json) is still loud', () => {
    const parent = seed();
    const store = bind(parent);
    fs.writeFileSync(path.join(splitDir(parent), 'run.json'), '{ not json');
    expect(() => listLaneStates({ cwd: parent, config: ON, sessionId: SID, openStore: () => store })).toThrow();
  });

  it('a damaged record is `invalid` and names the field', () => {
    const parent = seed();
    const store = bind(parent, { binding: { generation: 0 } });
    const opts = { cwd: parent, config: ON, sessionId: SID, openStore: () => store };
    expect(readLaneStates(opts).binding).toEqual({ status: 'invalid', reason: 'binding-invalid:generation' });
    const t = collect();
    expect(main(['--list'], { ...opts, ...t.io })).toBe(0);
    expect(t.stdout()).toMatch(/^binding: invalid \(binding-invalid:generation\)/m);
  });
});

describe('--list on a run that carries a record while the key is OFF — the legacy rows, and the table says the record was not consulted', () => {
  it('reads run.json only, opens no store, and rows keep the legacy five keys', () => {
    const parent = seed({ run: { runId: RUN, lanes: { auth: { state: 'active', since: '2026-10-19T01:00:00.000Z', window: 'w-a' } } } });
    bind(parent);
    const opts = { cwd: parent, config: OFF, sessionId: SID, openStore: neverOpen };
    expect(listLaneStates(opts)).toEqual(legacyRows(parent));
    expect(readLaneStates(opts).binding).toEqual({ status: 'disabled' });
    const j = collect();
    expect(main(['--list', '--json'], { ...opts, ...j.io })).toBe(0);
    expect(JSON.parse(j.stdout())).toEqual(legacyRows(parent));
  });

  it('the human table ends with a disabled footer; nothing else changes', () => {
    const parent = seed();
    bind(parent);
    const t = collect();
    expect(main(['--list'], { cwd: parent, config: OFF, openStore: neverOpen, ...t.io })).toBe(0);
    const lines = t.stdout().trimEnd().split('\n');
    expect(lines[0]).toMatch(/^limb\s+state\s+since\s+window\s+note$/);
    expect(lines.at(-1)).toMatch(/^binding: disabled \(.*\) - rows are the run\.json lanes$/);
  });

  it('every non-literal value of the key is OFF too (the shared reader decides, not this command)', () => {
    const parent = seed();
    bind(parent);
    for (const config of [null, {}, { split: { missionBinding: { enabled: 'true' } } }, { split: { missionBinding: { enabled: 1 } } }]) {
      expect(readLaneStates({ cwd: parent, config, openStore: neverOpen }).binding, JSON.stringify(config)).toEqual({ status: 'disabled' });
    }
  });
});

describe('--list failures keep the CLI contract', () => {
  it('a missing plan.json is a refusal with exit 1, as before', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-list-'));
    tmpDirs.push(parent);
    const c = collect();
    expect(main(['--list'], { cwd: parent, ...c.io })).toBe(1);
    expect(c.stderr()).toMatch(/plan\.json missing/);
  });

  it('a corrupt run.json is loud, not an empty table', () => {
    const parent = seed();
    fs.writeFileSync(path.join(splitDir(parent), 'run.json'), '{ not json');
    expect(() => listLaneStates({ cwd: parent })).toThrow();
    const c = collect();
    expect(main(['--list'], { cwd: parent, ...c.io })).toBe(1);
    expect(c.stderr()).toMatch(/lane-state refused/);
  });
});
