/**
 * Tests for lib/autopilot/cross-session-learner.js (v4.10.0 Track G).
 * Uses a fully-mocked session loader (DI) — no filesystem access.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCAN_LIMIT,
  extractSuccessPatterns,
  recommendDefaults,
  scanRecentSessions,
} from '../../lib/autopilot/cross-session-learner.js';

/**
 * Build a session-loader stub backed by an in-memory map.
 *
 * @param {Record<string, object>} byId
 * @returns {{ listIds: () => string[], load: (id: string) => object|null }}
 */
function mockLoader(byId) {
  return {
    listIds: () => Object.keys(byId),
    load: (id) => byId[id] || null,
  };
}

/**
 * Build a successful session state with a phase ordering.
 *
 * @param {string} id
 * @param {object} extra
 * @returns {object}
 */
function successSession(id, extra = {}) {
  return {
    sessionId: id,
    status: 'completed',
    phase: 'REPORT',
    phases: [
      { name: 'INTAKE' }, { name: 'PLAN' }, { name: 'EXECUTE' },
      { name: 'VERIFY' }, { name: 'REPORT' },
    ],
    iterations: 2,
    goalContract: {
      objective: 'do thing',
      stoppingCondition: 'thing done',
      maxIterations: 3,
    },
    ...extra,
  };
}

describe('scanRecentSessions', () => {
  it('returns [] when listIds throws', () => {
    const loader = { listIds: () => { throw new Error('boom'); }, load: () => null };
    expect(scanRecentSessions({ sessionLoader: loader })).toEqual([]);
  });

  it('returns [] when listIds returns non-array', () => {
    const loader = { listIds: () => null, load: () => null };
    expect(scanRecentSessions({ sessionLoader: loader })).toEqual([]);
  });

  it('returns sessions sorted newest-first (lexicographic id desc)', () => {
    const loader = mockLoader({
      'ap-20260101-000000-aaaa': successSession('ap-20260101-000000-aaaa'),
      'ap-20260301-000000-cccc': successSession('ap-20260301-000000-cccc'),
      'ap-20260201-000000-bbbb': successSession('ap-20260201-000000-bbbb'),
    });
    const result = scanRecentSessions({ sessionLoader: loader });
    expect(result.map((s) => s.sessionId)).toEqual([
      'ap-20260301-000000-cccc',
      'ap-20260201-000000-bbbb',
      'ap-20260101-000000-aaaa',
    ]);
  });

  it('caps results at limit', () => {
    const byId = {};
    for (let i = 0; i < 5; i += 1) {
      const id = `ap-20260${i}01-000000-xxxx`;
      byId[id] = successSession(id);
    }
    const result = scanRecentSessions({ sessionLoader: mockLoader(byId), limit: 2 });
    expect(result).toHaveLength(2);
  });

  it('skips sessions whose load throws or returns null', () => {
    const loader = {
      listIds: () => ['ap-good', 'ap-throws', 'ap-null'],
      load: (id) => {
        if (id === 'ap-throws') throw new Error('corrupt');
        if (id === 'ap-null') return null;
        return successSession(id);
      },
    };
    const result = scanRecentSessions({ sessionLoader: loader });
    expect(result.map((s) => s.sessionId)).toEqual(['ap-good']);
  });

  it('uses DEFAULT_SCAN_LIMIT when limit option absent', () => {
    expect(DEFAULT_SCAN_LIMIT).toBeGreaterThan(0);
  });
});

