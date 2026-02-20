import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// Mock node:fs so statSync is controllable in tests.
// Default: file exists with mtime 1000.
vi.mock('node:fs', () => ({
  statSync: vi.fn(() => ({ mtimeMs: 1000 })),
}));

const { readJsonFile } = await import('../../lib/core/file.js');
const { statSync } = await import('node:fs');

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

  describe('mtime-based cache invalidation', () => {
    it('returns cached config when mtime is unchanged', async () => {
      statSync.mockReturnValue({ mtimeMs: 1000 });
      readJsonFile.mockResolvedValue({ version: '1.5.0' });

      const first = await loadConfig();
      // mtime unchanged — second call must skip readJsonFile
      const second = await loadConfig();

      expect(first).toBe(second);
      expect(readJsonFile).toHaveBeenCalledTimes(1);
    });

    it('reloads when mtime has changed', async () => {
      statSync.mockReturnValue({ mtimeMs: 1000 });
      readJsonFile.mockResolvedValue({ version: '1.5.0' });
      await loadConfig();

      // Simulate file change: new mtime
      statSync.mockReturnValue({ mtimeMs: 2000 });
      readJsonFile.mockResolvedValue({ version: '2.0.0' });
      const reloaded = await loadConfig();

      expect(reloaded.version).toBe('2.0.0');
      expect(readJsonFile).toHaveBeenCalledTimes(2);
    });

    it('reloads when statSync throws (file missing after first load)', async () => {
      statSync.mockReturnValue({ mtimeMs: 1000 });
      readJsonFile.mockResolvedValue({ version: '1.5.0' });
      await loadConfig();

      // File disappears
      statSync.mockImplementation(() => { throw new Error('ENOENT'); });
      readJsonFile.mockResolvedValue(null);
      const reloaded = await loadConfig();

      // Falls back to defaults when file is missing
      expect(reloaded.version).toBe('1.0.0');
      expect(readJsonFile).toHaveBeenCalledTimes(2);
    });

    it('force=true reloads even when mtime is unchanged', async () => {
      statSync.mockReturnValue({ mtimeMs: 1000 });
      readJsonFile.mockResolvedValue({ version: '1.5.0' });
      await loadConfig();

      readJsonFile.mockResolvedValue({ version: '3.0.0' });
      const forced = await loadConfig(true);

      expect(forced.version).toBe('3.0.0');
      expect(readJsonFile).toHaveBeenCalledTimes(2);
    });

    it('resetConfig clears cached mtime so next load always reads file', async () => {
      statSync.mockReturnValue({ mtimeMs: 1000 });
      readJsonFile.mockResolvedValue({ version: '1.5.0' });
      await loadConfig();

      resetConfig();

      readJsonFile.mockResolvedValue({ version: '2.0.0' });
      const fresh = await loadConfig();

      expect(fresh.version).toBe('2.0.0');
      expect(readJsonFile).toHaveBeenCalledTimes(2);
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
