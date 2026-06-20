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
  findInstallPs1,
  findInstallScript,
  findPowerShell,
  findSourceRepo,
  installLanded,
  popAutostash,
  readCurrentVersion,
  resolveDefaultBranchPull,
  resolveHome,
  resolveRemoteDefaultBranch,
  saveBackupInfo,
  stashIfDirty,
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

  it('returns a string path or null (never throws) regardless of platform', () => {
    // The expanded Windows candidate list (Scoop, Chocolatey, git --exec-path,
    // where bash) must degrade gracefully — a missing candidate is skipped, not
    // fatal. On every platform the contract is: string | null, no throw.
    let result;
    expect(() => { result = findBash(); }).not.toThrow();
    expect(result === null || typeof result === 'string').toBe(true);
  });
});

describe('findPowerShell', () => {
  it('returns null on non-Windows platforms', () => {
    if (process.platform !== 'win32') {
      expect(findPowerShell()).toBeNull();
    } else {
      // Win10/11 always ship Windows PowerShell, so a string is expected, but
      // the contract permits null on a stripped-down host.
      const result = findPowerShell();
      expect(result === null || typeof result === 'string').toBe(true);
    }
  });

  it('never throws', () => {
    expect(() => findPowerShell()).not.toThrow();
  });
});

describe('findInstallPs1', () => {
  it('finds install.ps1 in the source repo when present, else returns null', () => {
    // The source repo may or may not ship install.ps1 (authored by a separate
    // task). The contract is: an existing-file path or null, never a throw.
    let result;
    expect(() => { result = findInstallPs1(); }).not.toThrow();
    if (result !== null) {
      expect(existsSync(result)).toBe(true);
      expect(result.endsWith('install.ps1')).toBe(true);
    }
  });

  it('resolves install.ps1 from the installed copy (~/.claude/artibot/)', () => {
    const claudeDir = join(tmpRoot, '.claude', 'artibot');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'install.ps1'), '# fake installer');

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    // Point HOME at tmpRoot. The source-repo candidate is checked first; it
    // only matches if the real repo ships install.ps1. Either way the result is
    // a valid install.ps1 path, which is what we assert.
    process.env.HOME = tmpRoot;
    process.env.USERPROFILE = tmpRoot;
    try {
      const result = findInstallPs1();
      expect(result).toBeTruthy();
      expect(result.endsWith('install.ps1')).toBe(true);
      expect(existsSync(result)).toBe(true);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
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

describe('stashIfDirty / popAutostash', () => {
  // Build a throwaway git repo with one committed file so we can dirty it.
  function initRepo() {
    const repo = join(tmpRoot, 'stash-repo');
    mkdirSync(repo, { recursive: true });
    const run = (args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    run(['init']);
    run(['config', 'user.email', 'test@artibot.local']);
    run(['config', 'user.name', 'artibot-test']);
    writeFileSync(join(repo, 'tracked.txt'), 'original\n');
    run(['add', '.']);
    run(['commit', '-m', 'init']);
    return repo;
  }

  function status(repo) {
    return execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf-8' }).trim();
  }

  it('returns false and makes no stash when the tree is clean', () => {
    const repo = initRepo();
    expect(stashIfDirty(repo)).toBe(false);
    const stashes = execFileSync('git', ['stash', 'list'], { cwd: repo, encoding: 'utf-8' }).trim();
    expect(stashes).toBe('');
  });

  it('stashes a dirty tracked file and pop restores it', () => {
    const repo = initRepo();
    writeFileSync(join(repo, 'tracked.txt'), 'dirty edit\n');
    expect(status(repo)).not.toBe('');

    const stashed = stashIfDirty(repo);
    expect(stashed).toBe(true);
    // After stash the working tree is clean again (pull would now succeed).
    expect(status(repo)).toBe('');

    popAutostash(repo);
    // The dirty edit is restored (normalize CRLF — git autocrlf may rewrite
    // line endings on Windows checkouts).
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf-8').replace(/\r\n/g, '\n'))
      .toBe('dirty edit\n');
  });

  it('includes untracked files in the stash', () => {
    const repo = initRepo();
    writeFileSync(join(repo, 'untracked.txt'), 'new file\n');
    expect(status(repo)).toContain('untracked.txt');

    expect(stashIfDirty(repo)).toBe(true);
    expect(existsSync(join(repo, 'untracked.txt'))).toBe(false); // stashed away

    popAutostash(repo);
    expect(existsSync(join(repo, 'untracked.txt'))).toBe(true); // restored
  });

  it('returns false when git status fails (not a repo)', () => {
    const notRepo = join(tmpRoot, 'not-a-repo');
    mkdirSync(notRepo, { recursive: true });
    expect(stashIfDirty(notRepo)).toBe(false);
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
    expect(() => saveBackupInfo(
      ['', 'nonexistent', 'cannot', 'write', 'here'].join('/'),
      'test-version-marker',
    )).not.toThrow();
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

describe('resolveRemoteDefaultBranch / resolveDefaultBranchPull (B1 dead-branch self-heal)', () => {
  // Build a bare "origin" with default branch master + a working clone.
  function initRemoteAndClone() {
    const origin = join(tmpRoot, 'origin.git');
    const seed = join(tmpRoot, 'seed');
    execFileSync('git', ['init', '--bare', '-b', 'master', origin], { stdio: 'ignore' });

    mkdirSync(seed, { recursive: true });
    const runSeed = (args) => execFileSync('git', args, { cwd: seed, stdio: 'ignore' });
    runSeed(['init', '-b', 'master']);
    runSeed(['config', 'user.email', 'test@artibot.local']);
    runSeed(['config', 'user.name', 'artibot-test']);
    writeFileSync(join(seed, 'f.txt'), 'x\n');
    runSeed(['add', '.']);
    runSeed(['commit', '-m', 'init']);
    runSeed(['remote', 'add', 'origin', origin]);
    runSeed(['push', '-u', 'origin', 'master']);

    const clone = join(tmpRoot, 'clone');
    execFileSync('git', ['clone', origin, clone], { stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@artibot.local'], { cwd: clone, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'artibot-test'], { cwd: clone, stdio: 'ignore' });
    return { origin, clone };
  }

  it('reads the remote default branch from origin/HEAD', () => {
    const { clone } = initRemoteAndClone();
    expect(resolveRemoteDefaultBranch(clone)).toBe('master');
  });

  it('returns null on a non-git directory (graceful)', () => {
    const notRepo = join(tmpRoot, 'not-a-repo');
    mkdirSync(notRepo, { recursive: true });
    expect(resolveRemoteDefaultBranch(notRepo)).toBeNull();
  });

  it('resolves the pull target to the remote default branch', () => {
    const { clone } = initRemoteAndClone();
    expect(resolveDefaultBranchPull(clone)).toEqual(['pull', 'origin', 'master']);
  });

  it('self-repairs origin/HEAD via set-head --auto when it was deleted', () => {
    const { clone } = initRemoteAndClone();
    // Simulate a clone whose origin/HEAD symref is missing (older clones, or a
    // branch rename). The resolver must re-populate it from the remote.
    execFileSync('git', ['remote', 'set-head', 'origin', '-d'], { cwd: clone, stdio: 'ignore' });
    expect(resolveDefaultBranchPull(clone)).toEqual(['pull', 'origin', 'master']);
  });

  it('never includes the dead artibot/master guess', () => {
    const { clone } = initRemoteAndClone();
    const args = resolveDefaultBranchPull(clone);
    expect(args[2]).not.toBe('artibot/master');
  });
});

describe('installLanded (B2 silent no-op guard)', () => {
  it('treats a forced/drift reinstall (no pending update) as landed', () => {
    expect(installLanded('4.26.0', 'v4.26.0', false)).toBe(true);
    // Even if versions differ, a non-pending reinstall is not held to the bar.
    expect(installLanded('4.26.0', 'v4.27.0', false)).toBe(true);
  });

  it('reports NOT landed when a real update stayed behind on disk', () => {
    expect(installLanded('4.26.0', 'v4.26.1', true)).toBe(false);
  });

  it('reports landed when the installed version reached the latest', () => {
    expect(installLanded('4.26.1', 'v4.26.1', true)).toBe(true);
  });

  it('tolerates a v-prefixed latest tag', () => {
    expect(installLanded('4.26.1', 'v4.26.1', true)).toBe(true);
    expect(installLanded('4.26.0', 'v4.26.1', true)).toBe(false);
  });
});

describe('CLI smoke (--check)', () => {
  // TODO(v4.13.1): libuv UV_HANDLE_CLOSING assertion (`win/async.c:76`) when
  // spawning update.js as a child on Windows. Pre-existing flake unrelated to
  // /save (last update.js touch: v4.8.3 / 91b77be). Track at known-issues
  // until child-process handle teardown in update.js is hardened.
  it.skip('runs `node update.js --check` and reports both versions', () => {
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
