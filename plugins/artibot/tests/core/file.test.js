import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  atomicCreateTextSync,
  atomicWriteJson,
  atomicWriteJsonSync,
  atomicWriteText,
  atomicWriteTextSync,
  CreateSkipReason,
  ensureDir,
  exists,
  listDirs,
  listFiles,
  NO_HARDLINK_CODES,
  readJsonFile,
  readTextFile,
  renameWithRetry,
  writeJsonFile,
} from '../../lib/core/file.js';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

describe('file', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `artibot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('exists()', () => {
    it('returns true for existing file', async () => {
      const file = path.join(tmpDir, 'test.txt');
      await fs.writeFile(file, 'hello');
      expect(await exists(file)).toBe(true);
    });

    it('returns true for existing directory', async () => {
      expect(await exists(tmpDir)).toBe(true);
    });

    it('returns false for nonexistent path', async () => {
      expect(await exists(path.join(tmpDir, 'nope.txt'))).toBe(false);
    });
  });

  describe('readJsonFile()', () => {
    it('reads and parses valid JSON', async () => {
      const file = path.join(tmpDir, 'data.json');
      await fs.writeFile(file, '{"name":"artibot"}');
      const result = await readJsonFile(file);
      expect(result).toEqual({ name: 'artibot' });
    });

    it('returns null for nonexistent file', async () => {
      expect(await readJsonFile(path.join(tmpDir, 'missing.json'))).toBeNull();
    });

    it('returns null for invalid JSON', async () => {
      const file = path.join(tmpDir, 'bad.json');
      await fs.writeFile(file, 'not json');
      expect(await readJsonFile(file)).toBeNull();
    });
  });

  describe('writeJsonFile()', () => {
    it('writes JSON to file', async () => {
      const file = path.join(tmpDir, 'output.json');
      await writeJsonFile(file, { version: '1.0' });
      const content = await fs.readFile(file, 'utf-8');
      expect(JSON.parse(content)).toEqual({ version: '1.0' });
    });

    it('creates parent directories', async () => {
      const file = path.join(tmpDir, 'nested', 'deep', 'config.json');
      await writeJsonFile(file, { ok: true });
      const content = await fs.readFile(file, 'utf-8');
      expect(JSON.parse(content)).toEqual({ ok: true });
    });

    it('adds trailing newline', async () => {
      const file = path.join(tmpDir, 'newline.json');
      await writeJsonFile(file, {});
      const content = await fs.readFile(file, 'utf-8');
      expect(content.endsWith('\n')).toBe(true);
    });

    it('respects custom indent', async () => {
      const file = path.join(tmpDir, 'indent.json');
      await writeJsonFile(file, { a: 1 }, 4);
      const content = await fs.readFile(file, 'utf-8');
      expect(content).toContain('    "a"');
    });
  });

  describe('readTextFile()', () => {
    it('reads file as string', async () => {
      const file = path.join(tmpDir, 'readme.md');
      await fs.writeFile(file, '# Hello');
      expect(await readTextFile(file)).toBe('# Hello');
    });

    it('returns null for nonexistent file', async () => {
      expect(await readTextFile(path.join(tmpDir, 'missing.txt'))).toBeNull();
    });
  });

  describe('ensureDir()', () => {
    it('creates directory recursively', async () => {
      const dir = path.join(tmpDir, 'a', 'b', 'c');
      await ensureDir(dir);
      const stat = await fs.stat(dir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('does not throw for existing directory', async () => {
      await ensureDir(tmpDir);
      // Should not throw
    });
  });

  describe('listFiles()', () => {
    it('lists files in directory', async () => {
      await fs.writeFile(path.join(tmpDir, 'a.js'), '');
      await fs.writeFile(path.join(tmpDir, 'b.md'), '');
      await fs.mkdir(path.join(tmpDir, 'sub'));
      const files = await listFiles(tmpDir);
      expect(files).toHaveLength(2);
      expect(files.some(f => f.endsWith('a.js'))).toBe(true);
      expect(files.some(f => f.endsWith('b.md'))).toBe(true);
    });

    it('filters by extension', async () => {
      await fs.writeFile(path.join(tmpDir, 'a.js'), '');
      await fs.writeFile(path.join(tmpDir, 'b.md'), '');
      const files = await listFiles(tmpDir, '.js');
      expect(files).toHaveLength(1);
      expect(files[0].endsWith('a.js')).toBe(true);
    });

    it('returns empty array for nonexistent directory', async () => {
      const files = await listFiles(path.join(tmpDir, 'nope'));
      expect(files).toEqual([]);
    });

    it('excludes subdirectories', async () => {
      await fs.mkdir(path.join(tmpDir, 'subdir'));
      await fs.writeFile(path.join(tmpDir, 'file.txt'), '');
      const files = await listFiles(tmpDir);
      expect(files).toHaveLength(1);
    });
  });

  describe('listDirs()', () => {
    it('lists subdirectories', async () => {
      await fs.mkdir(path.join(tmpDir, 'sub1'));
      await fs.mkdir(path.join(tmpDir, 'sub2'));
      await fs.writeFile(path.join(tmpDir, 'file.txt'), '');
      const dirs = await listDirs(tmpDir);
      expect(dirs).toHaveLength(2);
      expect(dirs.some(d => d.endsWith('sub1'))).toBe(true);
      expect(dirs.some(d => d.endsWith('sub2'))).toBe(true);
    });

    it('returns empty array for nonexistent directory', async () => {
      const dirs = await listDirs(path.join(tmpDir, 'nope'));
      expect(dirs).toEqual([]);
    });

    it('excludes files', async () => {
      await fs.writeFile(path.join(tmpDir, 'file.txt'), '');
      const dirs = await listDirs(tmpDir);
      expect(dirs).toEqual([]);
    });
  });

  describe('atomicWriteText()', () => {
    it('writes the exact string with no added trailing newline', async () => {
      const file = path.join(tmpDir, 'exact.md');
      await atomicWriteText(file, '# Title\n\nbody');
      expect(await fs.readFile(file, 'utf-8')).toBe('# Title\n\nbody');
    });

    it('preserves a trailing newline the caller supplied, without doubling it', async () => {
      const file = path.join(tmpDir, 'trailing.md');
      await atomicWriteText(file, 'line\n');
      expect(await fs.readFile(file, 'utf-8')).toBe('line\n');
    });

    it('writes an empty string as a zero-byte file', async () => {
      const file = path.join(tmpDir, 'empty.md');
      await atomicWriteText(file, '');
      expect((await fs.stat(file)).size).toBe(0);
    });

    it('creates parent directories', async () => {
      const file = path.join(tmpDir, 'nested', 'a', 'b', 'doc.md');
      await atomicWriteText(file, 'deep');
      expect(await fs.readFile(file, 'utf-8')).toBe('deep');
    });

    it('does not leave a .tmp sibling on success', async () => {
      const file = path.join(tmpDir, 'clean.md');
      await atomicWriteText(file, 'x');
      const entries = await fs.readdir(tmpDir);
      expect(entries.filter((e) => e.startsWith('clean.md.tmp'))).toEqual([]);
    });

    it('round-trips without growing the file', async () => {
      const file = path.join(tmpDir, 'roundtrip.md');
      const content = '# Skill\n\n## Rules\n- [preference] use tabs\n';
      await atomicWriteText(file, content);
      const first = (await fs.stat(file)).size;
      await atomicWriteText(file, await fs.readFile(file, 'utf-8'));
      expect((await fs.stat(file)).size).toBe(first);
    });

    it('cleans up tmp sibling and preserves existing content when rename fails', async () => {
      // A non-empty directory at the target makes rename fail on every platform.
      const target = path.join(tmpDir, 'collide.md');
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, 'x'), 'occupied');

      await expect(atomicWriteText(target, 'new')).rejects.toThrow();

      const entries = await fs.readdir(tmpDir);
      expect(entries.filter((e) => e.startsWith('collide.md.tmp'))).toEqual([]);
      // Pre-existing content survived the failed write.
      expect(await fs.readFile(path.join(target, 'x'), 'utf-8')).toBe('occupied');
    });

    it('overwrites an existing file', async () => {
      const file = path.join(tmpDir, 'over.md');
      await atomicWriteText(file, 'v1');
      await atomicWriteText(file, 'v2');
      expect(await fs.readFile(file, 'utf-8')).toBe('v2');
    });
  });

  describe('atomicWriteTextSync()', () => {
    it('writes the exact string with no added trailing newline', () => {
      const file = path.join(tmpDir, 'sync-exact.md');
      atomicWriteTextSync(file, 'no-newline');
      expect(fsSync.readFileSync(file, 'utf-8')).toBe('no-newline');
    });

    it('creates parent directories', () => {
      const file = path.join(tmpDir, 'sync', 'deep', 'doc.md');
      atomicWriteTextSync(file, 'ok');
      expect(fsSync.readFileSync(file, 'utf-8')).toBe('ok');
    });

    it('does not leave a .tmp sibling on success', () => {
      const file = path.join(tmpDir, 'sync-clean.md');
      atomicWriteTextSync(file, 'x');
      const entries = fsSync.readdirSync(tmpDir);
      expect(entries.filter((e) => e.startsWith('sync-clean.md.tmp'))).toEqual([]);
    });

    it('cleans up tmp sibling and preserves existing content when rename fails', () => {
      const target = path.join(tmpDir, 'sync-collide.md');
      fsSync.mkdirSync(target);
      fsSync.writeFileSync(path.join(target, 'x'), 'occupied');
      expect(() => atomicWriteTextSync(target, 'new')).toThrow();
      const entries = fsSync.readdirSync(tmpDir);
      expect(entries.filter((e) => e.startsWith('sync-collide.md.tmp'))).toEqual([]);
      expect(fsSync.readFileSync(path.join(target, 'x'), 'utf-8')).toBe('occupied');
    });
  });

  describe('atomicWriteJson()', () => {
    it('writes JSON atomically with trailing newline', async () => {
      const file = path.join(tmpDir, 'atomic.json');
      await atomicWriteJson(file, { hello: 'world' });
      const content = await fs.readFile(file, 'utf-8');
      expect(JSON.parse(content)).toEqual({ hello: 'world' });
      expect(content.endsWith('\n')).toBe(true);
    });

    it('creates parent directories', async () => {
      const file = path.join(tmpDir, 'nested', 'a', 'b', 'state.json');
      await atomicWriteJson(file, { ok: true });
      expect(JSON.parse(await fs.readFile(file, 'utf-8'))).toEqual({ ok: true });
    });

    it('does not leave a .tmp sibling on success', async () => {
      const file = path.join(tmpDir, 'clean.json');
      await atomicWriteJson(file, { a: 1 });
      const entries = await fs.readdir(tmpDir);
      const tmps = entries.filter((e) => e.startsWith('clean.json.tmp'));
      expect(tmps).toEqual([]);
    });

    it('overwrites existing file without readers observing partial state', async () => {
      const file = path.join(tmpDir, 'overwrite.json');
      await atomicWriteJson(file, { v: 1 });
      await atomicWriteJson(file, { v: 2 });
      expect(JSON.parse(await fs.readFile(file, 'utf-8'))).toEqual({ v: 2 });
    });

    it('cleans up tmp sibling when rename fails', async () => {
      // Simulate rename failure by making target a non-empty directory —
      // rename of a file over a non-empty dir fails on every platform.
      const target = path.join(tmpDir, 'collide.json');
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, 'x'), 'lock');

      await expect(atomicWriteJson(target, { v: 1 })).rejects.toThrow();

      // Temp sibling (if any) must not linger.
      const entries = await fs.readdir(tmpDir);
      const tmps = entries.filter((e) => e.startsWith('collide.json.tmp'));
      expect(tmps).toEqual([]);
    });

    it('concurrent writes: final file is valid + no tmp leaks', async () => {
      const file = path.join(tmpDir, 'concurrent.json');
      // Windows can EPERM on concurrent rename-over-same-target; tolerate
      // individual failures but assert the end-state invariants.
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) => atomicWriteJson(file, { writer: i })),
      );
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
      const parsed = JSON.parse(await fs.readFile(file, 'utf-8'));
      expect(typeof parsed.writer).toBe('number');
      // No tmp leftovers, regardless of per-writer outcome.
      const entries = await fs.readdir(tmpDir);
      const tmps = entries.filter((e) => e.startsWith('concurrent.json.tmp'));
      expect(tmps).toEqual([]);
    });

    it('respects custom indent', async () => {
      const file = path.join(tmpDir, 'indent.json');
      await atomicWriteJson(file, { a: 1 }, 4);
      const content = await fs.readFile(file, 'utf-8');
      expect(content).toContain('    "a"');
    });
  });

  describe('atomicWriteJsonSync()', () => {
    it('writes JSON atomically', () => {
      const file = path.join(tmpDir, 'sync-atomic.json');
      atomicWriteJsonSync(file, { hello: 'sync' });
      const content = fsSync.readFileSync(file, 'utf-8');
      expect(JSON.parse(content)).toEqual({ hello: 'sync' });
      expect(content.endsWith('\n')).toBe(true);
    });

    it('creates parent directories', () => {
      const file = path.join(tmpDir, 'sync', 'deep', 'nest.json');
      atomicWriteJsonSync(file, { ok: true });
      expect(JSON.parse(fsSync.readFileSync(file, 'utf-8'))).toEqual({ ok: true });
    });

    it('does not leave a .tmp sibling on success', () => {
      const file = path.join(tmpDir, 'sync-clean.json');
      atomicWriteJsonSync(file, { a: 1 });
      const entries = fsSync.readdirSync(tmpDir);
      expect(entries.filter((e) => e.startsWith('sync-clean.json.tmp'))).toEqual([]);
    });

    it('cleans up tmp sibling when rename fails', () => {
      const target = path.join(tmpDir, 'sync-collide.json');
      fsSync.mkdirSync(target);
      fsSync.writeFileSync(path.join(target, 'x'), 'lock');
      expect(() => atomicWriteJsonSync(target, { v: 1 })).toThrow();
      const entries = fsSync.readdirSync(tmpDir);
      expect(entries.filter((e) => e.startsWith('sync-collide.json.tmp'))).toEqual([]);
    });
  });

  // 2026-09-15 실측: 두 번 쓰는 시퀀스가 부하 하 480회 중 4회(0.83%)
  // `EPERM: operation not permitted, rename '<dest>.tmp…' -> '<dest>'` 로 실패했다.
  // 목적지가 이미 있는 두 번째 쓰기에서만 났다 — Windows 는 목적지에 열린 핸들이
  // 남아 있으면 rename 에 EPERM 을 준다. 두 호출부에서 독립적으로 실증됐다:
  // lib/git/split-brief.js#atomicWriteBytes(브리프) 와 atomicWriteTextSync(run.json).
  //
  // 이 절이 못 보는 것(rules §9): 실제 Windows 핸들 경합. 여기서는 renameSync 를
  // 대역해 재시도 경로만 핀한다. 빈도 감소는 부하 반복 실측이 답한다.
  describe('renameWithRetry()', () => {
    /** Throw `code` on the first `failures` calls, then delegate to the real rename. */
    function flakyRename(failures, code) {
      const real = fsSync.renameSync.bind(fsSync);
      let calls = 0;
      const spy = vi.spyOn(fsSync, 'renameSync').mockImplementation((from, to) => {
        calls += 1;
        if (calls <= failures) {
          const err = new Error(`${code}: injected rename failure`);
          err.code = code;
          throw err;
        }
        return real(from, to);
      });
      return { spy, count: () => calls };
    }

    it('retries a transient EPERM and lands the bytes on the third attempt', () => {
      const tmp = path.join(tmpDir, 'retry.txt.tmp');
      const dest = path.join(tmpDir, 'retry.txt');
      fsSync.writeFileSync(tmp, 'payload');
      const { spy, count } = flakyRename(2, 'EPERM');
      try {
        renameWithRetry(tmp, dest);
        expect(count()).toBe(3);
        expect(fsSync.readFileSync(dest, 'utf-8')).toBe('payload');
        expect(fsSync.existsSync(tmp)).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it('throws ENOENT on the first attempt without retrying', () => {
      const tmp = path.join(tmpDir, 'nope.txt.tmp');
      const dest = path.join(tmpDir, 'nope.txt');
      const { spy, count } = flakyRename(Number.POSITIVE_INFINITY, 'ENOENT');
      try {
        expect(() => renameWithRetry(tmp, dest)).toThrow(/ENOENT/);
        expect(count()).toBe(1);
      } finally {
        spy.mockRestore();
      }
    });

    /**
     * Capture every backoff sleep without spending the wall time. `sleepSync`
     * is module-private to `lib/core/file.js`, so it cannot be spied from
     * here; `Atomics.wait` is its single observable side effect and its 4th
     * argument IS the requested backoff, which makes the sequence assertable.
     * Returning 'timed-out' keeps the caller's control flow identical while
     * the suite pays no sleep.
     */
    function captureBackoff() {
      const sleeps = [];
      const spy = vi.spyOn(Atomics, 'wait').mockImplementation((_ia, _idx, _val, ms) => {
        sleeps.push(ms);
        return 'timed-out';
      });
      return { spy, sleeps };
    }

    it('exhausts the default 5 attempts with an uncapped 10·20·40·80 backoff', () => {
      const tmp = path.join(tmpDir, 'default.txt.tmp');
      const dest = path.join(tmpDir, 'default.txt');
      const { spy: renameSpy, count } = flakyRename(Number.POSITIVE_INFINITY, 'EPERM');
      const { spy: waitSpy, sleeps } = captureBackoff();
      try {
        expect(() => renameWithRetry(tmp, dest)).toThrow(/EPERM/);
        expect(count()).toBe(5);
        expect(sleeps).toEqual([10, 20, 40, 80]);
      } finally {
        waitSpy.mockRestore();
        renameSpy.mockRestore();
      }
    });

    // The session-store contract (S3, 2026-07): 8 attempts with each backoff
    // capped at 250ms — a ~810ms bounded budget. Pinned here so the caller can
    // drop its private copy and still keep the meaning it was raised for.
    it('honours attempts and maxBackoffMs options, capping the backoff at the ceiling', () => {
      const tmp = path.join(tmpDir, 'capped.txt.tmp');
      const dest = path.join(tmpDir, 'capped.txt');
      const { spy: renameSpy, count } = flakyRename(Number.POSITIVE_INFINITY, 'EPERM');
      const { spy: waitSpy, sleeps } = captureBackoff();
      try {
        expect(() => renameWithRetry(tmp, dest, { attempts: 8, maxBackoffMs: 250 }))
          .toThrow(/EPERM/);
        expect(count()).toBe(8);
        expect(sleeps).toEqual([10, 20, 40, 80, 160, 250, 250]);
      } finally {
        waitSpy.mockRestore();
        renameSpy.mockRestore();
      }
    });

    it('succeeds on the 7th attempt when attempts is raised to 8', () => {
      const tmp = path.join(tmpDir, 'seventh.txt.tmp');
      const dest = path.join(tmpDir, 'seventh.txt');
      fsSync.writeFileSync(tmp, 'payload');
      const { spy: renameSpy, count } = flakyRename(6, 'EBUSY');
      const { spy: waitSpy } = captureBackoff();
      try {
        renameWithRetry(tmp, dest, { attempts: 8, maxBackoffMs: 250 });
        expect(count()).toBe(7);
        expect(fsSync.readFileSync(dest, 'utf-8')).toBe('payload');
      } finally {
        waitSpy.mockRestore();
        renameSpy.mockRestore();
      }
    });

    it('does not retry a non-transient error even with attempts raised', () => {
      const tmp = path.join(tmpDir, 'hard.txt.tmp');
      const dest = path.join(tmpDir, 'hard.txt');
      const { spy: renameSpy, count } = flakyRename(Number.POSITIVE_INFINITY, 'EXDEV');
      const { spy: waitSpy, sleeps } = captureBackoff();
      try {
        expect(() => renameWithRetry(tmp, dest, { attempts: 8 })).toThrow(/EXDEV/);
        expect(count()).toBe(1);
        expect(sleeps).toEqual([]);
      } finally {
        waitSpy.mockRestore();
        renameSpy.mockRestore();
      }
    });
  });

  /**
   * `atomicCreateTextSync()` — EXCLUSIVE create, the counterpart to
   * `atomicWriteTextSync()`'s overwrite. The distinction is the whole point:
   * `atomicWriteTextSync` ends in a rename, and a rename replaces the
   * destination, so two writers that both find the target absent will both
   * "succeed" and the later one silently destroys the earlier one's file.
   *
   * MEASURED, NOT ASSUMED (2026-09-21, Windows 11, node v24.15.0). To
   * reproduce: release N real processes from a common wall-clock barrier and
   * have each one run the `existsSync` then `atomicWriteTextSync` order against
   * one path. Two or more of them claimed `written` in 190 of 200 trials at
   * N=2 and in 193 of 200 at N=8, while a negative control that staggered the
   * second writer by 500ms produced 0 of 25. The race is neither theoretical
   * nor rare under a barrier.
   *
   * WHAT THE BARRIER CANNOT GUARANTEE — do not read a green run as more than
   * it is. A child that boots slowly can reach the barrier instant after it
   * has already passed, and then it does not race: the calls serialize. A
   * serialized trial still catches a regression that swapped `link` for
   * `rename` (the second writer would overwrite and TWO results would carry
   * `created:true`), but it does NOT catch a regression back to check-then-
   * write, which passes trivially when nobody overlaps. Measured by the judge
   * on 2026-09-21 at a 600ms barrier with N=8: 26 late arrivals out of 400
   * (the 1200ms barrier used below is UNMEASURED). Each child therefore
   * reports how late it was, and the whole result set is attached to the
   * assertions below — visible when one fails, never asserted on, because a
   * lateness threshold is exactly the kind of timing assertion that flakes.
   *
   * The concurrency case below uses REAL child processes rather than promises
   * or fake timers, because the property under test is an OS-level filesystem
   * guarantee. A single-process test would prove nothing about `link`.
   */
  describe('atomicCreateTextSync()', () => {
    const FILE_MODULE_URL = pathToFileURL(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'core', 'file.js'),
    ).href;

    /** Names of stray `.tmp.` siblings left under `dir`. Should always be empty. */
    function tmpResidue(dir) {
      return fsSync.readdirSync(dir).filter((e) => e.includes('.tmp.'));
    }

    it('creates an absent target, byte-for-byte, and reports created:true', () => {
      const file = path.join(tmpDir, 'create-new.md');
      const body = 'line-1\nline-2 with no trailing newline';
      expect(atomicCreateTextSync(file, body)).toEqual({ created: true });
      expect(fsSync.readFileSync(file, 'utf-8')).toBe(body);
      expect(tmpResidue(tmpDir)).toEqual([]);
    });

    it('refuses an existing target without throwing and leaves it untouched', () => {
      const file = path.join(tmpDir, 'create-existing.md');
      fsSync.writeFileSync(file, 'original', 'utf-8');
      expect(atomicCreateTextSync(file, 'intruder')).toEqual({
        created: false,
        reason: CreateSkipReason.ALREADY_EXISTS,
      });
      expect(fsSync.readFileSync(file, 'utf-8')).toBe('original');
      expect(tmpResidue(tmpDir)).toEqual([]);
    });

    it('creates missing parent directories', () => {
      const file = path.join(tmpDir, 'deep', 'nested', 'MISSION.md');
      expect(atomicCreateTextSync(file, 'ok')).toEqual({ created: true });
      expect(fsSync.readFileSync(file, 'utf-8')).toBe('ok');
      expect(tmpResidue(path.join(tmpDir, 'deep', 'nested'))).toEqual([]);
    });

    it('leaves no .tmp sibling when the target already exists (skip path)', () => {
      const file = path.join(tmpDir, 'skip-clean.md');
      fsSync.writeFileSync(file, 'held', 'utf-8');
      atomicCreateTextSync(file, 'nope');
      atomicCreateTextSync(file, 'nope-again');
      expect(tmpResidue(tmpDir)).toEqual([]);
    });

    /**
     * THE CONTRACT THIS FUNCTION EXISTS FOR. Real processes race for one path.
     * Exactly one may claim the create; every other must be told ALREADY_EXISTS
     * rather than silently overwriting, and the surviving bytes must be the
     * winner's.
     *
     * REAL PROCESSES, NOT WORKERS OR PROMISES. The property under test is an
     * OS-level filesystem guarantee, so the racers have to be separate
     * processes — `link` is what is being trusted, and a single process could
     * appear to pass on nothing but JavaScript's run-to-completion.
     *
     * Measured 2026-09-21: the same barrier applied to the overwrite order
     * (`existsSync` then `atomicWriteTextSync`) produced two or more winners in
     * 190 of 200 trials at N=2 and 193 of 200 at N=8. Both widths are kept
     * below so the narrowest real race and the contended one are each pinned.
     *
     * @param {string} dir - fresh directory holding the target and the child.
     * @param {number} writers - number of racing processes.
     * @param {boolean} [forceFallback=false] - make `linkSync` throw EPERM in
     *   every child, so all of them take the `open(…, 'wx')` path instead.
     */
    async function raceForOnePath(dir, writers, forceFallback = false) {
      fsSync.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, 'MISSION.md');

      // The child lives in the tmp dir, never in the repo.
      const childPath = path.join(dir, 'race-child.mjs');
      fsSync.writeFileSync(childPath, [
        "const [moduleUrl, target, marker, startMs, forceFallback] = process.argv.slice(2);",
        "const fsSync = (await import('node:fs')).default;",
        "if (forceFallback === '1') {",
        "  fsSync.linkSync = () => { const e = new Error('EPERM: simulated'); e.code = 'EPERM'; throw e; };",
        "}",
        "const mod = await import(moduleUrl);",
        "let left = Number(startMs) - Date.now();",
        // How far PAST the barrier this child arrived. 0 means it was waiting
        // when the gate opened; a positive value means it never raced.
        "const late = left < 0 ? -left : 0;",
        "while (left > 0) { mod.sleepSync(Math.min(left, 5)); left = Number(startMs) - Date.now(); }",
        "let out;",
        // The marker travels back with the verdict so the caller can check the
        // surviving bytes against THE writer that was allowed to create, not
        // merely against the shape of a marker.
        "try { out = { ...mod.atomicCreateTextSync(target, marker), marker, late }; }",
        "catch (err) { out = { threw: String(err && err.code), marker, late }; }",
        "process.stdout.write(JSON.stringify(out));",
      ].join('\n'), 'utf-8');

      const startMs = Date.now() + 1200;
      const results = await Promise.all(
        Array.from({ length: writers }, (_, i) => new Promise((resolve) => {
          const child = spawn(
            process.execPath,
            [childPath, FILE_MODULE_URL, target, `writer-${i}`, String(startMs), forceFallback ? '1' : '0'],
            { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] },
          );
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (d) => { stdout += d; });
          child.stderr.on('data', (d) => { stderr += d; });
          child.on('close', () => {
            try { resolve(JSON.parse(stdout)); } catch { resolve({ nooutput: stderr.slice(0, 300) }); }
          });
        })),
      );

      // Carries every child's verdict AND its `late` reading into any failure
      // message, so a red run says whether the writers actually overlapped.
      const ctx = JSON.stringify(results);

      const winners = results.filter((r) => r.created === true);
      expect(winners, ctx).toHaveLength(1);
      expect(results.filter((r) => r.created === false).map((r) => r.reason), ctx).toEqual(
        Array.from({ length: writers - 1 }, () => CreateSkipReason.ALREADY_EXISTS),
      );
      // THE BYTES ON DISK ARE THE WINNER'S. Asserting only the SHAPE of a
      // marker here would pass even if a loser had overwritten the winner,
      // which is the exact failure this function exists to prevent.
      expect(fsSync.readFileSync(target, 'utf-8'), ctx).toBe(winners[0].marker);
      expect(tmpResidue(dir), ctx).toEqual([]);
    }

    it('lets exactly one of 2 concurrent real processes create the file', async () => {
      await raceForOnePath(path.join(tmpDir, 'race2'), 2);
    }, 60000);

    it('lets exactly one of 8 concurrent real processes create the file', async () => {
      await raceForOnePath(path.join(tmpDir, 'race8'), 8);
    }, 60000);

    /**
     * EXCLUSIVITY SURVIVES THE FALLBACK. On Windows an EPERM from `link` is
     * ambiguous: it can mean "this volume has no hard links" or "something
     * holds a handle right now". The function treats both the same way, so the
     * question that matters is not which one it was — it is whether the path it
     * takes instead is still exclusive. `open(…, 'wx')` is O_CREAT|O_EXCL, so
     * it should be; this races 8 real processes through it to show it is,
     * rather than inferring it from the flag's documentation.
     *
     * The fallback is still WEAKER in a way this cannot see: it publishes an
     * empty file and then fills it, so a process killed between the two leaves
     * a truncated file where the link path could not. That is a crash-safety
     * gap, not an exclusivity one.
     */
    it('keeps exclusivity when all 8 racers are forced onto the wx fallback', async () => {
      await raceForOnePath(path.join(tmpDir, 'race8-fallback'), 8, true);
    }, 60000);

    /**
     * FALLBACK PATH. `link` is not available everywhere — some network and
     * container filesystems answer EPERM/ENOTSUP/EOPNOTSUPP, and a cross-device
     * tmp answers EXDEV. On those the function must still create and still
     * refuse, via `open(…, 'wx')`.
     */
    it('still creates and still refuses when linkSync is unsupported', () => {
      // Drives the EXPORTED allowlist rather than a literal copy of it, so a
      // code added to the Set is exercised here automatically instead of
      // shipping with no fallback coverage.
      expect(NO_HARDLINK_CODES.size).toBeGreaterThan(0);
      for (const code of NO_HARDLINK_CODES) {
        const dir = path.join(tmpDir, `fallback-${code}`);
        fsSync.mkdirSync(dir, { recursive: true });
        const spy = vi.spyOn(fsSync, 'linkSync').mockImplementation(() => {
          const err = new Error(`${code}: simulated`);
          err.code = code;
          throw err;
        });
        try {
          const fresh = path.join(dir, 'a.md');
          expect(atomicCreateTextSync(fresh, 'via-fallback')).toEqual({ created: true });
          expect(fsSync.readFileSync(fresh, 'utf-8')).toBe('via-fallback');

          const taken = path.join(dir, 'b.md');
          fsSync.writeFileSync(taken, 'original', 'utf-8');
          expect(atomicCreateTextSync(taken, 'intruder')).toEqual({
            created: false,
            reason: CreateSkipReason.ALREADY_EXISTS,
          });
          expect(fsSync.readFileSync(taken, 'utf-8')).toBe('original');
        } finally {
          spy.mockRestore();
        }
        expect(tmpResidue(dir)).toEqual([]);
      }
    });

    /**
     * THE FALLBACK'S FAILURE BRANCH. Once `open(…, 'wx')` has succeeded, the
     * target already exists — empty. If the write that follows throws, the
     * function must not leave that empty file behind claiming to be an
     * artifact: it closes the descriptor, removes the file IT created, and
     * rethrows.
     *
     * The write is failed by descriptor, not by path: `writeFileSync` is
     * spied to throw only when its first argument is a number, which is the
     * fallback's `writeFileSync(fd, …)`. The tmp write earlier in the call
     * passes a path string and therefore still runs for real, so the test
     * exercises the branch without disabling everything around it.
     */
    it('removes its own empty file when the fallback write fails', () => {
      const dir = path.join(tmpDir, 'fallback-write-fails');
      fsSync.mkdirSync(dir, { recursive: true });
      const bystander = path.join(dir, 'bystander.md');
      fsSync.writeFileSync(bystander, 'untouched', 'utf-8');
      const target = path.join(dir, 'doomed.md');

      const realWriteFileSync = fsSync.writeFileSync;
      const linkSpy = vi.spyOn(fsSync, 'linkSync').mockImplementation(() => {
        const err = new Error('EPERM: simulated');
        err.code = 'EPERM';
        throw err;
      });
      const writeSpy = vi.spyOn(fsSync, 'writeFileSync').mockImplementation((dest, ...rest) => {
        if (typeof dest === 'number') {
          const err = new Error('ENOSPC: simulated');
          err.code = 'ENOSPC';
          throw err;
        }
        return realWriteFileSync(dest, ...rest);
      });
      try {
        expect(() => atomicCreateTextSync(target, 'body')).toThrow(/ENOSPC/);
      } finally {
        writeSpy.mockRestore();
        linkSpy.mockRestore();
      }

      expect(fsSync.existsSync(target)).toBe(false);
      expect(tmpResidue(dir)).toEqual([]);
      expect(fsSync.readFileSync(bystander, 'utf-8')).toBe('untouched');
      expect(fsSync.readdirSync(dir)).toEqual(['bystander.md']);
    });

    /**
     * NOT EVERY FAILURE IS A SKIP. Only EEXIST means "someone else has it".
     * Anything else is a real filesystem failure the caller must see, so it
     * propagates — and the tmp sibling still gets cleaned up on the way out.
     */
    it('rethrows a non-EEXIST link failure and leaves no tmp sibling', () => {
      const dir = path.join(tmpDir, 'hard-error');
      fsSync.mkdirSync(dir, { recursive: true });
      const spy = vi.spyOn(fsSync, 'linkSync').mockImplementation(() => {
        const err = new Error('EACCES: simulated');
        err.code = 'EACCES';
        throw err;
      });
      try {
        expect(() => atomicCreateTextSync(path.join(dir, 'x.md'), 'body')).toThrow(/EACCES/);
      } finally {
        spy.mockRestore();
      }
      expect(tmpResidue(dir)).toEqual([]);
      expect(fsSync.readdirSync(dir)).toEqual([]);
    });

    /**
     * The same rule against the REAL filesystem rather than a spy: a target
     * whose parent is a regular file cannot be created. The errno differs by
     * platform (ENOTDIR / ENOENT / EEXIST), so the code is not pinned — only
     * that it throws and drops nothing.
     */
    it('throws when the parent path is a file, leaving no tmp sibling', () => {
      const dir = path.join(tmpDir, 'parent-is-file');
      fsSync.mkdirSync(dir, { recursive: true });
      const blocker = path.join(dir, 'blocker');
      fsSync.writeFileSync(blocker, 'i am a file', 'utf-8');
      expect(() => atomicCreateTextSync(path.join(blocker, 'child.md'), 'body')).toThrow();
      expect(tmpResidue(dir)).toEqual([]);
      expect(fsSync.readFileSync(blocker, 'utf-8')).toBe('i am a file');
    });

    it('exposes a closed vocabulary of skip reasons', () => {
      expect(CreateSkipReason).toEqual({ ALREADY_EXISTS: 'ALREADY_EXISTS' });
      expect(Object.isFrozen(CreateSkipReason)).toBe(true);
    });

    /**
     * The fallback allowlist is a decision, not a convenience. Pinning its
     * exact membership means a sixth code cannot be slipped in without someone
     * re-arguing that the weaker `wx` path is acceptable for it — the loop
     * above would keep passing silently otherwise, since it just follows the
     * Set wherever it grows.
     */
    it('pins the exact set of codes that may fall back off linkSync', () => {
      expect([...NO_HARDLINK_CODES].sort()).toEqual(
        ['EMLINK', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'],
      );
    });
  });
});
