/**
 * Tests for scripts/cron/auto-cleanup-runner.
 *
 * Covers the new default-ON gate model:
 *   - Explicit opt-out
 *   - Kill switch
 *   - First-run observe-only (always rollback, log would-cleanup)
 *   - Critical blocker (non-low classification => rollback)
 *   - Failure -> kill-switch recordFailure wiring
 *
 * All tool/git ops injected via the `deps` bag. No real processes spawn.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  checkGates,
  resolveTools,
  runAutoCleanup,
} from '../../scripts/cron/auto-cleanup-runner.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig({
  masterEnabled = true,
  enabled = true,
  tools = ['eslint-fix'],
  maxFilesPerRun = 20,
} = {}) {
  return {
    ago: {
      selfControl: {
        masterEnabled,
        autoCleanup: { enabled, tools, maxFilesPerRun },
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
  return {
    cwd: '/repo',
    config: makeConfig(),
    env: {}, // env no longer consulted; kept for signature compat.
    logger: { log: vi.fn() },
    runner: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    gitOps: {
      collectDiff: vi.fn(async () => ({
        files: [{ path: 'README.md', status: 'M', additions: 1, deletions: 0 }],
      })),
    },
    guard: {
      snapshot: vi.fn(async () => ({ sha: 'beef1234', sessionId: 'test', timestamp: 'now' })),
      rollback: vi.fn(async () => ({ reverted: true, sha: 'beef1234' })),
    },
    trail: vi.fn(async () => ({ id: 'x', timestamp: 'now' })),
    killSwitch: makeKillSwitch(),
    firstRunGuard: makeFirstRunGuard(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// checkGates — default-ON semantics
// ---------------------------------------------------------------------------

describe('cleanup checkGates (default-ON)', () => {
  it('rejects master-disabled (explicit false)', () => {
    expect(checkGates(makeConfig({ masterEnabled: false }), {}).allowed).toBe(false);
  });

  it('rejects individual disable (explicit false)', () => {
    expect(checkGates(makeConfig({ enabled: false }), {}).allowed).toBe(false);
  });

  it('allows when config is empty (default ON)', () => {
    expect(checkGates({}, {}).allowed).toBe(true);
  });

  it('allows regardless of env var (env gate deprecated)', () => {
    expect(checkGates(makeConfig(), {}).allowed).toBe(true);
    expect(checkGates(makeConfig(), { ARTIBOT_SELF_CONTROL: '0' }).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveTools
// ---------------------------------------------------------------------------

describe('resolveTools', () => {
  it('resolves eslint-fix by default', () => {
    const tools = resolveTools(['eslint-fix']);
    expect(tools).toHaveLength(1);
    expect(tools[0].args).toContain('eslint');
    expect(tools[0].args).toContain('--fix');
  });

  it('filters unknown tool names', () => {
    expect(resolveTools(['bogus'])).toHaveLength(0);
  });

  it('defaults to eslint-fix if list is invalid', () => {
    const tools = resolveTools(undefined);
    expect(tools.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// runAutoCleanup — gates
// ---------------------------------------------------------------------------

describe('runAutoCleanup gates', () => {
  it('no-ops when master disabled — no snapshot, no runner', async () => {
    const deps = makeDeps({ config: makeConfig({ masterEnabled: false }) });
    const r = await runAutoCleanup(deps);
    expect(r.ran).toBe(false);
    expect(deps.guard.snapshot).not.toHaveBeenCalled();
    expect(deps.runner).not.toHaveBeenCalled();
  });

  it('runs when env var is unset (env gate deprecated)', async () => {
    const deps = makeDeps({ env: {} });
    const r = await runAutoCleanup(deps);
    expect(r.ran).toBe(true);
    expect(deps.runner).toHaveBeenCalled();
  });

  it('no-ops with no configured tools', async () => {
    const deps = makeDeps({ config: makeConfig({ tools: [] }) });
    const r = await runAutoCleanup(deps);
    expect(r.ran).toBe(false);
    expect(r.reason).toContain('no tools');
  });

  it('halts when kill switch is tripped', async () => {
    const deps = makeDeps({ killSwitch: makeKillSwitch({ tripped: true }) });
    const r = await runAutoCleanup(deps);
    expect(r.ran).toBe(false);
    expect(r.reason).toContain('kill-switch');
    expect(deps.runner).not.toHaveBeenCalled();
    expect(deps.guard.snapshot).not.toHaveBeenCalled();
    expect(deps.trail).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'refused', reason: expect.stringContaining('kill-switch') }),
    );
  });
});

// ---------------------------------------------------------------------------
// First-run observe mode
// ---------------------------------------------------------------------------

describe('runAutoCleanup first-run guard', () => {
  it('in observe mode: runs tools, rolls back, records would-cleanup', async () => {
    const deps = makeDeps({ firstRunGuard: makeFirstRunGuard({ observe: true }) });
    const r = await runAutoCleanup(deps);
    expect(r.ran).toBe(false);
    expect(r.observe).toBe(true);
    expect(r.reason).toBe('first-run-observe-mode');
    expect(deps.guard.rollback).toHaveBeenCalled();
    expect(deps.trail).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'would-cleanup' }),
    );
    expect(deps.firstRunGuard.bumpRunCounter).toHaveBeenCalledWith('autoCleanup', expect.any(Object));
  });

  it('passes through when guard says active', async () => {
    const deps = makeDeps();
    const r = await runAutoCleanup(deps);
    expect(r.ran).toBe(true);
    expect(r.rolledBack).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Full flow
// ---------------------------------------------------------------------------

describe('runAutoCleanup flow', () => {
  it('applies low-risk formatter changes and records trail', async () => {
    const deps = makeDeps();
    const r = await runAutoCleanup(deps);
    expect(r.ran).toBe(true);
    expect(r.rolledBack).toBe(false);
    expect(deps.trail).toHaveBeenCalledWith(
      expect.objectContaining({ subsystem: 'auto-cleanup', action: 'applied' }),
    );
  });

  it('rolls back when diff is not low-risk', async () => {
    const deps = makeDeps({
      gitOps: {
        collectDiff: vi.fn(async () => ({
          files: [{ path: 'package.json', status: 'M', additions: 5, deletions: 1 }],
        })),
      },
    });
    const r = await runAutoCleanup(deps);
    expect(r.rolledBack).toBe(true);
    expect(r.classification.level).toBe('critical');
    expect(deps.guard.rollback).toHaveBeenCalled();
    expect(deps.trail).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'rolled-back' }),
    );
  });

  it('respects maxFilesPerRun cap', async () => {
    const manyFiles = Array.from({ length: 30 }, (_, i) => ({
      path: `docs/file-${i}.md`,
      status: 'M',
      additions: 1,
      deletions: 0,
    }));
    const deps = makeDeps({
      config: makeConfig({ maxFilesPerRun: 5 }),
      gitOps: {
        collectDiff: vi.fn(async () => ({ files: manyFiles })),
      },
    });
    const r = await runAutoCleanup(deps);
    expect(r.changed).toBe(5);
  });

  it('reports zero changes when formatter produced nothing', async () => {
    const deps = makeDeps({
      gitOps: {
        collectDiff: vi.fn(async () => ({ files: [] })),
      },
    });
    const r = await runAutoCleanup(deps);
    expect(r.ran).toBe(true);
    expect(r.changed).toBe(0);
  });

  it('dry-run rolls back any changes it produced', async () => {
    const deps = makeDeps({ dryRun: true });
    const r = await runAutoCleanup(deps);
    expect(r.dryRun).toBe(true);
    expect(deps.guard.rollback).toHaveBeenCalled();
  });

  it('reports failure to kill-switch when snapshot throws', async () => {
    const deps = makeDeps();
    deps.guard.snapshot = vi.fn(async () => { throw new Error('git-index-corrupt'); });
    await expect(runAutoCleanup(deps)).rejects.toThrow(/git-index-corrupt/);
    expect(deps.killSwitch.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'autoCleanup' }),
      expect.any(Object),
    );
  });
});
