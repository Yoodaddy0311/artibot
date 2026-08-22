import { describe, expect, it } from 'vitest';
import {
  assertRepoSize,
  DEFAULT_CLONE_DEPTH,
  isStaleCache,
  MAX_CACHE_KEY_LENGTH,
  MAX_REPO_BYTES,
  parseRepoInput,
  REPO_INPUT_ERRORS,
  RepoInputError,
  sanitizeRepoName,
  STALE_AFTER_MS,
  tryParseRepoInput,
} from '../../lib/core/repo-input.js';

/**
 * lib/core/repo-input.js — the executable form of the clone rules that used to
 * exist only as prose in commands/repo.md § Security, skills/repo-benchmarking/
 * SKILL.md § Clone and Isolation Protocol, and agents/repo-benchmarker.md.
 *
 * The rejection table below is the point of the module: every row is a case
 * the prose named but nothing enforced. Each asserts a *thrown* error with a
 * stable code — not a falsy return — because the caller in lib/git/repo-acquire
 * relies on the throw to guarantee no filesystem work happened.
 */

/** @type {Array<[string, unknown, string]>} */
const REJECTIONS = [
  // --- scheme: HTTPS only (repo.md § Security rule 1) --------------------
  ['scp/SSH shorthand', 'git@github.com:google/magika.git', REPO_INPUT_ERRORS.NOT_ABSOLUTE_URL],
  ['bare hostname', 'github.com/google/magika', REPO_INPUT_ERRORS.NOT_ABSOLUTE_URL],
  ['relative path', '../../etc/passwd', REPO_INPUT_ERRORS.NOT_ABSOLUTE_URL],
  ['dot-relative path', './local-repo', REPO_INPUT_ERRORS.NOT_ABSOLUTE_URL],
  ['file:// URL', 'file:///tmp/evil-repo', REPO_INPUT_ERRORS.SCHEME_NOT_HTTPS],
  ['plain http', 'http://github.com/google/magika', REPO_INPUT_ERRORS.SCHEME_NOT_HTTPS],
  ['ssh:// URL', 'ssh://git@github.com/google/magika', REPO_INPUT_ERRORS.SCHEME_NOT_HTTPS],
  ['git:// URL', 'git://github.com/google/magika', REPO_INPUT_ERRORS.SCHEME_NOT_HTTPS],
  ['data: URL', 'data:text/plain,hello', REPO_INPUT_ERRORS.SCHEME_NOT_HTTPS],
  // --- empty / non-string -----------------------------------------------
  ['empty string', '', REPO_INPUT_ERRORS.EMPTY_INPUT],
  ['whitespace only', '   \t ', REPO_INPUT_ERRORS.EMPTY_INPUT],
  ['null', null, REPO_INPUT_ERRORS.EMPTY_INPUT],
  ['number', 42, REPO_INPUT_ERRORS.EMPTY_INPUT],
  ['object', { url: 'https://github.com/a/b' }, REPO_INPUT_ERRORS.EMPTY_INPUT],
  // --- NUL byte (repo.md § Security rule 6) -----------------------------
  ['NUL byte', 'https://github.com/google/mag\0ika', REPO_INPUT_ERRORS.NULL_BYTE],
  // --- credentials / query / fragment -----------------------------------
  ['embedded credentials', 'https://user:tok@github.com/a/b', REPO_INPUT_ERRORS.CREDENTIALS_IN_URL],
  ['username only', 'https://tok@github.com/a/b', REPO_INPUT_ERRORS.CREDENTIALS_IN_URL],
  ['query string', 'https://github.com/a/b?ref=main', REPO_INPUT_ERRORS.QUERY_OR_FRAGMENT],
  ['fragment', 'https://github.com/a/b#readme', REPO_INPUT_ERRORS.QUERY_OR_FRAGMENT],
  // --- host allowlist ----------------------------------------------------
  ['single-label host', 'https://localhost/a/b', REPO_INPUT_ERRORS.HOST_INVALID],
  ['IPv4 host', 'https://127.0.0.1/a/b', REPO_INPUT_ERRORS.HOST_INVALID],
  ['IPv6 host', 'https://[::1]/a/b', REPO_INPUT_ERRORS.HOST_INVALID],
  ['leading-hyphen label', 'https://-evil.com/a/b', REPO_INPUT_ERRORS.HOST_INVALID],
  ['empty label', 'https://a..com/x/y', REPO_INPUT_ERRORS.HOST_INVALID],
  // --- path: shell metacharacters (repo.md rule 6) -----------------------
  ['no path', 'https://github.com', REPO_INPUT_ERRORS.PATH_EMPTY],
  ['root path only', 'https://github.com/', REPO_INPUT_ERRORS.PATH_EMPTY],
  ['dotdot walking above the root', 'https://github.com/../..', REPO_INPUT_ERRORS.PATH_EMPTY],
  ['percent sign', 'https://github.com/a/b%20c', REPO_INPUT_ERRORS.PATH_CHAR_NOT_ALLOWED],
  ['semicolon', 'https://github.com/a/b;rm -rf ~', REPO_INPUT_ERRORS.PATH_CHAR_NOT_ALLOWED],
  ['pipe', 'https://github.com/a/b|cat', REPO_INPUT_ERRORS.PATH_CHAR_NOT_ALLOWED],
  ['command substitution', 'https://github.com/a/$(whoami)', REPO_INPUT_ERRORS.PATH_CHAR_NOT_ALLOWED],
  ['backtick', 'https://github.com/a/`id`', REPO_INPUT_ERRORS.PATH_CHAR_NOT_ALLOWED],
  ['ampersand', 'https://github.com/a/b&c', REPO_INPUT_ERRORS.PATH_CHAR_NOT_ALLOWED],
  ['glob star', 'https://github.com/a/*', REPO_INPUT_ERRORS.PATH_CHAR_NOT_ALLOWED],
  ['tilde', 'https://github.com/a/~root', REPO_INPUT_ERRORS.PATH_CHAR_NOT_ALLOWED],
  ['space', 'https://github.com/a/b c', REPO_INPUT_ERRORS.PATH_CHAR_NOT_ALLOWED],
];

