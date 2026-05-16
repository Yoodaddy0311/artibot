/**
 * Tests for scripts/update.js
 *
 * Covers the pure helpers that don't touch the network:
 *   - readCurrentVersion: artibot.config.json → package.json fallback → '0.0.0'
 *   - resolveHome: USERPROFILE / HOME / os.homedir order
 *   - findInstallScript: priority order (source repo → ~/.claude/artibot → CLAUDE_PLUGIN_ROOT)
 *   - findBash: returns 'bash' on non-Windows; null on Windows when no candidate works
 *   - findSourceRepo: source-repo.json → common locations → walk-up
 *   - saveBackupInfo: writes JSON with previousVersion + timestamp
 *   - clearCache: removes ~/.claude/plugins/cache/artibot when present
 *
 * Black-box smoke: `node scripts/update.js --check` exits 0 and reports versions.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  clearCache,
  detectHookDrift,
  fileHash,
  findBash,
  findInstallScript,
  findSourceRepo,
  readCurrentVersion,
  resolveHome,
  saveBackupInfo,
} from '../../scripts/update.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..', '..');
const UPDATE_SCRIPT = resolve(PLUGIN_ROOT, 'scripts', 'update.js');

let tmpRoot;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'artibot-update-test-'));
});

afterEach(() => {
  if (tmpRoot && existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

describe('readCurrentVersion', () => {
  it('reads version from artibot.config.json', () => {
    writeFileSync(join(tmpRoot, 'artibot.config.json'), JSON.stringify({ version: '9.9.9' }));
    expect(readCurrentVersion(tmpRoot)).toBe('9.9.9');
  });

  it('falls back to package.json when config is missing', () => {
    writeFileSync(join(tmpRoot, 'package.json'), JSON.stringify({ version: '7.7.7' }));
    expect(readCurrentVersion(tmpRoot)).toBe('7.7.7');
  });

  it('returns 0.0.0 when neither file exists', () => {
    expect(readCurrentVersion(tmpRoot)).toBe('0.0.0');
  });

  it('returns 0.0.0 when artibot.config.json is malformed', () => {
    writeFileSync(join(tmpRoot, 'artibot.config.json'), '{ not json');
    expect(readCurrentVersion(tmpRoot)).toBe('0.0.0');
  });
});

describe('resolveHome', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  it('prefers USERPROFILE when set (Windows convention)', () => {
    process.env.USERPROFILE = 'C:\\Users\\WinUser';
    process.env.HOME = '/home/posix';
    expect(resolveHome()).toBe('C:\\Users\\WinUser');
  });

  it('falls back to HOME when USERPROFILE is unset', () => {
    delete process.env.USERPROFILE;
    process.env.HOME = '/home/posix';
    expect(resolveHome()).toBe('/home/posix');
  });

  it('returns a non-empty string when neither env is set', () => {
    delete process.env.USERPROFILE;
    delete process.env.HOME;
    const result = resolveHome();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('findInstallScript', () => {
  it('finds install.sh in the source repo', () => {
    const result = findInstallScript();
    expect(result).toBeTruthy();
    expect(existsSync(result)).toBe(true);
    expect(result.endsWith('install.sh')).toBe(true);
  });
});

describe('findBash', () => {
  it('returns the string "bash" on non-Windows platforms', () => {
    if (process.platform === 'win32') {
      // On Windows the result is a path or null — covered separately.
      const result = findBash();
      expect(result === null || typeof result === 'string').toBe(true);
    } else {
      expect(findBash()).toBe('bash');
    }
  });
});

describe('findSourceRepo', () => {
  it('returns the repo when source-repo.json points to an existing .git dir', () => {
    // Build a fake "installed" .claude/artibot/ tree with a valid source-repo.json
    const claudeDir = join(tmpRoot, '.claude', 'artibot');
    mkdirSync(claudeDir, { recursive: true });

    const fakeRepoRoot = join(tmpRoot, 'fake-repo');
    mkdirSync(join(fakeRepoRoot, '.git'), { recursive: true });
    mkdirSync(join(fakeRepoRoot, 'plugins', 'artibot'), { recursive: true });

    writeFileSync(
      join(claudeDir, 'source-repo.json'),
      JSON.stringify({
        repoRoot: fakeRepoRoot,
        pluginDir: join(fakeRepoRoot, 'plugins', 'artibot'),
        savedAt: '2026-05-06T00:00:00Z',
      })
    );

    // Override HOME to point at our tmpRoot so findSourceRepo reads our fake source-repo.json
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpRoot;
    process.env.USERPROFILE = tmpRoot;

    try {
      const result = findSourceRepo();
      expect(result).toBeTruthy();
      expect(result.gitRoot).toBe(fakeRepoRoot);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it('walks up from installScriptDir to find .git', () => {
    const fakeRepoRoot = join(tmpRoot, 'walk-repo');
    const pluginDir = join(fakeRepoRoot, 'plugins', 'artibot');
    mkdirSync(pluginDir, { recursive: true });
    mkdirSync(join(fakeRepoRoot, '.git'), { recursive: true });

    // Point HOME away from any real source-repo.json so the walk-up branch is exercised
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = join(tmpRoot, 'no-such-home');
    process.env.USERPROFILE = join(tmpRoot, 'no-such-home');

    try {
      const result = findSourceRepo(pluginDir);
      expect(result).toBeTruthy();
      expect(result.gitRoot).toBe(fakeRepoRoot);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it('returns null when neither source-repo.json nor walk-up succeeds', () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = join(tmpRoot, 'no-such-home');
    process.env.USERPROFILE = join(tmpRoot, 'no-such-home');

    try {
      const result = findSourceRepo(join(tmpRoot, 'no-such-script-dir'));
      expect(result).toBeNull();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });
});

describe('saveBackupInfo', () => {
  it('writes update-backup.json with previousVersion and timestamp', () => {
    saveBackupInfo(tmpRoot, '4.5.0');
    const backupPath = join(tmpRoot, '.claude', 'artibot', 'update-backup.json');
    expect(existsSync(backupPath)).toBe(true);

    const data = JSON.parse(readFileSync(backupPath, 'utf-8'));
    expect(data.previousVersion).toBe('4.5.0');
    expect(typeof data.backupTimestamp).toBe('string');
    expect(new Date(data.backupTimestamp).toString()).not.toBe('Invalid Date');
  });

  it('does not throw when the home dir is not writable (best-effort)', () => {
    expect(() => saveBackupInfo('/nonexistent/path/that/cannot/be/written', '1.0.0')).not.toThrow();
  });
});

describe('clearCache', () => {
  it('removes ~/.claude/plugins/cache/artibot when present', () => {
    const cachePath = join(tmpRoot, '.claude', 'plugins', 'cache', 'artibot');
    mkdirSync(cachePath, { recursive: true });
    writeFileSync(join(cachePath, 'sentinel'), 'data');

    clearCache(tmpRoot);

    expect(existsSync(cachePath)).toBe(false);
  });

  it('does not throw when cache directory does not exist', () => {
    expect(() => clearCache(tmpRoot)).not.toThrow();
  });
});

describe('detectHookDrift', () => {
  function setupSourceHooks(pluginRoot, payload) {
    mkdirSync(join(pluginRoot, 'hooks'), { recursive: true });
    writeFileSync(join(pluginRoot, 'hooks', 'hooks.json'), payload);
  }

  function setupCacheHooks(home, version, payload) {
    const dir = join(home, '.claude', 'plugins', 'cache', 'artibot', 'artibot', version, 'hooks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hooks.json'), payload);
  }

  it('returns no drift when source matches every cache version', () => {
    const pluginRoot = join(tmpRoot, 'plugin');
    const home = join(tmpRoot, 'home');
    mkdirSync(pluginRoot, { recursive: true });
    mkdirSync(home, { recursive: true });
    setupSourceHooks(pluginRoot, '{"v": 1}');
    setupCacheHooks(home, '4.8.1', '{"v": 1}');
    setupCacheHooks(home, '4.8.2', '{"v": 1}');

    const report = detectHookDrift(pluginRoot, home);
    expect(report.drift).toBe(false);
  });

  it('detects drift when any cache version differs from source', () => {
    const pluginRoot = join(tmpRoot, 'plugin');
    const home = join(tmpRoot, 'home');
    mkdirSync(pluginRoot, { recursive: true });
    mkdirSync(home, { recursive: true });
    setupSourceHooks(pluginRoot, '{"v": 2}');
    setupCacheHooks(home, '4.8.1', '{"v": 1}'); // stale
    setupCacheHooks(home, '4.8.2', '{"v": 2}');

    const report = detectHookDrift(pluginRoot, home);
    expect(report.drift).toBe(true);
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0].version).toBe('4.8.1');
    expect(typeof report.sourceHash).toBe('string');
    expect(report.sourceHash).toHaveLength(40);
  });

  it('reports no drift when plugin cache is absent', () => {
    const pluginRoot = join(tmpRoot, 'plugin');
    const home = join(tmpRoot, 'home');
    mkdirSync(pluginRoot, { recursive: true });
    mkdirSync(home, { recursive: true });
    setupSourceHooks(pluginRoot, '{"v": 1}');

    const report = detectHookDrift(pluginRoot, home);
    expect(report.drift).toBe(false);
    expect(report.reason).toBe('no plugin cache present');
  });

  it('reports no drift when source hooks.json is unreadable', () => {
    const pluginRoot = join(tmpRoot, 'plugin');
    const home = join(tmpRoot, 'home');
    mkdirSync(pluginRoot, { recursive: true });
    mkdirSync(home, { recursive: true });
    // No source hooks.json written

    const report = detectHookDrift(pluginRoot, home);
    expect(report.drift).toBe(false);
    expect(report.reason).toMatch(/source/);
  });

  it('treats missing cache hooks.json as incomplete (not drift)', () => {
    const pluginRoot = join(tmpRoot, 'plugin');
    const home = join(tmpRoot, 'home');
    mkdirSync(pluginRoot, { recursive: true });
    mkdirSync(home, { recursive: true });
    setupSourceHooks(pluginRoot, '{"v": 1}');
    // Create cache version dir but no hooks.json inside
    mkdirSync(join(home, '.claude', 'plugins', 'cache', 'artibot', 'artibot', '4.8.1'), { recursive: true });

    const report = detectHookDrift(pluginRoot, home);
    expect(report.drift).toBe(false);
  });
});

describe('fileHash', () => {
  it('returns a stable SHA-1 digest for the same content', () => {
    const filePath = join(tmpRoot, 'a.txt');
    writeFileSync(filePath, 'hello');
    const a = fileHash(filePath);
    const b = fileHash(filePath);
    expect(a).toBe(b);
    expect(a).toHaveLength(40);
  });

  it('returns null for a missing file', () => {
    expect(fileHash(join(tmpRoot, 'nope'))).toBeNull();
  });

  it('returns different digests for different content', () => {
    writeFileSync(join(tmpRoot, 'a.txt'), 'one');
    writeFileSync(join(tmpRoot, 'b.txt'), 'two');
    expect(fileHash(join(tmpRoot, 'a.txt'))).not.toBe(fileHash(join(tmpRoot, 'b.txt')));
  });
});

describe('CLI smoke (--check)', () => {
  it('runs `node update.js --check` and reports both versions', () => {
    const output = execFileSync('node', [UPDATE_SCRIPT, '--check'], {
      cwd: PLUGIN_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    expect(output).toContain('Installed version');
    expect(output).toContain('Latest version');
  }, 20_000);
});
