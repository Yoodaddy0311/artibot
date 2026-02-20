import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig, getConfig, resetConfig } from '../../lib/core/config.js';

// Mock the file module
vi.mock('../../lib/core/file.js', () => ({
  readJsonFile: vi.fn(),
}));

// Mock the platform module
vi.mock('../../lib/core/platform.js', () => ({
  getPluginRoot: vi.fn(() => '/fake/plugin/root'),
  getHomeDir: vi.fn(() => '/fake/home'),
}));

const { readJsonFile } = await import('../../lib/core/file.js');

describe('config', () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
  });

  describe('loadConfig()', () => {
    it('returns defaults when config file is missing', async () => {
      readJsonFile.mockResolvedValue(null);
      const config = await loadConfig();
      expect(config.version).toBe('1.0.0');
      expect(config.team.enabled).toBe(false);
      expect(config.team.maxTeammates).toBe(7);
      expect(config.automation.intentDetection).toBe(true);
      expect(config.automation.ambiguityThreshold).toBe(50);
      expect(config.automation.supportedLanguages).toEqual(['en', 'ko', 'ja']);
    });

    it('merges loaded config over defaults', async () => {
      readJsonFile.mockResolvedValue({
        version: '2.0.0',
        team: { enabled: true },
      });
      const config = await loadConfig();
      expect(config.version).toBe('2.0.0');
      expect(config.team.enabled).toBe(true);
      expect(config.team.maxTeammates).toBe(7); // default preserved
    });

    it('deep merges nested objects', async () => {
      readJsonFile.mockResolvedValue({
        automation: { ambiguityThreshold: 75 },
      });
      const config = await loadConfig();
      expect(config.automation.ambiguityThreshold).toBe(75);
      expect(config.automation.intentDetection).toBe(true); // default preserved
      expect(config.automation.supportedLanguages).toEqual(['en', 'ko', 'ja']);
    });

    it('caches result on first load', async () => {
      readJsonFile.mockResolvedValue({ version: '1.5.0' });
      const first = await loadConfig();
      const second = await loadConfig();
      expect(first).toBe(second);
      expect(readJsonFile).toHaveBeenCalledTimes(1);
    });

    it('force reloads when force=true', async () => {
      readJsonFile.mockResolvedValue({ version: '1.5.0' });
      await loadConfig();
      readJsonFile.mockResolvedValue({ version: '2.0.0' });
      const reloaded = await loadConfig(true);
      expect(reloaded.version).toBe('2.0.0');
      expect(readJsonFile).toHaveBeenCalledTimes(2);
    });

    it('arrays from source override target arrays', async () => {
      readJsonFile.mockResolvedValue({
        automation: { supportedLanguages: ['en'] },
      });
      const config = await loadConfig();
      expect(config.automation.supportedLanguages).toEqual(['en']);
    });
  });

  describe('getConfig()', () => {
    it('throws when config is not yet loaded', () => {
      expect(() => getConfig()).toThrow('Config not loaded');
    });

    it('returns cached config after loadConfig()', async () => {
      readJsonFile.mockResolvedValue({});
      const loaded = await loadConfig();
      const gotten = getConfig();
      expect(gotten).toBe(loaded);
    });
  });

  describe('resetConfig()', () => {
    it('clears the cache so getConfig throws', async () => {
      readJsonFile.mockResolvedValue({});
      await loadConfig();
      resetConfig();
      expect(() => getConfig()).toThrow('Config not loaded');
    });
  });
});
