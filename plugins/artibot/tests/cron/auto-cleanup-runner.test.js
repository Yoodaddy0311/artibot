/**
 * Tests for scripts/cron/auto-cleanup-runner.
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

function makeDeps(overrides = {}) {
  return {
    cwd: '/repo',
    config: makeConfig(),
    env: { ARTIBOT_SELF_CONTROL: '1' },
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// checkGates
// ---------------------------------------------------------------------------

describe('cleanup checkGates', () => {
  it('rejects master-disabled', () => {
    expect(checkGates(makeConfig({ masterEnabled: false }), { ARTIBOT_SELF_CONTROL: '1' }).allowed)
      .toBe(false);
  });

  it('rejects individual disable', () => {
    expect(checkGates(makeConfig({ enabled: false }), { ARTIBOT_SELF_CONTROL: '1' }).allowed)
      .toBe(false);
  });

  it('rejects missing env', () => {
    expect(checkGates(makeConfig(), {}).allowed).toBe(false);
  });

  it('allows triple-gate pass', () => {
    expect(checkGates(makeConfig(), { ARTIBOT_SELF_CONTROL: '1' }).allowed).toBe(true);
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
// runAutoCleanup
// ---------------------------------------------------------------------------

describe('runAutoCleanup gates', () => {
  it('no-ops when master disabled — no snapshot, no runner', async () => {
    const deps = makeDeps({ config: makeConfig({ masterEnabled: false }) });
    const r = await runAutoCleanup(deps);
    expect(r.ran).toBe(false);
    expect(deps.guard.snapshot).not.toHaveBeenCalled();
    expect(deps.runner).not.toHaveBeenCalled();
  });

  it('no-ops when env not set', async () => {
    const deps = makeDeps({ env: {} });
    const r = await runAutoCleanup(deps);
    expect(r.ran).toBe(false);
    expect(deps.runner).not.toHaveBeenCalled();
  });

  it('no-ops with no configured tools', async () => {
    const deps = makeDeps({ config: makeConfig({ tools: [] }) });
    const r = await runAutoCleanup(deps);
    expect(r.ran).toBe(false);
    expect(r.reason).toContain('no tools');
  });
});

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
});
