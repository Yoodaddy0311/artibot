/**
 * Unit tests for lib/autopilot/auto-wire.js (Track J).
 *
 * Covers each wireXxx() function:
 *   - wirePreIntake: shape, complexity routing, template suggestion, DI
 *   - wireResume: drift / migration / rebase plan / clean states
 *   - wireVerifyFailure: targets list, recommended, no-checkpoint, label
 *   - wirePhaseEnd: drift threshold, missing/extra, warnPct override
 *   - wireReport: flamegraph + drift, empty state, sort opt
 */
import { describe, expect, it, vi } from 'vitest';
import {
  wirePhaseEnd,
  wirePreIntake,
  wireReport,
  wireResume,
  wireVerifyFailure,
} from '../../lib/autopilot/auto-wire.js';

const noHistoryDeps = {
  listSessions: vi.fn(() => []),
  readEvents: vi.fn(() => []),
};

// ---------------------------------------------------------------------------
// wirePreIntake
// ---------------------------------------------------------------------------

describe('wirePreIntake', () => {
  it('returns all expected fields', () => {
    const state = { sessionId: 'ap-pre-1' };
    const out = wirePreIntake(state, 'add new feature for user search', noHistoryDeps);
    expect(out).toHaveProperty('costEstimate');
    expect(out).toHaveProperty('complexity');
    expect(out).toHaveProperty('suggestedTemplate');
    expect(out).toHaveProperty('skippablePhases');
    expect(out).toHaveProperty('instruction');
    expect(typeof out.instruction).toBe('string');
    expect(out.sessionId).toBe('ap-pre-1');
  });

  it('routes trivial goals to bugfix template', () => {
    const out = wirePreIntake({}, 'fix typo in readme', noHistoryDeps);
    expect(out.suggestedTemplate).toBe('bugfix');
    expect(out.complexity.level).toBe('trivial');
  });

  it('routes complex goals to refactor template', () => {
    const out = wirePreIntake(
      {},
      'refactor the entire architecture and migrate the persistence layer to a new database and rewrite all clients',
      noHistoryDeps,
    );
    expect(out.suggestedTemplate).toBe('refactor');
    expect(out.complexity.level).toBe('complex');
  });

  it('routes medium goals to feature template', () => {
    // Pad the prompt so length + keyword stacking lands solidly in `medium`.
    const out = wirePreIntake(
      {},
      'implement a new pipeline subsystem and integrate workflow middleware across handlers also add support for the new endpoint plus feature flag wiring',
      noHistoryDeps,
    );
    expect(out.complexity.level).toBe('medium');
    expect(out.suggestedTemplate).toBe('feature');
  });

  it('recommends skipping CROSS_CHECK + IMPROVE for trivial goals', () => {
    const out = wirePreIntake({}, 'fix typo', noHistoryDeps);
    expect(out.skippablePhases.skip).toEqual(expect.arrayContaining(['CROSS_CHECK', 'IMPROVE']));
  });

  it('handles empty prompt gracefully', () => {
    const out = wirePreIntake({}, '', noHistoryDeps);
    expect(out.costEstimate.estimatedTokens).toBeGreaterThan(0);
  });

  it('handles non-string prompt', () => {
    const out = wirePreIntake({}, null, noHistoryDeps);
    expect(typeof out.instruction).toBe('string');
  });

  it('injects custom listSessions/readEvents via opts (DI)', () => {
    const listSessions = vi.fn(() => []);
    const readEvents = vi.fn(() => []);
    wirePreIntake({}, 'add feature', { listSessions, readEvents });
    expect(listSessions).toHaveBeenCalled();
  });

  it('instruction contains token estimate', () => {
    const out = wirePreIntake({}, 'add feature integration', noHistoryDeps);
    expect(out.instruction).toMatch(/tokens/);
    expect(out.instruction).toMatch(/Suggested template/);
  });
});

// ---------------------------------------------------------------------------
// wireResume
// ---------------------------------------------------------------------------

