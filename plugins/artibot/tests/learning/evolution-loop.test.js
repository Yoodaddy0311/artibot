import { describe, expect, it } from 'vitest';
import { createEvolutionLoop } from '../../lib/learning/evolution-loop.js';

// ---------------------------------------------------------------------------
// Mock factories
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

function createMockAutoResearch(shouldTrigger = false) {
  return {
    shouldResearch() { return shouldTrigger; },
    scope(q) { return { keywords: [q], sources: new Set(['memory']), query: q }; },
    async gather() { return { web: [], codebase: [], memory: [], durationMs: 10 }; },
    synthesize() { return { items: [{ content: 'finding', source: 'memory', relevance: 0.8, quality: 0.7 }], totalScore: 0.75 }; },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildLoop(overrides = {}) {
  return createEvolutionLoop({
    sessionMemory: createMockSessionMemory(),
    knowledgeGraph: createMockKnowledgeGraph(),
    skillEvolver: createMockSkillEvolver(),
    autoResearch: createMockAutoResearch(overrides.shouldResearch ?? false),
    now: overrides.now,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
describe('createEvolutionLoop', () => {
  // -----------------------------------------------------------------------
  describe('run() — compress stage', () => {
    it('compresses session memory when events are provided', async () => {
      const loop = buildLoop();
      const result = await loop.run({
        events: [{ type: 'edit', file: 'app.js' }],
      });

      expect(result.compressed).not.toBeNull();
      expect(result.compressed.id).toBe('mem-1');
      expect(result.compressed.sessionId).toBe('test-session');
      expect(result.compressed.keywords).toEqual(['frontend', 'component', 'react']);
    });

    it('returns null compressed when no events are provided', async () => {
      const loop = buildLoop();
      const result = await loop.run({});

      expect(result.compressed).toBeNull();
      expect(result.graphNodes).toBe(0);
      expect(result.graphEdges).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  describe('run() — ingest stage', () => {
    it('extracts keywords as nodes into knowledge graph', async () => {
      const kg = createMockKnowledgeGraph();
      const loop = createEvolutionLoop({
        sessionMemory: createMockSessionMemory(),
        knowledgeGraph: kg,
        skillEvolver: createMockSkillEvolver(),
        autoResearch: createMockAutoResearch(false),
      });

      await loop.run({ events: [{ type: 'edit' }] });

      const nodes = kg.getNodes();
      expect(nodes).toHaveLength(3);
      expect(nodes[0].id).toBe('kw-frontend');
      expect(nodes[1].id).toBe('kw-component');
      expect(nodes[2].id).toBe('kw-react');
    });

    it('builds co-occurrence edges between all keyword pairs', async () => {
      const kg = createMockKnowledgeGraph();
      const loop = createEvolutionLoop({
        sessionMemory: createMockSessionMemory(),
        knowledgeGraph: kg,
        skillEvolver: createMockSkillEvolver(),
        autoResearch: createMockAutoResearch(false),
      });

      await loop.run({ events: [{ type: 'edit' }] });

      // 3 keywords => C(3,2) = 3 edges: AB, AC, BC
      const edges = kg.getEdges();
      expect(edges).toHaveLength(3);
      expect(edges[0]).toMatchObject({ from: 'kw-frontend', to: 'kw-component' });
      expect(edges[1]).toMatchObject({ from: 'kw-frontend', to: 'kw-react' });
      expect(edges[2]).toMatchObject({ from: 'kw-component', to: 'kw-react' });
    });

    it('invokes knowledgeGraph.prune() with configured maxAgeDays before save (audit #2)', async () => {
      const calls = [];
      const kg = {
        addNode() {},
        addEdge() {},
        prune(days) { calls.push({ op: 'prune', days }); return 2; },
        async save() { calls.push({ op: 'save' }); },
      };
      const loop = createEvolutionLoop({
        sessionMemory: createMockSessionMemory(),
        knowledgeGraph: kg,
        skillEvolver: createMockSkillEvolver(),
        autoResearch: createMockAutoResearch(false),
        graphPruneMaxAgeDays: 30,
      });

      const result = await loop.run({ events: [{ type: 'edit' }] });

      const pruneIdx = calls.findIndex((c) => c.op === 'prune');
      const saveIdx = calls.findIndex((c) => c.op === 'save');
      expect(pruneIdx).toBeGreaterThanOrEqual(0);
      expect(saveIdx).toBeGreaterThan(pruneIdx);
      expect(calls[pruneIdx].days).toBe(30);
      expect(result.graphPruned).toBe(2);
    });

    it('defaults prune maxAgeDays to 90 when not supplied', async () => {
      const calls = [];
      const kg = {
        addNode() {}, addEdge() {},
        prune(days) { calls.push(days); return 0; },
      };
      const loop = createEvolutionLoop({
        sessionMemory: createMockSessionMemory(),
        knowledgeGraph: kg,
        skillEvolver: createMockSkillEvolver(),
        autoResearch: createMockAutoResearch(false),
      });
      await loop.run({ events: [{ type: 'edit' }] });
      expect(calls[0]).toBe(90);
    });

    it('records prune error and continues when prune throws', async () => {
      const kg = {
        addNode() {}, addEdge() {},
        prune() { throw new Error('graph corrupted'); },
        async save() {},
      };
      const loop = createEvolutionLoop({
        sessionMemory: createMockSessionMemory(),
        knowledgeGraph: kg,
        skillEvolver: createMockSkillEvolver(),
        autoResearch: createMockAutoResearch(false),
      });
      const result = await loop.run({ events: [{ type: 'edit' }] });
      expect(result.errors.some((e) => e.stage === 'prune')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  describe('run() — evaluate stage', () => {
    it('tracks and evaluates skills when skillUsages are provided', async () => {
      const se = createMockSkillEvolver();
      const loop = createEvolutionLoop({
        sessionMemory: createMockSessionMemory(),
        knowledgeGraph: createMockKnowledgeGraph(),
        skillEvolver: se,
        autoResearch: createMockAutoResearch(false),
      });

      const result = await loop.run({
        skillUsages: [
          { name: 'tdd-workflow', invoked: true, success: true, userEdited: false, editDistance: 0 },
          { name: 'coding-standards', invoked: true, success: false, userEdited: true, editDistance: 5 },
        ],
      });

      expect(result.skillEvaluations).toHaveLength(2);
      expect(result.skillEvaluations[0].name).toBe('tdd-workflow');
      expect(result.skillEvaluations[0].classification).toBe('stable');
      expect(result.skillEvaluations[1].name).toBe('coding-standards');

      // Verify tracking happened
      const tracked = se.getTracked();
      expect(tracked).toHaveLength(2);
      expect(tracked[0].name).toBe('tdd-workflow');
      expect(tracked[1].name).toBe('coding-standards');
    });
  });

  // -----------------------------------------------------------------------
  describe('run() — research stage', () => {
    it('triggers auto-research when routing confidence is low', async () => {
      const loop = buildLoop({ shouldResearch: true });

      const result = await loop.run({
        routingResult: { input: 'explain quantum computing', confidence: 0.3 },
      });

      expect(result.researchTriggered).toBe(true);
      expect(result.researchFindings).not.toBeNull();
      expect(result.researchFindings.totalScore).toBe(0.75);
      expect(result.researchFindings.items).toHaveLength(1);
    });

    it('skips auto-research when routing confidence is high', async () => {
      const loop = buildLoop({ shouldResearch: false });

      const result = await loop.run({
        routingResult: { input: 'create a button', confidence: 0.95 },
      });

      expect(result.researchTriggered).toBe(false);
      expect(result.researchFindings).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  describe('run() — resilience', () => {
    it('stage failure does not block other stages', async () => {
      const throwingMemory = {
        capture() { throw new Error('memory exploded'); },
        async compress() { throw new Error('memory exploded'); },
      };

      const se = createMockSkillEvolver();
      const loop = createEvolutionLoop({
        sessionMemory: throwingMemory,
        knowledgeGraph: createMockKnowledgeGraph(),
        skillEvolver: se,
        autoResearch: createMockAutoResearch(false),
      });

      const result = await loop.run({
        events: [{ type: 'edit' }],
        skillUsages: [{ name: 'test-skill', success: true }],
      });

      // Compress stage failed
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].stage).toBe('compress');
      expect(result.errors[0].message).toBe('memory exploded');

      // But evaluate stage still ran
      expect(result.skillEvaluations).toHaveLength(1);
      expect(result.skillEvaluations[0].name).toBe('test-skill');
    });
  });

  // -----------------------------------------------------------------------
  describe('run() — result properties', () => {
    it('records durationMs', async () => {
      let tick = 1000;
      const loop = buildLoop({ now: () => tick++ });

      const result = await loop.run({ events: [{ type: 'edit' }] });

      expect(result.durationMs).toBeGreaterThan(0);
    });

    it('returns a frozen result object', async () => {
      const loop = buildLoop();
      const result = await loop.run({});

      expect(Object.isFrozen(result)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  describe('run() — research stage PII scrubbing', () => {
    it('scrubs the user-supplied query before passing it to scope()', async () => {
      const scopeCalls = [];
      const ar = {
        shouldResearch() { return true; },
        scope(q) { scopeCalls.push(q); return { keywords: [], sources: new Set(), query: q }; },
        async gather() { return { web: [], codebase: [], memory: [], durationMs: 0 }; },
        synthesize() { return null; },
      };
      const loop = createEvolutionLoop({
        sessionMemory: createMockSessionMemory(),
        knowledgeGraph: createMockKnowledgeGraph(),
        skillEvolver: createMockSkillEvolver(),
        autoResearch: ar,
      });

      // Use a path that PII scrubber must catch.
      const homePath = process.platform === 'win32'
        ? 'C:\\Users\\alice\\project\\foo.js error'
        : '/home/alice/project/foo.js error';
      await loop.run({ routingResult: { input: homePath, confidence: 0.1 } });

      expect(scopeCalls).toHaveLength(1);
      // Raw username must not survive into the searchFn-bound query.
      expect(scopeCalls[0]).not.toContain('alice');
    });
  });

  // -----------------------------------------------------------------------
  describe('sub-component getters', () => {
    it('exposes sessionMemory, knowledgeGraph, skillEvolver, autoResearch', () => {
      const sm = createMockSessionMemory();
      const kg = createMockKnowledgeGraph();
      const se = createMockSkillEvolver();
      const ar = createMockAutoResearch();

      const loop = createEvolutionLoop({
        sessionMemory: sm,
        knowledgeGraph: kg,
        skillEvolver: se,
        autoResearch: ar,
      });

      expect(loop.sessionMemory).toBe(sm);
      expect(loop.knowledgeGraph).toBe(kg);
      expect(loop.skillEvolver).toBe(se);
      expect(loop.autoResearch).toBe(ar);
    });
  });
});
