import { describe, expect, it, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock swarm modules (must be before import of evolution-loop)
// ---------------------------------------------------------------------------

vi.mock('../../lib/swarm/collective-hub.js', () => ({
  qualifyPattern: vi.fn((pattern, config) => ({
    qualified:
      pattern.successRate >= (config.minSuccessRate || 0.6) &&
      pattern.usageCount >= (config.minUsageCount || 5),
    reasons: [],
  })),
  buildContribution: vi.fn((patterns, config) => {
    if (!config.optIn || !Array.isArray(patterns) || patterns.length === 0) return null;
    const minSuccess = config.minSuccessRate ?? 0.6;
    const minUsage = config.minUsageCount ?? 5;
    const qualified = patterns.filter(
      (p) => p.successRate >= minSuccess && p.usageCount >= minUsage,
    );
    if (qualified.length === 0) return null;
    return {
      batchId: 'test-batch-001',
      patterns: qualified.map((p) => ({
        id: `hash-${p.name}`,
        type: p.type,
        signature: `sig-${p.name}`,
        successRate: p.successRate,
        usageCount: p.usageCount,
        contributorCount: 1,
        score: 0,
        lastUpdated: new Date().toISOString(),
      })),
      instanceHash: 'test-instance-hash',
      timestamp: new Date().toISOString(),
      optIn: true,
    };
  }),
}));

vi.mock('../../lib/swarm/swarm-persistence.js', () => ({
  saveToDisk: vi.fn(async () => {}),
  loadFromDisk: vi.fn(async () => ({ patterns: [] })),
}));

import { createEvolutionLoop } from '../../lib/learning/evolution-loop.js';
import { buildContribution } from '../../lib/swarm/collective-hub.js';
import { saveToDisk, loadFromDisk } from '../../lib/swarm/swarm-persistence.js';

// ---------------------------------------------------------------------------
// Mock factories (same as existing test file for Stages 1-4)
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
        keywords: ['frontend', 'component'],
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

function createMockSkillEvolver(overrides = {}) {
  const successRate = overrides.successRate ?? 0.85;
  const usageCount = overrides.usageCount ?? 10;
  const tracked = [];
  return {
    track(name, outcome) { tracked.push({ name, outcome }); },
    evaluate() { return { successRate, usageCount, avgEditDistance: 2, trend: 0.1 }; },
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

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function buildLoop(overrides = {}) {
  return createEvolutionLoop({
    sessionMemory: createMockSessionMemory(),
    knowledgeGraph: createMockKnowledgeGraph(),
    skillEvolver: createMockSkillEvolver(overrides.skillEvolverOpts),
    autoResearch: createMockAutoResearch(),
    hubConfig: overrides.hubConfig,
    ...overrides,
  });
}

function defaultSkillUsages() {
  return [
    { name: 'tdd-workflow', invoked: true, success: true, userEdited: false, editDistance: 0 },
    { name: 'coding-standards', invoked: true, success: true, userEdited: false, editDistance: 1 },
  ];
}

// ---------------------------------------------------------------------------
describe('createEvolutionLoop — Stage 5: collective contribution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadFromDisk.mockResolvedValue({ patterns: [] });
    saveToDisk.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  it('contributes patterns when optIn is true and evaluations qualify', async () => {
    const loop = buildLoop({
      hubConfig: { optIn: true, minUsageCount: 5, minSuccessRate: 0.6 },
      skillEvolverOpts: { successRate: 0.85, usageCount: 10 },
    });

    const result = await loop.run({ skillUsages: defaultSkillUsages() });

    expect(result.contribution).not.toBeNull();
    expect(result.contribution.patternsShared).toBeGreaterThan(0);
    expect(result.contribution.batchId).toBe('test-batch-001');

    // buildContribution should have been called with qualified patterns
    expect(buildContribution).toHaveBeenCalledTimes(1);
    const [patterns, config] = buildContribution.mock.calls[0];
    expect(patterns.length).toBeGreaterThan(0);
    expect(config.optIn).toBe(true);

    // saveToDisk should have been called to persist
    expect(saveToDisk).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  it('skips contribution when optIn is false', async () => {
    const loop = buildLoop({
      hubConfig: { optIn: false, minUsageCount: 5, minSuccessRate: 0.6 },
      skillEvolverOpts: { successRate: 0.85, usageCount: 10 },
    });

    const result = await loop.run({ skillUsages: defaultSkillUsages() });

    expect(result.contribution).toBeNull();
    expect(buildContribution).not.toHaveBeenCalled();
    expect(saveToDisk).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  it('skips contribution when no skill evaluations qualify', async () => {
    // usageCount from evolver is 3, below minUsageCount of 10
    const loop = buildLoop({
      hubConfig: { optIn: true, minUsageCount: 10, minSuccessRate: 0.6 },
      skillEvolverOpts: { successRate: 0.85, usageCount: 3 },
    });

    const result = await loop.run({ skillUsages: defaultSkillUsages() });

    // Stage 5 filters by usageCount >= minUsageCount before calling buildContribution.
    // With usageCount 3 and minUsageCount 10, no patterns pass the pre-filter,
    // so either buildContribution is not called or returns null.
    expect(result.contribution).toBeNull();
    expect(saveToDisk).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  it('does not block other stages when Stage 5 fails', async () => {
    saveToDisk.mockRejectedValue(new Error('disk write failed'));

    const loop = buildLoop({
      hubConfig: { optIn: true, minUsageCount: 5, minSuccessRate: 0.6 },
      skillEvolverOpts: { successRate: 0.85, usageCount: 10 },
    });

    const result = await loop.run({
      events: [{ type: 'edit', file: 'app.js' }],
      skillUsages: defaultSkillUsages(),
    });

    // Stage 5 error is captured
    const contributeError = result.errors.find((e) => e.stage === 'contribute');
    expect(contributeError).toBeDefined();
    expect(contributeError.message).toBe('disk write failed');

    // Earlier stages still completed
    expect(result.compressed).not.toBeNull();
    expect(result.skillEvaluations.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  it('appends to existing patterns in the store', async () => {
    const existingPatterns = [
      { id: 'existing-1', type: 'skill', successRate: 0.9, usageCount: 20 },
      { id: 'existing-2', type: 'skill', successRate: 0.7, usageCount: 15 },
    ];
    loadFromDisk.mockResolvedValue({ patterns: existingPatterns });

    const loop = buildLoop({
      hubConfig: { optIn: true, minUsageCount: 5, minSuccessRate: 0.6 },
      skillEvolverOpts: { successRate: 0.85, usageCount: 10 },
    });

    await loop.run({ skillUsages: defaultSkillUsages() });

    expect(saveToDisk).toHaveBeenCalledTimes(1);
    const savedArg = saveToDisk.mock.calls[0][0];

    // Merged array should contain existing + new patterns
    expect(savedArg.patterns.length).toBeGreaterThan(existingPatterns.length);

    // Existing patterns should be preserved at the front
    expect(savedArg.patterns[0]).toEqual(existingPatterns[0]);
    expect(savedArg.patterns[1]).toEqual(existingPatterns[1]);
  });
});
