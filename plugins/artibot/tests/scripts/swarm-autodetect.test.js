/**
 * Regression tests for scripts/swarm-autodetect.js.
 *
 * v4.8.0 C-2: applyProfile() must reject malicious repoUrl values via
 * assertSafeGitUrl BEFORE invoking spawnSync, and must invoke node via
 * argv (shell:false) for legitimate URLs — never via a shell string.
 *
 * Strategy: stub `node:child_process` BEFORE the module is imported so
 * we capture exactly what spawnSync is called with (or whether it is
 * invoked at all).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Mock node:child_process FIRST so the SUT picks up the spy on import.
const spawnSyncSpy = vi.fn(() => ({
  status: 0,
  stdout: 'init-ok',
  stderr: '',
  error: undefined,
}));
vi.mock('node:child_process', () => ({
  spawnSync: spawnSyncSpy,
}));

// Now import the SUT — its `import { spawnSync }` binds to our spy.
const { applyProfile, readProfile } = await import('../../scripts/swarm-autodetect.js');

describe('applyProfile (C-2 shell-injection guard)', () => {
  const pluginRoot = '/fake/plugin/root';

  beforeEach(() => {
    spawnSyncSpy.mockClear();
    spawnSyncSpy.mockReturnValue({
      status: 0,
      stdout: 'init-ok',
      stderr: '',
      error: undefined,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -- Normal URLs (allow) ---------------------------------------------------

  it('accepts canonical https remote and invokes spawnSync with argv (shell:false)', () => {
    const result = applyProfile(pluginRoot, {
      repoUrl: 'https://github.com/owner/repo.git',
    });
    expect(result.ok).toBe(true);
    expect(spawnSyncSpy).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = spawnSyncSpy.mock.calls[0];
    // First arg is the node executable path, not a shell command string.
    expect(typeof cmd).toBe('string');
    expect(cmd.length).toBeGreaterThan(0);
    expect(Array.isArray(args)).toBe(true);
    // Second argv slot must be the --repo flag carrying the exact URL.
    expect(args).toContain('--repo=https://github.com/owner/repo.git');
    expect(options.shell).toBe(false);
  });

  it('accepts ssh remote and forwards the URL untouched in argv', () => {
    const result = applyProfile(pluginRoot, {
      repoUrl: 'ssh://git@github.com/owner/repo.git',
    });
    expect(result.ok).toBe(true);
    const args = spawnSyncSpy.mock.calls[0][1];
    expect(args).toContain('--repo=ssh://git@github.com/owner/repo.git');
  });

  // -- Malicious URLs (reject WITHOUT spawning) ------------------------------

  it.each([
    ['semicolon injection',     'https://github.com/foo;rm -rf /'],
    ['backtick injection',      'https://github.com/foo`whoami`.git'],
    ['command substitution',    'https://github.com/foo$(id).git'],
    ['pipe injection',          'https://github.com/foo|cat'],
    ['whitespace embedded',     'https://github.com/foo bar.git'],
    ['ampersand injection',     'https://github.com/foo&malicious'],
    ['newline injection',       'https://github.com/foo\nrm -rf /'],
    ['unrecognized scheme',     'just/some/path'],
  ])('rejects %s WITHOUT invoking spawnSync', (_label, malicious) => {
    const result = applyProfile(pluginRoot, { repoUrl: malicious });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unsafe repoUrl/);
    expect(spawnSyncSpy).not.toHaveBeenCalled();
  });

  // -- spawn error surface ---------------------------------------------------

  it('propagates spawnSync error.error as a graceful failure', () => {
    spawnSyncSpy.mockReturnValueOnce({
      status: null,
      stdout: '',
      stderr: '',
      error: new Error('ENOENT'),
    });
    const result = applyProfile(pluginRoot, {
      repoUrl: 'https://github.com/owner/repo.git',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ENOENT');
  });

  it('reports non-zero exit status with stderr', () => {
    spawnSyncSpy.mockReturnValueOnce({
      status: 2,
      stdout: '',
      stderr: 'init failed',
      error: undefined,
    });
    const result = applyProfile(pluginRoot, {
      repoUrl: 'https://github.com/owner/repo.git',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('status 2');
    expect(result.stderr).toContain('init failed');
  });
});

// ---------------------------------------------------------------------------
// readProfile() — v4.8.0 audit M-2: size cap + schema validation.
// ---------------------------------------------------------------------------

describe('readProfile (M-2 size cap + schema validation)', () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'artibot-swarm-profile-'));
    mkdirSync(path.join(tmpRoot, '.claude-plugin'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function writeProfile(content) {
    writeFileSync(path.join(tmpRoot, '.claude-plugin', 'swarm-profile.json'), content, 'utf-8');
  }

  it('returns a profile object for a well-formed JSON file with string repoUrl', () => {
    writeProfile(JSON.stringify({ repoUrl: 'https://github.com/owner/repo.git' }));
    const profile = readProfile(tmpRoot);
    expect(profile).not.toBeNull();
    expect(profile.repoUrl).toBe('https://github.com/owner/repo.git');
  });

  it('returns null when the profile file is larger than 64KB (M-2 size cap)', () => {
    // 70KB of valid JSON whitespace padding — over the 64KB cap.
    const giant = '{"repoUrl":"https://github.com/owner/repo.git","_pad":"' +
      'A'.repeat(70 * 1024) + '"}';
    writeProfile(giant);
    expect(readProfile(tmpRoot)).toBeNull();
  });

  it('returns null when JSON is malformed (M-2 parse guard)', () => {
    writeProfile('not json {');
    expect(readProfile(tmpRoot)).toBeNull();
  });

  it('returns null when repoUrl is not a string (M-2 schema check)', () => {
    writeProfile(JSON.stringify({ repoUrl: 12345 }));
    expect(readProfile(tmpRoot)).toBeNull();
  });

  it('returns null when repoUrl is missing (M-2 schema check)', () => {
    writeProfile(JSON.stringify({ other: 'field' }));
    expect(readProfile(tmpRoot)).toBeNull();
  });

  it('returns null when top-level JSON is an array (M-2 schema check)', () => {
    writeProfile(JSON.stringify(['https://github.com/owner/repo.git']));
    expect(readProfile(tmpRoot)).toBeNull();
  });

  it('returns null when top-level JSON is a primitive (M-2 schema check)', () => {
    writeProfile(JSON.stringify('https://github.com/owner/repo.git'));
    expect(readProfile(tmpRoot)).toBeNull();
  });

  it('returns null when repoUrl is empty string (M-2 schema check)', () => {
    writeProfile(JSON.stringify({ repoUrl: '' }));
    expect(readProfile(tmpRoot)).toBeNull();
  });
});
