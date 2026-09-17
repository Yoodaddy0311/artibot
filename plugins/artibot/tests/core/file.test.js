import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  atomicWriteJson,
  atomicWriteJsonSync,
  atomicWriteText,
  atomicWriteTextSync,
  ensureDir,
  exists,
  listDirs,
  listFiles,
  readJsonFile,
  readTextFile,
  renameWithRetry,
  writeJsonFile,
} from '../../lib/core/file.js';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
});
