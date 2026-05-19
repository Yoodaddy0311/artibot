/**
 * Stage 6 — categorizer hook integration tests for evolution-loop.
 *
 * Categorizer is dependency-injected — no real I/O, no real
 * failure-patterns.json read. Other stages reuse the same mock factory
 * shapes as `evolution-loop.test.js` to keep behavior identical.
 */
import { describe, expect, it, vi } from 'vitest';
import { createEvolutionLoop } from '../../lib/learning/evolution-loop.js';

// ---------------------------------------------------------------------------
// Mock factories — mirror evolution-loop.test.js for backward-compat coverage
// ---------------------------------------------------------------------------

function createMockSessionMemory() {
  const buffer = [];
  return {
    get bufferSize() { return buffer.length; },
    capture(event) { buffer.push(event); return event; },
    async compress() {
      if (buffer.length === 0) return null;
      return {
        id: 'mem-1',
        sessionId: 'test-session',
        summary: 'test summary',
        keywords: ['frontend', 'component', 'react'],
        eventCount: buffer.length,
      };
    },
  };
}

function createMockKnowledgeGraph() {
  const nodes = [];
  const edges = [];
  return {
    addNode(id, type, data) { nodes.push({ id, type, data }); },
    addEdge(from, to, relation) { edges.push({ from, to, relation }); },
    getNodes() { return nodes; },
    getEdges() { return edges; },
    async save() {},
    getStats() { return { nodes: nodes.length, edges: edges.length, components: 1, density: 0 }; },
  };
}

function createMockSkillEvolver() {
  const tracked = [];
  return {
    track(name, outcome) { tracked.push({ name, outcome }); },
    evaluate() { return { successRate: 0.85, usageCount: 5, avgEditDistance: 2, trend: 0.1 }; },
    classify() { return 'stable'; },
    suggest() { return null; },
    getTracked() { return tracked; },
  };
}

function createMockAutoResearch() {
  return {
    shouldResearch() { return false; },
    scope(q) { return { keywords: [q], sources: new Set(['memory']), query: q }; },
    async gather() { return { web: [], codebase: [], memory: [], durationMs: 10 }; },
    synthesize() { return null; },
  };
}

