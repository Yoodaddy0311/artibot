/**
 * tool-history.js#saveHistory when the re-read under the lock FAILS (F2,
 * review-fixes 2026-11-21, cross-check xcB MED-1).
 *
 * The merge treats the file on disk as the base. Before this fix the re-read
 * swallowed every error as "no file", so a transient read failure (EBUSY on
 * Windows while another process renames over the file, EACCES, EMFILE, ...)
 * made the save write the in-memory copy whole: every row another process had
 * added since this one loaded was erased, and saveHistory() still said true
 * (xcB measured 61 rows -> 51, worst case 1, on a copy).
 *
 * The contract pinned here (allowlist, not denylist):
 *   - ENOENT                 -> no file: write the in-memory history (unchanged)
 *   - unparseable JSON       -> replaced by the in-memory history (unchanged)
 *   - ANY other read error   -> write nothing, return false, keep the pending
 *                               rows for the next save in this process
 *
 * Real disk (the per-worker state dir from tests/setup/state-dir.js) with ONE
 * injected readFileSync failure on the history path; every other read —
 * including the lock file's — goes to the real fs.
 *
 * What this does NOT cover: a read error that persists across every save of a
 * short-lived process (the hook) — those rows are lost with the process, and
 * the only trace is the stderr line and the false return.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fault } = vi.hoisted(() => ({ fault: { path: null, code: null, left: 0 } }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal();
  const faultyReadFileSync = (p, ...rest) => {
    if (fault.left > 0 && String(p) === fault.path) {
      fault.left -= 1;
      throw Object.assign(new Error(`${fault.code}: injected read failure, '${p}'`), { code: fault.code });
    }
    return real.readFileSync(p, ...rest);
  };
  return { ...real, readFileSync: faultyReadFileSync, default: { ...real.default, readFileSync: faultyReadFileSync } };
});

const {
  clearCache,
  getHistoryPath,
  loadHistory,
  notePendingRecord,
  saveHistory,
} = await import('../../lib/learning/tool-history.js');
const { _clearCache, flushToDisk, recordUsage, resetHistory } = await import('../../lib/learning/tool-learner.js');

const rec = (i) => ({ tool: 'Read', context: 'read:js:file', score: 1, timestamp: 1_000 + i });

/** Write a history file holding `n` rows, as another process would have. */
function seedDisk(n) {
  mkdirSync(path.dirname(getHistoryPath()), { recursive: true });
  const rows = Array.from({ length: n }, (_, i) => rec(i));
  writeFileSync(getHistoryPath(), JSON.stringify({ version: 2, contexts: { 'read:js:file': rows }, aggregates: {}, lastUpdated: 1 }));
}

const diskRows = () => JSON.parse(readFileSync(getHistoryPath(), 'utf-8')).contexts['read:js:file']?.length ?? 0;

/** Arm one read failure on the history file. */
function failNextRead(code) {
  fault.path = getHistoryPath();
  fault.code = code;
  fault.left = 1;
}

/** Load 50 rows, then "another process" adds 10, then this process adds 1. */
async function loadedThenOvertaken() {
  seedDisk(50);
  await loadHistory();
  seedDisk(60);
  const h = await loadHistory();
  const mine = { tool: 'Grep', context: 'read:js:file', score: 1, timestamp: 9_999 };
  h.contexts['read:js:file'].push(mine);
  notePendingRecord(mine);
}

let stderr;
beforeEach(() => {
  clearCache();
  _clearCache();
  fault.left = 0;
  rmSync(getHistoryPath(), { force: true });
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  fault.left = 0;
  stderr.mockRestore();
  clearCache();
  _clearCache();
  rmSync(getHistoryPath(), { force: true });
  rmSync(`${getHistoryPath()}.lock`, { force: true });
});

describe('saveHistory() — a failed re-read under the lock never overwrites', () => {
  for (const code of ['EBUSY', 'EACCES', 'EPERM', 'EMFILE', 'EIO']) {
    it(`${code}: returns false, leaves the other process's rows, keeps this process's row pending`, async () => {
      await loadedThenOvertaken();
      const before = readFileSync(getHistoryPath(), 'utf-8');
      failNextRead(code);

      expect(await saveHistory()).toBe(false);
      expect(fault.left).toBe(0); // the injected failure was actually consumed
      expect(readFileSync(getHistoryPath(), 'utf-8')).toBe(before);
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain(code);

      // The next save (no fault) merges the kept pending row onto all 60.
      expect(await saveHistory()).toBe(true);
      expect(diskRows()).toBe(61);
    });
  }

  it('ENOENT is still "no file": the in-memory history is written', async () => {
    const h = await loadHistory();
    const mine = rec(1);
    h.contexts['read:js:file'] = [mine];
    notePendingRecord(mine);
    expect(await saveHistory()).toBe(true);
    expect(diskRows()).toBe(1);
  });

  it('an unparseable file is still replaced by the in-memory history', async () => {
    const h = await loadHistory();
    const mine = rec(1);
    h.contexts['read:js:file'] = [mine];
    notePendingRecord(mine);
    mkdirSync(path.dirname(getHistoryPath()), { recursive: true });
    writeFileSync(getHistoryPath(), '{ half-written');
    expect(await saveHistory()).toBe(true);
    expect(diskRows()).toBe(1);
  });
});

describe('tool-learner — save results are returned, not dropped', () => {
  it('flushToDisk() resolves false when the save did not reach disk', async () => {
    seedDisk(60);
    await recordUsage('Read', 'read:js:file', 1);
    failNextRead('EBUSY');
    expect(await flushToDisk()).toBe(false);
    expect(fault.left).toBe(0);
    expect(diskRows()).toBe(60);
  });

  it('flushToDisk() resolves true when the save landed, and when nothing was pending', async () => {
    expect(await flushToDisk()).toBe(true); // nothing pending
    seedDisk(60);
    await recordUsage('Read', 'read:js:file', 1);
    expect(await flushToDisk()).toBe(true);
    expect(diskRows()).toBe(61);
  });

  it('resetHistory() resolves false when the lock is held past its wait, and leaves the file', async () => {
    seedDisk(5);
    const lockPath = `${getHistoryPath()}.lock`;
    // A live holder on this host (our own pid, fresh timestamp) is never stale.
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: hostname(), token: 'other', timestamp: Date.now() }));
    expect(await resetHistory()).toBe(false);
    expect(diskRows()).toBe(5);
  }, 10_000);

  it('resetHistory() resolves true and empties the file; a read error does not block it', async () => {
    seedDisk(5);
    failNextRead('EBUSY');
    expect(await resetHistory()).toBe(true);
    expect(fault.left).toBe(1); // a reset writes whole: it never read the file
    fault.left = 0;
    expect(JSON.parse(readFileSync(getHistoryPath(), 'utf-8')).contexts).toEqual({});
  });
});
