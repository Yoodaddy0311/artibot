/**
 * webfetch-cache-post.js#persistCacheEntry — the cache entry is replaced atomically.
 *
 * Since 2026-11-22 the cache is GLOBAL (`<state dir>/runtime/cache/webfetch/`), so sessions in
 * different projects can write the same entry at once. A plain `writeFile` truncates the target
 * and then writes it, so a reader (or a second writer) can meet a half-written JSON file, and a
 * failed write can destroy the previous entry. The entry now goes through
 * `lib/core/file.js#atomicWriteJson` (tmp sibling + rename): a failed write leaves the previous
 * entry intact and is reported as `persisted: false` — the cache is best-effort, so it is not
 * an error.
 *
 * HOW A FAILURE IS PRODUCED: the default export of `node:fs/promises` (what lib/core/file.js
 * calls) is wrapped so a rename onto the one path in `failing.renameTo` throws a non-transient
 * `EIO` (no retry budget spent) — the technique of tests/scripts/swarm-init.test.js.
 *
 * WHAT THIS DOES NOT SEE: two real processes racing on one entry (the rename is the mechanism;
 * the race itself is not reproduced), and a transient Windows lock that clears inside the
 * retry budget (tests/core/file-atomic-write-retry.test.js covers the helper).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { pointStateDirAt } from '../helpers/state-dir.js';

const failing = vi.hoisted(() => ({ renameTo: null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  const real = actual.default ?? actual;
  const rename = (from, to) => {
    if (failing.renameTo !== null && String(to) === failing.renameTo) {
      return Promise.reject(Object.assign(new Error(`EIO: injected rename failure -> ${to}`), { code: 'EIO' }));
    }
    return real.rename(from, to);
  };
  return { ...actual, rename, default: { ...real, rename } };
});

const { persistCacheEntry } = await import('../../scripts/hooks/webfetch-cache-post.js');
const { cacheDir, cacheKey } = await import('../../scripts/hooks/webfetch-cache-pre.js');

const URL_ = 'https://example.com/atomic';
const NO_VALIDATORS = { etag: null, lastModified: null };

let tmp;
let restoreStateDir;
let errSpy;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'artibot-webfetch-atomic-'));
  restoreStateDir = pointStateDirAt(path.join(tmp, 'state'));
  errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  failing.renameTo = null;
  errSpy.mockRestore();
  restoreStateDir();
  rmSync(tmp, { recursive: true, force: true });
});

describe('persistCacheEntry — atomic replace', () => {
  it('keeps the previous entry and reports persisted:false when the replacing write does not land', async () => {
    const entry = path.join(cacheDir(), `${cacheKey(URL_)}.json`);
    expect((await persistCacheEntry(URL_, 'first body', NO_VALIDATORS)).persisted).toBe(true);

    failing.renameTo = entry;
    const second = await persistCacheEntry(URL_, 'second body', NO_VALIDATORS);

    expect(second).toEqual({ key: cacheKey(URL_), persisted: false, bytes: 0 });
    expect(JSON.parse(readFileSync(entry, 'utf-8')).content).toBe('first body');
    expect(readdirSync(cacheDir()).filter((f) => f.includes('.tmp.'))).toEqual([]);
  });

  it('replaces the entry when the write lands', async () => {
    const entry = path.join(cacheDir(), `${cacheKey(URL_)}.json`);
    await persistCacheEntry(URL_, 'first body', NO_VALIDATORS);

    const second = await persistCacheEntry(URL_, 'second body', NO_VALIDATORS);

    expect(second.persisted).toBe(true);
    expect(JSON.parse(readFileSync(entry, 'utf-8')).content).toBe('second body');
  });
});
