/**
 * Atomic writers report what actually happened (2026-11-21 review M4 + M7).
 *
 * Before: `scripts/utils/index.js#atomicWriteSync` logged a failed write to stderr and
 * returned `undefined` — the same value as a successful write. Every caller that wanted to
 * say "written" therefore said it unconditionally:
 *   - `_team-state.js#mergeSessionSnapshot` returned `wrote: true` for a rename that failed;
 *   - `lib/core/rotation.js#rotateJsonArray` returned `rotated: true` for an unrotated file;
 *   - `lib/core/skill-hash-cache.js#persistSkillHashCache` returned `true` for a cache that
 *     never reached disk (its try/catch could never fire on an I/O error).
 * The two lib modules also imported the writer from `scripts/` (an L1 -> hook edge); they now
 * use `lib/core/file.js#atomicWriteJsonSync`, which throws, so their catch blocks see it.
 *
 * HOW A FAILURE IS PRODUCED: `node:fs#renameSync` is wrapped so that a rename onto a path
 * ending in FAIL_SUFFIX throws a non-transient `EIO` (no retry budget is spent). Every other
 * rename — the lock files, other tests' files — is the real one. Both the named export
 * (scripts/utils) and the default export (lib/core/file.js) are wrapped, because the two
 * writers bind to `node:fs` differently.
 *
 * WHAT THIS FILE CANNOT SEE
 *  1. A real Windows sharing violation. The injected error is EIO, which neither writer
 *     retries; an EPERM/EBUSY that clears inside the retry budget is a success and is
 *     covered by tests/core/file-atomic-write-retry.test.js, not here.
 *  2. Callers other than the three named above. `saveState`, team-idle-handler and
 *     inject-source-hash ignore the return value today; nothing here pins that they should.
 *  3. Whether a hook that receives `false` does anything useful with it.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FAIL_SUFFIX = 'FAIL-RENAME-TARGET.json';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  const renameSync = (from, to) => {
    if (String(to).endsWith('FAIL-RENAME-TARGET.json') || String(to).endsWith('skill-hashes.json')) {
      throw Object.assign(new Error(`EIO: injected rename failure -> ${to}`), { code: 'EIO' });
    }
    return actual.renameSync(from, to);
  };
  return { ...actual, renameSync, default: { ...actual, renameSync } };
});

const { atomicWriteSync } = await import('../../scripts/utils/index.js');
const { mergeSessionSnapshot } = await import('../../scripts/hooks/_team-state.js');
const { rotateJsonArray } = await import('../../lib/core/rotation.js');
const { persistSkillHashCache } = await import('../../lib/core/skill-hash-cache.js');

let tmp;
let stderrSpy;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'artibot-honest-write-'));
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

describe('scripts/utils#atomicWriteSync returns a boolean and never throws (M4)', () => {
  it('returns true when the file was written', () => {
    const p = path.join(tmp, 'ok.json');
    expect(atomicWriteSync(p, { a: 1 })).toBe(true);
    expect(JSON.parse(readFileSync(p, 'utf-8'))).toEqual({ a: 1 });
  });

  it('returns false when the rename fails, and leaves no tmp file', () => {
    const p = path.join(tmp, FAIL_SUFFIX);
    expect(atomicWriteSync(p, { a: 1 })).toBe(false);
    expect(existsSync(p)).toBe(false);
    expect(existsSync(`${p}.tmp.${process.pid}`)).toBe(false);
  });

  it('returns false (does not throw) when the parent directory cannot be created', () => {
    const blocker = path.join(tmp, 'a-file');
    writeFileSync(blocker, 'x');
    let result;
    expect(() => { result = atomicWriteSync(path.join(blocker, 'child.json'), { a: 1 }); }).not.toThrow();
    expect(result).toBe(false);
  });

  it('returns false when the destination is a directory (real fs, no injection)', () => {
    const dirTarget = path.join(tmp, 'is-a-dir');
    mkdirSync(dirTarget);
    expect(atomicWriteSync(dirTarget, 'text')).toBe(false);
  });
});

describe('_team-state#mergeSessionSnapshot reports the write it did not make (M4)', () => {
  const snap = () => ({ sessionId: 's1', endedAt: 'now', startedAt: null, cwd: tmp, metadata: {} });

  it('returns false when the merged state could not be written', () => {
    expect(mergeSessionSnapshot(path.join(tmp, FAIL_SUFFIX), snap())).toBe(false);
  });

  it('positive control: returns true for a writable path', () => {
    const p = path.join(tmp, 'state.json');
    expect(mergeSessionSnapshot(p, snap())).toBe(true);
    expect(JSON.parse(readFileSync(p, 'utf-8')).sessionId).toBe('s1');
  });
});

describe('lib/core/rotation#rotateJsonArray does not claim a rotation it did not write (M7)', () => {
  it('rotated:false with an error when the write fails; the file is unchanged', () => {
    const p = path.join(tmp, FAIL_SUFFIX);
    const original = JSON.stringify([{ i: 1 }, { i: 2 }, { i: 3 }]);
    writeFileSync(p, original);
    const r = rotateJsonArray(p, { maxEntries: 1 });
    expect(r.rotated).toBe(false);
    expect(typeof r.error).toBe('string');
    expect(readFileSync(p, 'utf-8')).toBe(original);
  });

  it('positive control: a writable file is rotated', () => {
    const p = path.join(tmp, 'rot.json');
    writeFileSync(p, JSON.stringify([{ i: 1 }, { i: 2 }, { i: 3 }]));
    const r = rotateJsonArray(p, { maxEntries: 1 });
    expect(r).toMatchObject({ rotated: true, before: 3, after: 1, removed: 2 });
    expect(JSON.parse(readFileSync(p, 'utf-8'))).toEqual([{ i: 3 }]);
  });

  it('a file that is not JSON is unsupported-shape, not a crash (local parseJSON)', () => {
    const p = path.join(tmp, 'garbage.json');
    writeFileSync(p, '{not json');
    expect(rotateJsonArray(p, { maxEntries: 1 })).toMatchObject({ rotated: false, error: 'unsupported-shape' });
  });
});

describe('lib/core/skill-hash-cache#persistSkillHashCache is false when the cache never landed (M7)', () => {
  it('returns false when the rename onto skill-hashes.json fails', () => {
    expect(persistSkillHashCache({ version: 1, generatedAt: 'x', skills: {} })).toBe(false);
  });
});
