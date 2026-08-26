/**
 * Unit tests for lib/autopilot/preflight.js
 *
 * Coverage:
 *   - Each individual check: pass / warn / fail branches.
 *   - runPreflight aggregation: all-ok, errors-only, warnings-only.
 *   - DI: gitRunner / statfs / lockChecker / telemetry / nodeVersion /
 *     resolveRepoIdentity / listLocks / listAgents / env.
 *   - Hermetic: zero real git / disk / lock / telemetry I/O.
 *   - repoConcurrency (same repo, different task): fail / warn / pass buckets.
 *   - peerNotice: pass in every branch (the always-pass contract itself is
 *     pinned by tests/firewall/peer-notice-advisory.test.js).
 */

import { describe, expect, it, vi } from 'vitest';
import { runIndividualCheck, runPreflight } from '../../lib/autopilot/preflight.js';

/** Number of checks in ALL_CHECKS — bump deliberately, never by accident. */
const CHECK_COUNT = 7;

const baseCtx = () => ({
  cwd: '/tmp/some/path',
  featureKey: 'autopilot:test',
  sessionId: undefined, // telemetry skipped when undefined
});

/** Hermetic seams for the two repo-scoped checks. */
const repoDeps = () => ({
  resolveRepoIdentity: () => 'owner/repo',
  listLocks: () => [],
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
  // Identity unresolvable → the checker is called exactly as before scoping.
  const noRepo = { resolveRepoIdentity: () => null };

  it('returns pass when lock is free', () => {
    const lockChecker = vi.fn(() => ({ locked: false }));
    const r = runIndividualCheck('lockFree', baseCtx(), { lockChecker, ...noRepo });
    expect(r).toEqual({ name: 'lockFree', status: 'pass' });
    expect(lockChecker).toHaveBeenCalledWith('autopilot:test');
  });

  it('probes the repo-scoped key when the identity resolves (same key the engine acquires)', () => {
    const lockChecker = vi.fn(() => ({ locked: false }));
    const r = runIndividualCheck('lockFree', baseCtx(), { lockChecker, resolveRepoIdentity: () => 'owner/repo' });
    expect(r.status).toBe('pass');
    expect(lockChecker).toHaveBeenCalledExactlyOnceWith('autopilot:test', { repoIdentity: 'owner/repo' });
  });

  it('names a legacy-scheme holder found through the parallel reader', () => {
    const lockChecker = vi.fn(() => ({ locked: true, stale: false, holder: { pid: 77 }, scheme: 'legacy' }));
    const r = runIndividualCheck('lockFree', baseCtx(), { lockChecker, resolveRepoIdentity: () => 'owner/repo' });
    expect(r.status).toBe('fail');
    expect(r.detail).toBe('held by pid=77 (legacy-scheme holder)');
  });

  it('returns warn when lock exists but is stale', () => {
    const lockChecker = vi.fn(() => ({ locked: false, stale: true, holder: { pid: 999 } }));
    // locked:false → pass actually. To exercise stale-warn branch, locked:true + stale:true.
    const lockChecker2 = vi.fn(() => ({ locked: true, stale: true, holder: { pid: 999 } }));
    const r = runIndividualCheck('lockFree', baseCtx(), { lockChecker: lockChecker2, ...noRepo });
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/stale/);
    // First lockChecker should have produced a pass if executed
    expect(lockChecker).not.toHaveBeenCalled();
  });

  it('returns fail when lock is actively held by a live process', () => {
    const lockChecker = vi.fn(() => ({ locked: true, stale: false, holder: { pid: 12345 } }));
    const r = runIndividualCheck('lockFree', baseCtx(), { lockChecker, ...noRepo });
    expect(r.status).toBe('fail');
    expect(r.detail).toBe('held by pid=12345');
  });

  it('returns warn when lock probe throws', () => {
    const lockChecker = vi.fn(() => { throw new Error('lock probe boom'); });
    const r = runIndividualCheck('lockFree', baseCtx(), { lockChecker, ...noRepo });
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
      ...repoDeps(),
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
    expect(r.checks).toHaveLength(CHECK_COUNT);
    expect(r.checks.every((c) => c.status === 'pass')).toBe(true);
    // Stable order is a contract (REPORT table + telemetry): new checks go LAST.
    expect(r.checks.map((c) => c.name)).toEqual([
      'gitClean', 'lockFree', 'diskSpace', 'nodeVersion', 'goalContractLint',
      'repoConcurrency', 'peerNotice',
    ]);
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
      resolveRepoIdentity: () => null,
      listLocks: () => [],
    };
    const r = runPreflight(undefined, deps);
    expect(r).toBeDefined();
    expect(Array.isArray(r.checks)).toBe(true);
    expect(r.checks).toHaveLength(CHECK_COUNT);
  });
});

