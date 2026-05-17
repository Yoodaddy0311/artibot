/**
 * Unit tests for lib/autopilot/rollback.js
 *
 * Covers:
 *   - worktree guard (no toplevel → refuse)
 *   - no checkpoints → reason='no-green-checkpoint'
 *   - no green status → refuse
 *   - multi-green pick LATEST (highest checkpoint index)
 *   - unsafe SHA filtered out
 *   - dryRun → returns target without invoking reset
 *   - real reset invokes `git reset --hard <sha>` once
 *   - git failure propagates as reason
 *   - listRollbackTargets returns latest-first
 *   - listRollbackTargets empty on missing session
 *   - listRollbackTargets handles state DI
 *   - invalid sessionId rejected
 *   - state DI bypasses disk
 *   - reset is run in worktreeRoot, not opts.cwd
 *   - mixed pass/fail statuses filtered correctly
 *   - malformed checkpoints skipped safely
 *   - isSafeSha rejects option-injection
 */
import { describe, expect, it, vi } from 'vitest';
import { isSafeSha, listRollbackTargets, rollbackToLastGreen } from '../../lib/autopilot/rollback.js';

function makeGitRunner({ topLevel = '/repo/worktree', failResetWith = null } = {}) {
  return vi.fn((args) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      if (topLevel === null) {
        const err = new Error('not a git repo');
        throw err;
      }
      return `${topLevel}\n`;
    }
    if (args[0] === 'reset' && args[1] === '--hard') {
      if (failResetWith) throw new Error(failResetWith);
      return '';
    }
    return '';
  });
}

function stateWith(checkpoints) {
  return { sessionId: 'ap-test-rb', schemaVersion: 2, checkpoints };
}

describe('isSafeSha', () => {
  it('accepts standard hex sha', () => {
    expect(isSafeSha('abc123def456')).toBe(true);
  });
  it('rejects leading dash (option-injection)', () => {
    expect(isSafeSha('--upload-pack=evil')).toBe(false);
  });
  it('rejects empty / non-string', () => {
    expect(isSafeSha('')).toBe(false);
    expect(isSafeSha(null)).toBe(false);
    expect(isSafeSha(42)).toBe(false);
  });
  it('rejects path traversal', () => {
    expect(isSafeSha('../etc/passwd')).toBe(false);
  });
});

