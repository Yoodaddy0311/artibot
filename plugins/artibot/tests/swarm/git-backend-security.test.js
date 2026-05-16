/**
 * Security regression tests for lib/swarm/git-backend.js.
 *
 * Covers v4.8.0 C-1: runGit must use argv (no shell) and reject git URLs
 * containing shell metachars before any spawn happens.
 */

import { describe, expect, it } from 'vitest';
import { assertSafeGitUrl } from '../../lib/swarm/git-backend.js';

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