describe('wireResume', () => {
  it('detects no drift on first save', () => {
    const state = { sessionId: 'ap-rs-1' };
    const out = wireResume(state, { machineId: 'host_user' });
    expect(out.driftDetected).toBe(false);
    expect(out.rebasePlan).toBeNull();
  });

  it('detects no drift when machineId matches', () => {
    const state = { sessionId: 'ap-rs-2', machineId: 'host_user' };
    const out = wireResume(state, { machineId: 'host_user' });
    expect(out.driftDetected).toBe(false);
    expect(out.instruction).toMatch(/no drift/);
  });

  it('detects drift and builds a rebase plan', () => {
    const state = { sessionId: 'ap-rs-3', machineId: 'oldhost_user' };
    const out = wireResume(state, {
      machineId: 'newhost_user',
      baseBranch: 'main',
      remote: 'origin',
    });
    expect(out.driftDetected).toBe(true);
    expect(Array.isArray(out.rebasePlan)).toBe(true);
    expect(out.rebasePlan).toHaveLength(2);
    expect(out.rebasePlan[0].args).toContain('fetch');
    expect(out.rebasePlan[1].args[0]).toBe('rebase');
  });

  it('flags v2→v3 migration when schemaVersion is 2', () => {
    const state = { sessionId: 'ap-rs-4', schemaVersion: 2, machineId: 'h_u' };
    const out = wireResume(state, { machineId: 'h_u' });
    expect(out.migrationNeeded).toBe(true);
    expect(out.instruction).toMatch(/v2.*v3/);
  });

  it('reports up-to-date schema when version is already 3', () => {
    const state = { sessionId: 'ap-rs-5', schemaVersion: 3, machineId: 'h_u' };
    const out = wireResume(state, { machineId: 'h_u' });
    expect(out.migrationNeeded).toBe(false);
    expect(out.instruction).toMatch(/up-to-date/);
  });

  it('instruction includes the rebase commands when drift detected', () => {
    const state = { sessionId: 'ap-rs-6', machineId: 'a_a' };
    const out = wireResume(state, { machineId: 'b_b' });
    expect(out.instruction).toMatch(/git fetch/);
    expect(out.instruction).toMatch(/git rebase/);
  });
});

// ---------------------------------------------------------------------------
// wireVerifyFailure
// ---------------------------------------------------------------------------

describe('wireVerifyFailure', () => {
  it('returns no-recommendation when no green checkpoints', () => {
    const state = { sessionId: 'ap-vf-1', checkpoints: [] };
    const out = wireVerifyFailure(state, 'EXECUTE');
    expect(out.targets).toHaveLength(0);
    expect(out.recommended).toBeNull();
    expect(out.instruction).toMatch(/manual recovery/);
  });

  it('recommends the latest green checkpoint', () => {
    const state = {
      sessionId: 'ap-vf-2',
      checkpoints: [
        { phase: 'PLAN', sha: 'abc111', status: 'passed' },
        { phase: 'EXECUTE', sha: 'def222', status: 'passed' },
      ],
    };
    const out = wireVerifyFailure(state, 'VERIFY');
    expect(out.recommended).not.toBeNull();
    expect(out.recommended.sha).toBe('def222');
  });

  it('skips non-passed checkpoints', () => {
    const state = {
      sessionId: 'ap-vf-3',
      checkpoints: [
        { phase: 'EXECUTE', sha: 'aaa111', status: 'failed' },
        { phase: 'PLAN', sha: 'bbb222', status: 'passed' },
      ],
    };
    const out = wireVerifyFailure(state, 'VERIFY');
    expect(out.recommended.sha).toBe('bbb222');
  });

  it('does NOT execute rollback', () => {
    const state = {
      sessionId: 'ap-vf-4',
      checkpoints: [{ phase: 'PLAN', sha: 'safe1', status: 'passed' }],
    };
    const out = wireVerifyFailure(state, 'EXECUTE');
    expect(out.instruction).toMatch(/rollbackToLastGreen/);
    expect(out.instruction).toMatch(/surfaces the option/);
  });

  it('handles missing failedPhase string', () => {
    const state = { sessionId: 'ap-vf-5', checkpoints: [] };
    const out = wireVerifyFailure(state, null);
    expect(out.instruction).toMatch(/unknown/);
  });

  it('accepts opts.sessionId override', () => {
    const state = {
      sessionId: 'ap-vf-6',
      checkpoints: [{ phase: 'PLAN', sha: 'ccc333', status: 'passed' }],
    };
    const out = wireVerifyFailure(state, 'VERIFY', { sessionId: 'ap-vf-6' });
    expect(out.recommended.sha).toBe('ccc333');
  });
});

// ---------------------------------------------------------------------------
// wirePhaseEnd
// ---------------------------------------------------------------------------