describe('rollbackToLastGreen — guards', () => {
  it('returns invalid-session-id on empty sessionId', () => {
    const out = rollbackToLastGreen('');
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('invalid-session-id');
  });

  it('refuses to operate outside a git worktree', () => {
    const gitRunner = makeGitRunner({ topLevel: null });
    const out = rollbackToLastGreen('ap-x', {
      gitRunner,
      state: stateWith([{ phase: 'EXECUTE', sha: 'aaaa', status: 'passed' }]),
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('not-in-worktree');
  });

  it('returns no-green-checkpoint when no checkpoints exist', () => {
    const gitRunner = makeGitRunner();
    const out = rollbackToLastGreen('ap-x', { gitRunner, state: stateWith([]) });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('no-green-checkpoint');
    expect(out.worktreeRoot).toBe('/repo/worktree');
  });

  it('returns no-green-checkpoint when all checkpoints are failed', () => {
    const gitRunner = makeGitRunner();
    const out = rollbackToLastGreen('ap-x', {
      gitRunner,
      state: stateWith([
        { phase: 'EXECUTE', sha: 'aaaa', status: 'failed' },
        { phase: 'VERIFY', sha: 'bbbb', status: 'failed' },
      ]),
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('no-green-checkpoint');
  });
});

describe('rollbackToLastGreen — selection', () => {
  it('picks the LATEST green checkpoint when multiple exist', () => {
    const gitRunner = makeGitRunner();
    const out = rollbackToLastGreen('ap-x', {
      gitRunner,
      state: stateWith([
        { phase: 'EXECUTE', sha: 'aaaa1', status: 'passed', ts: 't1' },
        { phase: 'VERIFY', sha: 'bbbb2', status: 'failed' },
        { phase: 'IMPROVE', sha: 'cccc3', status: 'passed', ts: 't3' },
      ]),
    });
    expect(out.ok).toBe(true);
    expect(out.target.sha).toBe('cccc3');
    expect(out.target.phase).toBe('IMPROVE');
    expect(out.target.ts).toBe('t3');
  });

  it('skips checkpoints with unsafe SHAs', () => {
    const gitRunner = makeGitRunner();
    const out = rollbackToLastGreen('ap-x', {
      gitRunner,
      state: stateWith([
        { phase: 'EXECUTE', sha: 'aaaa1', status: 'passed' },
        { phase: 'VERIFY', sha: '--evil', status: 'passed' },
      ]),
    });
    expect(out.ok).toBe(true);
    expect(out.target.sha).toBe('aaaa1');
  });

  it('skips malformed checkpoints safely', () => {
    const gitRunner = makeGitRunner();
    const out = rollbackToLastGreen('ap-x', {
      gitRunner,
      state: stateWith([
        null,
        { phase: 'EXECUTE', status: 'passed' },
        { phase: 'VERIFY', sha: 'goodsha', status: 'passed' },
      ]),
    });
    expect(out.ok).toBe(true);
    expect(out.target.sha).toBe('goodsha');
  });
});

describe('rollbackToLastGreen — execution', () => {
  it('invokes git reset --hard <sha> in worktreeRoot', () => {
    const gitRunner = makeGitRunner({ topLevel: '/repo/worktree-A' });
    const out = rollbackToLastGreen('ap-x', {
      gitRunner,
      cwd: '/repo/worktree-A/subdir',
      state: stateWith([{ phase: 'EXECUTE', sha: 'aaaa1', status: 'passed' }]),
    });
    expect(out.ok).toBe(true);
    const resetCall = gitRunner.mock.calls.find((c) => c[0][0] === 'reset');
    expect(resetCall).toBeDefined();
    expect(resetCall[0]).toEqual(['reset', '--hard', 'aaaa1']);
    expect(resetCall[1]).toBe('/repo/worktree-A');
  });

  it('dryRun returns target without invoking reset', () => {
    const gitRunner = makeGitRunner();
    const out = rollbackToLastGreen('ap-x', {
      gitRunner,
      dryRun: true,
      state: stateWith([{ phase: 'EXECUTE', sha: 'aaaa1', status: 'passed' }]),
    });
    expect(out.ok).toBe(true);
    expect(out.dryRun).toBe(true);
    const resetCalled = gitRunner.mock.calls.some((c) => c[0][0] === 'reset');
    expect(resetCalled).toBe(false);
  });

  it('propagates git reset failure as reason', () => {
    const gitRunner = makeGitRunner({ failResetWith: 'fatal: bad object' });
    const out = rollbackToLastGreen('ap-x', {
      gitRunner,
      state: stateWith([{ phase: 'EXECUTE', sha: 'aaaa1', status: 'passed' }]),
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/git-reset-failed/);
  });
});

describe('listRollbackTargets', () => {
  it('returns greens latest-first', () => {
    const out = listRollbackTargets('ap-x', {
      state: stateWith([
        { phase: 'A', sha: 'a1', status: 'passed' },
        { phase: 'B', sha: 'b1', status: 'failed' },
        { phase: 'C', sha: 'c1', status: 'passed' },
      ]),
    });
    expect(out.map((r) => r.sha)).toEqual(['c1', 'a1']);
  });

  it('returns [] for empty sessionId', () => {
    expect(listRollbackTargets('')).toEqual([]);
  });

  it('returns [] when state has no checkpoints', () => {
    expect(listRollbackTargets('ap-x', { state: stateWith([]) })).toEqual([]);
  });
});
