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
const { applyProfile } = await import('../../scripts/swarm-autodetect.js');

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
