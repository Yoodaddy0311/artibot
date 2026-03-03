/**
 * Tests for file-store.js — JSON file persistence layer.
 *
 * @module tests/server/file-store
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

// Mock node:fs
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
}));

// Mock node:crypto for deterministic temp file names
vi.mock('node:crypto', () => ({
  randomBytes: vi.fn(() => Buffer.from('deadbeef', 'hex')),
}));

const {
  initDataDir,
  readData,
  writeData,
  scheduleSave,
  flushAll,
  mapToObject,
  objectToMap,
} = await import('../../server/file-store.js');

describe('file-store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initDataDir', () => {
    it('should create data directory and return true', () => {
      mkdirSync.mockReturnValue(undefined);
      expect(initDataDir()).toBe(true);
      expect(mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    });

    it('should return false when directory creation fails', () => {
      mkdirSync.mockImplementation(() => { throw new Error('EACCES'); });
      expect(initDataDir()).toBe(false);
    });
  });

  describe('readData', () => {
    it('should parse and return JSON data from file', () => {
      const testData = { version: 1, items: ['a', 'b'] };
      readFileSync.mockReturnValue(JSON.stringify(testData));

      const result = readData('test.json');
      expect(result).toEqual(testData);
    });

    it('should return null for missing file', () => {
      readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      expect(readData('missing.json')).toBeNull();
    });

    it('should return null for corrupt JSON', () => {
      readFileSync.mockReturnValue('not valid json{{{');
      expect(readData('corrupt.json')).toBeNull();
    });
  });

  describe('writeData', () => {
    it('should write JSON atomically (temp + rename)', () => {
      writeFileSync.mockReturnValue(undefined);
      renameSync.mockReturnValue(undefined);

      const result = writeData('test.json', { key: 'value' });
      expect(result).toBe(true);
      expect(writeFileSync).toHaveBeenCalledTimes(1);
      expect(renameSync).toHaveBeenCalledTimes(1);
    });

    it('should return false on write failure', () => {
      writeFileSync.mockImplementation(() => { throw new Error('ENOSPC'); });
      expect(writeData('test.json', {})).toBe(false);
    });
  });

  describe('scheduleSave', () => {
    it('should debounce writes', () => {
      const dataFn = vi.fn(() => ({ saved: true }));
      writeFileSync.mockReturnValue(undefined);
      renameSync.mockReturnValue(undefined);

      scheduleSave('debounce.json', dataFn);
      scheduleSave('debounce.json', dataFn); // should cancel previous

      // Data function should not have been called yet
      expect(dataFn).not.toHaveBeenCalled();

      // Advance past debounce delay
      vi.advanceTimersByTime(3000);
      expect(dataFn).toHaveBeenCalledTimes(1);
    });

    it('should not write when dataFn returns null', () => {
      const dataFn = vi.fn(() => null);
      scheduleSave('null.json', dataFn);
      vi.advanceTimersByTime(3000);
      expect(writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('flushAll', () => {
    it('should flush pending saves immediately', () => {
      const dataFn = vi.fn(() => ({ flushed: true }));
      writeFileSync.mockReturnValue(undefined);
      renameSync.mockReturnValue(undefined);

      // Schedule a save
      scheduleSave('flush.json', dataFn);

      // Flush before debounce fires
      const providers = new Map([['flush.json', dataFn]]);
      const count = flushAll(providers);

      expect(count).toBe(1);
      expect(dataFn).toHaveBeenCalled();
    });

    it('should return 0 when no pending saves', () => {
      const count = flushAll(new Map());
      expect(count).toBe(0);
    });
  });

  describe('mapToObject / objectToMap', () => {
    it('should round-trip Map ↔ Object', () => {
      const map = new Map([['a', 1], ['b', { nested: true }]]);
      const obj = mapToObject(map);

      expect(obj).toEqual({ a: 1, b: { nested: true } });

      const restored = objectToMap(obj);
      expect(restored.get('a')).toBe(1);
      expect(restored.get('b')).toEqual({ nested: true });
      expect(restored.size).toBe(2);
    });

    it('should handle empty Map', () => {
      expect(mapToObject(new Map())).toEqual({});
    });

    it('should handle null/undefined input in objectToMap', () => {
      expect(objectToMap(null).size).toBe(0);
      expect(objectToMap(undefined).size).toBe(0);
    });
  });
});
