/**
 * Unit tests for lib/learning/grpo/agent-policy.js (and its store split).
 *
 * Mocks core file / platform so tests interact with an in-memory store.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

vi.mock('../../../lib/core/file.js', () => {
  const store = new Map();
  return {
    __store: store,
    readJsonFile: vi.fn(async (p) => {
      const v = store.get(p);
      return v ? JSON.parse(v) : null;
    }),
    writeJsonFile: vi.fn(async (p, data) => {
      store.set(p, JSON.stringify(data));
    }),
    ensureDir: vi.fn(async () => {}),
  };
});

vi.mock('../../../lib/core/platform.js', () => ({
  getHomeDir: () => '/tmp/artibot-agent-test-home',
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual('node:fs/promises');
  return {
    ...actual,
    readdir: vi.fn(async () => []),
    stat: vi.fn(async () => ({ mtimeMs: Date.now() })),
    unlink: vi.fn(async () => {}),
  };
});

const file = await import('../../../lib/core/file.js');
const {
  softmax,
  clipWeights,
  computeAdvantages,
  klFromPrev,
  klTotal,
  baselineAgentFor,
  defaultCandidates,
  selectAgent,
  normalizeEpisode,
  groupByFamily,
  updatePolicy,
  evaluatePolicy,
  getRecommendation,
  resolvePolicyPaths,
  loadPolicy,
  savePolicy,
  snapshot,
  listSnapshots,
  createAgentPolicy,
} = await import('../../../lib/learning/grpo/agent-policy.js');

function resetStore() {
  file.__store.clear();
}

const BASE_CONFIG = {
  agents: {
    taskBased: {
      'code review': 'code-reviewer',
      refactor: 'refactor-cleaner',
      plan: 'planner',
    },
  },
};

function makeEpisode(overrides = {}) {
  return {
    reward: 0.5,
    taskFamily: 'refactor',
    selectedAgent: 'refactor-cleaner',
    candidates: ['refactor-cleaner', 'backend-developer'],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  process.env.NODE_ENV = 'test';
});

// ---------------------------------------------------------------------------
// Math primitives
// ---------------------------------------------------------------------------

describe('softmax', () => {
  it('returns empty array for empty input', () => {
    expect(softmax([])).toEqual([]);
  });

  it('produces a probability distribution summing to 1', () => {
    const p = softmax([1, 2, 3]);
    const sum = p.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
    expect(p.every((v) => v >= 0 && v <= 1)).toBe(true);
  });

  it('temperature = Infinity approximates uniform', () => {
    const p = softmax([1, 2, 3], 1e9);
    expect(Math.max(...p) - Math.min(...p)).toBeLessThan(1e-6);
  });

  it('low temperature sharpens the distribution', () => {
    const sharp = softmax([0, 1], 0.01);
    expect(sharp[1]).toBeGreaterThan(0.99);
  });

  it('handles NaN and Infinity gracefully', () => {
    const p = softmax([NaN, 1, 2]);
    expect(p.every((v) => Number.isFinite(v))).toBe(true);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it('is numerically stable for very large logits', () => {
    const p = softmax([1000, 1001, 1002]);
    expect(p.every((v) => Number.isFinite(v))).toBe(true);
    expect(p[2]).toBeGreaterThan(p[0]);
  });
});

describe('clipWeights', () => {
  it('clips finite values to [-range, range] and zeroes non-finite inputs', () => {
    // Infinity / NaN are not finite -> mapped to 0; 10 -> 5, -10 -> -5.
    expect(clipWeights([10, -10, 1, Infinity, -Infinity, NaN], 5))
      .toEqual([5, -5, 1, 0, 0, 0]);
  });
});

describe('computeAdvantages', () => {
  it('returns empty for empty', () => {
    expect(computeAdvantages([])).toEqual([]);
  });

  it('yields 0 for singletons', () => {
    expect(computeAdvantages([0.5])).toEqual([0]);
  });

  it('is mean-zero for symmetric rewards', () => {
    const adv = computeAdvantages([1, 0, -1]);
    expect(adv.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 10);
  });

  it('epsilon-guards zero-variance groups', () => {
    expect(computeAdvantages([0.3, 0.3, 0.3]).every((v) => v === 0)).toBe(true);
  });

  it('assigns positive advantage to above-mean reward', () => {
    const adv = computeAdvantages([0.1, 0.2, 0.9]);
    expect(adv[2]).toBeGreaterThan(0);
    expect(adv[0]).toBeLessThan(0);
  });
});

describe('klFromPrev / klTotal', () => {
  it('klFromPrev is 0 for identical vectors', () => {
    expect(klFromPrev([1, 2, 3], [1, 2, 3])).toBe(0);
  });

  it('klFromPrev increases with divergence', () => {
    const a = klFromPrev([1, 1, 1], [0, 0, 0]);
    const b = klFromPrev([2, 2, 2], [0, 0, 0]);
    expect(b).toBeGreaterThan(a);
  });

  it('klTotal sums per-family divergence, ignoring __count__', () => {
    const next = { refactor: { 'refactor-cleaner': 1, __count__: 5 } };
    const prev = { refactor: { 'refactor-cleaner': 0, __count__: 0 } };
    expect(klTotal(next, prev)).toBeCloseTo(1, 10);
  });

  it('klTotal handles missing prev family as origin', () => {
    const next = { plan: { planner: 0.5 } };
    const out = klTotal(next, {});
    expect(out).toBeCloseTo(0.25, 10);
  });
});

// ---------------------------------------------------------------------------
// Baseline fallback
// ---------------------------------------------------------------------------

describe('baselineAgentFor + defaultCandidates', () => {
  it('reads agents.taskBased[family]', () => {
    expect(baselineAgentFor(BASE_CONFIG, 'refactor')).toBe('refactor-cleaner');
    expect(baselineAgentFor(BASE_CONFIG, 'unknown-family')).toBeNull();
    expect(baselineAgentFor(null, 'x')).toBeNull();
  });

  it('defaultCandidates unions learned + baseline', () => {
    const weights = { refactor: { 'refactor-cleaner': 0.5, 'backend-developer': 0.2 } };
    const cands = defaultCandidates(weights, 'refactor', BASE_CONFIG);
    expect(cands).toContain('refactor-cleaner');
    expect(cands).toContain('backend-developer');
  });

  it('defaultCandidates falls back to all taskBased values when untrained', () => {
    const cands = defaultCandidates({}, 'unknown', BASE_CONFIG);
    expect(cands).toContain('code-reviewer');
    expect(cands).toContain('refactor-cleaner');
    expect(cands).toContain('planner');
  });

  it('defaultCandidates returns [] when no config + no weights', () => {
    expect(defaultCandidates({}, 'x')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// selectAgent
// ---------------------------------------------------------------------------

describe('selectAgent', () => {
  it('returns null agent when no candidates exist', () => {
    const out = selectAgent({}, 'unknown');
    expect(out.agent).toBeNull();
    expect(out.source).toBe('fallback');
  });

  it('falls back to baseline when family untrained', () => {
    const out = selectAgent({}, 'refactor', { config: BASE_CONFIG });
    expect(out.agent).toBe('refactor-cleaner');
    expect(out.source).toBe('baseline');
  });

  it('uses softmax argmax after enough evidence', () => {
    const weights = {
      refactor: { 'refactor-cleaner': 2.0, 'backend-developer': 0.0, __count__: 10 },
    };
    const out = selectAgent(weights, 'refactor', { config: BASE_CONFIG });
    expect(out.source).toBe('policy');
    expect(out.agent).toBe('refactor-cleaner');
    expect(out.distribution.find((d) => d.agent === 'refactor-cleaner').prob)
      .toBeGreaterThan(0.5);
  });

  it('temperature flattens the distribution (uniform -> low confidence)', () => {
    const weights = {
      refactor: { 'refactor-cleaner': 2.0, 'backend-developer': 0.0, __count__: 10 },
    };
    const flat = selectAgent(weights, 'refactor', { config: BASE_CONFIG, temperature: 1e6 });
    expect(flat.confidence).toBeLessThan(0.1);
  });

  it('respects explicit candidate override', () => {
    const weights = {
      refactor: { 'refactor-cleaner': 5, 'backend-developer': 0, __count__: 10 },
    };
    const out = selectAgent(weights, 'refactor', {
      config: BASE_CONFIG,
      candidates: ['backend-developer', 'planner'],
    });
    expect(out.distribution.map((d) => d.agent).sort())
      .toEqual(['backend-developer', 'planner']);
  });
});

// ---------------------------------------------------------------------------
// Episode + grouping
// ---------------------------------------------------------------------------

describe('normalizeEpisode + groupByFamily', () => {
  it('returns null for missing reward / family / agent', () => {
    expect(normalizeEpisode(null)).toBeNull();
    expect(normalizeEpisode({})).toBeNull();
    expect(normalizeEpisode({ reward: 1 })).toBeNull();
    expect(normalizeEpisode({ reward: 1, taskFamily: 'x' })).toBeNull();
  });

  it('maps fields to canonical shape', () => {
    const out = normalizeEpisode(makeEpisode());
    expect(out.family).toBe('refactor');
    expect(out.agent).toBe('refactor-cleaner');
    expect(out.reward).toBe(0.5);
    expect(out.exploration).toBe(false);
  });

  it('flags exploration', () => {
    const out = normalizeEpisode(makeEpisode({ isExploration: true }));
    expect(out.exploration).toBe(true);
  });

  it('groupByFamily buckets, skipping malformed', () => {
    const g = groupByFamily([
      makeEpisode(),
      makeEpisode({ taskFamily: 'plan', selectedAgent: 'planner' }),
      { reward: NaN },
      null,
    ]);
    expect(g.get('refactor')).toHaveLength(1);
    expect(g.get('plan')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// updatePolicy
// ---------------------------------------------------------------------------

describe('updatePolicy', () => {
  it('pushes weights toward rewarded agents within a family', () => {
    const eps = [];
    for (let i = 0; i < 10; i++) {
      eps.push(makeEpisode({ reward: 1 })); // refactor-cleaner
    }
    for (let i = 0; i < 10; i++) {
      eps.push(makeEpisode({
        reward: -1,
        selectedAgent: 'backend-developer',
      }));
    }
    const out = updatePolicy(eps, {}, { learningRate: 0.5, klPenalty: 0 });
    expect(out.familiesTouched).toBe(1);
    const rf = out.weights.refactor;
    expect(rf['refactor-cleaner']).toBeGreaterThan(rf['backend-developer']);
  });

  it('skips exploration-flagged episodes from the gradient', () => {
    const eps = [
      makeEpisode({ reward: 1, isExploration: true }),
      makeEpisode({ reward: 1, isExploration: true }),
    ];
    const out = updatePolicy(eps, {});
    expect(out.explorationSkipped).toBe(2);
    expect(out.episodesUsed).toBe(0);
  });

  it('isolates families: updating one family does not touch another', () => {
    const prev = {
      plan: { planner: 0.7, __count__: 5 },
    };
    const eps = [makeEpisode({ reward: 1 }), makeEpisode({ reward: 1 })];
    const out = updatePolicy(eps, prev, { learningRate: 0.5, klPenalty: 0 });
    expect(out.weights.plan.planner).toBe(0.7);
    expect(out.weights.refactor).toBeDefined();
  });

  it('KL penalty shrinks toward previous weights', () => {
    const prev = {
      refactor: { 'refactor-cleaner': 1.0, 'backend-developer': 0.0, __count__: 20 },
    };
    const eps = [];
    for (let i = 0; i < 5; i++) eps.push(makeEpisode({ reward: 0.5 }));
    const strong = updatePolicy(eps, prev, { klPenalty: 1.0, learningRate: 0 });
    // learningRate=0 means only KL shrinkage fires. weights shrink toward prev, so they equal prev.
    expect(strong.weights.refactor['refactor-cleaner']).toBeCloseTo(1.0, 10);
  });

  it('clips weights to [-5, +5] after aggressive updates', () => {
    const eps = [];
    for (let i = 0; i < 50; i++) eps.push(makeEpisode({ reward: 100 }));
    const out = updatePolicy(eps, {}, { learningRate: 1000, klPenalty: 0, iterations: 3 });
    const vals = Object.entries(out.weights.refactor)
      .filter(([k]) => k !== '__count__')
      .map(([, v]) => v);
    for (const v of vals) expect(Math.abs(v)).toBeLessThanOrEqual(5 + 1e-9);
  });

  it('increments __count__ by the number of trainable episodes', () => {
    const eps = [makeEpisode(), makeEpisode(), makeEpisode({ isExploration: true })];
    const out = updatePolicy(eps, {}, { learningRate: 0.1, klPenalty: 0 });
    expect(out.weights.refactor.__count__).toBe(2);
  });

  it('returns base weights when episodes are empty', () => {
    const prev = { x: { a: 1 } };
    const out = updatePolicy([], prev);
    expect(out.weights).toEqual(prev);
    expect(out.episodesUsed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// evaluatePolicy
// ---------------------------------------------------------------------------

describe('evaluatePolicy', () => {
  it('returns zero samples when held-out is empty', () => {
    const m = evaluatePolicy({}, []);
    expect(m.samples).toBe(0);
  });

  it('measures logLoss and accuracy on a trained toy set', () => {
    const eps = [];
    for (let i = 0; i < 30; i++) eps.push(makeEpisode({ reward: 1 }));
    for (let i = 0; i < 30; i++) {
      eps.push(makeEpisode({
        reward: -1,
        selectedAgent: 'backend-developer',
      }));
    }
    const trained = updatePolicy(eps, {}, { learningRate: 1.0, klPenalty: 0, iterations: 5 });
    const metrics = evaluatePolicy(trained.weights, eps);
    expect(metrics.samples).toBe(60);
    expect(metrics.logLoss).toBeGreaterThan(0);
    expect(metrics.accuracyVsBaseline).toBeGreaterThanOrEqual(0);
    expect(metrics.accuracyVsBaseline).toBeLessThanOrEqual(1);
  });

  it('klFromPrev increases when weights diverge', () => {
    const prev = { refactor: { 'refactor-cleaner': 0, 'backend-developer': 0, __count__: 0 } };
    const next = { refactor: { 'refactor-cleaner': 2, 'backend-developer': -2, __count__: 10 } };
    const m = evaluatePolicy(next, [makeEpisode()], prev);
    expect(m.klFromPrev).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('persistence', () => {
  it('resolvePolicyPaths defaults to ~/.claude/artibot/policies/', () => {
    const paths = resolvePolicyPaths();
    expect(paths.policyFile.endsWith('agent-policy-v1.json')).toBe(true);
    expect(paths.snapshotDir.endsWith(`policies${path.sep}agent-snapshots`)).toBe(true);
  });

  it('resolvePolicyPaths honors absolute overrides', () => {
    const p = path.resolve('/tmp/my-agent-policy.json');
    expect(resolvePolicyPaths(p).policyFile).toBe(p);
  });

  it('savePolicy writes a record + snapshot', async () => {
    const weights = { refactor: { 'refactor-cleaner': 0.3, __count__: 5 } };
    const out = await savePolicy(weights, {
      logLoss: 0.5, accuracyVsBaseline: 0.8, klFromPrev: 0.02,
    }, { trainedOnEpisodes: 42 });
    expect(out.policy.weights).toEqual(weights);
    expect(out.policy.version).toBe(1);
    expect(out.policy.modelType).toBe('softmax-weights');
    expect(out.policy.trainedOnEpisodes).toBe(42);
    expect(out.snapshotId).toMatch(/^agent-v1-/);
    expect(file.writeJsonFile).toHaveBeenCalledTimes(2);
  });

  it('loadPolicy returns null for missing / malformed files', async () => {
    expect(await loadPolicy()).toBeNull();
    file.__store.set(resolvePolicyPaths().policyFile, JSON.stringify({ bogus: true }));
    expect(await loadPolicy()).toBeNull();
  });

  it('loadPolicy round-trips a saved policy', async () => {
    const weights = { plan: { planner: 0.9, __count__: 3 } };
    await savePolicy(weights, { logLoss: 0.5, accuracyVsBaseline: 0.8, klFromPrev: 0 });
    const loaded = await loadPolicy();
    expect(loaded.weights).toEqual(weights);
  });

  it('snapshot() writes to agent-snapshots/ with the given id', async () => {
    const f = await snapshot({ x: { a: 1 } }, 'test-id');
    expect(f.endsWith('test-id.json')).toBe(true);
    expect(file.writeJsonFile).toHaveBeenCalled();
  });

  it('listSnapshots returns [] when directory is empty', async () => {
    const out = await listSnapshots();
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getRecommendation
// ---------------------------------------------------------------------------

describe('getRecommendation', () => {
  it('returns baseline + topK=1 when untrained', () => {
    const out = getRecommendation({}, 'refactor', { config: BASE_CONFIG, topK: 1 });
    expect(out.recommendation).toBe('refactor-cleaner');
    expect(out.source).toBe('baseline');
    expect(out.alternatives).toHaveLength(1);
  });

  it('returns policy source with confidence > 0 when trained', () => {
    const weights = {
      refactor: { 'refactor-cleaner': 3, 'backend-developer': 0, __count__: 20 },
    };
    const out = getRecommendation(weights, 'refactor', { config: BASE_CONFIG, topK: 2 });
    expect(out.source).toBe('policy');
    expect(out.confidence).toBeGreaterThan(0);
    expect(out.alternatives).toHaveLength(2);
    expect(out.alternatives[0].agent).toBe('refactor-cleaner');
  });

  it('returns recommendation=null with no config + no weights', () => {
    const out = getRecommendation({}, 'x');
    expect(out.recommendation).toBeNull();
    expect(out.source).toBe('fallback');
  });
});

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

describe('createAgentPolicy facade', () => {
  it('selectAgent falls back to baseline when no policy exists', async () => {
    const p = createAgentPolicy({ baseConfig: BASE_CONFIG });
    const out = await p.selectAgent('refactor');
    expect(out.source).toBe('baseline');
    expect(out.agent).toBe('refactor-cleaner');
  });

  it('trains and then selects from policy', async () => {
    const p = createAgentPolicy({
      baseConfig: BASE_CONFIG,
      config: { learningRate: 1.0, klPenalty: 0, minFamilyOccurrences: 3 },
    });
    const eps = [];
    for (let i = 0; i < 10; i++) eps.push(makeEpisode({ reward: 1 }));
    for (let i = 0; i < 10; i++) {
      eps.push(makeEpisode({ reward: -1, selectedAgent: 'backend-developer' }));
    }
    const res = await p.trainFromEpisodes(eps);
    expect(res.policy).toBeTruthy();
    const pick = await p.selectAgent('refactor');
    expect(pick.source).toBe('policy');
    expect(pick.agent).toBe('refactor-cleaner');
  });

  it('skips persistence with no trainable episodes', async () => {
    const p = createAgentPolicy();
    const res = await p.trainFromEpisodes([
      makeEpisode({ isExploration: true }),
      makeEpisode({ isExploration: true }),
    ]);
    expect(res.metrics.reason).toBe('no-trainable-episodes');
  });

  it('rejects update when KL exceeds threshold', async () => {
    // Seed a baseline policy with low weights
    await savePolicy(
      { refactor: { 'refactor-cleaner': 0, 'backend-developer': 0, __count__: 50 } },
      { logLoss: 0.5, accuracyVsBaseline: 0.7, klFromPrev: 0 },
    );
    const p = createAgentPolicy({
      baseConfig: BASE_CONFIG,
      config: { learningRate: 10, klPenalty: 0, klRejectThreshold: 0.0001 },
    });
    const eps = [];
    for (let i = 0; i < 20; i++) eps.push(makeEpisode({ reward: 1 }));
    for (let i = 0; i < 20; i++) {
      eps.push(makeEpisode({ reward: -1, selectedAgent: 'backend-developer' }));
    }
    const res = await p.trainFromEpisodes(eps);
    expect(res.rejected).toBe('kl-threshold');
  });

  it('getRecommendation is available from facade', async () => {
    const p = createAgentPolicy({ baseConfig: BASE_CONFIG });
    const out = await p.getRecommendation('refactor', { topK: 2 });
    expect(out.recommendation).toBe('refactor-cleaner');
    expect(out.alternatives.length).toBeGreaterThan(0);
  });
});
