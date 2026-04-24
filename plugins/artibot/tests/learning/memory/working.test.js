/**
 * Tests for lib/learning/memory/working.js — L1 Working memory store.
 *
 * Covers:
 *   - append() accumulates tokens + returns frozen receipt
 *   - tokenBudget / getBudgetStatus reflect live usage
 *   - partialFlush() drops oldest entries at/above 90% ratio
 *   - maybePartialFlush() triggers only when willPartialFlush=true
 *   - flush() importance-score calculation per design Section 3.1
 *   - flush() promotes to Episodic when score >= 1.0
 *   - flush() below threshold skips but clears
 *   - snapshot() is immutable
 *   - reset()
 *   - compaction stub: flush reason='compaction' + onFlush subscribers
 *   - pure helpers: estimateEntryTokens, tallyEntryKinds, computeImportanceScore
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createWorkingStore,
  estimateEntryTokens,
  tallyEntryKinds,
  computeImportanceScore,
  WORKING_CONSTANTS,
} from '../../../lib/learning/memory/working.js';

// ---------------------------------------------------------------------------
// Pure helpers — cheap, no IO
// ---------------------------------------------------------------------------

describe('working — pure helpers', () => {
  it('estimateEntryTokens returns MIN for null/empty', () => {
    expect(estimateEntryTokens(null)).toBe(WORKING_CONSTANTS.MIN_ENTRY_TOKENS);
    expect(estimateEntryTokens('')).toBe(WORKING_CONSTANTS.MIN_ENTRY_TOKENS);
  });

  it('estimateEntryTokens approximates len/4 over the floor', () => {
    const body = 'x'.repeat(1000); // 1000 / 4 = 250
    expect(estimateEntryTokens(body)).toBe(250);
  });

  it('estimateEntryTokens serialises objects deterministically', () => {
    const a = estimateEntryTokens({ a: 1, b: 2 });
    const b = estimateEntryTokens({ a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it('tallyEntryKinds counts by kind', () => {
    const tally = tallyEntryKinds([
      { kind: 'tool_call' },
      { kind: 'tool_call' },
      { kind: 'error' },
      { kind: 'success' },
      { kind: 'user_correction' },
      { kind: 'generic' },
    ]);
    expect(tally).toEqual({
      tool_calls: 2,
      errors: 1,
      successes: 1,
      user_corrections: 1,
    });
  });

  it('computeImportanceScore matches design Section 3.1 formula', () => {
    // 2·0.3 + 1·0.5 + 1·0.4 + 1·0.8 = 0.6+0.5+0.4+0.8 = 2.3
    const score = computeImportanceScore({
      tool_calls: 2,
      errors: 1,
      successes: 1,
      user_corrections: 1,
    });
    expect(score).toBeCloseTo(2.3, 6);
  });

  it('computeImportanceScore returns 0 on empty tally', () => {
    expect(computeImportanceScore({})).toBe(0);
    expect(computeImportanceScore(null)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Store behaviour
// ---------------------------------------------------------------------------

describe('working — store', () => {
  let nowCounter;
  let now;
  let store;

  beforeEach(() => {
    nowCounter = 1_700_000_000_000;
    now = vi.fn(() => (nowCounter += 1));
    store = createWorkingStore({ tokenBudget: 100, now });
  });

  describe('append()', () => {
    it('returns a frozen receipt with id/tokens/totalTokens', () => {
      const receipt = store.append({ kind: 'tool_call', body: 'abcd'.repeat(5) });
      expect(receipt).toBeDefined();
      expect(typeof receipt.id).toBe('string');
      expect(receipt.tokens).toBeGreaterThanOrEqual(WORKING_CONSTANTS.MIN_ENTRY_TOKENS);
      expect(receipt.totalTokens).toBe(receipt.tokens);
      expect(Object.isFrozen(receipt)).toBe(true);
    });

    it('accumulates totalTokens across multiple appends', () => {
      const r1 = store.append({ kind: 'tool_call', body: 'x'.repeat(40) });
      const r2 = store.append({ kind: 'error', body: 'y'.repeat(40) });
      expect(r2.totalTokens).toBe(r1.totalTokens + r2.tokens);
    });

    it('accepts explicit tokens override', () => {
      const r = store.append({ kind: 'success', body: 'z', tokens: 25 });
      expect(r.tokens).toBe(25);
    });
  });

  describe('snapshot()', () => {
    it('is immutable and frozen', () => {
      store.append({ kind: 'tool_call', body: 'abc' });
      const snap = store.snapshot();
      expect(Object.isFrozen(snap)).toBe(true);
      expect(() => { snap.entries.push({}); }).toThrow();
    });

    it('reflects tokens and lastFlushAt', async () => {
      store.append({ kind: 'tool_call', body: 'abc' });
      const s1 = store.snapshot();
      expect(s1.tokens).toBeGreaterThan(0);
      expect(s1.lastFlushAt).toBe(0);

      await store.flush({ reason: 'test' });
      const s2 = store.snapshot();
      expect(s2.entries.length).toBe(0);
      expect(s2.tokens).toBe(0);
      expect(s2.lastFlushAt).toBeGreaterThan(0);
    });
  });

  describe('tokenBudget() / getBudgetStatus()', () => {
    it('reports used and budget', () => {
      store.append({ kind: 'tool_call', body: 'x'.repeat(40) });
      const tb = store.tokenBudget();
      expect(tb.used).toBeGreaterThan(0);
      expect(tb.budget).toBe(100);
    });

    it('flags willPartialFlush when ratio exceeds trigger', () => {
      // Budget = 100, trigger = 0.9 → 90 tokens needed.
      store.append({ kind: 'tool_call', body: 'x'.repeat(500), tokens: 95 });
      const status = store.getBudgetStatus();
      expect(status.willPartialFlush).toBe(true);
    });
  });

  describe('partialFlush()', () => {
    it('drops oldest entries until minTokens freed', async () => {
      // 4 entries × 20 tokens each → total 80.
      for (let i = 0; i < 4; i += 1) {
        store.append({ kind: 'tool_call', body: 'x'.repeat(40), tokens: 20 });
      }
      const r = await store.partialFlush({ minTokens: 40 });
      expect(r.dropped).toBe(2);
      expect(r.tokensFreed).toBe(40);
      const snap = store.snapshot();
      expect(snap.entries.length).toBe(2);
      expect(snap.tokens).toBe(40);
    });

    it('is no-op when store is empty', async () => {
      const r = await store.partialFlush({ minTokens: 40 });
      expect(r.dropped).toBe(0);
    });
  });

  describe('maybePartialFlush()', () => {
    it('runs when budget ratio >= trigger', async () => {
      store.append({ kind: 'tool_call', body: 'x', tokens: 95 });
      const r = await store.maybePartialFlush();
      expect(r).not.toBeNull();
      expect(r.dropped).toBe(1);
    });

    it('returns null when budget is not near full', async () => {
      store.append({ kind: 'tool_call', body: 'x', tokens: 10 });
      const r = await store.maybePartialFlush();
      expect(r).toBeNull();
    });
  });

  describe('flush()', () => {
    it('returns empty marker when no entries', async () => {
      const r = await store.flush();
      expect(r.skipped).toBe(true);
      expect(r.promoted).toBe(false);
      expect(r.reason).toBe('empty');
    });

    it('calculates importance score per 3.1 formula', async () => {
      store.append({ kind: 'tool_call', body: 't', tokens: 10 });
      store.append({ kind: 'error', body: 'e', tokens: 10 });
      store.append({ kind: 'success', body: 's', tokens: 10 });
      const r = await store.flush();
      // 1·0.3 + 1·0.5 + 1·0.4 = 1.2
      expect(r.importanceScore).toBeCloseTo(1.2, 3);
    });

    it('promotes to Episodic when score >= 1.0', async () => {
      const appendEpisode = vi.fn(async (ep) => ({ id: 'ep1', ...ep }));
      const storeWithEp = createWorkingStore({
        tokenBudget: 1000,
        now,
        episodicStore: { appendEpisode },
      });
      storeWithEp.append({ kind: 'user_correction', body: 'fix this', tokens: 20 });
      storeWithEp.append({ kind: 'success', body: 'ok', tokens: 10 });
      // 1·0.8 + 1·0.4 = 1.2
      const r = await storeWithEp.flush({ reason: 'session-close' });
      expect(r.promoted).toBe(true);
      expect(appendEpisode).toHaveBeenCalledTimes(1);
      const ep = appendEpisode.mock.calls[0][0];
      expect(ep.sessionId).toMatch(/^working-/);
      expect(ep.importanceScore).toBeCloseTo(1.2, 3);
      expect(ep.title).toContain('working');
      expect(typeof ep.summary).toBe('string');
    });

    it('below threshold but above noise floor — skip with below-threshold', async () => {
      const appendEpisode = vi.fn();
      const storeWithEp = createWorkingStore({
        tokenBudget: 1000,
        now,
        episodicStore: { appendEpisode },
      });
      // 3·0.3 = 0.9 (above 0.85 noise, below 1.0)
      storeWithEp.append({ kind: 'tool_call', body: 't1', tokens: 10 });
      storeWithEp.append({ kind: 'tool_call', body: 't2', tokens: 10 });
      storeWithEp.append({ kind: 'tool_call', body: 't3', tokens: 10 });
      const r = await storeWithEp.flush();
      expect(r.promoted).toBe(false);
      expect(r.skipReason).toBe('below-threshold');
      expect(appendEpisode).not.toHaveBeenCalled();
    });

    it('noise-floor skip drops entries without promotion', async () => {
      const appendEpisode = vi.fn();
      const storeWithEp = createWorkingStore({
        tokenBudget: 1000,
        now,
        episodicStore: { appendEpisode },
      });
      // 1·0.3 = 0.3 (below 0.85 noise floor)
      storeWithEp.append({ kind: 'tool_call', body: 't', tokens: 10 });
      const r = await storeWithEp.flush();
      expect(r.promoted).toBe(false);
      expect(r.skipReason).toBe('noise');
      expect(appendEpisode).not.toHaveBeenCalled();
    });

    it('always clears entries + tokens after flush', async () => {
      store.append({ kind: 'tool_call', body: 'x', tokens: 10 });
      await store.flush();
      expect(store.snapshot().entries.length).toBe(0);
      expect(store.snapshot().tokens).toBe(0);
    });

    it('handles episodic-store errors gracefully', async () => {
      const appendEpisode = vi.fn(async () => { throw new Error('disk full'); });
      const storeWithEp = createWorkingStore({
        tokenBudget: 1000,
        now,
        episodicStore: { appendEpisode },
      });
      storeWithEp.append({ kind: 'user_correction', body: 'x', tokens: 10 });
      storeWithEp.append({ kind: 'success', body: 'y', tokens: 10 });
      const r = await storeWithEp.flush();
      expect(r.promoted).toBe(false);
      expect(r.skipReason).toBe('episodic-error');
      // still cleared
      expect(storeWithEp.snapshot().entries.length).toBe(0);
    });

    it('emits to onFlush subscribers', async () => {
      const appendEpisode = vi.fn(async () => ({ id: 'ep' }));
      const storeWithEp = createWorkingStore({
        tokenBudget: 1000,
        now,
        episodicStore: { appendEpisode },
      });
      const listener = vi.fn();
      const dispose = storeWithEp.onFlush(listener);
      storeWithEp.append({ kind: 'user_correction', body: 'x', tokens: 10 });
      storeWithEp.append({ kind: 'success', body: 'y', tokens: 10 });
      await storeWithEp.flush({ reason: 'compaction' });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].reason).toBe('compaction');
      dispose();
    });
  });

  describe('reset()', () => {
    it('clears entries + tokens + lastFlushAt', async () => {
      store.append({ kind: 'tool_call', body: 'x', tokens: 10 });
      await store.flush();
      store.reset();
      const snap = store.snapshot();
      expect(snap.entries.length).toBe(0);
      expect(snap.tokens).toBe(0);
      expect(snap.lastFlushAt).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Compaction hook integration stub — verifies flush accepts reason label
// ---------------------------------------------------------------------------

describe('working — compaction reason plumbing', () => {
  it('records the provided reason in the flush result', async () => {
    const store = createWorkingStore({ tokenBudget: 1000 });
    store.append({ kind: 'user_correction', body: 'x', tokens: 10 });
    store.append({ kind: 'success', body: 'y', tokens: 10 });
    const r = await store.flush({ reason: 'compaction' });
    expect(r.reason).toBe('compaction');
  });
});
