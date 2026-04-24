import { describe, it, expect } from 'vitest';
import {
  createAccumulator,
  extractDelta,
  foldDelta,
  createSessionCaptureMiddleware,
} from '../../../lib/runtime/middleware/session-capture.js';

describe('session-capture (smoke)', () => {
  it('createAccumulator returns an object with sessionId + startTime', () => {
    const acc = createAccumulator('s1', 1000);
    expect(typeof acc).toBe('object');
    expect(acc.sessionId).toBe('s1');
    expect(acc.startTime).toBe(1000);
  });

  it('extractDelta from empty state returns an object', () => {
    const delta = extractDelta({});
    expect(typeof delta).toBe('object');
  });

  it('foldDelta combines deltas safely', () => {
    const acc = createAccumulator('s1', 1000);
    const delta = { tokens: 10 };
    const out = foldDelta(acc, delta);
    expect(typeof out).toBe('object');
  });

  it('createSessionCaptureMiddleware returns a function when aggregator provided', () => {
    const fakeAggregator = {
      recordSession: async () => ({ ok: true }),
    };
    const mw = createSessionCaptureMiddleware({ aggregator: fakeAggregator });
    expect(typeof mw).toBe('function');
  });

  it('createSessionCaptureMiddleware throws without aggregator', () => {
    expect(() => createSessionCaptureMiddleware({})).toThrow();
  });
});
