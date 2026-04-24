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
  getHomeDir: () => '/tmp/artibot-test-home',
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
  FEATURE_DIM,
  FEATURE_NAMES,
  DEFAULTS,
  sigmoid,
  dot,
  predict,
  clipTheta,
  buildFeatureVector,
  normalizeEpisode,
  groupEpisodes,
  computeAdvantages,
  logisticGradient,
  klShrinkage,
  klFromPrev,
  coldStartWarmup,
  trainBatch,
  evaluatePolicy,
  resolvePolicyPaths,
  loadPolicy,
  savePolicy,
  snapshot,
  listSnapshots,
  createPolicyUpdater,
} = await import('../../../lib/learning/grpo/policy-updater.js');

function resetStore() {
  file.__store.clear();
}

function makeEpisode(overrides = {}) {
  return {
    reward: 0.5,
    classification: {
      system: 1,
      factors: { steps: 0.2, domains: 0.3, uncertainty: 0.1, risk: 0.1, novelty: 0.2 },
    },
    context: { s1SuccessRate: 0.7, sessionDepth: 4, errorRateMa10: 0.1 },
    intentFamily: 'general',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

describe('primitive math', () => {
  it('sigmoid is monotonic and bounded', () => {
    expect(sigmoid(0)).toBeCloseTo(0.5, 10);
    expect(sigmoid(100)).toBeCloseTo(1, 5);
    expect(sigmoid(-100)).toBeCloseTo(0, 5);
    expect(sigmoid(1) > sigmoid(0)).toBe(true);
  });

  it('sigmoid has no overflow for large magnitudes', () => {
    expect(Number.isFinite(sigmoid(1000))).toBe(true);
    expect(Number.isFinite(sigmoid(-1000))).toBe(true);
  });

  it('dot returns 0 on mismatched inputs', () => {
    expect(dot([1, 2], [1])).toBe(0);
    expect(dot(null, [1])).toBe(0);
  });

  it('dot computes the classic inner product', () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
  });

  it('predict(theta, x) equals sigmoid(dot(theta, x))', () => {
    const theta = [0.1, 0.2, -0.3];
    const x = [1, -1, 0.5];
    expect(predict(theta, x)).toBeCloseTo(sigmoid(dot(theta, x)), 12);
  });

  it('clipTheta clips both sides to [-range, range]', () => {
    expect(clipTheta([10, -10, 1, Infinity, -Infinity, NaN], 5)).toEqual([5, -5, 1, 5, -5, 0]);
  });

  it('FEATURE_DIM is 9 and names line up', () => {
    expect(FEATURE_DIM).toBe(9);
    expect(FEATURE_NAMES).toHaveLength(9);
    expect(FEATURE_NAMES[FEATURE_NAMES.length - 1]).toBe('bias');
  });
});

describe('buildFeatureVector', () => {
  it('returns a 9-dim vector with bias=1 at tail', () => {
    const x = buildFeatureVector({ factors: { steps: 0.3 } }, { sessionDepth: 10 });
    expect(x).toHaveLength(9);
    expect(x[8]).toBe(1);
    expect(x[0]).toBe(0.3);
    expect(x[6]).toBeCloseTo(0.5, 5); // 10/20
  });

  it('clips inputs to [0, 1]', () => {
    const x = buildFeatureVector({
      factors: { steps: -1, domains: 2, uncertainty: 0.5, risk: 1.5, novelty: 0.3 },
    }, { s1SuccessRate: 99, sessionDepth: 999, errorRateMa10: -4 });
    for (let i = 0; i < 8; i++) {
      expect(x[i]).toBeGreaterThanOrEqual(0);
      expect(x[i]).toBeLessThanOrEqual(1);
    }
  });

  it('handles missing context gracefully', () => {
    const x = buildFeatureVector({ factors: {} });
    expect(x.every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('normalizeEpisode', () => {
  it('returns null when reward is missing', () => {
    expect(normalizeEpisode({ classification: { factors: {} } })).toBeNull();
  });

  it('returns null when reward is NaN', () => {
    expect(normalizeEpisode({ reward: NaN, classification: { factors: {} } })).toBeNull();
  });

  it('maps system=1 to label=0 and system=2 to label=1', () => {
    const a = normalizeEpisode(makeEpisode({ classification: { system: 1, factors: {} } }));
    const b = normalizeEpisode(makeEpisode({ classification: { system: 2, factors: {} } }));
    expect(a.label).toBe(0);
    expect(b.label).toBe(1);
  });

  it('builds group key from intentFamily + recentCommand', () => {
    const e = normalizeEpisode(makeEpisode({ intentFamily: 'refactor', recentCommand: 'implement' }));
    expect(e.group).toBe('refactor|implement');
  });

  it('flags exploration', () => {
    const e = normalizeEpisode(makeEpisode({ isExploration: true }));
    expect(e.exploration).toBe(true);
  });
});

describe('groupEpisodes', () => {
  it('buckets by group key, ignoring malformed entries', () => {
    const eps = [
      makeEpisode({ intentFamily: 'A' }),
      makeEpisode({ intentFamily: 'A' }),
      makeEpisode({ intentFamily: 'B' }),
      { reward: 'not-a-number' },
      null,
    ];
    const g = groupEpisodes(eps);
    expect(g.get('A')).toHaveLength(2);
    expect(g.get('B')).toHaveLength(1);
  });
});

describe('computeAdvantages', () => {
  it('yields zero advantage for singletons', () => {
    expect(computeAdvantages([0.5])).toEqual([0]);
  });

  it('is mean-zero for symmetric rewards', () => {
    const adv = computeAdvantages([1, 0, -1]);
    const sum = adv.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(0, 10);
  });

  it('assigns positive advantage to above-mean reward', () => {
    const adv = computeAdvantages([0.1, 0.2, 0.9]);
    expect(adv[2]).toBeGreaterThan(0);
    expect(adv[0]).toBeLessThan(0);
  });

  it('epsilon-guards zero-variance groups', () => {
    const adv = computeAdvantages([0.3, 0.3, 0.3]);
    expect(adv.every((v) => v === 0)).toBe(true);
  });
});

describe('logisticGradient', () => {
  it('is zero when prediction already matches the label', () => {
    // label=1, theta chosen so sigmoid is ~1
    const theta = [10, 0, 0];
    const x = [1, 0, 0];
    const grad = logisticGradient(theta, x, 1, 1);
    for (const g of grad) expect(Math.abs(g)).toBeLessThan(1e-3);
  });

  it('pushes theta toward the label', () => {
    const theta = [0, 0, 0];
    const x = [0.5, 0.5, 1];
    const gradPos = logisticGradient(theta, x, 1, 1);
    expect(gradPos.every((g, i) => g * x[i] >= 0)).toBe(true);
  });
});

describe('klShrinkage', () => {
  it('is all-zero when lambda is 0', () => {
    const s = klShrinkage([1, 2, 3], [0, 0, 0], 0);
    expect(s).toEqual([0, 0, 0]);
  });

  it('shrinks toward thetaPrev proportionally to lambda', () => {
    const s = klShrinkage([1, 2, 3], [0, 0, 0], 0.5);
    expect(s).toEqual([0.5, 1.0, 1.5]);
  });

  it('returns zero vector on length mismatch', () => {
    const s = klShrinkage([1, 2], [1], 0.5);
    expect(s).toEqual([0, 0]);
  });
});

describe('klFromPrev', () => {
  it('is zero for identical thetas', () => {
    expect(klFromPrev([1, 2, 3], [1, 2, 3])).toBe(0);
  });

  it('increases with divergence', () => {
    const a = klFromPrev([1, 1, 1], [1, 1, 1]);
    const b = klFromPrev([2, 2, 2], [1, 1, 1]);
    expect(b).toBeGreaterThan(a);
  });
});

describe('coldStartWarmup', () => {
  function manyEpisodes(n, label) {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(makeEpisode({
        classification: {
          system: label === 1 ? 2 : 1,
          factors: { steps: 0.5, domains: 0.3, uncertainty: 0.2, risk: 0.4, novelty: 0.1 },
        },
      }));
    }
    return out;
  }

  it('returns null when below minEpisodes threshold', () => {
    const res = coldStartWarmup(manyEpisodes(10, 0), { minEpisodes: 200 });
    expect(res).toBeNull();
  });

  it('fits heuristic labels with high agreement (>=0.95)', () => {
    // All episodes with system=2 (label=1) in distinguishable feature space
    const eps = [];
    for (let i = 0; i < 120; i++) {
      eps.push(makeEpisode({
        classification: {
          system: 2,
          factors: { steps: 0.8, domains: 0.8, uncertainty: 0.2, risk: 0.7, novelty: 0.3 },
        },
      }));
    }
    for (let i = 0; i < 120; i++) {
      eps.push(makeEpisode({
        classification: {
          system: 1,
          factors: { steps: 0.1, domains: 0.1, uncertainty: 0.05, risk: 0.0, novelty: 0.05 },
        },
      }));
    }
    const res = coldStartWarmup(eps, { minEpisodes: 200, iterations: 400, learningRate: 0.5 });
    expect(res).not.toBeNull();
    let correct = 0;
    for (const ep of eps) {
      const n = normalizeEpisode(ep);
      const p = predict(res.theta, n.x);
      const decision = p > 0.5 ? 1 : 0;
      if (decision === n.label) correct++;
    }
    expect(correct / eps.length).toBeGreaterThanOrEqual(0.95);
  });

  it('clips theta to the stability range', () => {
    const eps = [];
    for (let i = 0; i < 210; i++) {
      eps.push(makeEpisode({
        classification: {
          system: 2,
          factors: { steps: 1, domains: 1, uncertainty: 1, risk: 1, novelty: 1 },
        },
      }));
    }
    const res = coldStartWarmup(eps, { minEpisodes: 200, iterations: 10, learningRate: 10 });
    for (const v of res.theta) expect(Math.abs(v)).toBeLessThanOrEqual(DEFAULTS.clipRange + 1e-9);
  });
});

describe('trainBatch', () => {
  it('produces a 9-dim theta after one iteration', () => {
    const eps = [
      makeEpisode({ reward: 1 }),
      makeEpisode({ reward: -0.5 }),
      makeEpisode({ reward: 0.2 }),
    ];
    const out = trainBatch(eps, new Array(9).fill(0));
    expect(out.theta).toHaveLength(9);
  });

  it('skips exploration-flagged episodes from the gradient', () => {
    const eps = [
      makeEpisode({ reward: 1, isExploration: true }),
      makeEpisode({ reward: 1, isExploration: true }),
    ];
    const out = trainBatch(eps, new Array(9).fill(0));
    expect(out.explorationSkipped).toBe(2);
    expect(out.episodesUsed).toBe(0);
    expect(out.theta.every((v) => v === 0)).toBe(true);
  });

  it('respects the KL penalty by shrinking toward thetaPrev', () => {
    const prev = [0.5, 0, 0, 0, 0, 0, 0, 0, 0];
    const eps = [];
    for (let i = 0; i < 10; i++) eps.push(makeEpisode({ reward: 0.5 }));
    const strong = trainBatch(eps, prev, { klPenalty: 10, learningRate: 0 });
    // With lr=0 and strong KL, theta should be identical to prev (0 gradient, 0 shrinkage change)
    for (let i = 0; i < 9; i++) expect(strong.theta[i]).toBeCloseTo(prev[i], 10);
  });

  it('clips theta to [-5, +5] even after aggressive updates', () => {
    const eps = [];
    for (let i = 0; i < 100; i++) {
      eps.push(makeEpisode({
        reward: 10,
        classification: {
          system: 2,
          factors: { steps: 1, domains: 1, uncertainty: 1, risk: 1, novelty: 1 },
        },
      }));
    }
    const out = trainBatch(eps, new Array(9).fill(0), { learningRate: 100, klPenalty: 0, iterations: 5 });
    for (const v of out.theta) expect(Math.abs(v)).toBeLessThanOrEqual(5 + 1e-9);
  });

  it('returns base theta when episodes are empty', () => {
    const prev = [0.1, 0.2, 0.3, 0, 0, 0, 0, 0, 0];
    const out = trainBatch([], prev);
    expect(out.theta).toEqual(prev);
    expect(out.episodesUsed).toBe(0);
  });
});

describe('evaluatePolicy', () => {
  it('returns zero samples metric when held-out is empty', () => {
    const m = evaluatePolicy(new Array(9).fill(0), []);
    expect(m.samples).toBe(0);
  });

  it('achieves > 90% accuracy on a linearly separable toy set', () => {
    const eps = [];
    for (let i = 0; i < 50; i++) {
      eps.push(makeEpisode({
        classification: {
          system: 2,
          factors: { steps: 0.9, domains: 0.8, uncertainty: 0.2, risk: 0.8, novelty: 0.3 },
        },
      }));
      eps.push(makeEpisode({
        classification: {
          system: 1,
          factors: { steps: 0.05, domains: 0.05, uncertainty: 0.05, risk: 0.0, novelty: 0.05 },
        },
      }));
    }
    const w = coldStartWarmup(eps, { minEpisodes: 50, iterations: 500, learningRate: 0.5 });
    const metrics = evaluatePolicy(w.theta, eps, new Array(9).fill(0));
    expect(metrics.accuracyVsHeuristic).toBeGreaterThan(0.9);
    expect(metrics.logLoss).toBeLessThan(0.7);
    expect(metrics.klFromPrev).toBeGreaterThan(0);
  });
});

describe('persistence', () => {
  it('resolvePolicyPaths defaults to ~/.claude/artibot/policies/', () => {
    const paths = resolvePolicyPaths();
    expect(paths.policyFile.endsWith('routing-policy-v1.json')).toBe(true);
    expect(paths.snapshotDir.endsWith(`policies${path.sep}snapshots`)).toBe(true);
  });

  it('resolvePolicyPaths honors absolute overrides', () => {
    const p = path.resolve('/tmp/my-policy.json');
    expect(resolvePolicyPaths(p).policyFile).toBe(p);
  });

  it('savePolicy writes a well-formed record and one snapshot', async () => {
    const theta = new Array(9).fill(0.1);
    const out = await savePolicy(theta, { logLoss: 0.5, accuracyVsHeuristic: 0.7, klFromPrev: 0.01 }, {
      trainedOnEpisodes: 42,
    });
    expect(out.policy.theta).toEqual(theta);
    expect(out.policy.version).toBe(1);
    expect(out.policy.modelType).toBe('logistic-regression');
    expect(out.policy.features).toHaveLength(9);
    expect(out.policy.trainedOnEpisodes).toBe(42);
    expect(out.policy.metrics.logLoss).toBeCloseTo(0.5, 6);
    expect(out.snapshotId).toMatch(/^v1-/);
    // 2 writes: policy + snapshot
    expect(file.writeJsonFile).toHaveBeenCalledTimes(2);
  });

  it('loadPolicy returns null for missing or malformed files', async () => {
    expect(await loadPolicy()).toBeNull();
    file.__store.set(resolvePolicyPaths().policyFile, JSON.stringify({ bogus: true }));
    expect(await loadPolicy()).toBeNull();
  });

  it('loadPolicy round-trips a saved policy', async () => {
    const theta = new Array(9).fill(0.3);
    await savePolicy(theta, { logLoss: 0.5, accuracyVsHeuristic: 0.7, klFromPrev: 0 });
    const loaded = await loadPolicy();
    expect(loaded.theta).toEqual(theta);
  });

  it('snapshot() writes to snapshots/ with the given id', async () => {
    const f = await snapshot(new Array(9).fill(0), 'test-id');
    expect(f.endsWith('test-id.json')).toBe(true);
    expect(file.writeJsonFile).toHaveBeenCalled();
  });

  it('listSnapshots returns [] when directory is empty', async () => {
    const out = await listSnapshots();
    expect(out).toEqual([]);
  });
});

describe('createPolicyUpdater facade', () => {
  it('defers cold-start when episodes below threshold', async () => {
    const updater = createPolicyUpdater({ config: { coldStartEpisodes: 200 } });
    const out = await updater.trainFromEpisodes([makeEpisode()]);
    expect(out.policy).toBeNull();
    expect(out.metrics.reason).toBe('cold-start-insufficient');
  });

  it('trains on existing policy with KL guard', async () => {
    // Seed an existing policy so we hit the non-cold-start branch
    const seed = new Array(9).fill(0.05);
    await savePolicy(seed, { logLoss: 0.5, accuracyVsHeuristic: 0.7, klFromPrev: 0 });

    const updater = createPolicyUpdater({
      config: { coldStartEpisodes: 200, learningRate: 0.01, klPenalty: 0.01, klRejectThreshold: 10 },
    });
    const eps = [];
    for (let i = 0; i < 20; i++) eps.push(makeEpisode({ reward: Math.random() }));
    const out = await updater.trainFromEpisodes(eps);
    expect(out.policy).toBeTruthy();
    expect(out.policy.theta).toHaveLength(9);
  });

  it('rejects update when KL exceeds threshold', async () => {
    const seed = new Array(9).fill(0);
    await savePolicy(seed, { logLoss: 0.5, accuracyVsHeuristic: 0.7, klFromPrev: 0 });
    const updater = createPolicyUpdater({
      config: { klRejectThreshold: 0.0001, learningRate: 10, klPenalty: 0 },
    });
    const eps = [];
    for (let i = 0; i < 50; i++) {
      eps.push(makeEpisode({
        reward: 1,
        classification: {
          system: 2,
          factors: { steps: 1, domains: 1, uncertainty: 1, risk: 1, novelty: 1 },
        },
      }));
    }
    const out = await updater.trainFromEpisodes(eps);
    expect(out.rejected).toBe('kl-threshold');
  });
});