describe('parseRepoInput — rejection (fail-closed)', () => {
  it.each(REJECTIONS)('rejects %s', (_label, input, code) => {
    // A thrown RepoInputError, not a falsy return: the throw is what proves
    // the caller could not have proceeded to clone.
    let thrown = null;
    try {
      parseRepoInput(/** @type {string} */ (input));
    } catch (err) {
      thrown = err;
    }
    expect(thrown, 'expected a throw, got a successful parse').toBeInstanceOf(RepoInputError);
    expect(thrown.code).toBe(code);
    expect(thrown.message.length).toBeGreaterThan(0);
  });

  it('exercises every rejection code reachable through parseRepoInput', () => {
    // Control on the table itself: if a new code is added to the module and no
    // row exercises it, this fails instead of silently passing.
    //
    // Three codes are excluded, each for a stated reason — this list is the
    // gate's own blind-spot note, not a convenience:
    //   SIZE_EXCEEDED  — belongs to assertRepoSize, covered in its own block.
    //   NAME_EMPTY     — belongs to sanitizeRepoName, covered in its own block.
    //   PATH_TRAVERSAL — a backstop the WHATWG URL parser makes unreachable
    //                    from here (it collapses `.`/`..`/`%2e` at construction
    //                    time). The "collapses traversal" acceptance tests
    //                    below assert that parser behaviour directly, so a
    //                    regression in it surfaces there.
    const excluded = new Set([
      REPO_INPUT_ERRORS.SIZE_EXCEEDED,
      REPO_INPUT_ERRORS.NAME_EMPTY,
      REPO_INPUT_ERRORS.PATH_TRAVERSAL,
    ]);
    const exercised = new Set(REJECTIONS.map(([, , code]) => code));
    const expected = Object.values(REPO_INPUT_ERRORS).filter((code) => !excluded.has(code));
    expect([...expected].sort()).toEqual([...exercised].sort());
  });
});

describe('parseRepoInput — traversal is collapsed before validation', () => {
  // These pin the parser behaviour the PATH_TRAVERSAL backstop relies on. If a
  // future Node stops collapsing, these fail loudly here rather than letting a
  // `..` segment quietly become the cache key.
  it.each([
    ['https://github.com/a/../../etc', 'etc'],
    ['https://github.com/a/b/..', 'a'],
    ['https://github.com/a/%2e%2e/b', 'b'],
    ['https://github.com/a/./b', 'b'],
  ])('%s resolves to a traversal-free cache key', (input, cacheKey) => {
    const desc = parseRepoInput(input);
    expect(desc.cacheKey).toBe(cacheKey);
    expect(desc.pathSegments).not.toContain('..');
    expect(desc.pathSegments).not.toContain('.');
  });

  it('strips ASCII control characters so none can reach the cache key', () => {
    // WHATWG removes tab/LF/CR during parsing; assert the survivor is clean
    // rather than assuming the character was rejected.
    const desc = parseRepoInput('https://github.com/a/b\nc');
    expect(desc.cacheKey).toBe('bc');
    expect([...desc.cacheKey].every((ch) => ch.codePointAt(0) > 0x1f)).toBe(true);
  });
});

