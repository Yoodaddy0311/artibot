import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * git-autopilot-setup.js — opt-in activation + allowlist policy (v4.4.0+).
 *
 * Policy under test:
 *   1. No autopilot.json + no --init + not Artibot repo + not allowlisted → 'skipped'.
 *   2. No autopilot.json + --init flag → 'created'.
 *   3. autopilot.json exists + allowlisted repo → 'updated' (refresh).
 *   4. autopilot.json exists + NOT allowlisted + not Artibot repo → 'skipped-not-allowed'
 *      (Capture-Only Mode: stale config files in unrelated repos stay inert).
 *   5. Artibot self-repo (plugin.json grandfather) → 'created' even when remote
 *      URL probe fails.
 *   6. Outside any git repo → 'no-repo' silent.
 */

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------
const mockState = {
  existsSyncResults: {},
  readFileSyncImpl: () => { throw new Error('ENOENT'); },
  execSyncImpl: () => '/fake/repo/root\n',
  // Default: probing remote URL fails (simulates non-allowlisted unknown repo).
  // Tests that need allowlisted behavior override this with the artibot URL.
  execFileSyncImpl: () => { throw new Error('git config failed'); },
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
  execFileSync: vi.fn((...args) => mockState.execFileSyncImpl(...args)),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function resetState() {
  mockState.existsSyncResults = {};
  mockState.readFileSyncImpl = () => { throw new Error('ENOENT'); };
  mockState.execSyncImpl = () => '/fake/repo/root\n';
  mockState.execFileSyncImpl = () => { throw new Error('git config failed'); };
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
    it('returns "updated" and preserves user overrides when repo is allowlisted', async () => {
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
      // Allowlisted repo URL — passes the capture-only gate.
      mockState.execFileSyncImpl = () =>
        'https://github.com/Yoodaddy0311/artibot.git\n';

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

    it('returns "skipped-not-allowed" when existing config is in a non-allowlisted repo (Capture-Only Mode)', async () => {
      const staleConfig = {
        version: 1,
        enabled: true,
        wipIntervalMinutes: 30,
        autoPullOnSession: true,
        autoPushOnStop: true,
        squashWipOnClose: true,
        branchPrefix: 'artibot/',
        conflictStrategy: 'union',
        guardEnabled: true,
        lastSetupAt: '2026-01-01T00:00:00.000Z',
      };
      mockState.existsSyncResults = {
        'autopilot.json': true,
        'plugin.json': false,
      };
      mockState.readFileSyncImpl = (p) => {
        if (String(p).includes('autopilot.json')) return JSON.stringify(staleConfig);
        throw new Error('ENOENT');
      };
      // Non-allowlisted remote — stale config must NOT be refreshed.
      mockState.execFileSyncImpl = () =>
        'https://github.com/Yoodaddy0311/carib-website.git\n';

      const outcome = await mainFn([]);

      expect(outcome).toBe('skipped-not-allowed');
      expect(mockState.atomicWrites).toHaveLength(0);
      expect(mockState.stdoutChunks).toHaveLength(0);
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
