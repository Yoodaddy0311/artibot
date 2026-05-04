/**
 * Integration tests: middleware event-bus feature emissions.
 * Verifies that middlewares emit feature:* events picked up by feature-tracker.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFeatureTracker } from '../../../lib/core/feature-tracker.js';
import { reset as resetEventBus } from '../../../lib/core/event-bus.js';
import { createGuardrailMiddleware } from '../../../lib/runtime/middleware/guardrail.js';
import { createTokenUsageMiddleware } from '../../../lib/runtime/middleware/token-usage.js';
import { createRouterMiddleware } from '../../../lib/runtime/middleware/router.js';
import { createSummarizationMiddleware } from '../../../lib/runtime/middleware/summarization.js';

function makeState(prompt = 'hello world') {
  return {
    userPrompt: prompt,
    input: prompt,
    messageParts: [],
    context: {},
    config: {
      automation: { supportedLanguages: ['en'], ambiguityThreshold: 50 },
      cognitive: { router: { threshold: 0.4 } },
    },
  };
}

describe('middleware feature indicator emissions', () => {
  let tracker;

  beforeEach(() => {
    resetEventBus();
    tracker = createFeatureTracker({ now: () => Date.now() });
  });

  afterEach(() => {
    tracker.destroy();
    resetEventBus();
  });

  // ---------------------------------------------------------------------------
  // Router middleware → feature:cognitive-route
  // ---------------------------------------------------------------------------

  describe('router middleware', () => {
    it('emits feature:cognitive-route event', async () => {
      const mw = createRouterMiddleware();
      const state = makeState('fix a simple typo');
      await mw(state);

      const store = tracker.getStore();
      expect(store.has('cognitive-route')).toBe(true);
      expect(store.get('cognitive-route').count).toBe(1);
      expect(store.get('cognitive-route').lastDetail).toMatch(/system/);
    });
  });

  // ---------------------------------------------------------------------------
  // Token usage middleware → feature:token-saving
  // ---------------------------------------------------------------------------

  describe('token-usage middleware', () => {
    it('emits feature:token-saving event', async () => {
      const mw = createTokenUsageMiddleware({ now: () => 1000 });
      const state = makeState('analyze the codebase');
      await mw(state);

      const store = tracker.getStore();
      expect(store.has('token-saving')).toBe(true);
      expect(store.get('token-saving').lastDetail).toMatch(/\d/);
    });
  });

  // ---------------------------------------------------------------------------
  // Guardrail middleware → feature:guardrail-applied
  // ---------------------------------------------------------------------------

  describe('guardrail middleware', () => {
    it('emits feature:guardrail-applied when tools are denied', async () => {
      const mw = createGuardrailMiddleware({ failClosed: true });
      const state = makeState('run something');
      // Inject tool candidates that will be denied
      state.context.subagents = { contract: { tools: ['UnknownTool'] } };
      await mw(state);

      const store = tracker.getStore();
      expect(store.has('guardrail')).toBe(true);
      expect(store.get('guardrail').lastDetail).toContain('denied');
    });

    it('emits feature:guardrail-applied when tools need ask', async () => {
      const mw = createGuardrailMiddleware();
      const state = makeState('do something');
      state.context.subagents = { contract: { tools: ['Bash'] } };
      await mw(state);

      const store = tracker.getStore();
      expect(store.has('guardrail')).toBe(true);
      expect(store.get('guardrail').lastDetail).toContain('ask');
    });

    it('does NOT emit when no tools evaluated or all allowed', async () => {
      const mw = createGuardrailMiddleware();
      const state = makeState('read a file');
      state.context.subagents = { contract: { tools: ['Read'] } };
      await mw(state);

      const store = tracker.getStore();
      expect(store.has('guardrail')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Summarization middleware → feature:token-saving (compaction)
  // ---------------------------------------------------------------------------

  describe('summarization middleware', () => {
    it('emits feature:token-saving when compaction triggers', async () => {
      const longPrompt = Array.from({ length: 100 }, (_, i) =>
        `Segment ${i}: This is a moderately long segment that contributes to the total length.`,
      ).join('\n\n');

      const mw = createSummarizationMiddleware({
        maxTokens: 10,
        charsPerToken: 4,
      });
      const state = makeState(longPrompt);
      await mw(state);

      const store = tracker.getStore();
      expect(store.has('token-saving')).toBe(true);
      expect(store.get('token-saving').lastDetail).toMatch(/compacted \d+%/);
    });

    it('does NOT emit when no compaction needed', async () => {
      const mw = createSummarizationMiddleware({ maxTokens: 100000 });
      const state = makeState('short prompt');
      await mw(state);

      // token-saving may exist from other middleware but not from summarization
      const store = tracker.getStore();
      const record = store.get('token-saving');
      if (record) {
        expect(record.lastDetail).not.toMatch(/compacted/);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-middleware: tracker aggregates multiple features
  // ---------------------------------------------------------------------------

  describe('cross-middleware aggregation', () => {
    it('tracks activations from multiple middlewares', async () => {
      const routerMw = createRouterMiddleware();
      const tokenMw = createTokenUsageMiddleware({ now: () => 1000 });

      const state = makeState('analyze security vulnerabilities');
      await routerMw(state);
      await tokenMw(state);

      const stats = tracker.getStats();
      expect(stats.activeFeatures).toBeGreaterThanOrEqual(2);
      expect(stats.totalActivations).toBeGreaterThanOrEqual(2);
    });
  });
});