function buildLoop(overrides = {}) {
  return createEvolutionLoop({
    sessionMemory: createMockSessionMemory(),
    knowledgeGraph: createMockKnowledgeGraph(),
    skillEvolver: createMockSkillEvolver(),
    autoResearch: createMockAutoResearch(),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
describe('createEvolutionLoop — Stage 6: failure categorization', () => {
  // -------------------------------------------------------------------------
  describe('backward compatibility', () => {
    it('omits categorization when context.failures is absent (regression)', async () => {
      const categorizer = vi.fn();
      const loop = buildLoop({ categorizer });

      const result = await loop.run({ events: [{ type: 'edit' }] });

      expect(categorizer).not.toHaveBeenCalled();
      expect(result.categorizedFailures).toEqual([]);
      expect(result.categoryDistribution).toEqual({});
      // Stages 1-2 still ran
      expect(result.compressed).not.toBeNull();
      expect(result.graphNodes).toBe(3);
    });

    it('omits categorization when context.failures is an empty array', async () => {
      const categorizer = vi.fn();
      const loop = buildLoop({ categorizer });

      const result = await loop.run({ failures: [] });

      expect(categorizer).not.toHaveBeenCalled();
      expect(result.categorizedFailures).toEqual([]);
      expect(result.categoryDistribution).toEqual({});
    });

    it('keeps the result frozen even with Stage 6 populated', async () => {
      const categorizer = vi.fn(async () => [
        { categoryId: 'ci-exit-mask', confidence: 0.9, severity: 'high', matchedSignals: [], weight: 1.0 },
      ]);
      const loop = buildLoop({ categorizer });

      const result = await loop.run({ failures: [{ stderr: 'boom' }] });

      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.categorizedFailures)).toBe(true);
      expect(Object.isFrozen(result.categoryDistribution)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('happy path', () => {
    it('records top-1 category per failure and builds distribution', async () => {
      const categorizer = vi.fn(async (failure) => {
        if (failure.stderr?.includes('UV_HANDLE_CLOSING')) {
          return [{ categoryId: 'libuv-handle-closing', confidence: 0.85, severity: 'high', matchedSignals: [], weight: 1.0 }];
        }
        return [
          { categoryId: 'ci-exit-mask', confidence: 0.75, severity: 'high', matchedSignals: [], weight: 1.0 },
          { categoryId: 'tz-mismatch-mtime', confidence: 0.20, severity: 'medium', matchedSignals: [], weight: 1.0 },
        ];
      });
      const loop = buildLoop({ categorizer });

      const result = await loop.run({
        failures: [
          { stderr: 'reporter exit 0 FAIL' },
          { stderr: 'UV_HANDLE_CLOSING' },
          { stderr: 'reporter exit 0 FAIL again' },
        ],
      });

      expect(result.categorizedFailures).toHaveLength(3);
      // top-1 only — second-place tz-mismatch should NOT appear
      expect(result.categorizedFailures.map((c) => c.categoryId)).toEqual([
        'ci-exit-mask',
        'libuv-handle-closing',
        'ci-exit-mask',
      ]);
      expect(result.categoryDistribution).toEqual({
        'ci-exit-mask': 2,
        'libuv-handle-closing': 1,
      });
    });

    it('emits an entry with categoryId, confidence, and severity only', async () => {
      const categorizer = vi.fn(async () => [{
        categoryId: 'ci-exit-mask',
        confidence: 0.9,
        severity: 'high',
        matchedSignals: [{ type: 'regex', pattern: 'reporter exit 0' }],
        weight: 1.0,
      }]);
      const loop = buildLoop({ categorizer });

      const result = await loop.run({ failures: [{ stderr: 'reporter exit 0' }] });

      expect(result.categorizedFailures).toHaveLength(1);
      const entry = result.categorizedFailures[0];
      expect(entry).toEqual({ categoryId: 'ci-exit-mask', confidence: 0.9, severity: 'high' });
      // matchedSignals/weight should NOT leak through the result
      expect(entry).not.toHaveProperty('matchedSignals');
      expect(entry).not.toHaveProperty('weight');
    });

    it('skips failures whose categorizer returns an empty array', async () => {
      const categorizer = vi.fn(async (failure) => {
        return failure.stderr === 'no-match' ? [] : [
          { categoryId: 'ci-exit-mask', confidence: 0.9, severity: 'high' },
        ];
      });
      const loop = buildLoop({ categorizer });

      const result = await loop.run({
        failures: [
          { stderr: 'reporter exit 0 FAIL' },
          { stderr: 'no-match' },
          { stderr: 'reporter exit 0 FAIL' },
        ],
      });

      expect(result.categorizedFailures).toHaveLength(2);
      expect(result.categoryDistribution).toEqual({ 'ci-exit-mask': 2 });
    });
  });

  // -------------------------------------------------------------------------
  describe('categorizer invocation', () => {
    it('passes each failure context through to the categorizer', async () => {
      const categorizer = vi.fn(async () => []);
      const loop = buildLoop({ categorizer });

      const failures = [
        { stderr: 'a', files: ['x.js'] },
        { stdout: 'b' },
        { diff: 'c' },
      ];
      await loop.run({ failures });

      expect(categorizer).toHaveBeenCalledTimes(3);
      expect(categorizer).toHaveBeenNthCalledWith(1, failures[0]);
      expect(categorizer).toHaveBeenNthCalledWith(2, failures[1]);
      expect(categorizer).toHaveBeenNthCalledWith(3, failures[2]);
    });
  });

  // -------------------------------------------------------------------------
  describe('resilience', () => {
    it('records the error and continues when a single failure categorization throws', async () => {
      const categorizer = vi.fn(async (failure) => {
        if (failure.stderr === 'boom') throw new Error('regex compile failed');
        return [{ categoryId: 'ci-exit-mask', confidence: 0.8, severity: 'high' }];
      });
      const loop = buildLoop({ categorizer });

      const result = await loop.run({
        failures: [
          { stderr: 'reporter exit 0 FAIL' },
          { stderr: 'boom' },
          { stderr: 'reporter exit 0 FAIL again' },
        ],
      });

      expect(result.categorizedFailures).toHaveLength(2);
      expect(result.categoryDistribution).toEqual({ 'ci-exit-mask': 2 });

      const catErrors = result.errors.filter((e) => e.stage === 'categorize');
      expect(catErrors).toHaveLength(1);
      expect(catErrors[0].message).toBe('regex compile failed');
    });

    it('keeps earlier stages intact when Stage 6 errors', async () => {
      const categorizer = vi.fn(async () => { throw new Error('all categorization broken'); });
      const loop = buildLoop({ categorizer });

      const result = await loop.run({
        events: [{ type: 'edit' }],
        skillUsages: [{ name: 'tdd-workflow', success: true }],
        failures: [{ stderr: 'x' }, { stderr: 'y' }],
      });

      // Stage 1-3 results survived
      expect(result.compressed).not.toBeNull();
      expect(result.graphNodes).toBe(3);
      expect(result.skillEvaluations).toHaveLength(1);

      // Per-failure errors captured (one per throw)
      const catErrors = result.errors.filter((e) => e.stage === 'categorize');
      expect(catErrors).toHaveLength(2);
      expect(result.categorizedFailures).toEqual([]);
      expect(result.categoryDistribution).toEqual({});
    });
  });
});
