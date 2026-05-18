/**
 * Unit tests for lib/autopilot/preflight.js
 *
 * Coverage:
 *   - Each individual check: pass / warn / fail branches.
 *   - runPreflight aggregation: all-ok, errors-only, warnings-only.
 *   - DI: gitRunner / statfs / lockChecker / telemetry / nodeVersion.
 *   - Hermetic: zero real git / disk / lock / telemetry I/O.
 */

import { describe, expect, it, vi } from 'vitest';
import { runIndividualCheck, runPreflight } from '../../lib/autopilot/preflight.js';

const baseCtx = () => ({
  cwd: '/tmp/some/path',
  featureKey: 'autopilot:test',
  sessionId: undefined, // telemetry skipped when undefined
});

describe('runIndividualCheck — gitClean', () => {
  it('returns pass when git status is empty', () => {
    const gitRunner = vi.fn(() => '');
    const r = runIndividualCheck('gitClean', baseCtx(), { gitRunner });
    expect(r).toEqual({ name: 'gitClean', status: 'pass' });
    expect(gitRunner).toHaveBeenCalledWith(['status', '--porcelain'], '/tmp/some/path');
  });

  it('returns warn when working tree is dirty', () => {
    const gitRunner = vi.fn(() => ' M file1\n?? file2\n');
    const r = runIndividualCheck('gitClean', baseCtx(), { gitRunner });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('2 dirty');
  });

  it('returns warn when git runner throws', () => {
    const gitRunner = vi.fn(() => { throw new Error('not a git repo'); });
    const r = runIndividualCheck('gitClean', baseCtx(), { gitRunner });
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/not a git repo/);
  });
});

describe('runIndividualCheck — lockFree', () => {
  it('returns pass when lock is free', () => {
    const lockChecker = vi.fn(() => ({ locked: false }));
    const r = runIndividualCheck('lockFree', baseCtx(), { lockChecker });
    expect(r).toEqual({ name: 'lockFree', status: 'pass' });
    expect(lockChecker).toHaveBeenCalledWith('autopilot:test');
  });

  it('returns warn when lock exists but is stale', () => {
    const lockChecker = vi.fn(() => ({ locked: false, stale: true, holder: { pid: 999 } }));
    // locked:false → pass actually. To exercise stale-warn branch, locked:true + stale:true.
    const lockChecker2 = vi.fn(() => ({ locked: true, stale: true, holder: { pid: 999 } }));
    const r = runIndividualCheck('lockFree', baseCtx(), { lockChecker: lockChecker2 });
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/stale/);
    // First lockChecker should have produced a pass if executed
    expect(lockChecker).not.toHaveBeenCalled();
  });

  it('returns fail when lock is actively held by a live process', () => {
    const lockChecker = vi.fn(() => ({ locked: true, stale: false, holder: { pid: 12345 } }));
    const r = runIndividualCheck('lockFree', baseCtx(), { lockChecker });
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/12345/);
  });

  it('returns warn when lock probe throws', () => {
    const lockChecker = vi.fn(() => { throw new Error('lock probe boom'); });
    const r = runIndividualCheck('lockFree', baseCtx(), { lockChecker });
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/lock probe boom/);
  });
});

describe('runIndividualCheck — diskSpace', () => {
  it('returns pass when free space > 2GB', () => {
    const statfs = vi.fn(() => 5 * 1024 * 1024 * 1024);
    const r = runIndividualCheck('diskSpace', baseCtx(), { statfs });
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/GB free/);
  });

  it('returns warn when free space < 2GB but >= 500MB', () => {
    const statfs = vi.fn(() => 1 * 1024 * 1024 * 1024); // 1 GB
    const r = runIndividualCheck('diskSpace', baseCtx(), { statfs });
    expect(r.status).toBe('warn');
  });

  it('returns fail when free space < 500MB', () => {
    const statfs = vi.fn(() => 100 * 1024 * 1024); // 100 MB
    const r = runIndividualCheck('diskSpace', baseCtx(), { statfs });
    expect(r.status).toBe('fail');
  });

  it('silent skips (warn=disk-check-unavailable) when statfs throws', () => {
    const statfs = vi.fn(() => { throw new Error('statfs ENOSYS'); });
    const r = runIndividualCheck('diskSpace', baseCtx(), { statfs });
    expect(r.status).toBe('warn');
    expect(r.detail).toBe('disk-check-unavailable');
  });
});

describe('runIndividualCheck — nodeVersion', () => {
  it('returns pass on node >= 20', () => {
    const r = runIndividualCheck('nodeVersion', baseCtx(), { nodeVersion: '22.4.0' });
    expect(r.status).toBe('pass');
  });

  it('returns warn on node 18.x', () => {
    const r = runIndividualCheck('nodeVersion', baseCtx(), { nodeVersion: '18.19.0' });
    expect(r.status).toBe('warn');
  });

  it('returns fail on node < 18', () => {
    const r = runIndividualCheck('nodeVersion', baseCtx(), { nodeVersion: '16.20.0' });
    expect(r.status).toBe('fail');
  });
});

