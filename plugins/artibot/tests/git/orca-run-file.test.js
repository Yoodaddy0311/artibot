/**
 * `lib/git/orca-run-file.js` — read, validate, back up, atomically write and
 * read-modify-write `run.json`.
 *
 * Every case runs in an mkdtemp parent root; no test touches a real run. The
 * run object is the REAL `compileRun` output, and updates go through the real
 * `bindLimb` / `appendDispatch`.
 *
 * Proof by construction where a fake would prove nothing:
 *  - "backup BEFORE write": the atomic writer is wrapped (a real call except when
 *    a test arms it to fail), and the failing case asserts `run.json.bak` already
 *    holds the old bytes when the write throws;
 *  - "no lost update": four real node processes update the same file at once;
 *  - "lock timeout": a lock file held by this live process is left in place and the
 *    call really waits out the lock's 2 s budget.
 *
 * What this file cannot see:
 *  - A crash between the backup copy and the rename (the writer throws instead);
 *    the rename's atomicity itself is `lib/core/file.js`'s, tested there.
 *  - A writer that bypasses this module (the inline `node -e` that once truncated a
 *    state file) — nothing here can stop one, only `readOrcaRun` reports it afterwards.
 *  - Windows antivirus or indexer handles on `run.json.bak` (a `backup-failed` the
 *    tests only provoke with a directory in its place).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendDispatch, bindLimb, compileRun } from '../../lib/git/orca-plan.js';
import {
  ORCA_RUN_SCHEMA_VERSION,
  orcaRunPath,
  readOrcaRun,
  updateOrcaRun,
  validateOrcaRun,
  writeOrcaRun,
} from '../../lib/git/orca-run-file.js';

/** Arm `writeError` to make the NEXT atomic write throw; otherwise the real writer runs. */
const injected = vi.hoisted(() => ({ writeError: null }));
vi.mock('../../lib/core/file.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    atomicWriteJsonSync: (...args) => {
      if (injected.writeError) {
        const error = injected.writeError;
        injected.writeError = null;
        throw error;
      }
      return actual.atomicWriteJsonSync(...args);
    },
  };
});

