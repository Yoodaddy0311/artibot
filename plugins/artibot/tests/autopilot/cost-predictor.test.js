/**
 * Unit tests for lib/autopilot/cost-predictor.js
 *
 * All filesystem dependencies (listSessions / readEvents) are stubbed via DI.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  classifyComplexity,
  predictCost,
} from '../../lib/autopilot/cost-predictor.js';

/** Build a fake readEvents that returns a canned event list per session id. */
function makeReader(map) {
  return (id) => (map[id] ? map[id] : []);
}

describe('classifyComplexity', () => {
  it('returns medium for empty / non-string', () => {
    expect(classifyComplexity('')).toBe('medium');
    expect(classifyComplexity(null)).toBe('medium');
  });

  it('detects high-tier keywords', () => {
    expect(classifyComplexity('migrate auth from v1 to v2')).toBe('high');
    expect(classifyComplexity('refactor cache layer')).toBe('high');
  });

  it('detects medium-tier keywords', () => {
    expect(classifyComplexity('implement search ranking')).toBe('medium');
    expect(classifyComplexity('optimize cold start')).toBe('medium');
  });

  it('detects low-tier keywords', () => {
    expect(classifyComplexity('fix typo in README')).toBe('low');
    expect(classifyComplexity('rename foo to bar')).toBe('low');
  });

  it('defaults to medium when no keyword matches', () => {
    expect(classifyComplexity('do the thing please')).toBe('medium');
  });
});

describe('predictCost (no history)', () => {
  const opts = {
    listSessions: () => [],
    readEvents: () => [],
  };

  it('returns conservative default with confidence=0 when history empty', () => {
    const out = predictCost('fix login bug', opts);
    expect(out.basedOnNSessions).toBe(0);
    expect(out.confidence).toBe(0);
    expect(out.estimatedTokens).toBeGreaterThan(0);
    expect(out.estimatedDurationMs).toBeGreaterThan(0);
  });

  it('floors at min tokens even for trivial goal', () => {
    const out = predictCost({ task: 'fix' }, opts);
    expect(out.estimatedTokens).toBeGreaterThanOrEqual(8000);
  });

  it('high-complexity multiplies vs low-complexity', () => {
    const big = predictCost('refactor entire auth module from scratch with new schema', opts);
    const small = predictCost('fix the typo in the readme file please now', opts);
    expect(big.complexity).toBe('high');
    expect(small.complexity).toBe('low');
    // big task is also longer, so the gap is amplified
    expect(big.estimatedTokens).toBeGreaterThan(small.estimatedTokens);
  });
});

describe('predictCost (with history)', () => {
  it('uses rolling avg tokens-per-char when history present', () => {
    // build two prior sessions: each had 100 chars of task and 2000 tokens total
    const events = (taskChars, totalTokens) => [
      { ts: '2026-05-16T10:00:00Z', type: 'session-start', data: { task: 'x'.repeat(taskChars) } },
      { ts: '2026-05-16T10:30:00Z', type: 'usage', data: { tokensIn: totalTokens / 2, tokensOut: totalTokens / 2 } },
    ];
    const opts = {
      listSessions: () => ['s1', 's2'],
      readEvents: makeReader({
        s1: events(100, 2000),
        s2: events(100, 2000),
      }),
    };
    const out = predictCost({ task: 'x'.repeat(100) }, opts);
    expect(out.basedOnNSessions).toBe(2);
    expect(out.confidence).toBeGreaterThan(0);
    // baseline = 100 * 20 = 2000 tokens × medium mult (1.0). floor at 8000.
    expect(out.tokensPerCharUsed).toBeCloseTo(20, 1);
    expect(out.estimatedTokens).toBe(8000); // floor wins
  });

  it('confidence caps at 0.9 with 10+ samples', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `s${i}`);
    const events = [
      { ts: '2026-05-16T10:00:00Z', type: 'session-start', data: { task: 'a'.repeat(50) } },
      { ts: '2026-05-16T11:00:00Z', type: 'usage', data: { tokensIn: 500, tokensOut: 500 } },
    ];
    const map = Object.fromEntries(ids.map((id) => [id, events]));
    const opts = { listSessions: () => ids, readEvents: makeReader(map) };
    const out = predictCost({ task: 'a'.repeat(50) }, opts);
    expect(out.confidence).toBe(0.9);
    expect(out.basedOnNSessions).toBeGreaterThanOrEqual(10);
  });

  it('skips sessions with no usable usage', () => {
    const opts = {
      listSessions: () => ['empty-1', 'empty-2'],
      readEvents: makeReader({ 'empty-1': [], 'empty-2': [] }),
    };
    const out = predictCost('refactor things', opts);
    expect(out.basedOnNSessions).toBe(0);
    expect(out.confidence).toBe(0);
  });

  it('uses avg duration from history when present', () => {
    const fortyFiveMinutes = 45 * 60 * 1000;
    const events = [
      { ts: '2026-05-16T10:00:00Z', type: 'session-start', data: { task: 'aaa' } },
      { ts: '2026-05-16T10:00:00Z', type: 'usage', data: { tokensIn: 100, tokensOut: 100 } },
      { ts: new Date(Date.parse('2026-05-16T10:00:00Z') + fortyFiveMinutes).toISOString(), type: 'phase-end' },
    ];
    const opts = {
      listSessions: () => ['s1'],
      readEvents: makeReader({ s1: events }),
    };
    const out = predictCost('implement search', opts);
    // medium mult = 1.0 → ~45 min
    expect(out.estimatedDurationMs).toBeGreaterThan(40 * 60 * 1000);
    expect(out.estimatedDurationMs).toBeLessThan(50 * 60 * 1000);
  });

  it('survives a thrown readEvents (skips that session)', () => {
    const reader = vi.fn((id) => {
      if (id === 'bad') throw new Error('disk error');
      return [
        { ts: '2026-05-16T10:00:00Z', type: 'session-start', data: { task: 'aaa' } },
        { ts: '2026-05-16T10:01:00Z', type: 'usage', data: { tokensIn: 100, tokensOut: 100 } },
      ];
    });
    const opts = { listSessions: () => ['bad', 'good'], readEvents: reader };
    const out = predictCost('implement search', opts);
    expect(out.basedOnNSessions).toBe(1);
  });

  it('survives a thrown listSessions', () => {
    const opts = {
      listSessions: () => { throw new Error('boom'); },
      readEvents: () => [],
    };
    const out = predictCost('fix bug', opts);
    expect(out.basedOnNSessions).toBe(0);
    expect(out.confidence).toBe(0);
    expect(out.estimatedTokens).toBeGreaterThan(0);
  });

  it('respects cap option (only takes last N sessions)', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const reader = vi.fn(() => [
      { ts: '2026-05-16T10:00:00Z', type: 'session-start', data: { task: 'a' } },
      { ts: '2026-05-16T10:01:00Z', type: 'usage', data: { tokensIn: 100, tokensOut: 100 } },
    ]);
    const opts = { listSessions: () => ids, readEvents: reader, cap: 5 };
    predictCost('fix', opts);
    expect(reader).toHaveBeenCalledTimes(5);
  });

  it('handles non-string goal gracefully', () => {
    const opts = { listSessions: () => [], readEvents: () => [] };
    const out = predictCost(null, opts);
    expect(out.estimatedTokens).toBeGreaterThan(0);
    expect(out.complexity).toBe('medium');
  });

  it('accepts task string directly', () => {
    const opts = { listSessions: () => [], readEvents: () => [] };
    const out = predictCost('refactor auth', opts);
    expect(out.complexity).toBe('high');
  });
});