describe('wirePhaseEnd', () => {
  it('reports 0% drift when goal matches output', () => {
    const state = {
      goalContract: { deliverables: ['file-a.js', 'file-b.js'] },
    };
    const out = wirePhaseEnd(state, 'EXECUTE', {
      deliverables: ['file-a.js', 'file-b.js'],
    });
    expect(out.driftPct).toBe(0);
    expect(out.warning).toBe(false);
    expect(out.instruction).toMatch(/on track/);
  });

  it('flags warning when drift crosses threshold', () => {
    const state = {
      goalContract: { deliverables: ['a', 'b', 'c', 'd'] },
    };
    const out = wirePhaseEnd(state, 'EXECUTE', { deliverables: ['a'] });
    expect(out.driftPct).toBeGreaterThanOrEqual(25);
    expect(out.warning).toBe(true);
    expect(out.instruction).toMatch(/DRIFT/);
  });

  it('respects custom warnPct override', () => {
    const state = {
      goalContract: { deliverables: ['a', 'b', 'c', 'd'] },
    };
    const out = wirePhaseEnd(state, 'EXECUTE', { deliverables: ['a', 'b', 'c'] }, {
      warnPct: 10,
    });
    expect(out.warning).toBe(true);
  });

  it('lists missing deliverables in instruction', () => {
    const state = { goalContract: { deliverables: ['file-x', 'file-y'] } };
    const out = wirePhaseEnd(state, 'EXECUTE', { deliverables: ['file-x'] });
    expect(out.missing).toContain('file-y');
    expect(out.instruction).toMatch(/Missing/);
  });

  it('lists extras (scope creep)', () => {
    const state = { goalContract: { deliverables: ['a'] } };
    const out = wirePhaseEnd(state, 'EXECUTE', { deliverables: ['a', 'unexpected.js'] });
    // computeDrift canonicalizes paths — `.` → `-`. Match the canonical form.
    expect(out.extra).toContain('unexpected-js');
  });

  it('handles missing goalContract', () => {
    const out = wirePhaseEnd({}, 'EXECUTE', { deliverables: ['a'] });
    expect(out.driftPct).toBe(100);
    expect(out.warning).toBe(true);
  });

  it('handles non-string phase label', () => {
    const state = { goalContract: { deliverables: ['a'] } };
    const out = wirePhaseEnd(state, null, { deliverables: ['a'] });
    expect(out.instruction).toMatch(/unknown/);
  });
});

// ---------------------------------------------------------------------------
// wireReport
// ---------------------------------------------------------------------------

describe('wireReport', () => {
  it('returns markdown with flamegraph + drift sections', () => {
    const state = {
      sessionId: 'ap-rep-1',
      goalContract: { deliverables: ['a', 'b'] },
      phases: [
        { phase: 'EXECUTE', durationMs: 60_000, tokens: 1000, cost: 0.1, deliverables: ['a'] },
        { phase: 'VERIFY', durationMs: 30_000, tokens: 500, cost: 0.05, deliverables: ['b'] },
      ],
    };
    const out = wireReport(state);
    expect(out).toMatch(/Phase Flamegraph/);
    expect(out).toMatch(/Drift Summary/);
    expect(out).toMatch(/EXECUTE/);
    expect(out).toMatch(/Drift:/);
  });

  it('handles empty phases list', () => {
    const out = wireReport({ phases: [], goalContract: null });
    expect(typeof out).toBe('string');
    expect(out).toMatch(/Phase Flamegraph/);
  });

  it('handles missing state', () => {
    const out = wireReport(null);
    expect(typeof out).toBe('string');
  });

  it('accepts sort=duration opt', () => {
    const state = {
      phases: [
        { phase: 'A', durationMs: 1000, tokens: 0, cost: 0 },
        { phase: 'B', durationMs: 9000, tokens: 0, cost: 0 },
      ],
    };
    const out = wireReport(state, { sort: 'duration' });
    const aIdx = out.indexOf('A ');
    const bIdx = out.indexOf('B ');
    // duration sort puts the bigger bar (B) first
    expect(bIdx).toBeLessThan(aIdx);
  });

  it('lists missing deliverables in drift summary', () => {
    const state = {
      goalContract: { deliverables: ['needed-x'] },
      phases: [{ phase: 'EXECUTE', durationMs: 1000, deliverables: ['other-y'] }],
    };
    const out = wireReport(state);
    expect(out).toMatch(/needed-x/);
  });
});