describe('parseRepoInput — acceptance', () => {
  it('parses a github URL into a cache key', () => {
    const desc = parseRepoInput('https://github.com/google/magika.git');
    expect(desc).toEqual({
      sourceUrl: 'https://github.com/google/magika.git',
      host: 'github.com',
      owner: 'google',
      repoName: 'magika',
      cacheKey: 'magika',
      pathSegments: ['google', 'magika.git'],
    });
  });

  it('accepts a URL without the .git suffix and yields the same cache key', () => {
    expect(parseRepoInput('https://github.com/google/magika').cacheKey).toBe('magika');
  });

  it('normalizes a trailing slash out of sourceUrl', () => {
    expect(parseRepoInput('https://github.com/google/magika/').sourceUrl).toBe(
      'https://github.com/google/magika',
    );
  });

  it('trims surrounding whitespace', () => {
    expect(parseRepoInput('  https://github.com/a/b  ').sourceUrl).toBe('https://github.com/a/b');
  });

  it('lowercases the host but preserves path case', () => {
    const desc = parseRepoInput('https://GitHub.COM/Google/MagiKa');
    expect(desc.host).toBe('github.com');
    expect(desc.repoName).toBe('MagiKa');
  });

  it('keeps a non-default port so self-hosted forges stay addressable', () => {
    expect(parseRepoInput('https://git.example.com:8443/team/tool').sourceUrl).toBe(
      'https://git.example.com:8443/team/tool',
    );
  });

  it('accepts deep paths (gitlab subgroups) and takes the last segment as the name', () => {
    const desc = parseRepoInput('https://gitlab.com/group/sub/tool.git');
    expect(desc.owner).toBe('sub');
    expect(desc.cacheKey).toBe('tool');
  });

  it('accepts a single-segment path with no owner', () => {
    const desc = parseRepoInput('https://git.sr.ht/tool');
    expect(desc.owner).toBeNull();
    expect(desc.cacheKey).toBe('tool');
  });

  it('returns a frozen descriptor', () => {
    const desc = parseRepoInput('https://github.com/a/b');
    expect(Object.isFrozen(desc)).toBe(true);
    expect(Object.isFrozen(desc.pathSegments)).toBe(true);
  });
});

describe('tryParseRepoInput', () => {
  it('wraps success', () => {
    const result = tryParseRepoInput('https://github.com/a/b');
    expect(result.ok).toBe(true);
    expect(result.value.cacheKey).toBe('b');
  });

  it('wraps rejection without throwing so batch parsing survives one bad URL', () => {
    const result = tryParseRepoInput('file:///tmp/x');
    expect(result.ok).toBe(false);
    expect(result.code).toBe(REPO_INPUT_ERRORS.SCHEME_NOT_HTTPS);
  });
});

describe('sanitizeRepoName', () => {
  it('strips shell metacharacters and whitespace', () => {
    expect(sanitizeRepoName('my repo; rm -rf ~')).toBe('myreporm-rf');
  });

  it('strips leading dots so the result can never be a hidden dir or ..', () => {
    expect(sanitizeRepoName('...hidden')).toBe('hidden');
  });

  it('throws NAME_EMPTY when nothing survives', () => {
    for (const input of ['..', '.', '///', '$( )', '']) {
      let thrown = null;
      try {
        sanitizeRepoName(input);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `expected "${input}" to be rejected`).toBeInstanceOf(RepoInputError);
      expect(thrown.code).toBe(REPO_INPUT_ERRORS.NAME_EMPTY);
    }
  });

  it('rejects a non-string', () => {
    expect(() => sanitizeRepoName(null)).toThrow(RepoInputError);
  });

  it('caps the length at MAX_CACHE_KEY_LENGTH', () => {
    expect(sanitizeRepoName('a'.repeat(500))).toHaveLength(MAX_CACHE_KEY_LENGTH);
  });
});

describe('assertRepoSize', () => {
  it('returns the size when under the ceiling', () => {
    expect(assertRepoSize(1024)).toBe(1024);
    expect(assertRepoSize(MAX_REPO_BYTES)).toBe(MAX_REPO_BYTES);
  });

  it('throws SIZE_EXCEEDED one byte over the real 500MB ceiling', () => {
    // The fixture reaches the failure region by construction: the boundary is
    // asserted at MAX_REPO_BYTES + 1, not at some small stand-in number.
    let thrown = null;
    try {
      assertRepoSize(MAX_REPO_BYTES + 1);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RepoInputError);
    expect(thrown.code).toBe(REPO_INPUT_ERRORS.SIZE_EXCEEDED);
    expect(thrown.message).toContain(String(MAX_REPO_BYTES));
  });

  it('honours an overridden ceiling', () => {
    expect(() => assertRepoSize(101, 100)).toThrow(RepoInputError);
    expect(assertRepoSize(100, 100)).toBe(100);
  });

  it('rejects an unmeasurable size rather than treating it as zero', () => {
    for (const bad of [NaN, Infinity, -1]) {
      expect(() => assertRepoSize(bad)).toThrow(RepoInputError);
    }
  });
});

describe('isStaleCache', () => {
  const now = 1_800_000_000_000;

  it('is fresh inside the 7-day threshold', () => {
    expect(isStaleCache(now - STALE_AFTER_MS + 1, now)).toBe(false);
  });

  it('is stale past the threshold', () => {
    expect(isStaleCache(now - STALE_AFTER_MS - 1, now)).toBe(true);
  });

  it('treats an unknown timestamp as stale (fail-closed toward refreshing)', () => {
    expect(isStaleCache(null, now)).toBe(true);
    expect(isStaleCache(undefined, now)).toBe(true);
  });
});

describe('policy constants match the documented numbers', () => {
  it('500MB ceiling, depth 1, 7-day staleness', () => {
    expect(MAX_REPO_BYTES).toBe(500 * 1024 * 1024);
    expect(DEFAULT_CLONE_DEPTH).toBe(1);
    expect(STALE_AFTER_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
