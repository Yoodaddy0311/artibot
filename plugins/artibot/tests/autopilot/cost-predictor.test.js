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

  it('high-complexity multiplier exceeds low-complexity for equal-length goals', () => {
    // Use a long enough task (>~700 chars at default 12 tokens/char) so the
    // floor (DEFAULT_MIN_TOKENS=8000) does not mask the multiplier difference.
    const filler = 'x '.repeat(400);
    const big = predictCost(`refactor everything ${filler}`, opts);
    const small = predictCost(`fix typo ${filler}`, opts);
    expect(big.complexity).toBe('high');
    expect(small.complexity).toBe('low');
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

/**
 * History window semantics.
 *
 * `listSessions()` is a `readdir` listing, i.e. ALPHABETICAL, not chronological,
 * and it includes every id ever written to the store. A block of unusable ids
 * sorting to the end of that list therefore used to consume the whole window:
 * the old implementation took `ids.slice(-cap)` FIRST and only then dropped the
 * sessions with no usable usage, so the sample size collapsed to zero while
 * usable history sat just outside the slice.
 *
 * The window is now "scan backwards until `cap` USABLE sessions are found",
 * bounded by a read budget so a store full of unusable ids cannot turn one
 * prediction into thousands of file reads. No id-name rule is involved: a
 * session is judged only by whether its events aggregate to a positive
 * tokens-per-char.
 */
describe('predictCost history window', () => {
  const usableEvents = (taskChars, totalTokens) => [
    { ts: '2026-05-16T10:00:00Z', type: 'session-start', data: { task: 'x'.repeat(taskChars) } },
    { ts: '2026-05-16T10:30:00Z', type: 'usage', data: { tokensIn: totalTokens / 2, tokensOut: totalTokens / 2 } },
  ];

  it('counts usable sessions that sit beyond the tail block of unusable ids', () => {
    const usable = ['a-old-1', 'a-old-2', 'a-old-3'];
    const unusable = Array.from({ length: 60 }, (_, i) => `z-empty-${i}`);
    const map = Object.fromEntries(usable.map((id) => [id, usableEvents(100, 2000)]));
    const opts = {
      listSessions: () => [...usable, ...unusable],
      readEvents: makeReader(map),
      cap: 50,
    };
    const out = predictCost({ task: 'x'.repeat(100) }, opts);
    expect(out.basedOnNSessions).toBe(3);
    expect(out.confidence).toBeGreaterThan(0);
  });

  it('bounds readEvents calls at cap x 10 when nothing is usable', () => {
    const ids = Array.from({ length: 100 }, (_, i) => `empty-${i}`);
    const reader = vi.fn(() => []);
    const opts = { listSessions: () => ids, readEvents: reader, cap: 5 };
    const out = predictCost('fix bug', opts);
    expect(reader.mock.calls.length).toBeLessThanOrEqual(50);
    expect(out.basedOnNSessions).toBe(0);
  });

  it('stops at cap and keeps the most recent usable sessions', () => {
    // 10 old sessions at 100 tokens/char, then 50 recent ones at 20 tokens/char.
    // With cap=50 only the recent block may be sampled, so the rolling average
    // must land on 20; a 100 anywhere in the mean would prove an older session
    // leaked into the window.
    const old = Array.from({ length: 10 }, (_, i) => `a-old-${i}`);
    const recent = Array.from({ length: 50 }, (_, i) => `b-recent-${i}`);
    const map = {
      ...Object.fromEntries(old.map((id) => [id, usableEvents(100, 10000)])),
      ...Object.fromEntries(recent.map((id) => [id, usableEvents(100, 2000)])),
    };
    const opts = {
      listSessions: () => [...old, ...recent],
      readEvents: makeReader(map),
      cap: 50,
    };
    const out = predictCost({ task: 'x'.repeat(100) }, opts);
    expect(out.basedOnNSessions).toBe(50);
    expect(out.tokensPerCharUsed).toBeCloseTo(20, 5);
  });

  it('is deterministic for the same session list and events', () => {
    const usable = ['a-1', 'a-2'];
    const unusable = Array.from({ length: 12 }, (_, i) => `z-${i}`);
    const map = Object.fromEntries(usable.map((id) => [id, usableEvents(100, 2000)]));
    const makeOpts = () => ({
      listSessions: () => [...usable, ...unusable],
      readEvents: makeReader(map),
      cap: 50,
    });
    const first = predictCost({ task: 'implement search' }, makeOpts());
    const second = predictCost({ task: 'implement search' }, makeOpts());
    expect(first).toEqual(second);
    expect(first.basedOnNSessions).toBe(2);
  });
});
