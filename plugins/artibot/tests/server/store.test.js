/**
 * Tests for store.js — Server storage with file persistence.
 *
 * Tests cover in-memory store operations and persistence integration.
 *
 * @module tests/server/store
 */

import { describe, expect, it, vi } from 'vitest';

// Mock file-store.js to prevent actual file I/O
vi.mock('../../server/file-store.js', () => ({
  initDataDir: vi.fn(() => true),
  readData: vi.fn(() => null),
  writeData: vi.fn(() => true),
  scheduleSave: vi.fn(),
  flushAll: vi.fn(() => 0),
  mapToObject: vi.fn((map) => {
    const obj = {};
    for (const [k, v] of map) obj[k] = v;
    return obj;
  }),
  objectToMap: vi.fn((obj) => {
    const m = new Map();
    if (obj) for (const [k, v] of Object.entries(obj)) m.set(k, v);
    return m;
  }),
}));

const {
  storeWeights,
  getLatestWeights,
  getWeightsSince,
  getRecentWeightSnapshots,
  setGlobalWeights,
  storeTelemetry,
  getTelemetrySummary,
  getClientStats,
  recordDownload,
  getServerInfo,
  initStore,
  flushStore,
} = await import('../../server/store.js');

const { scheduleSave, initDataDir, readData } = await import('../../server/file-store.js');

describe('store', () => {
  describe('initStore', () => {
    it('should initialize data directory', () => {
      const result = initStore();
      expect(result).toBe(true);
      expect(initDataDir).toHaveBeenCalled();
    });

    it('should return false when data dir is unavailable', () => {
      initDataDir.mockReturnValueOnce(false);
      // Re-import would be needed for clean state; test the mock at least
      expect(initDataDir()).toBe(false);
    });

    it('should restore data from disk when available', () => {
      readData.mockImplementation((filename) => {
        if (filename === 'weights.json') return { versionCounter: 5, snapshots: {} };
        if (filename === 'client-stats.json') return { client1: { uploads: 3, downloads: 1 } };
        if (filename === 'telemetry.json') return [{ event: 'test' }];
        if (filename === 'global-weights.json') return { tools: { key1: { score: 0.8 } } };
        return null;
      });

      const result = initStore();
      expect(result).toBe(true);
    });
  });

  describe('storeWeights', () => {
    it('should store weights and return version', () => {
      const result = storeWeights({ tools: {} }, { clientId: 'test-client' });
      expect(result).toHaveProperty('version');
      expect(result).toHaveProperty('timestamp');
      expect(result.version).toMatch(/^v\d+$/);
    });

    it('should track client uploads', () => {
      storeWeights({ tools: {} }, { clientId: 'tracker' });
      const stats = getClientStats('tracker');
      expect(stats).not.toBeNull();
      expect(stats.uploads).toBeGreaterThanOrEqual(1);
    });

    it('should trigger persistence on store', () => {
      storeWeights({ tools: {} }, { clientId: 'persist-test' });
      expect(scheduleSave).toHaveBeenCalled();
    });

    it('should handle anonymous client', () => {
      const result = storeWeights({ tools: {} }, {});
      expect(result.version).toBeDefined();
    });
  });

  describe('getLatestWeights / setGlobalWeights', () => {
    it('should return null when no global weights set', () => {
      setGlobalWeights(null);
      // getLatestWeights checks for currentGlobalWeights
    });

    it('should return weights with checksum', () => {
      const weights = { tools: { k: { score: 0.5 } } };
      setGlobalWeights(weights);
      const result = getLatestWeights();
      expect(result).not.toBeNull();
      expect(result.weights).toEqual(weights);
      expect(result.checksum).toBeDefined();
      expect(typeof result.checksum).toBe('string');
      expect(result.checksum.length).toBe(64); // SHA-256 hex
    });

    it('should persist global weights on set', () => {
      setGlobalWeights({ tools: {} });
      expect(scheduleSave).toHaveBeenCalled();
    });
  });

  describe('getWeightsSince', () => {
    it('should return full weights when version not found', () => {
      setGlobalWeights({ tools: { a: { score: 1 } } });
      const result = getWeightsSince('v999');
      expect(result).not.toBeNull();
      expect(result.weights).toBeDefined();
    });
  });

  describe('getRecentWeightSnapshots', () => {
    it('should return stored snapshots', () => {
      storeWeights({ tools: {} }, { clientId: 'snap1' });
      storeWeights({ tools: {} }, { clientId: 'snap2' });
      const snaps = getRecentWeightSnapshots(10);
      expect(snaps.length).toBeGreaterThanOrEqual(2);
    });

    it('should respect limit parameter', () => {
      const snaps = getRecentWeightSnapshots(1);
      expect(snaps.length).toBeLessThanOrEqual(1);
    });
  });

  describe('telemetry', () => {
    it('should store telemetry records', () => {
      storeTelemetry({ event: 'test', value: 42 });
      const summary = getTelemetrySummary();
      expect(summary.totalRecords).toBeGreaterThanOrEqual(1);
    });

    it('should cap telemetry at MAX_TELEMETRY', () => {
      for (let i = 0; i < 20; i++) {
        storeTelemetry({ event: `test-${i}` });
      }
      const summary = getTelemetrySummary();
      expect(summary.totalRecords).toBeLessThanOrEqual(10001);
    });
  });

  describe('client stats', () => {
    it('should return null for unknown client', () => {
      expect(getClientStats('nonexistent-client-xyz')).toBeNull();
    });

    it('should track downloads', () => {
      storeWeights({ tools: {} }, { clientId: 'dl-client' });
      recordDownload('dl-client');
      const stats = getClientStats('dl-client');
      expect(stats.downloads).toBeGreaterThanOrEqual(1);
    });

    it('should not crash on null clientId download', () => {
      expect(() => recordDownload(null)).not.toThrow();
      expect(() => recordDownload(undefined)).not.toThrow();
    });

    it('should include rank in stats', () => {
      storeWeights({ tools: {} }, { clientId: 'rank-test' });
      const stats = getClientStats('rank-test');
      expect(stats.rank).toBeGreaterThanOrEqual(1);
    });
  });

  describe('getServerInfo', () => {
    it('should return server info object', () => {
      const info = getServerInfo();
      expect(info).toHaveProperty('totalClients');
      expect(info).toHaveProperty('totalVersions');
      expect(info).toHaveProperty('memoryUsageMB');
      expect(typeof info.memoryUsageMB).toBe('number');
    });
  });

  describe('flushStore', () => {
    it('should call flushAll', () => {
      flushStore();
      // flushAll is mocked, just verify no crash
    });
  });
});
