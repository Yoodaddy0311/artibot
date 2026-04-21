import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  atomicWriteJson,
  atomicWriteJsonSync,
  ensureDir,
  exists,
  listDirs,
  listFiles,
  readJsonFile,
  readTextFile,
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
});