// ---------------------------------------------------------------------------
// repoConcurrency — same repository, different task (PRD F3)
// ---------------------------------------------------------------------------
const OWN = { cwd: '/repo/main', featureKey: 'task-a', sessionId: 'sess-own' };
const lockOf = (over) => ({
  lockKey: 'x',
  lockPath: '/locks/x.lock',
  stale: false,
  holder: { pid: 1, sessionId: 'sess-peer', acquiredAt: 1, featureKey: 'task-b', repoIdentity: 'owner/repo', cwd: '/repo/main', ...over },
});

describe('runIndividualCheck — repoConcurrency', () => {
  it('warns (never fails) when the repo identity cannot be resolved', () => {
    const listLocks = vi.fn(() => []);
    const r = runIndividualCheck('repoConcurrency', OWN, { resolveRepoIdentity: () => null, listLocks });
    expect(r.status).toBe('warn');
    expect(r.detail).toBe('repo-identity-unavailable');
    expect(listLocks).not.toHaveBeenCalled();
  });

  it('passes with no locks at all and names the identity', () => {
    const r = runIndividualCheck('repoConcurrency', OWN, { resolveRepoIdentity: () => 'owner/repo', listLocks: () => [] });
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('owner/repo');
  });

  it('fails on a live peer with a different task in the SAME working tree', () => {
    const r = runIndividualCheck('repoConcurrency', OWN, {
      resolveRepoIdentity: () => 'owner/repo',
      listLocks: () => [lockOf({ featureKey: 'task-b', cwd: '/repo/main' })],
    });
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('task-b');
  });

  it('fails (fail-closed) when the peer recorded no cwd', () => {
    const r = runIndividualCheck('repoConcurrency', OWN, {
      resolveRepoIdentity: () => 'owner/repo',
      listLocks: () => [lockOf({ cwd: undefined })],
    });
    expect(r.status).toBe('fail');
  });

  it('warns on a live peer in ANOTHER worktree of the same repo', () => {
    const r = runIndividualCheck('repoConcurrency', OWN, {
      resolveRepoIdentity: () => 'owner/repo',
      listLocks: () => [lockOf({ cwd: '/repo/.claude/worktrees/limb-1' })],
    });
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/other worktree/);
  });

  it('passes when the peer feature key is allowlisted (exact and prefix*)', () => {
    const deps = {
      resolveRepoIdentity: () => 'owner/repo',
      listLocks: () => [lockOf({ featureKey: 'task-b' }), lockOf({ featureKey: 'split-limb-2' })],
    };
    const ctx = { ...OWN, options: { repoConcurrency: { allow: ['task-b', 'split-*'] } } };
    const r = runIndividualCheck('repoConcurrency', ctx, deps);
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('allowlisted');
    expect(r.detail).toContain('split-limb-2');
  });

  it('still fails when only ONE of two same-tree peers is allowlisted', () => {
    const ctx = { ...OWN, options: { repoConcurrency: { allow: ['task-b'] } } };
    const r = runIndividualCheck('repoConcurrency', ctx, {
      resolveRepoIdentity: () => 'owner/repo',
      listLocks: () => [lockOf({ featureKey: 'task-b' }), lockOf({ featureKey: 'task-c' })],
    });
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('task-c');
    expect(r.detail).not.toContain('task-b');
  });

  it('ignores locks from OTHER repositories entirely', () => {
    const r = runIndividualCheck('repoConcurrency', OWN, {
      resolveRepoIdentity: () => 'owner/repo',
      listLocks: () => [lockOf({ repoIdentity: 'someone/else' })],
    });
    expect(r.status).toBe('pass');
  });

  it('ignores the same feature key (lockFree owns that case) and its own session', () => {
    const r = runIndividualCheck('repoConcurrency', OWN, {
      resolveRepoIdentity: () => 'owner/repo',
      listLocks: () => [lockOf({ featureKey: 'task-a' }), lockOf({ sessionId: 'sess-own', featureKey: 'task-z' })],
    });
    expect(r.status).toBe('pass');
  });

  it('downgrades a stale same-repo peer to warn', () => {
    const r = runIndividualCheck('repoConcurrency', OWN, {
      resolveRepoIdentity: () => 'owner/repo',
      listLocks: () => [{ ...lockOf({}), stale: true }],
    });
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/stale/);
  });

  it('reports legacy-scheme (unattributable) live locks as a warn naming another plugin version', () => {
    const r = runIndividualCheck('repoConcurrency', OWN, {
      resolveRepoIdentity: () => 'owner/repo',
      listLocks: () => [lockOf({ repoIdentity: undefined, cwd: undefined })],
    });
    expect(r.status).toBe('warn');
    expect(r.detail).toBe('1 legacy-scheme live lock(s) from another plugin version (unattributable to a repo)');
  });

  it('runIndividualCheck does not memoize across calls that reuse one ctx object', () => {
    const first = runIndividualCheck('repoConcurrency', OWN, { resolveRepoIdentity: () => null, listLocks: () => [] });
    const second = runIndividualCheck('repoConcurrency', OWN, { resolveRepoIdentity: () => 'owner/repo', listLocks: () => [] });
    expect(first.status).toBe('warn');
    expect(second.status).toBe('pass');
  });

  it('runPreflight resolves the identity once per battery across lockFree and repoConcurrency', () => {
    const resolveRepoIdentity = vi.fn(() => 'owner/repo');
    const r = runPreflight(OWN, {
      gitRunner: () => '',
      lockChecker: () => ({ locked: false }),
      statfs: () => 10 * 1024 * 1024 * 1024,
      nodeVersion: '22.0.0',
      resolveRepoIdentity,
      listLocks: () => [],
    });
    expect(r.ok).toBe(true);
    expect(resolveRepoIdentity).toHaveBeenCalledTimes(1);
  });

  it('warns when the lock listing throws', () => {
    const r = runIndividualCheck('repoConcurrency', OWN, {
      resolveRepoIdentity: () => 'owner/repo',
      listLocks: () => { throw new Error('locks dir boom'); },
    });
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/locks dir boom/);
  });

  it('is a hard fail in runPreflight (ok=false) when a same-tree peer exists', () => {
    const r = runPreflight(OWN, {
      gitRunner: () => '',
      lockChecker: () => ({ locked: false }),
      statfs: () => 10 * 1024 * 1024 * 1024,
      nodeVersion: '22.0.0',
      resolveRepoIdentity: () => 'owner/repo',
      listLocks: () => [lockOf({})],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.find((e) => e.check === 'repoConcurrency')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// peerNotice — advisory
// ---------------------------------------------------------------------------
describe('runIndividualCheck — peerNotice', () => {
  it('passes with peer-listing-unavailable when no listAgents seam is injected', () => {
    const r = runIndividualCheck('peerNotice', OWN, { env: {} });
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('peer-listing-unavailable');
  });

  it('counts only peers whose cwd overlaps this repo', () => {
    const listAgents = vi.fn(() => [
      { name: 'limb-1', cwd: '/repo/main/.claude/worktrees/limb-1' },
      { name: 'elsewhere', cwd: '/other/place' },
      { name: 'root', cwd: '/repo' },
    ]);
    const r = runIndividualCheck('peerNotice', { ...OWN, cwd: '/repo/main' }, { listAgents });
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('2 peer session(s)');
    expect(r.detail).toContain('limb-1');
    expect(r.detail).not.toContain('elsewhere');
  });
});
