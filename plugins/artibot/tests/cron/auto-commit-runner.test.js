/**
 * Tests for scripts/cron/auto-commit-runner.
 *
 * Covers the new default-ON gate model:
 *   - Explicit opt-out (masterEnabled/autoCommit.enabled = false)
 *   - Kill switch
 *   - First-run observe-only guard
 *   - Critical blocker (risk ceiling)
 *   - Failure -> kill-switch recordFailure wiring
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

function makeKillSwitch({ tripped = false } = {}) {
  return {
    isKillSwitchTripped: vi.fn(async () => tripped),
    recordFailure: vi.fn(async () => undefined),
  };
}

function makeFirstRunGuard({ observe = false, mode = 'active' } = {}) {
  return {
    shouldObserveOnly: vi.fn(async () => ({ shouldObserve: observe, mode })),
    bumpRunCounter: vi.fn(async () => undefined),
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
    env: {}, // env no longer consulted; kept for signature compat.
    logger: { log: vi.fn() },
    gitOps,
    guard,
    trail,
    killSwitch: makeKillSwitch(),
    firstRunGuard: makeFirstRunGuard(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// checkGates — default-ON semantics
// ---------------------------------------------------------------------------

describe('checkGates (default-ON)', () => {
  it('rejects when masterEnabled is explicitly false', () => {
    const r = checkGates(makeConfig({ masterEnabled: false }), {});
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('masterEnabled');
  });

  it('rejects when autoCommit.enabled is explicitly false', () => {
    const r = checkGates(makeConfig({ acEnabled: false }), {});
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('autoCommit.enabled');
  });

  it('allows when config is empty (default ON)', () => {
    expect(checkGates({}, {}).allowed).toBe(true);
  });

  it('allows when selfControl is missing entirely', () => {
    expect(checkGates({ ago: {} }, {}).allowed).toBe(true);
  });

  it('allows regardless of env vars (env gate deprecated)', () => {
    // Previously required ARTIBOT_SELF_CONTROL=1 — now ignored.
    expect(checkGates(makeConfig(), {}).allowed).toBe(true);
    expect(checkGates(makeConfig(), { ARTIBOT_SELF_CONTROL: '0' }).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runAutoCommit — gate enforcement
// ---------------------------------------------------------------------------

describe('runAutoCommit gates', () => {
  it('returns early when masterEnabled=false — no git ops, no kill-switch query', async () => {
    const deps = makeDeps({ config: makeConfig({ masterEnabled: false }) });
    const r = await runAutoCommit(deps);
    expect(r.ran).toBe(false);
    expect(r.reason).toContain('masterEnabled');
    expect(deps.gitOps.collectDiff).not.toHaveBeenCalled();
    expect(deps.gitOps.runGit).not.toHaveBeenCalled();
    expect(deps.guard.snapshot).not.toHaveBeenCalled();
  });

  it('runs when env var is unset (env gate deprecated)', async () => {
    const deps = makeDeps({ env: {} });
    const r = await runAutoCommit(deps);
    expect(r.ran).toBe(true);
    expect(r.committed).toBe(true);
  });

  it('halts when kill switch is tripped', async () => {
    const deps = makeDeps({ killSwitch: makeKillSwitch({ tripped: true }) });
    const r = await runAutoCommit(deps);
    expect(r.ran).toBe(false);
    expect(r.reason).toContain('kill-switch');
    expect(deps.gitOps.collectDiff).not.toHaveBeenCalled();
    expect(deps.trail).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'refused', reason: expect.stringContaining('kill-switch') }),
    );
  });
});

// ---------------------------------------------------------------------------
// First-run guard
// ---------------------------------------------------------------------------

describe('runAutoCommit first-run guard', () => {
  it('logs would-commit and skips write ops when in observe mode', async () => {
    const deps = makeDeps({ firstRunGuard: makeFirstRunGuard({ observe: true }) });
    const r = await runAutoCommit(deps);
    expect(r.ran).toBe(false);
    expect(r.observe).toBe(true);
    expect(r.reason).toBe('first-run-observe-mode');
    // No commit / snapshot / validation performed.
    expect(deps.guard.snapshot).not.toHaveBeenCalled();
    expect(deps.guard.runValidation).not.toHaveBeenCalled();
    expect(deps.gitOps.runGit).not.toHaveBeenCalled();
    // Trail records intent.
    expect(deps.trail).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'would-commit' }),
    );
    // Counter was bumped.
    expect(deps.firstRunGuard.bumpRunCounter).toHaveBeenCalledWith('autoCommit', expect.any(Object));
  });

  it('passes through when guard says active', async () => {
    const deps = makeDeps();
    const r = await runAutoCommit(deps);
    expect(r.ran).toBe(true);
    expect(r.committed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Risk classification — critical blocker always on
// ---------------------------------------------------------------------------

describe('runAutoCommit risk ceiling', () => {
  it('refuses critical changes (package.json)', async () => {
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
// Full flow + rollback + kill-switch failure wiring
// ---------------------------------------------------------------------------

describe('runAutoCommit full flow', () => {
  it('commits low-risk diff when all gates pass', async () => {
    const deps = makeDeps();
    const r = await runAutoCommit(deps);
    expect(r.ran).toBe(true);
    expect(r.committed).toBe(true);
    expect(r.rolledBack).toBe(false);
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

  it('reports critical failure to kill-switch on rollback-failure', async () => {
    const deps = makeDeps();
    deps.guard.validateAgainstBaseline = vi.fn(async () => ({
      passed: false,
      regressions: ['tests'],
      current: {},
      baseline: {},
    }));
    deps.guard.rollback = vi.fn(async () => { throw new Error('rollback-disk-full'); });
    await expect(runAutoCommit(deps)).rejects.toThrow(/rollback-disk-full/);
    expect(deps.killSwitch.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'autoCommit',
        error: expect.stringContaining('rollback-failed'),
      }),
      expect.any(Object),
    );
  });

  it('reports failure to kill-switch when snapshot throws', async () => {
    const deps = makeDeps();
    deps.guard.snapshot = vi.fn(async () => { throw new Error('git-index-corrupt'); });
    await expect(runAutoCommit(deps)).rejects.toThrow(/git-index-corrupt/);
    expect(deps.killSwitch.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'autoCommit' }),
      expect.any(Object),
    );
  });
});
