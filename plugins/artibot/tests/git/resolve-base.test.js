import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * resolve-base.js — multi-step base-branch resolver for autopilot hooks.
 *
 * Resolution order:
 *   1. config.baseBranch (explicit override)
 *   2. origin/HEAD via `git symbolic-ref --short refs/remotes/origin/HEAD`
 *   3. local `master` then `main` via `git rev-parse --verify`
 *   4. null when every probe fails
 */

const mockState = {
  /** Map keyed by `args.join(' ')` -> string return value or Error to throw. */
  responses: new Map(),
};

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn((file, args /*, opts */) => {
    if (file !== 'git') throw new Error(`unexpected exec: ${file}`);
    const key = (args || []).join(' ');
    if (!mockState.responses.has(key)) {
      // Default: throw — simulates non-zero exit status.
      throw new Error(`no-mock-for: ${key}`);
    }
    const value = mockState.responses.get(key);
    if (value instanceof Error) throw value;
    return value;
  }),
}));

let resolveBaseBranch;

beforeEach(async () => {
  mockState.responses = new Map();
  if (!resolveBaseBranch) {
    ({ resolveBaseBranch } = await import('../../lib/git/resolve-base.js'));
  }
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('resolveBaseBranch', () => {
  it('uses config.baseBranch verbatim when provided (config-first)', () => {
    // Even if origin/HEAD exists, the config wins.
    mockState.responses.set('symbolic-ref --short refs/remotes/origin/HEAD', 'origin/main');
    const result = resolveBaseBranch('/repo', { baseBranch: 'develop' });
    expect(result).toBe('develop');
  });

  it('trims whitespace around config.baseBranch but rejects empty/whitespace-only strings', () => {
    mockState.responses.set('symbolic-ref --short refs/remotes/origin/HEAD', 'origin/main');
    expect(resolveBaseBranch('/repo', { baseBranch: '  develop  ' })).toBe('develop');
    // Empty / whitespace-only must fall through to origin/HEAD (not return empty string).
    expect(resolveBaseBranch('/repo', { baseBranch: '   ' })).toBe('main');
  });

  it('falls back to origin/HEAD short-name when config has no baseBranch', () => {
    mockState.responses.set('symbolic-ref --short refs/remotes/origin/HEAD', 'origin/main');
    const result = resolveBaseBranch('/repo', null);
    expect(result).toBe('main');
  });

  it('falls back to local master then main when origin/HEAD probe fails', () => {
    // origin/HEAD missing
    mockState.responses.set(
      'symbolic-ref --short refs/remotes/origin/HEAD',
      new Error('no symbolic-ref'),
    );
    // master verifies successfully
    mockState.responses.set('rev-parse --verify --quiet master', 'mastersha');
    const result = resolveBaseBranch('/repo', {});
    expect(result).toBe('master');
  });

  it('prefers main over no-result when master is missing', () => {
    mockState.responses.set(
      'symbolic-ref --short refs/remotes/origin/HEAD',
      new Error('no symbolic-ref'),
    );
    mockState.responses.set(
      'rev-parse --verify --quiet master',
      new Error('unknown ref'),
    );
    mockState.responses.set('rev-parse --verify --quiet main', 'mainsha');
    const result = resolveBaseBranch('/repo', {});
    expect(result).toBe('main');
  });

  it('returns null when every probe fails (config null + origin/HEAD missing + no local master/main)', () => {
    mockState.responses.set(
      'symbolic-ref --short refs/remotes/origin/HEAD',
      new Error('no symbolic-ref'),
    );
    mockState.responses.set(
      'rev-parse --verify --quiet master',
      new Error('unknown ref'),
    );
    mockState.responses.set(
      'rev-parse --verify --quiet main',
      new Error('unknown ref'),
    );
    const result = resolveBaseBranch('/repo', null);
    expect(result).toBeNull();
  });

  it('handles non-prefixed origin/HEAD output gracefully (e.g. plain "main")', () => {
    // Some git versions / hosts return the short name without the "origin/" prefix.
    mockState.responses.set('symbolic-ref --short refs/remotes/origin/HEAD', 'main');
    const result = resolveBaseBranch('/repo', undefined);
    expect(result).toBe('main');
  });
});

describe('resolveBaseBranch — v4.5.12 stacked-PR upstream tracking', () => {
  it('uses upstream tracking when branch tracks a DIFFERENT parent (stacked PR)', () => {
    // Branch "phase3-4" tracks "origin/feature-parent" (a sibling, not self).
    mockState.responses.set('rev-parse --abbrev-ref HEAD', 'phase3-4');
    mockState.responses.set(
      'rev-parse --abbrev-ref --symbolic-full-name @{upstream}',
      'origin/feature-parent',
    );
    // origin/HEAD MUST NOT be consulted when stacked upstream resolves.
    mockState.responses.set('symbolic-ref --short refs/remotes/origin/HEAD', 'origin/master');
    const result = resolveBaseBranch('/repo', undefined);
    expect(result).toBe('origin/feature-parent');
  });

  it('skips upstream when it points at the branch itself (origin/foo for branch foo)', () => {
    // Self-tracking is the common case — must fall through to origin/HEAD.
    mockState.responses.set('rev-parse --abbrev-ref HEAD', 'foo');
    mockState.responses.set(
      'rev-parse --abbrev-ref --symbolic-full-name @{upstream}',
      'origin/foo',
    );
    mockState.responses.set('symbolic-ref --short refs/remotes/origin/HEAD', 'origin/master');
    const result = resolveBaseBranch('/repo', undefined);
    expect(result).toBe('master');
  });

  it('skips upstream tracking step when HEAD is detached', () => {
    mockState.responses.set('rev-parse --abbrev-ref HEAD', 'HEAD');
    mockState.responses.set('symbolic-ref --short refs/remotes/origin/HEAD', 'origin/main');
    const result = resolveBaseBranch('/repo', undefined);
    expect(result).toBe('main');
  });

  it('skips upstream tracking step when @{upstream} fails (no tracking set)', () => {
    mockState.responses.set('rev-parse --abbrev-ref HEAD', 'detached-feature');
    // @{upstream} throws when no upstream is configured
    mockState.responses.set(
      'rev-parse --abbrev-ref --symbolic-full-name @{upstream}',
      new Error('no upstream'),
    );
    mockState.responses.set('symbolic-ref --short refs/remotes/origin/HEAD', 'origin/main');
    const result = resolveBaseBranch('/repo', undefined);
    expect(result).toBe('main');
  });

  it('explicit config.baseBranch still wins over upstream tracking', () => {
    mockState.responses.set('rev-parse --abbrev-ref HEAD', 'phase3-4');
    mockState.responses.set(
      'rev-parse --abbrev-ref --symbolic-full-name @{upstream}',
      'origin/feature-parent',
    );
    const result = resolveBaseBranch('/repo', { baseBranch: 'develop' });
    expect(result).toBe('develop');
  });
});

describe('isMergeBaseFresh — v4.5.12 age sanity gate', () => {
  let isMergeBaseFresh;

  beforeEach(async () => {
    ({ isMergeBaseFresh } = await import('../../lib/git/resolve-base.js'));
  });

  it('returns true when mergeBase is recent (within maxAgeDays)', () => {
    const now = Math.floor(Date.now() / 1000);
    const fiveDaysAgo = now - 5 * 86400;
    mockState.responses.set(`log -1 --format=%ct abc123`, String(fiveDaysAgo));
    mockState.responses.set(`log -1 --format=%ct HEAD`, String(now));
    expect(isMergeBaseFresh('abc123', '/repo', 30)).toBe(true);
  });

  it('returns false when mergeBase is older than maxAgeDays (default 30)', () => {
    const now = Math.floor(Date.now() / 1000);
    const sixtyDaysAgo = now - 60 * 86400;
    mockState.responses.set(`log -1 --format=%ct ancientSha`, String(sixtyDaysAgo));
    mockState.responses.set(`log -1 --format=%ct HEAD`, String(now));
    expect(isMergeBaseFresh('ancientSha', '/repo')).toBe(false);
  });

  it('respects a custom maxAgeDays', () => {
    const now = Math.floor(Date.now() / 1000);
    const tenDaysAgo = now - 10 * 86400;
    mockState.responses.set(`log -1 --format=%ct shaX`, String(tenDaysAgo));
    mockState.responses.set(`log -1 --format=%ct HEAD`, String(now));
    expect(isMergeBaseFresh('shaX', '/repo', 7)).toBe(false);
    expect(isMergeBaseFresh('shaX', '/repo', 14)).toBe(true);
  });

  it('returns false for invalid inputs (null, empty, non-string)', () => {
    expect(isMergeBaseFresh(null, '/repo')).toBe(false);
    expect(isMergeBaseFresh('', '/repo')).toBe(false);
    expect(isMergeBaseFresh(undefined, '/repo')).toBe(false);
    expect(isMergeBaseFresh(42, '/repo')).toBe(false);
  });

  it('returns false when maxAgeDays is invalid (zero / negative / NaN)', () => {
    const now = Math.floor(Date.now() / 1000);
    mockState.responses.set(`log -1 --format=%ct sha`, String(now - 86400));
    mockState.responses.set(`log -1 --format=%ct HEAD`, String(now));
    expect(isMergeBaseFresh('sha', '/repo', 0)).toBe(false);
    expect(isMergeBaseFresh('sha', '/repo', -5)).toBe(false);
    expect(isMergeBaseFresh('sha', '/repo', NaN)).toBe(false);
  });

  it('returns false when git log fails for the mergeBase (commit missing)', () => {
    mockState.responses.set(
      `log -1 --format=%ct missingSha`,
      new Error('unknown revision'),
    );
    mockState.responses.set(
      `log -1 --format=%ct HEAD`,
      String(Math.floor(Date.now() / 1000)),
    );
    expect(isMergeBaseFresh('missingSha', '/repo', 30)).toBe(false);
  });

  it('returns false when timestamp is malformed (non-numeric)', () => {
    mockState.responses.set(`log -1 --format=%ct sha`, 'not-a-number');
    mockState.responses.set(
      `log -1 --format=%ct HEAD`,
      String(Math.floor(Date.now() / 1000)),
    );
    expect(isMergeBaseFresh('sha', '/repo', 30)).toBe(false);
  });
});
