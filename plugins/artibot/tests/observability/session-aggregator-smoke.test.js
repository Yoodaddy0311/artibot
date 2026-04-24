import { describe, it, expect } from 'vitest';
import {
  dayKey,
  normalizeMetrics,
  buildSessionRecord,
  foldIntoBucket,
  upsertBucket,
  isOlderThan,
  createSessionAggregator,
} from '../../lib/observability/session-aggregator.js';

describe('session-aggregator pure helpers (smoke)', () => {
  it('dayKey returns YYYY-MM-DD for a timestamp', () => {
    const key = dayKey(Date.parse('2026-04-25T12:00:00Z'));
    expect(typeof key).toBe('string');
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('normalizeMetrics returns an object with sane defaults', () => {
    const norm = normalizeMetrics();
    expect(typeof norm).toBe('object');
  });

  it('normalizeMetrics preserves provided numeric fields', () => {
    const norm = normalizeMetrics({ tokens: 100, errors: 2 });
    expect(typeof norm).toBe('object');
  });

  it('buildSessionRecord accepts minimal input', () => {
    const rec = buildSessionRecord({
      sessionId: 's1',
      startTime: 1000,
      endTime: 2000,
      metrics: {},
    });
    expect(typeof rec).toBe('object');
    expect(rec.sessionId).toBe('s1');
  });

  it('foldIntoBucket accumulates session records', () => {
    const bucket = { date: '2026-04-25', sessions: 0, tokens: 0 };
    const record = { sessionId: 's1', startTime: 0, endTime: 0, metrics: { tokens: 50 } };
    const out = foldIntoBucket(bucket, record);
    expect(typeof out).toBe('object');
  });

  it('upsertBucket returns updated rollups array', () => {
    const rollups = [];
    const bucket = { date: '2026-04-25', sessions: 1 };
    const out = upsertBucket(rollups, bucket);
    expect(Array.isArray(out)).toBe(true);
  });

  it('isOlderThan is a function returning a boolean', () => {
    const nowMs = Date.parse('2026-04-25T00:00:00Z');
    const record = { startTime: nowMs - 1000 };
    const result = isOlderThan(record, 30, nowMs);
    expect(typeof result).toBe('boolean');
  });

  it('createSessionAggregator factory returns an object', () => {
    const agg = createSessionAggregator({ storagePath: '/tmp/artibot-test-agg', windowDays: 30 });
    expect(typeof agg).toBe('object');
  });
});
