/**
 * `lib/core/file.js#atomicWriteText` — the ASYNC atomic writer retries a transient
 * rename failure the way `renameWithRetry` already does for the sync writers.
 *
 * WHY THIS FILE EXISTS. The 2026-09-15 fix (see the `renameWithRetry()` block in
 * `file.test.js`) put the retry under the SYNC writers only. The async
 * `atomicWriteText`, and with it `atomicWriteJson` and `writeJsonFile` (whose JSDoc
 * said they retry), still renamed once. Measured 2026-09-30 on Windows, with file
 * churn running beside it: the scorecard CLI's SECOND `add` (a rename over an
 * existing store) failed in 4 of 160 add/add/diff sequences (0 of 140 without
 * churn) with
 * `EPERM: operation not permitted, rename '<store>.tmp.<pid>.<ts>.<rand>' -> '<store>'`.
 * Same errno, same second-write-only shape as the 2026-09-15 measurement.
 *
 * WHAT IS PINNED. Which codes are retried (EPERM, EBUSY, EACCES), how many attempts
 * (`MAX_RENAME_ATTEMPTS`), the 10·20·40·80 ms backoff, that the LAST error is the
 * one rethrown, and what is left on disk afterwards (old content intact, no `.tmp`
 * sibling). Every count below is exact, so a stub the writer never calls fails
 * loudly instead of passing for want of a failure.
 *
 * WHAT THIS FILE CANNOT SEE (rules §9): a real handle conflict. `fs.rename` is
 * replaced by a stub that throws the errno and then delegates, so this pins the
 * retry PATH, not how long a real scanner holds a file. Whether ~150 ms is enough
 * under load is a measurement (the churn probe in the commit message), not an
 * assertion. Also not covered: the sync writers (`file.test.js`) and the
 * `flock`-style locks (`file-lock*.test.js`).
 *
 * @module tests/core/file-atomic-write-retry
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicWriteJson, atomicWriteText, MAX_RENAME_ATTEMPTS } from '../../lib/core/file.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('atomicWriteText() — transient rename failures', () => {
  let tmpDir;
  /** @type {Array<import('vitest').MockInstance>} */
  let spies;

  beforeEach(async () => {
    spies = [];
    tmpDir = path.join(os.tmpdir(), `artibot-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    for (const spy of spies) spy.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Make `fs.rename` throw `code` on its first `failures` calls, then delegate to the real one.
   * Each injected message carries its call number, so a test can tell WHICH failure was rethrown.
   *
   * @param {number} failures - how many calls fail (`Infinity` = all of them)
   * @param {string} code - errno to throw
   * @returns {{count: () => number}}
   */
  function flakyRename(failures, code) {
    const real = fs.rename.bind(fs);
    let calls = 0;
    spies.push(vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      calls += 1;
      if (calls <= failures) {
        const err = new Error(`${code}: injected rename failure #${calls}`);
        err.code = code;
        throw err;
      }
      return real(from, to);
    }));
    return { count: () => calls };
  }

  /**
   * Record every backoff the writer asks for without spending the wall time: the stub calls
   * the timer callback at once. Vitest's own timeout uses its saved timers, not this global.
   *
   * @returns {{sleeps: number[]}}
   */
  function captureBackoff() {
    const sleeps = [];
    spies.push(vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...args) => {
      sleeps.push(ms);
      fn(...args);
      return 0;
    }));
    return { sleeps };
  }

  /** @returns {Promise<string[]>} `.tmp` siblings left in the directory */
  async function tmpSiblings() {
    return (await fs.readdir(tmpDir)).filter((e) => e.includes('.tmp.'));
  }

  it.each(['EPERM', 'EBUSY', 'EACCES'])(
    '%s on the first two renames over an existing file: the third lands the bytes',
    async (code) => {
      const file = path.join(tmpDir, 'store.txt');
      await atomicWriteText(file, 'v1'); // a first write CREATES the file: no destination to collide with
      const { count } = flakyRename(2, code);
      captureBackoff();

      await atomicWriteText(file, 'v2');

      expect(count()).toBe(3);
      expect(await fs.readFile(file, 'utf-8')).toBe('v2');
      expect(await tmpSiblings()).toEqual([]);
    },
  );

  it('atomicWriteJson goes through the same retry', async () => {
    const file = path.join(tmpDir, 'store.json');
    await atomicWriteJson(file, { v: 1 });
    const { count } = flakyRename(1, 'EPERM');
    captureBackoff();

    await atomicWriteJson(file, { v: 2 });

    expect(count()).toBe(2);
    expect(JSON.parse(await fs.readFile(file, 'utf-8'))).toEqual({ v: 2 });
  });

  it('exhausts the attempts and rethrows the LAST error, old content intact, no tmp sibling', async () => {
    const file = path.join(tmpDir, 'locked.txt');
    await atomicWriteText(file, 'v1');
    const { count } = flakyRename(Number.POSITIVE_INFINITY, 'EPERM');
    captureBackoff();

    await expect(atomicWriteText(file, 'v2')).rejects.toThrow(`#${MAX_RENAME_ATTEMPTS}`);

    expect(count()).toBe(MAX_RENAME_ATTEMPTS);
    expect(await fs.readFile(file, 'utf-8')).toBe('v1');
    expect(await tmpSiblings()).toEqual([]);
  });

  it('backs off 10, 20, 40 and 80 ms between the five attempts', async () => {
    const file = path.join(tmpDir, 'backoff.txt');
    flakyRename(Number.POSITIVE_INFINITY, 'EBUSY');
    const { sleeps } = captureBackoff();

    await expect(atomicWriteText(file, 'x')).rejects.toThrow(/EBUSY/);

    expect(MAX_RENAME_ATTEMPTS).toBe(5);
    expect(sleeps).toEqual([10, 20, 40, 80]);
  });

  it.each(['ENOENT', 'EXDEV', 'EEXIST'])('%s is not transient: thrown on the first attempt, no sleep', async (code) => {
    const file = path.join(tmpDir, 'hard.txt');
    const { count } = flakyRename(Number.POSITIVE_INFINITY, code);
    const { sleeps } = captureBackoff();

    await expect(atomicWriteText(file, 'x')).rejects.toThrow(new RegExp(code));

    expect(count()).toBe(1);
    expect(sleeps).toEqual([]);
    expect(await tmpSiblings()).toEqual([]);
  });

  it('a first-try success costs no sleep and exactly one rename', async () => {
    const file = path.join(tmpDir, 'clean.txt');
    const { count } = flakyRename(0, 'EPERM');
    const { sleeps } = captureBackoff();

    await atomicWriteText(file, 'ok');

    expect(count()).toBe(1);
    expect(sleeps).toEqual([]);
    expect(await fs.readFile(file, 'utf-8')).toBe('ok');
  });
});
