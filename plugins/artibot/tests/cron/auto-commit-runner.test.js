/**
 * Tests for scripts/cron/auto-commit-runner.
 *
 * All git/validation ops are injected via the `deps` bag. No real git
 * commands are ever executed.
 */
import { describe, expect, it, vi } from 'vitest';

import { checkGates, runAutoCommit } from '../../scripts/cron/auto-commit-runner.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig({
  masterEnabled = true,
  acEnabled = true,
  maxRiskLevel = 'low',
  requiredTestsPass = true,
  requiredLintClean = true,
  rollbackOnRegression = true,
} = {}) {
  return {
    ago: {
      selfControl: {
        masterEnabled,
        autoCommit: {
          enabled: acEnabled,
          maxRiskLevel,
          requiredTestsPass,
          requiredLintClean,
          rollbackOnRegression,
        },
      },
    },
  };
}

function makeDeps(overrides = {}) {
  const gitOps = {
    collectDiff: vi.fn(async () => ({
      files: [{ path: 'README.md', status: 'M', additions: 1, deletions: 0 }],
    })),
    runGit: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
  };
  const guard = {
    snapshot: vi.fn(async () => ({ sha: 'deadbeef', sessionId: 'test', timestamp: 'now' })),
    runValidation: vi.fn(async () => ({
      passed: true,
      tests: { passed: true, code: 0 },
      lint: { passed: true, code: 0 },
    })),
    validateAgainstBaseline: vi.fn(async () => ({
      passed: true, regressions: [], current: {}, baseline: {},
    })),
    rollback: vi.fn(async () => ({ reverted: true, sha: 'deadbeef' })),
  };
  const trail = vi.fn(async () => ({ id: 'x', timestamp: 'now' }));
  return {
    cwd: '/repo',
    config: makeConfig(),
    env: { ARTIBOT_SELF_CONTROL: '1' },
    logger: { log: vi.fn() },
    gitOps,
    guard,
    trail,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// checkGates
// ---------------------------------------------------------------------------

describe('checkGates', () => {
  it('rejects when masterEnabled is false', () => {
    const r = checkGates(makeConfig({ masterEnabled: false }), { ARTIBOT_SELF_CONTROL: '1' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('masterEnabled');
  });

  it('rejects when autoCommit.enabled is false', () => {
    const r = checkGates(makeConfig({ acEnabled: false }), { ARTIBOT_SELF_CONTROL: '1' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('autoCommit.enabled');
  });

  it('rejects when env var is missing', () => {
    const r = checkGates(makeConfig(), {});
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('ARTIBOT_SELF_CONTROL');
  });

  it('allows only when all three gates pass', () => {
    const r = checkGates(makeConfig(), { ARTIBOT_SELF_CONTROL: '1' });
    expect(r.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runAutoCommit — gate enforcement
// ---------------------------------------------------------------------------

describe('runAutoCommit gates', () => {
  it('returns early when masterEnabled=false — no git ops', async () => {
    const deps = makeDeps({ config: makeConfig({ masterEnabled: false }) });
    const r = await runAutoCommit(deps);
    expect(r.ran).toBe(false);
    expect(deps.gitOps.collectDiff).not.toHaveBeenCalled();
    expect(deps.gitOps.runGit).not.toHaveBeenCalled();
    expect(deps.guard.snapshot).not.toHaveBeenCalled();
  });

  it('returns early when env not set — no git ops', async () => {
    const deps = makeDeps({ env: {} });
    const r = await runAutoCommit(deps);
    expect(r.ran).toBe(false);
    expect(deps.gitOps.collectDiff).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runAutoCommit — risk classification
// ---------------------------------------------------------------------------

describe('runAutoCommit risk ceiling', () => {
  it('refuses critical changes', async () => {
    const deps = makeDeps({
      gitOps: {
        collectDiff: vi.fn(async () => ({
          files: [{ path: 'package.json', status: 'M', additions: 1, deletions: 1 }],
        })),
        runGit: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
      },
    });
    const r = await runAutoCommit(deps);
    expect(r.ran).toBe(false);
    expect(r.reason).toBe('risk ceiling');
    expect(r.classification.level).toBe('critical');
    expect(deps.guard.snapshot).not.toHaveBeenCalled();
    // trail should record the refusal
    expect(deps.trail).toHaveBeenCalledWith(
      expect.objectContaining({ subsystem: 'auto-commit', action: 'refused' }),
    );
  });

  it('refuses medium changes when ceiling is low', async () => {
    const deps = makeDeps({
      gitOps: {
        collectDiff: vi.fn(async () => ({
          files: [{ path: 'lib/core/config.js', status: 'M', additions: 5, deletions: 3 }],
        })),
        runGit: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
      },
    });
    const r = await runAutoCommit(deps);
    expect(r.ran).toBe(false);
    expect(r.reason).toBe('risk ceiling');
  });

  it('refuses when diff has no files', async () => {
    const deps = makeDeps({
      gitOps: {
        collectDiff: vi.fn(async () => ({ files: [] })),
        runGit: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
      },
    });
    const r = await runAutoCommit(deps);
    expect(r.ran).toBe(false);
    expect(r.reason).toBe('no changes');
  });
});

// ---------------------------------------------------------------------------
// runAutoCommit — happy path + rollback
// ---------------------------------------------------------------------------

describe('runAutoCommit full flow', () => {
  it('commits low-risk diff when all gates pass', async () => {
    const deps = makeDeps();
    const r = await runAutoCommit(deps);
    expect(r.ran).toBe(true);
    expect(r.committed).toBe(true);
    expect(r.rolledBack).toBe(false);
    // verify argv never contains push
    for (const call of deps.gitOps.runGit.mock.calls) {
      expect(call[0]).not.toContain('push');
    }
  });

  it('rolls back when post-commit validation regresses', async () => {
    const deps = makeDeps();
    deps.guard.validateAgainstBaseline = vi.fn(async () => ({
      passed: false,
      regressions: ['tests'],
      current: {},
      baseline: {},
    }));
    const r = await runAutoCommit(deps);
    expect(r.ran).toBe(true);
    expect(r.rolledBack).toBe(true);
    expect(deps.guard.rollback).toHaveBeenCalled();
    expect(deps.trail).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'rolled-back' }),
    );
  });

  it('dry-run never invokes git add or commit', async () => {
    const deps = makeDeps({ dryRun: true });
    const r = await runAutoCommit(deps);
    expect(r.ran).toBe(false);
    expect(r.reason).toBe('dry-run');
    // Only collectDiff should have been called on gitOps, no writes.
    expect(deps.gitOps.runGit).not.toHaveBeenCalled();
  });

  it('refuses when baseline tests are already failing', async () => {
    const deps = makeDeps();
    deps.guard.runValidation = vi.fn(async () => ({
      passed: false,
      tests: { passed: false, code: 1 },
      lint: { passed: true, code: 0 },
    }));
    const r = await runAutoCommit(deps);
    expect(r.ran).toBe(false);
    expect(r.reason).toContain('baseline tests');
  });
});