const tmpDirs = [];
const mkTmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-run-'));
  tmpDirs.push(dir);
  return dir;
};
afterEach(() => {
  injected.writeError = null;
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date('2026-11-19T04:50:00.000Z');
const makeRun = () => {
  const compiled = compileRun({
    objective: '/orca 구현',
    tag: 'a1b2c3',
    now: NOW,
    appVersion: '1.4.259',
    repoId: 'repo-1',
    tasks: [
      { id: 'alpha', affectedPaths: ['src/alpha/'] },
      { id: 'beta', affectedPaths: ['src/beta/'] },
      { id: 'gamma', affectedPaths: ['src/gamma/'], dependsOn: ['alpha', 'beta'] },
    ],
    plan: null,
  });
  expect(compiled.ok, JSON.stringify(compiled)).toBe(true);
  return compiled.run;
};
const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
};

const BINDING = {
  worktreeId: 'd56eb7c9-5a43-4fcf-8c27-05cfbf914642::<HOME>/orca/workspaces/Artibot/orca-p0-a',
  worktreePath: '<HOME>/orca/workspaces/Artibot/orca-p0-a',
  branch: 'orca/alpha-a1b2c3',
  forkPoint: 'a'.repeat(40),
};
const dispatchOf = (id) => ({ dispatchId: `ctx_${id}`, taskId: `task_${id}`, kind: 'initial', at: '2026-11-19T05:00:00.000Z' });

const fileOf = (root) => orcaRunPath(root);
const bakOf = (root) => `${orcaRunPath(root)}.bak`;
const listDir = (root) => fs.readdirSync(path.dirname(orcaRunPath(root))).sort();
const writeRaw = (root, text) => {
  fs.mkdirSync(path.dirname(fileOf(root)), { recursive: true });
  fs.writeFileSync(fileOf(root), text);
};
/** Seed a valid file through the module itself and return the exact bytes on disk. */
const seed = (root, run = makeRun()) => {
  const written = writeOrcaRun(root, run);
  expect(written.ok, JSON.stringify(written)).toBe(true);
  return fs.readFileSync(fileOf(root));
};

describe('orcaRunPath', () => {
  it('is <parentRoot>/.artibot/orca/run.json, joined from segments', () => {
    expect(orcaRunPath('/r')).toBe(path.join('/r', '.artibot', 'orca', 'run.json'));
  });

  it('rejects a missing or empty root', () => {
    for (const root of ['', undefined, null, 5, {}]) expect(() => orcaRunPath(root), String(root)).toThrow(TypeError);
  });
});

describe('ORCA_RUN_SCHEMA_VERSION', () => {
  it('is 1', () => {
    expect(ORCA_RUN_SCHEMA_VERSION).toBe(1);
  });
});

describe('validateOrcaRun', () => {
  const unbound = (limb, deps = []) => ({
    limb, taskIds: [limb], affectedPaths: ['src/'], deps, worktreeId: null, worktreePath: null, branch: null, forkPoint: null, dispatches: [],
  });
  const base = (patch = {}) => ({
    schema_version: 1, provider: 'orca', runId: null, tag: 'a1b2c3', objective: 'o', integrationRef: 'origin/master', createdAt: '2026-11-19T00:00:00.000Z',
    orca: { appVersion: '1.4.259', environment: 'local', repoId: 'r' }, limbs: [unbound('aa'), unbound('bb', ['aa'])], ...patch,
  });

  it('accepts the IC-2 shape, the real compileRun output, a file without schema_version and a run with no limbs', () => {
    expect(validateOrcaRun(base())).toEqual({ ok: true, errors: [] });
    expect(validateOrcaRun(makeRun())).toEqual({ ok: true, errors: [] });
    const { schema_version: _version, ...unstamped } = base();
    expect(validateOrcaRun(unstamped).ok).toBe(true);
    expect(validateOrcaRun(base({ limbs: [] })).ok).toBe(true);
    expect(validateOrcaRun(base({ runId: 'run_3c01547fc37f' })).ok).toBe(true);
  });

  it('refuses a file that is not an orca run object', () => {
    for (const value of [null, undefined, [], 'run', 5]) expect(validateOrcaRun(value).ok, String(value)).toBe(false);
    expect(validateOrcaRun(base({ provider: 'split' })).errors).toContain("provider: must be 'orca'");
    const { provider: _provider, ...noProvider } = base();
    expect(validateOrcaRun(noProvider).ok).toBe(false);
  });

  it('refuses a schema_version that is invalid or newer than this reader', () => {
    expect(validateOrcaRun(base({ schema_version: 2 })).errors.join(' ')).toMatch(/newer than this reader/);
    for (const schemaVersion of [0, -1, 1.5, '1', null]) expect(validateOrcaRun(base({ schema_version: schemaVersion })).ok, String(schemaVersion)).toBe(false);
  });

  it('refuses badly typed header fields', () => {
    for (const patch of [{ runId: '' }, { runId: 5 }, { tag: '' }, { tag: 5 }, { objective: ' ' }, { integrationRef: null }, { createdAt: 7 }, { orca: 'x' }, { orca: { appVersion: 5 } }, { orca: [] }]) {
      expect(validateOrcaRun(base(patch)).ok, JSON.stringify(patch)).toBe(false);
    }
  });

  it('refuses limbs that are not an array, bad rows (named by index and limb) and duplicate names', () => {
    expect(validateOrcaRun(base({ limbs: {} })).errors).toContain('limbs: must be an array');
    expect(validateOrcaRun(base({ limbs: undefined })).ok).toBe(false);
    const bad = validateOrcaRun(base({ limbs: [unbound('aa'), { ...unbound('bb'), branch: '' }, null] }));
    expect(bad.ok).toBe(false);
    expect(bad.errors.some((error) => error.startsWith('limbs[1] (bb): branch:'))).toBe(true);
    expect(bad.errors.some((error) => error.startsWith('limbs[2]: row must be an object'))).toBe(true);
    expect(validateOrcaRun(base({ limbs: [unbound('aa'), unbound('aa')] })).errors).toContain('limbs: duplicate limb name aa');
  });

  it('does not check cross-limb integrity: an unknown dependency stays visible through readyLimbs instead', () => {
    expect(validateOrcaRun(base({ limbs: [unbound('aa', ['ghost'])] })).ok).toBe(true);
  });

  it('never throws, whatever it is handed', () => {
    for (const value of [undefined, null, 0, 5, '', 'text', true, [], {}, () => 1, Symbol('s')]) {
      expect(() => validateOrcaRun(value), String(value)).not.toThrow();
    }
  });
});

describe('readOrcaRun', () => {
  it('says absent when there is no file, whether or not the directory exists', () => {
    const root = mkTmp();
    expect(readOrcaRun(root)).toEqual({ ok: false, reason: 'absent' });
    fs.mkdirSync(path.dirname(fileOf(root)), { recursive: true });
    expect(readOrcaRun(root)).toEqual({ ok: false, reason: 'absent' });
  });

  it('says absent when a path component is a file, not a directory', () => {
    const root = mkTmp();
    fs.writeFileSync(path.join(root, '.artibot'), 'not a directory');
    expect(readOrcaRun(root).reason).toBe('absent');
  });

  it('says bad-root for an unusable parent root instead of throwing', () => {
    for (const root of ['', undefined, null, 5]) expect(readOrcaRun(root), String(root)).toMatchObject({ ok: false, reason: 'bad-root' });
  });

  it('says unparseable for empty, whitespace-only, truncated and non-JSON content — with a detail', () => {
    for (const text of ['', '   \n', '{ not json', '{"schema_version":1,"provider":"orca","limbs":[', String.fromCodePoint(0xfeff)]) {
      const root = mkTmp();
      writeRaw(root, text);
      const result = readOrcaRun(root);
      expect(result.ok, JSON.stringify(text)).toBe(false);
      expect(result.reason, JSON.stringify(text)).toBe('unparseable');
      expect(result.detail, JSON.stringify(text)).toEqual(expect.any(String));
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });

  it('names run.json.bak in the detail when a previous copy exists', () => {
    const root = mkTmp();
    seed(root);
    writeOrcaRun(root, makeRun()); // creates the .bak
    writeRaw(root, '');
    const result = readOrcaRun(root);
    expect(result.reason).toBe('unparseable');
    expect(result.detail).toContain(`${fileOf(root)}.bak`);
  });

  it('says schema for JSON that is not an orca run, naming the problem', () => {
    const cases = [
      ['null', /JSON object/],
      ['[1,2]', /JSON object/],
      ['"run"', /JSON object/],
      [JSON.stringify({ ...makeRun(), provider: 'split' }), /provider/],
      [JSON.stringify({ ...makeRun(), limbs: {} }), /limbs: must be an array/],
      [JSON.stringify({ ...makeRun(), schema_version: 2 }), /newer than this reader/],
      [JSON.stringify({ ...makeRun(), schema_version: 'one' }), /schema_version/],
      [JSON.stringify({ ...makeRun(), limbs: [{ ...makeRun().limbs[0], affectedPaths: 'src/' }] }), /limbs\[0\] \(alpha\): affectedPaths/],
      [JSON.stringify({ ...makeRun(), limbs: [makeRun().limbs[0], makeRun().limbs[0]] }), /duplicate limb name alpha/],
    ];
    for (const [text, pattern] of cases) {
      const root = mkTmp();
      writeRaw(root, text);
      const result = readOrcaRun(root);
      expect(result.reason, text.slice(0, 60)).toBe('schema');
      expect(result.detail, text.slice(0, 60)).toMatch(pattern);
    }
  });

  it('lists the first five problems and counts the rest, so a badly damaged file stays one readable line', () => {
    const root = mkTmp();
    const rows = Array.from({ length: 8 }, (_, index) => ({ limb: `lb${index}`, affectedPaths: [], branch: '', worktreePath: '' }));
    writeRaw(root, JSON.stringify({ ...makeRun(), limbs: rows }));
    const result = readOrcaRun(root);
    expect(result.reason).toBe('schema');
    expect(result.detail).toMatch(/\(\+11 more\)/); // 8 rows x 2 problems = 16; 5 shown
    expect(result.detail.split('; ')).toHaveLength(6);
  });

  it('says unreadable when run.json exists but cannot be read (here: it is a directory)', () => {
    const root = mkTmp();
    fs.mkdirSync(fileOf(root), { recursive: true });
    expect(readOrcaRun(root)).toMatchObject({ ok: false, reason: 'unreadable' });
  });

  it('reads a valid file, tolerating a BOM, and returns the object as stored', () => {
    const root = mkTmp();
    const run = makeRun();
    writeRaw(root, `${String.fromCodePoint(0xfeff)}${JSON.stringify(run)}`);
    expect(readOrcaRun(root)).toEqual({ ok: true, run });
  });

  it('accepts a file without schema_version as it is (it is stamped by the next write)', () => {
    const root = mkTmp();
    const { schema_version: _version, ...unstamped } = makeRun();
    writeRaw(root, JSON.stringify(unstamped));
    const result = readOrcaRun(root);
    expect(result.ok).toBe(true);
    expect(result.run).not.toHaveProperty('schema_version');
  });

  it('reads a limb bound with real receipt values and a dispatch record back unchanged', () => {
    const root = mkTmp();
    const bound = bindLimb(makeRun(), 'alpha', BINDING).run;
    const run = appendDispatch(bound, 'alpha', dispatchOf('a')).run;
    seed(root, run);
    expect(readOrcaRun(root)).toEqual({ ok: true, run });
  });
});

describe('writeOrcaRun', () => {
  it('creates the directory, stamps schema_version first, writes pretty JSON with a trailing newline, and leaves nothing else', () => {
    const root = mkTmp();
    const { schema_version: _version, ...unstamped } = makeRun();
    const result = writeOrcaRun(root, unstamped);
    expect(result).toEqual({ ok: true, path: fileOf(root) });
    const text = fs.readFileSync(fileOf(root), 'utf-8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "schema_version": 1,');
    expect(Object.keys(JSON.parse(text))[0]).toBe('schema_version');
    expect(listDir(root)).toEqual(['run.json']); // no .bak on a first write, no tmp, no lock
  });

  it('round-trips through readOrcaRun and does not mutate the object it was given', () => {
    const root = mkTmp();
    const run = deepFreeze(makeRun());
    const before = JSON.stringify(run);
    expect(writeOrcaRun(root, run).ok).toBe(true);
    expect(JSON.stringify(run)).toBe(before);
    expect(readOrcaRun(root)).toEqual({ ok: true, run });
  });

  it('copies the previous bytes to run.json.bak before replacing the file, and rotates it each time', () => {
    const root = mkTmp();
    const first = seed(root);
    const second = bindLimb(makeRun(), 'alpha', BINDING).run;
    expect(writeOrcaRun(root, second).ok).toBe(true);
    expect(fs.readFileSync(bakOf(root)).equals(first)).toBe(true);
    const secondBytes = fs.readFileSync(fileOf(root));
    expect(secondBytes.equals(first)).toBe(false);

    const third = appendDispatch(second, 'alpha', dispatchOf('a')).run;
    expect(writeOrcaRun(root, third).ok).toBe(true);
    expect(fs.readFileSync(bakOf(root)).equals(secondBytes)).toBe(true);
    expect(listDir(root)).toEqual(['run.json', 'run.json.bak']);
  });

  it('refuses an object that is not a valid run, and leaves the file and its backup untouched', () => {
    const root = mkTmp();
    const original = seed(root);
    for (const bad of [{}, { provider: 'orca' }, { ...makeRun(), provider: 'split' }, { ...makeRun(), limbs: 'x' }, { ...makeRun(), schema_version: 2 }, null, [], 'run', 5]) {
      const result = writeOrcaRun(root, bad);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      expect(result.reason, JSON.stringify(bad)).toBe('schema');
    }
    expect(fs.readFileSync(fileOf(root)).equals(original)).toBe(true);
    expect(fs.existsSync(bakOf(root))).toBe(false);
  });

  it('replaces a corrupt file, keeping the corrupt bytes in the backup for a human to look at', () => {
    const root = mkTmp();
    writeRaw(root, '{ half a fi');
    expect(writeOrcaRun(root, makeRun()).ok).toBe(true);
    expect(fs.readFileSync(bakOf(root), 'utf-8')).toBe('{ half a fi');
    expect(readOrcaRun(root).ok).toBe(true);
  });

  it('refuses to write when the backup cannot be made, leaving run.json as it was', () => {
    const root = mkTmp();
    const original = seed(root);
    fs.mkdirSync(bakOf(root)); // a directory where the backup file must go
    const result = writeOrcaRun(root, bindLimb(makeRun(), 'alpha', BINDING).run);
    expect(result).toMatchObject({ ok: false, reason: 'backup-failed' });
    expect(fs.readFileSync(fileOf(root)).equals(original)).toBe(true);
  });

  it('has already backed up the old bytes when the write itself fails, and leaves run.json untouched', () => {
    const root = mkTmp();
    // Two good writes first, so the .bak holds the FIRST state: only the failing attempt can bring it to the second.
    const first = seed(root);
    expect(writeOrcaRun(root, bindLimb(makeRun(), 'alpha', BINDING).run).ok).toBe(true);
    const second = fs.readFileSync(fileOf(root));
    expect(fs.readFileSync(bakOf(root)).equals(first)).toBe(true);
    expect(second.equals(first)).toBe(false);

    injected.writeError = Object.assign(new Error('simulated disk failure'), { code: 'ENOSPC' });
    const third = appendDispatch(bindLimb(makeRun(), 'alpha', BINDING).run, 'alpha', dispatchOf('a')).run;
    const result = writeOrcaRun(root, third);
    expect(result).toMatchObject({ ok: false, reason: 'write-failed' });
    expect(result.detail).toMatch(/simulated disk failure/);
    expect(fs.readFileSync(bakOf(root)).equals(second)).toBe(true); // refreshed BEFORE the write that then failed
    expect(fs.readFileSync(fileOf(root)).equals(second)).toBe(true); // run.json itself untouched
    expect(readOrcaRun(root).ok).toBe(true);
  });

  it('says bad-root for an unusable parent root', () => {
    expect(writeOrcaRun('', makeRun())).toMatchObject({ ok: false, reason: 'bad-root' });
    expect(writeOrcaRun(undefined, makeRun())).toMatchObject({ ok: false, reason: 'bad-root' });
  });

  it('says lock-failed, not lock-timeout, when the lock cannot even be created (a file where the state directory should be)', () => {
    // A creation error is not contention. The reason tells the two apart, so no wall-clock bound is asserted.
    const root = mkTmp();
    fs.mkdirSync(path.join(root, '.artibot'));
    fs.writeFileSync(path.join(root, '.artibot', 'orca'), 'a file where the state directory should be');
    expect(writeOrcaRun(root, makeRun())).toMatchObject({ ok: false, reason: 'lock-failed' });
    expect(updateOrcaRun(root, (run) => run)).toMatchObject({ ok: false, reason: 'lock-failed' });
  });
});

describe('updateOrcaRun', () => {
  it('reports absent, unparseable and schema failures and writes nothing', () => {
    const missing = mkTmp();
    const never = vi.fn((run) => run);
    expect(updateOrcaRun(missing, never)).toEqual({ ok: false, reason: 'absent' });
    expect(fs.existsSync(fileOf(missing))).toBe(false);

    const corrupt = mkTmp();
    writeRaw(corrupt, '{ nope');
    expect(updateOrcaRun(corrupt, never)).toMatchObject({ ok: false, reason: 'unparseable' });
    expect(fs.readFileSync(fileOf(corrupt), 'utf-8')).toBe('{ nope');

    const wrong = mkTmp();
    writeRaw(wrong, JSON.stringify({ provider: 'split', limbs: [] }));
    expect(updateOrcaRun(wrong, never)).toMatchObject({ ok: false, reason: 'schema' });
    expect(never).not.toHaveBeenCalled();
    expect(fs.existsSync(bakOf(wrong))).toBe(false);
  });

  it('applies the mutation, writes it, returns the written run, and backs up the state before it', () => {
    const root = mkTmp();
    const before = seed(root);
    const result = updateOrcaRun(root, (run) => {
      const bound = bindLimb(run, 'alpha', BINDING);
      if (!bound.ok) throw new Error(bound.reason);
      return bound.run;
    });
    expect(result.ok).toBe(true);
    expect(result.run.limbs[0]).toMatchObject(BINDING);
    expect(readOrcaRun(root)).toEqual({ ok: true, run: result.run });
    // the caller gets an ordinary object, not rows shared with the frozen copy the mutator saw
    expect(Object.isFrozen(result.run) || Object.isFrozen(result.run.limbs) || Object.isFrozen(result.run.limbs[0])).toBe(false);
    expect(() => result.run.limbs.sort()).not.toThrow();
    expect(fs.readFileSync(bakOf(root)).equals(before)).toBe(true);
    expect(listDir(root)).toEqual(['run.json', 'run.json.bak']);
  });

  it('accumulates sequential updates, and each backup is the state just before its update', () => {
    const root = mkTmp();
    seed(root);
    let previous = fs.readFileSync(fileOf(root));
    for (const id of ['a', 'b', 'c']) {
      const result = updateOrcaRun(root, (run) => {
        const next = appendDispatch(run, 'alpha', dispatchOf(id));
        if (!next.ok) throw new Error(next.reason);
        return next.run;
      });
      expect(result.ok, id).toBe(true);
      expect(fs.readFileSync(bakOf(root)).equals(previous), id).toBe(true);
      previous = fs.readFileSync(fileOf(root));
    }
    expect(readOrcaRun(root).run.limbs[0].dispatches.map((entry) => entry.dispatchId)).toEqual(['ctx_a', 'ctx_b', 'ctx_c']);
  });

  it('hands the mutator a deep-frozen copy, so editing in place fails instead of "working"', () => {
    const root = mkTmp();
    const original = seed(root);
    const result = updateOrcaRun(root, (run) => {
      run.limbs[0].branch = 'sneaky'; // in-place edit
      return run;
    });
    expect(result).toMatchObject({ ok: false, reason: 'mutate-failed' });
    expect(result.detail).toMatch(/read only|read-only|frozen|Cannot assign/i);
    expect(fs.readFileSync(fileOf(root)).equals(original)).toBe(true);
  });

  it('reports a throwing mutator with its message, and writes nothing', () => {
    const root = mkTmp();
    const original = seed(root);
    const result = updateOrcaRun(root, () => {
      throw new Error('unknown-limb');
    });
    expect(result).toEqual({ ok: false, reason: 'mutate-failed', detail: 'unknown-limb' });
    expect(fs.readFileSync(fileOf(root)).equals(original)).toBe(true);
    expect(fs.existsSync(bakOf(root))).toBe(false);
  });

  it('reports a mutator that throws something that is not an Error', () => {
    const root = mkTmp();
    seed(root);
    expect(updateOrcaRun(root, () => {
      throw 'plain string';
    })).toEqual({ ok: false, reason: 'mutate-failed', detail: 'plain string' });
  });

  it('reports a failed write as write-failed, with run.json untouched and still readable', () => {
    const root = mkTmp();
    const original = seed(root);
    injected.writeError = Object.assign(new Error('simulated disk failure'), { code: 'ENOSPC' });
    const result = updateOrcaRun(root, (run) => {
      const bound = bindLimb(run, 'alpha', BINDING);
      if (!bound.ok) throw new Error(bound.reason);
      return bound.run;
    });
    expect(result).toMatchObject({ ok: false, reason: 'write-failed' });
    expect(fs.readFileSync(fileOf(root)).equals(original)).toBe(true);
    expect(readOrcaRun(root).ok).toBe(true);
  });

  it('refuses a mutator that does not return a run object', () => {
    const root = mkTmp();
    const original = seed(root);
    for (const returned of [undefined, null, [], 'run', 5]) {
      expect(updateOrcaRun(root, () => returned), String(returned)).toMatchObject({ ok: false, reason: 'mutate-invalid' });
    }
    expect(fs.readFileSync(fileOf(root)).equals(original)).toBe(true);
  });

  it('validates what the mutator returns, so a run that would be unreadable is never written', () => {
    const root = mkTmp();
    const original = seed(root);
    const result = updateOrcaRun(root, (run) => ({ ...run, limbs: undefined }));
    expect(result).toMatchObject({ ok: false, reason: 'schema' });
    expect(fs.readFileSync(fileOf(root)).equals(original)).toBe(true);
    expect(fs.existsSync(bakOf(root))).toBe(false);
    expect(readOrcaRun(root).ok).toBe(true);
  });

  it('rejects a mutator that is not a function, and an unusable root', () => {
    expect(updateOrcaRun(mkTmp(), 'nope')).toMatchObject({ ok: false, reason: 'bad-mutator' });
    expect(updateOrcaRun('', (run) => run)).toMatchObject({ ok: false, reason: 'bad-root' });
  });

  it('refuses re-entry: an update started from inside a mutator reports lock-reentrant, and the outer one still completes', () => {
    const root = mkTmp();
    seed(root);
    let inner = null;
    const result = updateOrcaRun(root, (run) => {
      inner = updateOrcaRun(root, (other) => other);
      return run;
    });
    expect(inner).toMatchObject({ ok: false, reason: 'lock-reentrant' });
    expect(result.ok).toBe(true);
    expect(listDir(root)).not.toContain('run.json.lock');
  });

  it('reports lock-timeout, writing nothing, while another live holder keeps the lock', () => {
    const root = mkTmp();
    const original = seed(root);
    const lockPath = `${fileOf(root)}.lock`;
    // The record file-lock.js writes: this process is alive and the timestamp is fresh, so the lock is not stale.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'held-by-the-test', timestamp: Date.now() }));
    const mutator = vi.fn((run) => run);
    try {
      const started = Date.now();
      const result = updateOrcaRun(root, mutator);
      expect(result).toMatchObject({ ok: false, reason: 'lock-timeout' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(1500); // it really waited for the lock's budget
      expect(mutator).not.toHaveBeenCalled();
      expect(fs.readFileSync(fileOf(root)).equals(original)).toBe(true);
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  });

  it('loses no update when several processes hammer the same run at once', async () => {
    const root = mkTmp();
    seed(root);
    const libDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'git');
    const planUrl = pathToFileURL(path.join(libDir, 'orca-plan.js')).href;
    const fileUrl = pathToFileURL(path.join(libDir, 'orca-run-file.js')).href;
    const script = path.join(mkTmp(), 'child.mjs');
    // Every child spins until the same wall-clock instant, then runs ROUNDS updates back to back: a
    // single update per process overlapped in only part of the runs when the lock was taken out (2 of 3).
    fs.writeFileSync(script, [
      `import { appendDispatch } from ${JSON.stringify(planUrl)};`,
      `import { updateOrcaRun } from ${JSON.stringify(fileUrl)};`,
      'const [root, limb, tag, startAt, rounds] = process.argv.slice(2);',
      'while (Date.now() < Number(startAt)) { /* wait for the shared start */ }',
      'for (let round = 0; round < Number(rounds); round += 1) {',
      '  let result = null;',
      '  for (let attempt = 0; attempt < 8; attempt += 1) {',
      '    result = updateOrcaRun(root, (run) => {',
      "      const id = tag + '-' + round;",
      "      const next = appendDispatch(run, limb, { dispatchId: 'ctx_' + id, taskId: 'task_' + id, kind: 'initial', at: '2026-11-19T05:00:00.000Z' });",
      '      if (!next.ok) throw new Error(next.reason);',
      '      return next.run;',
      '    });',
      "    if (result.ok || result.reason !== 'lock-timeout') break;",
      '  }',
      '  if (!result.ok) {',
      '    process.stdout.write(JSON.stringify(result));',
      '    process.exitCode = 1;',
      '    break;',
      '  }',
      '}',
    ].join('\n'));

    const rounds = 10;
    const jobs = [['alpha', 'p1'], ['alpha', 'p2'], ['beta', 'p3'], ['gamma', 'p4']];
    const startAt = Date.now() + 2_000;
    const runs = jobs.map(([limb, tag]) => new Promise((resolve) => {
      const child = spawn(process.execPath, [script, root, limb, tag, String(startAt), String(rounds)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { out += chunk; });
      child.on('close', (code) => resolve({ code, out }));
    }));
    const results = await Promise.all(runs);
    for (const result of results) expect(result.code, result.out).toBe(0);

    const { run } = readOrcaRun(root);
    const ids = run.limbs.flatMap((row) => row.dispatches.map((entry) => entry.dispatchId)).sort();
    const expected = jobs.flatMap(([, tag]) => Array.from({ length: rounds }, (_, round) => `ctx_${tag}-${round}`)).sort();
    expect(ids).toEqual(expected);
    expect(listDir(root)).toEqual(['run.json', 'run.json.bak']);
  });
});
