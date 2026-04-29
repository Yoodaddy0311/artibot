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
