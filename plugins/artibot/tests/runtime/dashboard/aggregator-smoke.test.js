import { describe, expect, it } from 'vitest';
import {
  createAggregator,
  DEFAULT_TOKEN_BUCKETS,
  envTime,
  extractTokens,
  getErrorRateTrend,
  getTokenHistogram,
  getToolUsageTop,
  groupSessions,
} from '../../../lib/runtime/dashboard/aggregator.js';

describe('dashboard/aggregator (smoke)', () => {
  it('DEFAULT_TOKEN_BUCKETS is a frozen array', () => {
    expect(Array.isArray(DEFAULT_TOKEN_BUCKETS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TOKEN_BUCKETS)).toBe(true);
  });

  it('extractTokens returns number or 0', () => {
    expect(typeof extractTokens({ payload: { usage: { total_tokens: 100 } } })).toBe('number');
    expect(typeof extractTokens({})).toBe('number');
  });

  it('envTime returns a millisecond timestamp', () => {
    const t = envTime({ timestamp: '2026-04-25T12:00:00Z' });
    expect(typeof t).toBe('number');
  });

  it('groupSessions returns object keyed by sessionId', () => {
    const envelopes = [
      { sessionId: 'a', timestamp: '2026-04-25T12:00:00Z' },
      { sessionId: 'b', timestamp: '2026-04-25T12:00:00Z' },
      { sessionId: 'a', timestamp: '2026-04-25T12:05:00Z' },
    ];
    const grouped = groupSessions(envelopes);
    expect(typeof grouped).toBe('object');
  });

  it('getToolUsageTop returns an array', () => {
    const envelopes = [
      { event: 'PostToolUse', tool: 'Read', timestamp: '2026-04-25T12:00:00Z' },
      { event: 'PostToolUse', tool: 'Read', timestamp: '2026-04-25T12:01:00Z' },
      { event: 'PostToolUse', tool: 'Bash', timestamp: '2026-04-25T12:02:00Z' },
    ];
    const top = getToolUsageTop(envelopes, 5);
    expect(Array.isArray(top)).toBe(true);
  });

  it('getErrorRateTrend returns an array', () => {
    const trend = getErrorRateTrend([], 7);
    expect(Array.isArray(trend)).toBe(true);
  });

  it('getTokenHistogram returns an object/array', () => {
    const hist = getTokenHistogram([], DEFAULT_TOKEN_BUCKETS);
    expect(hist).toBeDefined();
  });

  it('createAggregator factory returns an object', () => {
    const agg = createAggregator({ eventFile: '/tmp/noop.jsonl', windowDays: 7 });
    expect(typeof agg).toBe('object');
  });
});
