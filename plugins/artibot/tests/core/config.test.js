import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfig, loadConfig, resetConfig } from '../../lib/core/config.js';

// Mock the file module
vi.mock('../../lib/core/file.js', () => ({
  readJsonFile: vi.fn(),
}));

// Mock the platform module
vi.mock('../../lib/core/platform.js', () => ({
  getPluginRoot: vi.fn(() => '/fake/plugin/root'),
  getHomeDir: vi.fn(() => '/fake/home'),
  // `resolveArtibotDir` compares the recorded home against the live one through
  // this. A mock factory replaces the whole module, so every export the module
  // under test reaches for has to be listed here or the import throws at
  // collection time.
  normalizeDirPath: vi.fn((p) => (typeof p === 'string' && p.trim() ? p.trim() : null)),
  sameDirPath: vi.fn((a, b) => Boolean(a) && Boolean(b) && a === b),
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
      // Absent key = ON, matching the sole owner `lib/core/team-config.js#isTeamEnabled`.
      expect(config.team.enabled).toBe(true);
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

  describe('prototype pollution prevention', () => {
    it('ignores __proto__ key in loaded config', async () => {
      readJsonFile.mockResolvedValue(
        JSON.parse('{"__proto__": {"polluted": true}, "version": "3.0.0"}'),
      );
      const config = await loadConfig();
      expect(config.version).toBe('3.0.0');
      expect(config.polluted).toBeUndefined();
    });

    it('ignores constructor key in loaded config', async () => {
      readJsonFile.mockResolvedValue({
        constructor: { prototype: { polluted: true } },
        version: '3.0.0',
      });
      const config = await loadConfig();
      expect(config.version).toBe('3.0.0');
    });

    it('ignores prototype key in loaded config', async () => {
      readJsonFile.mockResolvedValue({
        prototype: { polluted: true },
        version: '3.0.0',
      });
      const config = await loadConfig();
      expect(config.version).toBe('3.0.0');
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

  describe('team.enabled default agrees with isTeamEnabled', () => {
    // M5 (2026-11-21): DEFAULTS said `team.enabled: false` while the sole owner of
    // the meaning (`isTeamEnabled`) reads an ABSENT key as ON. A config file
    // without `team.enabled` was therefore OFF through `loadConfig()` and ON
    // through every surface that reads the raw file.
    //
    // SCOPE OF "same answer": the `null` row is the ABSENT file only. `readJsonFile`
    // also returns `null` for a MALFORMED file, and there the two sides do NOT
    // agree: `loadConfig()` falls back to DEFAULTS (team ON) while the three
    // raw-file hooks (`auto-team-trigger.js#loadTeamConfig`,
    // `auto-command-suggest.js#loadConfig`, `autopilot-nlu-trigger.js#isEnabled`)
    // catch the parse error and fail closed (OFF). That divergence is by design
    // on the hook side and is not asserted here.
    it.each([
      ['file missing (absent, not malformed)', null],
      ['file without a team block', { version: '2.0.0' }],
      ['team block without enabled', { team: { maxTeammates: 3 } }],
      ['team block with only autoApply:true', { team: { autoApply: true } }],
    ])('%s: loadConfig and raw-file readers give the same answer', async (_label, raw) => {
      const { isTeamEnabled } = await import('../../lib/core/team-config.js');
      readJsonFile.mockResolvedValue(raw);
      const config = await loadConfig(true);
      expect(isTeamEnabled(config.team)).toBe(isTeamEnabled(raw?.team));
      expect(isTeamEnabled(config.team)).toBe(true);
    });

    it('an explicit false still wins over the default', async () => {
      const { isTeamEnabled } = await import('../../lib/core/team-config.js');
      readJsonFile.mockResolvedValue({ team: { enabled: false } });
      const config = await loadConfig(true);
      expect(config.team.enabled).toBe(false);
      expect(isTeamEnabled(config.team)).toBe(false);
    });
  });
});
