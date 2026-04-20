import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * git-autopilot-setup.js — opt-in activation policy (v2.7.1+).
 *
 * Policy under test:
 *   1. No autopilot.json + no --init + not Artibot repo → silent no-op, no write.
 *   2. No autopilot.json + --init flag → create with defaults.
 *   3. No autopilot.json + Artibot repo self-detected → create (grandfather).
 *   4. autopilot.json already exists → refresh (update lastSetupAt).
 *   5. Outside any git repo → silent no-op.
 */

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------
const mockState = {
  existsSyncResults: {},
  readFileSyncImpl: () => { throw new Error('ENOENT'); },
  execSyncImpl: () => '/fake/repo/root\n',
  atomicWrites: [],
  stdoutChunks: [],
  stderrChunks: [],
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../scripts/utils/index.js', () => ({
  atomicWriteSync: vi.fn((file, data) => {
    mockState.atomicWrites.push({ file, data });
  }),
}));

vi.mock('../../lib/core/hook-utils.js', () => ({
  logHookError: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: vi.fn((p) => {
      for (const [key, val] of Object.entries(mockState.existsSyncResults)) {
        if (String(p).includes(key)) return val;
      }
      return false;
    }),
    readFileSync: vi.fn((...args) => mockState.readFileSyncImpl(...args)),
  };
});

vi.mock('node:child_process', () => ({
  execSync: vi.fn((...args) => mockState.execSyncImpl(...args)),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function resetState() {
  mockState.existsSyncResults = {};
  mockState.readFileSyncImpl = () => { throw new Error('ENOENT'); };
  mockState.execSyncImpl = () => '/fake/repo/root\n';
  mockState.atomicWrites = [];
  mockState.stdoutChunks = [];
  mockState.stderrChunks = [];
}

let mainFn;
let stdoutSpy;
let stderrSpy;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('git-autopilot-setup opt-in policy', () => {
  beforeEach(async () => {
    resetState();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      mockState.stdoutChunks.push(String(chunk));
      return true;
    });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      mockState.stderrChunks.push(String(chunk));
      return true;
    });
    if (!mainFn) {
      const mod = await import('../../scripts/hooks/git-autopilot-setup.js');
      mainFn = mod.main;
    }
  });

  afterEach(() => {
    stdoutSpy?.mockRestore();
    stderrSpy?.mockRestore();
    vi.clearAllMocks();
  });

  describe('non-Artibot repo without --init', () => {
    it('returns "skipped" and writes nothing when autopilot.json is absent', async () => {
      mockState.existsSyncResults = {
        'autopilot.json': false,
        'plugin.json': false,
      };

      const outcome = await mainFn([]);

      expect(outcome).toBe('skipped');
      expect(mockState.atomicWrites).toHaveLength(0);
      expect(mockState.stdoutChunks).toHaveLength(0);
      expect(mockState.stderrChunks).toHaveLength(0);
    });
  });

  describe('--init flag explicit activation', () => {
    it('returns "created" and writes autopilot.json with defaults', async () => {
      mockState.existsSyncResults = {
        'autopilot.json': false,
        'plugin.json': false,
      };

      const outcome = await mainFn(['--init']);

      expect(outcome).toBe('created');
      expect(mockState.atomicWrites).toHaveLength(1);
      const written = mockState.atomicWrites[0].data;
      expect(written.enabled).toBe(true);
      expect(written.branchPrefix).toBe('artibot/');
      expect(written.wipIntervalMinutes).toBe(30);
      expect(typeof written.lastSetupAt).toBe('string');
      expect(mockState.stdoutChunks.join('')).toContain('Created');
    });
  });

  describe('existing autopilot.json refresh', () => {
    it('returns "updated" and preserves user overrides while refreshing lastSetupAt', async () => {
      const oldConfig = {
        version: 1,
        enabled: true,
        wipIntervalMinutes: 60,
        autoPullOnSession: false,
        autoPushOnStop: false,
        squashWipOnClose: true,
        branchPrefix: 'custom/',
        conflictStrategy: 'union',
        guardEnabled: true,
        lastSetupAt: '2026-01-01T00:00:00.000Z',
      };
      mockState.existsSyncResults = {
        'autopilot.json': true,
        'plugin.json': false,
      };
      mockState.readFileSyncImpl = (p) => {
        if (String(p).includes('autopilot.json')) return JSON.stringify(oldConfig);
        throw new Error('ENOENT');
      };

      const outcome = await mainFn([]);

      expect(outcome).toBe('updated');
      expect(mockState.atomicWrites).toHaveLength(1);
      const written = mockState.atomicWrites[0].data;
      expect(written.wipIntervalMinutes).toBe(60);
      expect(written.autoPullOnSession).toBe(false);
      expect(written.branchPrefix).toBe('custom/');
      expect(written.lastSetupAt).not.toBe('2026-01-01T00:00:00.000Z');
      expect(mockState.stdoutChunks.join('')).toContain('Updated');
    });
  });

  describe('Artibot self-repo detection', () => {
    it('returns "created" when plugin.json identifies this as the Artibot repo', async () => {
      mockState.existsSyncResults = {
        'autopilot.json': false,
        'plugin.json': true,
      };
      mockState.readFileSyncImpl = (p) => {
        if (String(p).includes('plugin.json')) {
          return JSON.stringify({ name: 'artibot', version: '2.7.1' });
        }
        throw new Error('ENOENT');
      };

      const outcome = await mainFn([]);

      expect(outcome).toBe('created');
      expect(mockState.atomicWrites).toHaveLength(1);
      expect(mockState.stdoutChunks.join('')).toContain('Created');
    });

    it('returns "skipped" when plugin.json exists but name is different', async () => {
      mockState.existsSyncResults = {
        'autopilot.json': false,
        'plugin.json': true,
      };
      mockState.readFileSyncImpl = (p) => {
        if (String(p).includes('plugin.json')) {
          return JSON.stringify({ name: 'some-other-plugin' });
        }
        throw new Error('ENOENT');
      };

      const outcome = await mainFn([]);

      expect(outcome).toBe('skipped');
      expect(mockState.atomicWrites).toHaveLength(0);
    });
  });

  describe('outside any git repo', () => {
    it('returns "no-repo" silently (no stderr noise)', async () => {
      mockState.execSyncImpl = () => {
        throw new Error('fatal: not a git repository');
      };

      const outcome = await mainFn([]);

      expect(outcome).toBe('no-repo');
      expect(mockState.atomicWrites).toHaveLength(0);
      expect(mockState.stderrChunks).toHaveLength(0);
    });
  });
});