describe('runIndividualCheck — goalContractLint', () => {
  it('returns pass when contract is absent (legacy mode)', () => {
    const r = runIndividualCheck('goalContractLint', baseCtx(), {});
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/no contract/);
  });

  it('returns fail when objective is missing', () => {
    const ctx = { ...baseCtx(), goalContract: { stoppingCondition: 'tests green' } };
    const r = runIndividualCheck('goalContractLint', ctx, {});
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/objective/);
  });

  it('returns fail when stoppingCondition is missing', () => {
    const ctx = { ...baseCtx(), goalContract: { objective: 'do thing' } };
    const r = runIndividualCheck('goalContractLint', ctx, {});
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/stoppingCondition/);
  });

  it('returns warn when validationCommand is missing', () => {
    const ctx = {
      ...baseCtx(),
      goalContract: { objective: 'do thing', stoppingCondition: 'tests green' },
    };
    const r = runIndividualCheck('goalContractLint', ctx, {});
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/validationCommand/);
  });

  it('returns pass when all required fields present', () => {
    const ctx = {
      ...baseCtx(),
      goalContract: {
        objective: 'do thing',
        stoppingCondition: 'tests green',
        validationCommand: 'npm test',
      },
    };
    const r = runIndividualCheck('goalContractLint', ctx, {});
    expect(r.status).toBe('pass');
  });
});

describe('runIndividualCheck — unknown check', () => {
  it('returns warn for unrecognized check names', () => {
    const r = runIndividualCheck('nonExistentCheck', baseCtx(), {});
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/unknown/);
  });
});

describe('runPreflight — aggregation', () => {
  it('returns ok=true when every check passes', () => {
    const deps = {
      gitRunner: () => '',
      lockChecker: () => ({ locked: false }),
      statfs: () => 10 * 1024 * 1024 * 1024,
      nodeVersion: '22.0.0',
    };
    const ctx = {
      ...baseCtx(),
      goalContract: {
        objective: 'x', stoppingCondition: 'y', validationCommand: 'z',
      },
    };
    const r = runPreflight(ctx, deps);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.checks).toHaveLength(5);
    expect(r.checks.every((c) => c.status === 'pass')).toBe(true);
  });

  it('returns ok=false when any hard fail occurs', () => {
    const deps = {
      gitRunner: () => '',
      lockChecker: () => ({ locked: true, stale: false, holder: { pid: 1 } }),
      statfs: () => 10 * 1024 * 1024 * 1024,
      nodeVersion: '22.0.0',
    };
    const r = runPreflight(baseCtx(), deps);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.find((e) => e.check === 'lockFree')).toBeTruthy();
  });

  it('returns ok=true when only warnings exist', () => {
    const deps = {
      gitRunner: () => ' M dirty.js\n',
      lockChecker: () => ({ locked: false }),
      statfs: () => 10 * 1024 * 1024 * 1024,
      nodeVersion: '22.0.0',
    };
    const r = runPreflight(baseCtx(), deps);
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings.find((w) => w.check === 'gitClean')).toBeTruthy();
  });

  it('passes cwd through to gitRunner without injecting extra args', () => {
    const gitRunner = vi.fn(() => '');
    const ctx = { ...baseCtx(), cwd: '/some/korean/path' };
    runPreflight(ctx, {
      gitRunner,
      lockChecker: () => ({ locked: false }),
      statfs: () => 10 * 1024 * 1024 * 1024,
      nodeVersion: '22.0.0',
    });
    expect(gitRunner).toHaveBeenCalledExactlyOnceWith(['status', '--porcelain'], '/some/korean/path');
  });

  it('emits telemetry when sessionId is present', () => {
    const telemetry = vi.fn();
    const ctx = { ...baseCtx(), sessionId: 'sess-123' };
    runPreflight(ctx, {
      gitRunner: () => '',
      lockChecker: () => ({ locked: false }),
      statfs: () => 10 * 1024 * 1024 * 1024,
      nodeVersion: '22.0.0',
      telemetry,
    });
    expect(telemetry).toHaveBeenCalledTimes(1);
    const [sid, payload] = telemetry.mock.calls[0];
    expect(sid).toBe('sess-123');
    expect(payload.phase).toBe('PREFLIGHT');
    expect(payload.type).toBe('preflight');
  });

  it('does not emit telemetry when sessionId is missing', () => {
    const telemetry = vi.fn();
    runPreflight(baseCtx(), {
      gitRunner: () => '',
      lockChecker: () => ({ locked: false }),
      statfs: () => 10 * 1024 * 1024 * 1024,
      nodeVersion: '22.0.0',
      telemetry,
    });
    expect(telemetry).not.toHaveBeenCalled();
  });

  it('survives telemetry failures silently', () => {
    const telemetry = vi.fn(() => { throw new Error('disk full'); });
    const ctx = { ...baseCtx(), sessionId: 'sess-999' };
    expect(() => runPreflight(ctx, {
      gitRunner: () => '',
      lockChecker: () => ({ locked: false }),
      statfs: () => 10 * 1024 * 1024 * 1024,
      nodeVersion: '22.0.0',
      telemetry,
    })).not.toThrow();
  });

  it('tolerates entirely missing ctx / deps', () => {
    // ctx undefined → safeCtx empty → every default-dep tries to run real I/O.
    // We must supply at least overrides that avoid disk/git calls.
    const deps = {
      gitRunner: () => '',
      lockChecker: () => ({ locked: false }),
      statfs: () => 10 * 1024 * 1024 * 1024,
      nodeVersion: '22.0.0',
    };
    const r = runPreflight(undefined, deps);
    expect(r).toBeDefined();
    expect(Array.isArray(r.checks)).toBe(true);
    expect(r.checks).toHaveLength(5);
  });
});
