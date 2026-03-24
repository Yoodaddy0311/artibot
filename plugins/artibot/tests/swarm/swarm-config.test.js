/**
 * Tests for swarm-config.js — Opt-in/out management.
 *
 * @module tests/swarm/swarm-config
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock file.js for disk operations
vi.mock('../../lib/core/file.js', () => ({
  readJsonFile: vi.fn(async () => null),
  writeJsonFile: vi.fn(async () => {}),
  ensureDir: vi.fn(async () => {}),
}));

const { readJsonFile, writeJsonFile } = await import('../../lib/core/file.js');

const {
  isSwarmActive,
  getSwarmConfig,
  optIn,
  optOut,
  loadConsent,
  SWARM_DEFAULTS,
} = await import('../../lib/swarm/swarm-config.js');

describe('swarm-config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('SWARM_DEFAULTS', () => {
    it('should have expected default values', () => {
      expect(SWARM_DEFAULTS.enabled).toBe(false);
      expect(SWARM_DEFAULTS.optIn).toBe(false);
      expect(SWARM_DEFAULTS.syncInterval).toBe('session');
      expect(SWARM_DEFAULTS.localGlobalRatio).toEqual([0.3, 0.7]);
      expect(SWARM_DEFAULTS.differentialPrivacy.enabled).toBe(true);
      expect(SWARM_DEFAULTS.differentialPrivacy.epsilon).toBe(1.0);
      expect(SWARM_DEFAULTS.differentialPrivacy.delta).toBe(1e-5);
    });

    it('should have a valid localhost server URL', () => {
      expect(SWARM_DEFAULTS.serverUrl).toContain('localhost');
      expect(SWARM_DEFAULTS.serverUrl).toMatch(/^http:\/\/localhost/);
    });
  });

  describe('getSwarmConfig', () => {
    it('should return defaults when no config provided', () => {
      const result = getSwarmConfig({});
      expect(result).toEqual(SWARM_DEFAULTS);
    });

    it('should merge user overrides with defaults', () => {
      const config = {
        swarm: {
          enabled: true,
          syncInterval: 'hourly',
        },
      };
      const result = getSwarmConfig(config);
      expect(result.enabled).toBe(true);
      expect(result.syncInterval).toBe('hourly');
      expect(result.localGlobalRatio).toEqual([0.3, 0.7]); // default preserved
    });

    it('should deep-merge differentialPrivacy', () => {
      const config = {
        swarm: {
          differentialPrivacy: { epsilon: 2.0 },
        },
      };
      const result = getSwarmConfig(config);
      expect(result.differentialPrivacy.epsilon).toBe(2.0);
      expect(result.differentialPrivacy.enabled).toBe(true); // default preserved
      expect(result.differentialPrivacy.delta).toBe(1e-5); // default preserved
    });

    it('should handle null config', () => {
      const result = getSwarmConfig(null);
      expect(result).toEqual(SWARM_DEFAULTS);
    });
  });

  describe('isSwarmActive', () => {
    it('should return false when swarm is disabled', async () => {
      const result = await isSwarmActive({ swarm: { enabled: false } });
      expect(result).toBe(false);
    });

    it('should return false when enabled but not consented', async () => {
      readJsonFile.mockResolvedValue(null); // no consent file
      const result = await isSwarmActive({ swarm: { enabled: true } });
      expect(result).toBe(false);
    });

    it('should return true when enabled and consented', async () => {
      readJsonFile.mockResolvedValue({ optedIn: true, optedInAt: '2024-01-01' });
      const result = await isSwarmActive({ swarm: { enabled: true } });
      expect(result).toBe(true);
    });

    it('should return false when no config', async () => {
      const result = await isSwarmActive({});
      expect(result).toBe(false);
    });
  });

  describe('optIn', () => {
    it('should write consent file with optedIn=true', async () => {
      const result = await optIn();
      expect(result.optedIn).toBe(true);
      expect(result.optedInAt).toBeDefined();
      expect(result.optedOutAt).toBeNull();
      expect(writeJsonFile).toHaveBeenCalledWith(
        expect.stringContaining('swarm-consent.json'),
        expect.objectContaining({ optedIn: true }),
      );
    });
  });

  describe('optOut', () => {
    it('should write consent file with optedIn=false', async () => {
      const result = await optOut();
      expect(result.optedIn).toBe(false);
      expect(result.optedOutAt).toBeDefined();
      expect(writeJsonFile).toHaveBeenCalledWith(
        expect.stringContaining('swarm-consent.json'),
        expect.objectContaining({ optedIn: false }),
      );
    });
  });

  describe('loadConsent', () => {
    it('should return default state when no file', async () => {
      readJsonFile.mockResolvedValue(null);
      const result = await loadConsent();
      expect(result.optedIn).toBe(false);
      expect(result.optedInAt).toBeNull();
      expect(result.optedOutAt).toBeNull();
    });

    it('should return stored consent state', async () => {
      readJsonFile.mockResolvedValue({
        optedIn: true,
        optedInAt: '2024-06-01T00:00:00Z',
        optedOutAt: null,
      });
      const result = await loadConsent();
      expect(result.optedIn).toBe(true);
      expect(result.optedInAt).toBe('2024-06-01T00:00:00Z');
    });

    it('should handle corrupt consent data', async () => {
      readJsonFile.mockResolvedValue('not an object');
      const result = await loadConsent();
      expect(result.optedIn).toBe(false);
    });

    it('should handle missing fields in consent', async () => {
      readJsonFile.mockResolvedValue({ optedIn: true });
      const result = await loadConsent();
      expect(result.optedIn).toBe(true);
      expect(result.optedInAt).toBeNull();
      expect(result.optedOutAt).toBeNull();
    });
  });
});
