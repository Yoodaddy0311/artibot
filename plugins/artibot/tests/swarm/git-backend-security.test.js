/**
 * Security regression tests for lib/swarm/git-backend.js.
 *
 * Covers v4.8.0 C-1: runGit must use argv (no shell) and reject git URLs
 * containing shell metachars before any spawn happens.
 * Covers v4.8.0 L-2: commitAndPushSwarm must cap message argv at 8KB to
 * stay under the OS CreateProcess argv limit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock node:child_process BEFORE importing the SUT so spawnSync inside
// git-backend.js binds to our spy (needed for L-2 message-cap assertion).
const spawnSyncSpy = vi.fn();
vi.mock('node:child_process', () => ({
  spawnSync: spawnSyncSpy,
}));

const { assertSafeGitUrl, commitAndPushSwarm } = await import('../../lib/swarm/git-backend.js');

describe('assertSafeGitUrl (C-1 shell-injection guard)', () => {
  it('accepts canonical https remotes', () => {
    expect(assertSafeGitUrl('https://github.com/foo/bar.git')).toBe(
      'https://github.com/foo/bar.git',
    );
  });

  it('accepts ssh:// remotes', () => {
    expect(assertSafeGitUrl('ssh://git@github.com/foo/bar.git')).toBe(
      'ssh://git@github.com/foo/bar.git',
    );
  });

  it('accepts scp-style remotes (git@host:owner/repo.git)', () => {
    expect(assertSafeGitUrl('git@github.com:Yoodaddy0311/artibot-swarm.git')).toBe(
      'git@github.com:Yoodaddy0311/artibot-swarm.git',
    );
  });

  it.each([
    ['empty', ''],
    ['non-string', 123],
    ['null', null],
    ['undefined', undefined],
    ['whitespace embedded', 'https://github.com/foo bar.git'],
    ['semicolon injection', 'https://github.com/foo;rm -rf /'],
    ['backtick injection', 'https://github.com/foo`whoami`.git'],
    ['dollar injection', 'https://github.com/foo$(whoami).git'],
    ['pipe injection', 'https://github.com/foo|cat.git'],
    ['ampersand injection', 'https://github.com/foo&malicious'],
    ['parenthesis injection', 'https://github.com/foo(cmd)'],
    ['quote injection', 'https://github.com/"foo".git'],
    ['single-quote injection', "https://github.com/'foo'.git"],
    ['newline injection', 'https://github.com/foo\nrm -rf /'],
    ['backslash injection', 'https://github.com\\foo'],
    ['no recognized scheme', 'just/some/path'],
  ])('rejects %s', (_label, value) => {
    expect(() => assertSafeGitUrl(/** @type {string} */ (value))).toThrow();
  });

  it('rejects absurdly long URLs (>2048 chars)', () => {
    const long = 'https://github.com/' + 'a'.repeat(3000);
    expect(() => assertSafeGitUrl(long)).toThrow(/too long/);
  });
});

// ---------------------------------------------------------------------------
// L-2: commitAndPushSwarm — commit message size cap
// ---------------------------------------------------------------------------

describe('commitAndPushSwarm (L-2 commit message size cap)', () => {
  const cloneDir = '/fake/clone/dir';
  const COMMIT_CAP = 8 * 1024;

  beforeEach(() => {
    spawnSyncSpy.mockReset();
    // Default stub: every git call succeeds, `status --porcelain` returns
    // a non-empty string so commitAndPushSwarm proceeds past the early
    // "nothing to commit" return.
    spawnSyncSpy.mockImplementation((_cmd, args) => {
      if (Array.isArray(args) && args.includes('status')) {
        return { status: 0, stdout: ' M file.txt\n', stderr: '', error: undefined };
      }
      return { status: 0, stdout: '', stderr: '', error: undefined };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function findCommitArgs() {
    for (const call of spawnSyncSpy.mock.calls) {
      const args = call[1];
      if (Array.isArray(args) && args[0] === 'commit' && args[1] === '-m') {
        return args;
      }
    }
    return null;
  }

  it('passes a short commit message through untouched (argv slot 2)', () => {
    const ok = commitAndPushSwarm(cloneDir, 'tiny message');
    expect(ok).toBe(true);
    const commitArgs = findCommitArgs();
    expect(commitArgs).not.toBeNull();
    expect(commitArgs[2]).toBe('tiny message');
    expect(commitArgs[2]).not.toMatch(/truncated/);
  });

  it('truncates oversized commit messages to the 8KB cap with a marker', () => {
    const huge = 'A'.repeat(COMMIT_CAP * 2); // 16KB
    const ok = commitAndPushSwarm(cloneDir, huge);
    expect(ok).toBe(true);
    const commitArgs = findCommitArgs();
    expect(commitArgs).not.toBeNull();
    const sent = commitArgs[2];
    // Must be shorter than the raw input
    expect(sent.length).toBeLessThan(huge.length);
    // Must carry the truncation marker so reviewers know the body was cut
    expect(sent.endsWith('\n... (truncated)')).toBe(true);
    // Bounded by cap + marker length (no runaway)
    expect(sent.length).toBeLessThanOrEqual(COMMIT_CAP + '\n... (truncated)'.length);
  });

  it('coerces non-string messages to string before truncation (no crash)', () => {
    const ok = commitAndPushSwarm(cloneDir, /** @type {any} */ (12345));
    expect(ok).toBe(true);
    const commitArgs = findCommitArgs();
    expect(commitArgs).not.toBeNull();
    expect(typeof commitArgs[2]).toBe('string');
    expect(commitArgs[2]).toBe('12345');
  });

  it('always uses argv (shell:false) for the commit spawn — no shell string', () => {
    commitAndPushSwarm(cloneDir, 'msg');
    for (const call of spawnSyncSpy.mock.calls) {
      const [, args, options] = call;
      expect(Array.isArray(args)).toBe(true);
      if (options && 'shell' in options) {
        expect(options.shell).not.toBe(true);
      }
    }
  });
});