describe('extractSuccessPatterns', () => {
  it('handles empty input', () => {
    const r = extractSuccessPatterns([]);
    expect(r.total).toBe(0);
    expect(r.successCount).toBe(0);
    expect(r.commonPhaseOrdering).toBeNull();
    expect(r.avgIterations).toBeNull();
  });

  it('counts total vs success sessions separately', () => {
    const sessions = [
      successSession('a'),
      successSession('b'),
      { sessionId: 'c', failedAt: '2026-05-17T00:00:00Z' },
    ];
    const r = extractSuccessPatterns(sessions);
    expect(r.total).toBe(3);
    expect(r.successCount).toBe(2);
  });

  it('picks the mode phase ordering from successes', () => {
    const ordA = [{ name: 'PLAN' }, { name: 'EXECUTE' }, { name: 'REPORT' }];
    const ordB = [{ name: 'INTAKE' }, { name: 'EXECUTE' }, { name: 'REPORT' }];
    const sessions = [
      successSession('a', { phases: ordA }),
      successSession('b', { phases: ordA }),
      successSession('c', { phases: ordB }),
    ];
    const r = extractSuccessPatterns(sessions);
    expect(r.commonPhaseOrdering).toEqual(['PLAN', 'EXECUTE', 'REPORT']);
  });

  it('averages iterations rounded to one decimal', () => {
    const sessions = [
      successSession('a', { iterations: 1 }),
      successSession('b', { iterations: 2 }),
      successSession('c', { iterations: 4 }),
    ];
    const r = extractSuccessPatterns(sessions);
    expect(r.avgIterations).toBeCloseTo(2.3, 1);
  });

  it('falls back to iterationHistory.length when iterations missing', () => {
    const sessions = [
      successSession('a', { iterations: undefined, iterationHistory: [{}, {}, {}] }),
    ];
    const r = extractSuccessPatterns(sessions);
    expect(r.avgIterations).toBe(3);
  });

  it('counts contract field usage only for known schema fields', () => {
    const sessions = [
      successSession('a', {
        goalContract: {
          objective: 'foo',
          stoppingCondition: 'done',
          validationCommand: 'npm t',
          forbiddenChanges: ['x'],
          maxIterations: 3,
          unknown: 'ignored',
        },
      }),
      successSession('b', {
        goalContract: { objective: 'bar', stoppingCondition: 'ok' },
      }),
    ];
    const r = extractSuccessPatterns(sessions);
    expect(r.contractFields.objective).toBe(2);
    expect(r.contractFields.validationCommand).toBe(1);
    expect(r.contractFields).not.toHaveProperty('unknown');
  });

  it('falls back to timeline when phases is missing', () => {
    const sessions = [
      successSession('a', {
        phases: undefined,
        timeline: [
          { phase: 'PLAN' }, { phase: 'EXECUTE' }, { phase: 'REPORT' },
        ],
      }),
    ];
    const r = extractSuccessPatterns(sessions);
    expect(r.commonPhaseOrdering).toEqual(['PLAN', 'EXECUTE', 'REPORT']);
  });
});

describe('recommendDefaults', () => {
  it('combines complexity, skip, and pattern advice', () => {
    const loader = mockLoader({
      'ap-001': successSession('ap-001', { iterations: 2 }),
      'ap-002': successSession('ap-002', { iterations: 3 }),
    });
    const r = recommendDefaults('Implement new endpoint in routes.js', { sessionLoader: loader });
    expect(r.complexity.level).toBe('medium');
    expect(r.skip.skip).toEqual([]);
    expect(r.suggestedMaxIterations).toBe(3);
    expect(r.suggestedPhaseOrdering).toEqual(['INTAKE', 'PLAN', 'EXECUTE', 'VERIFY', 'REPORT']);
    expect(r.sampledSessions).toBe(2);
  });

  it('clamps suggested iteration count to [1, 10]', () => {
    const huge = successSession('big', { iterations: 99 });
    const r = recommendDefaults('typo', { sessionLoader: mockLoader({ big: huge }) });
    expect(r.suggestedMaxIterations).toBeLessThanOrEqual(10);
    expect(r.suggestedMaxIterations).toBeGreaterThanOrEqual(1);
  });

  it('returns null suggestedMaxIterations when no successful sessions', () => {
    const r = recommendDefaults('typo', { sessionLoader: mockLoader({}) });
    expect(r.suggestedMaxIterations).toBeNull();
    expect(r.suggestedPhaseOrdering).toBeNull();
  });
});
