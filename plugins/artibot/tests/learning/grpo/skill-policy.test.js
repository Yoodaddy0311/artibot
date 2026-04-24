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
  getHomeDir: () => '/tmp/artibot-skill-test-home',
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
  DEFAULTS,
  POLICY_VERSION,
  MODEL_TYPE,
  sigmoid,
  extractFeatureTokens,
  emptySkillEntry,
  emptyPolicy,
  computeLogit,
  scoreSkillsWith,
  selectFromScores,
  computeAdvantages,
  applyUpdate,
  decayEntry,
  normalizeEpisode,
  trainBatch,
  resolvePolicyPaths,
  loadPolicy,
  savePolicy,
  createSkillPolicy,
  scoreSkills,
  selectSkills,
  updatePolicy,
} = await import('../../../lib/learning/grpo/skill-policy.js');

function resetStore() {
  file.__store.clear();
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

describe('extractFeatureTokens', () => {
  it('lowercases and splits on non-word boundaries', () => {
    const out = extractFeatureTokens('Refactor Foo.js', {}, 2);
    expect(out).toEqual(['refactor', 'foo', 'js']);
  });

  it('deduplicates tokens across intent and context', () => {
    const out = extractFeatureTokens('test coverage', {
      commands: ['/test'],
      intents: ['action:test'],
    });
    expect(out.filter((t) => t === 'test').length).toBe(1);
  });

  it('drops tokens shorter than minLen', () => {
    const out = extractFeatureTokens('a be car', {}, 3);
    expect(out).toEqual(['car']);
  });

  it('handles non-string and missing inputs safely', () => {
    expect(extractFeatureTokens(null)).toEqual([]);
    expect(extractFeatureTokens(undefined, null)).toEqual([]);
    expect(extractFeatureTokens(42)).toEqual([]);
  });

  it('handles Korean tokens (Unicode letter class)', () => {
    const out = extractFeatureTokens('한국어 test', {});
    expect(out).toContain('한국어');
    expect(out).toContain('test');
  });
});

describe('primitives', () => {
  it('sigmoid is bounded and monotone', () => {
    expect(sigmoid(0)).toBeCloseTo(0.5, 10);
    expect(sigmoid(100)).toBeCloseTo(1, 5);
    expect(sigmoid(-100)).toBeCloseTo(0, 5);
    expect(Number.isFinite(sigmoid(1e6))).toBe(true);
    expect(Number.isFinite(sigmoid(-1e6))).toBe(true);
    expect(sigmoid(NaN)).toBe(0.5);
  });

  it('emptySkillEntry builds a zeroed entry', () => {
    const e = emptySkillEntry();
    expect(e.baseline_bias).toBe(0);
    expect(e.usageCount).toBe(0);
    expect(e.successRate).toBe(0);
    expect(Object.keys(e.triggerWeights)).toEqual([]);
  });

  it('emptyPolicy has correct version and modelType', () => {
    const p = emptyPolicy();
    expect(p.version).toBe(POLICY_VERSION);
    expect(p.modelType).toBe(MODEL_TYPE);
    expect(p.skills).toBeTruthy();
    expect(Object.keys(p.skills)).toEqual([]);
  });

  it('computeLogit returns 0 for missing entry', () => {
    expect(computeLogit(null, ['foo'])).toBe(0);
    expect(computeLogit(undefined, [])).toBe(0);
  });

  it('computeLogit sums matched tokens plus bias', () => {
    const e = { ...emptySkillEntry(), baseline_bias: 0.5, triggerWeights: { test: 1.0, coverage: 0.25 } };
    expect(computeLogit(e, ['test'])).toBeCloseTo(1.5, 10);
    expect(computeLogit(e, ['test', 'coverage'])).toBeCloseTo(1.75, 10);
    expect(computeLogit(e, ['unrelated'])).toBeCloseTo(0.5, 10);
  });
});

describe('scoreSkillsWith', () => {
  it('returns neutral score for skills without entries', () => {
    const policy = emptyPolicy();
    const scores = scoreSkillsWith(policy, 'refactor foo', {}, ['unknown-skill']);
    expect(scores['unknown-skill']).toBeCloseTo(DEFAULTS.neutralScore, 10);
  });

  it('returns policy-derived score for trained skills', () => {
    const policy = emptyPolicy();
    policy.skills['tdd-workflow'] = {
      ...emptySkillEntry(),
      triggerWeights: { test: 2.0, coverage: 1.0 },
    };
    const scores = scoreSkillsWith(policy, 'write test coverage', {}, ['tdd-workflow']);
    expect(scores['tdd-workflow']).toBeGreaterThan(0.9);
  });

  it('empty candidates returns empty map', () => {
    const policy = emptyPolicy();
    expect(scoreSkillsWith(policy, 'hi', {}, [])).toEqual({});
  });

  it('filters non-string candidate entries', () => {
    const policy = emptyPolicy();
    const scores = scoreSkillsWith(policy, 'hi', {}, [null, 42, '', 'ok']);
    expect(Object.keys(scores)).toEqual(['ok']);
  });
});

describe('selectFromScores', () => {
  it('applies threshold and maxTriggers', () => {
    const scores = { a: 0.9, b: 0.6, c: 0.4, d: 0.7, e: 0.8 };
    const out = selectFromScores(scores, { threshold: 0.5, maxTriggers: 3 });
    expect(out.map((s) => s.name)).toEqual(['a', 'e', 'd']);
  });

  it('returns empty array when nothing crosses threshold', () => {
    const out = selectFromScores({ a: 0.1, b: 0.2 }, { threshold: 0.5, maxTriggers: 3 });
    expect(out).toEqual([]);
  });

  it('handles non-finite scores', () => {
    const scores = { a: NaN, b: Infinity, c: 0.9 };
    const out = selectFromScores(scores, { threshold: 0.5, maxTriggers: 5 });
    expect(out.map((s) => s.name)).toEqual(['c']);
  });

  it('defaults threshold and maxTriggers from DEFAULTS', () => {
    const out = selectFromScores({ a: 0.6, b: 0.55 }, {});
    expect(out.length).toBeLessThanOrEqual(DEFAULTS.maxTriggers);
  });
});

describe('computeAdvantages', () => {
  it('is zero for singletons', () => {
    expect(computeAdvantages([0.7])).toEqual([0]);
  });

  it('is empty for empty input', () => {
    expect(computeAdvantages([])).toEqual([]);
  });

  it('yields mean-zero vector', () => {
    const adv = computeAdvantages([1, 0, -1]);
    expect(adv.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 10);
  });

  it('epsilon-guards zero-variance groups', () => {
    expect(computeAdvantages([0.3, 0.3, 0.3]).every((v) => v === 0)).toBe(true);
  });
});

describe('applyUpdate', () => {
  it('increases weights for positive advantage', () => {
    const e = emptySkillEntry();
    applyUpdate(e, ['test'], 1.0, { learningRate: 0.1 });
    expect(e.triggerWeights.test).toBeGreaterThan(0);
  });

  it('decreases weights for negative advantage', () => {
    const e = emptySkillEntry();
    applyUpdate(e, ['test'], -1.0, { learningRate: 0.1 });
    expect(e.triggerWeights.test).toBeLessThan(0);
  });

  it('caps weights to weightClip', () => {
    const e = emptySkillEntry();
    for (let i = 0; i < 100; i++) applyUpdate(e, ['test'], 1.0, { learningRate: 1.0, weightClip: 2.0 });
    expect(e.triggerWeights.test).toBeLessThanOrEqual(2.0);
    expect(e.triggerWeights.test).toBeGreaterThanOrEqual(-2.0);
  });

  it('moves baseline bias in advantage direction', () => {
    const e = emptySkillEntry();
    applyUpdate(e, ['a'], 1.0, { learningRate: 0.1 });
    expect(e.baseline_bias).toBeGreaterThan(0);
  });

  it('enforces maxTokens dictionary size', () => {
    const e = emptySkillEntry();
    const tokens = Array.from({ length: 100 }, (_, i) => `t${i}`);
    applyUpdate(e, tokens, 1.0, { learningRate: 0.1, maxTokens: 10 });
    expect(Object.keys(e.triggerWeights).length).toBeLessThanOrEqual(10);
  });
});

describe('decayEntry', () => {
  it('shrinks weights toward zero', () => {
    const e = emptySkillEntry();
    e.triggerWeights.a = 1.0;
    e.triggerWeights.b = -0.5;
    e.baseline_bias = 0.3;
    decayEntry(e, 0.1);
    expect(e.triggerWeights.a).toBeCloseTo(0.9, 6);
    expect(e.triggerWeights.b).toBeCloseTo(-0.45, 6);
    expect(e.baseline_bias).toBeCloseTo(0.27, 6);
  });

  it('is a no-op at rate 0', () => {
    const e = emptySkillEntry();
    e.triggerWeights.a = 1.0;
    decayEntry(e, 0);
    expect(e.triggerWeights.a).toBe(1.0);
  });

  it('handles missing entry gracefully', () => {
    expect(() => decayEntry(null, 0.1)).not.toThrow();
    expect(() => decayEntry({}, 0.1)).not.toThrow();
  });
});

describe('normalizeEpisode', () => {
  it('rejects episodes without reward', () => {
    expect(normalizeEpisode({ skillsUsed: ['a'], intent: 'hi' })).toBeNull();
  });

  it('rejects episodes without skills', () => {
    expect(normalizeEpisode({ reward: 1, intent: 'hi' })).toBeNull();
  });

  it('extracts tokens from intent + context', () => {
    const n = normalizeEpisode({
      reward: 0.5,
      intent: 'refactor foo',
      context: { commands: ['/refactor'] },
      skillsUsed: ['tdd-workflow'],
    });
    expect(n).not.toBeNull();
    expect(n.tokens).toContain('refactor');
    expect(n.tokens).toContain('foo');
    expect(n.skillsUsed).toEqual(['tdd-workflow']);
  });

  it('flags exploration', () => {
    const n = normalizeEpisode({ reward: 1, intent: 'x', skillsUsed: ['a'], isExploration: true });
    expect(n.exploration).toBe(true);
  });
});

describe('trainBatch', () => {
  it('updates weights for each touched skill', () => {
    const policy = emptyPolicy();
    const episodes = [
      { reward: 1.0, intent: 'write tests', skillsUsed: ['tdd'] },
      { reward: 0.8, intent: 'write tests now', skillsUsed: ['tdd'] },
      { reward: -0.5, intent: 'ship quick', skillsUsed: ['ship'] },
      { reward: -0.3, intent: 'ship quick now', skillsUsed: ['ship'] },
    ];
    const metrics = trainBatch(policy, episodes, { learningRate: 0.2 });
    expect(metrics.skillsTouched).toBe(2);
    expect(metrics.episodesUsed).toBe(4);
    expect(policy.skills.tdd).toBeTruthy();
    expect(policy.skills.ship).toBeTruthy();
    expect(policy.skills.tdd.usageCount).toBe(2);
  });

  it('skips exploration episodes from gradient but counts them', () => {
    const policy = emptyPolicy();
    const episodes = [
      { reward: 1.0, intent: 'a', skillsUsed: ['x'], isExploration: true },
      { reward: 0.5, intent: 'a', skillsUsed: ['x'], isExploration: true },
    ];
    const metrics = trainBatch(policy, episodes);
    expect(metrics.explorationSkipped).toBe(2);
    expect(metrics.skillsTouched).toBe(0);
  });

  it('decays skills not touched in the batch', () => {
    const policy = emptyPolicy();
    policy.skills.stale = {
      ...emptySkillEntry(),
      triggerWeights: { stuff: 1.0 },
      baseline_bias: 0.5,
    };
    const episodes = [
      { reward: 1, intent: 'x', skillsUsed: ['fresh'] },
      { reward: 0.5, intent: 'y', skillsUsed: ['fresh'] },
    ];
    trainBatch(policy, episodes, { decayRate: 0.5 });
    expect(policy.skills.stale.triggerWeights.stuff).toBeLessThan(1.0);
  });

  it('computes successRate from positive rewards', () => {
    const policy = emptyPolicy();
    const episodes = [
      { reward: 1, intent: 'x', skillsUsed: ['s'] },
      { reward: 1, intent: 'y', skillsUsed: ['s'] },
      { reward: -0.5, intent: 'z', skillsUsed: ['s'] },
      { reward: 0.1, intent: 'w', skillsUsed: ['s'] },
    ];
    trainBatch(policy, episodes);
    expect(policy.skills.s.successRate).toBeCloseTo(0.75, 6);
  });

  it('handles empty or malformed batches', () => {
    const policy = emptyPolicy();
    expect(trainBatch(policy, []).episodesUsed).toBe(0);
    expect(trainBatch(policy, [null, undefined, { no: 'reward' }]).episodesUsed).toBe(0);
  });
});

describe('persistence', () => {
  it('resolvePolicyPaths defaults to ~/.claude/artibot/policies/skill-policy-v1.json', () => {
    const paths = resolvePolicyPaths();
    expect(paths.policyFile.endsWith('skill-policy-v1.json')).toBe(true);
    expect(paths.snapshotDir.endsWith(`policies${path.sep}skill-snapshots`)).toBe(true);
  });

  it('resolvePolicyPaths honors absolute overrides', () => {
    const p = path.resolve('/tmp/custom-skill.json');
    expect(resolvePolicyPaths(p).policyFile).toBe(p);
  });

  it('savePolicy writes record + snapshot', async () => {
    const policy = emptyPolicy();
    policy.skills.demo = { ...emptySkillEntry(), triggerWeights: { foo: 0.5 } };
    const out = await savePolicy(policy, { metrics: { skillsTouched: 1, episodesUsed: 3 } });
    expect(out.policy.modelType).toBe(MODEL_TYPE);
    expect(out.policy.version).toBe(POLICY_VERSION);
    expect(out.policy.skills.demo.triggerWeights.foo).toBe(0.5);
    expect(out.policy.metrics.skillsTouched).toBe(1);
    expect(out.snapshotId).toMatch(/^sk1-/);
    expect(file.writeJsonFile).toHaveBeenCalledTimes(2);
  });

  it('loadPolicy returns null when file missing', async () => {
    expect(await loadPolicy()).toBeNull();
  });

  it('loadPolicy returns null when modelType mismatches', async () => {
    file.__store.set(resolvePolicyPaths().policyFile, JSON.stringify({
      modelType: 'other',
      skills: {},
    }));
    expect(await loadPolicy()).toBeNull();
  });

  it('loadPolicy returns null when skills missing', async () => {
    file.__store.set(resolvePolicyPaths().policyFile, JSON.stringify({
      modelType: MODEL_TYPE,
    }));
    expect(await loadPolicy()).toBeNull();
  });

  it('loadPolicy round-trips a saved policy', async () => {
    const policy = emptyPolicy();
    policy.skills.demo = { ...emptySkillEntry(), triggerWeights: { alpha: 1.5 }, usageCount: 7 };
    await savePolicy(policy);
    const loaded = await loadPolicy();
    expect(loaded).not.toBeNull();
    expect(loaded.skills.demo.triggerWeights.alpha).toBe(1.5);
    expect(loaded.skills.demo.usageCount).toBe(7);
  });
});

describe('createSkillPolicy facade', () => {
  it('scoreSkills returns neutral for all candidates when policy absent', async () => {
    const policy = createSkillPolicy({});
    const scores = await policy.scoreSkills('hi', {}, { candidates: ['a', 'b'] });
    expect(scores.a).toBeCloseTo(DEFAULTS.neutralScore, 10);
    expect(scores.b).toBeCloseTo(DEFAULTS.neutralScore, 10);
  });

  it('selectSkills returns trained selections above threshold', async () => {
    const seed = emptyPolicy();
    seed.skills['tdd-workflow'] = {
      ...emptySkillEntry(),
      triggerWeights: { test: 2.5, coverage: 1.5 },
    };
    seed.skills['copywriting'] = {
      ...emptySkillEntry(),
      triggerWeights: { headline: 2.5 },
      baseline_bias: -1.0,
    };
    await savePolicy(seed);

    const policy = createSkillPolicy({});
    const chosen = await policy.selectSkills('write test coverage', {}, {
      candidates: ['tdd-workflow', 'copywriting'],
      threshold: 0.6,
      maxTriggers: 3,
    });
    expect(chosen.find((s) => s.name === 'tdd-workflow')).toBeTruthy();
    expect(chosen.find((s) => s.name === 'copywriting')).toBeFalsy();
  });

  it('updatePolicy persists on success', async () => {
    const facade = createSkillPolicy({});
    const episodes = [];
    for (let i = 0; i < 5; i++) {
      episodes.push({ reward: 1, intent: `write test ${i}`, skillsUsed: ['tdd'] });
      episodes.push({ reward: -0.5, intent: `ship quick ${i}`, skillsUsed: ['ship'] });
    }
    const out = await facade.updatePolicy(episodes);
    expect(out.policy).toBeTruthy();
    expect(out.metrics.skillsTouched).toBe(2);
    expect(out.metrics.episodesUsed).toBe(10);

    const loaded = await facade.loadPolicy();
    expect(loaded.skills.tdd).toBeTruthy();
    expect(loaded.skills.ship).toBeTruthy();
  });

  it('updatePolicy skips save when no eligible episodes', async () => {
    const facade = createSkillPolicy({});
    const out = await facade.updatePolicy([null, { foo: 'bar' }]);
    expect(out.metrics.reason).toBe('no-episodes');
  });

  it('scoreSkills falls back to neutral for untrained candidate alongside trained ones', async () => {
    const seed = emptyPolicy();
    seed.skills['known'] = { ...emptySkillEntry(), triggerWeights: { hello: 2.0 } };
    await savePolicy(seed);

    const facade = createSkillPolicy({});
    const scores = await facade.scoreSkills('hello world', {}, { candidates: ['known', 'unknown'] });
    expect(scores.known).toBeGreaterThan(0.8);
    expect(scores.unknown).toBeCloseTo(DEFAULTS.neutralScore, 10);
  });
});

describe('standalone helpers', () => {
  it('scoreSkills (module-level) works without facade', async () => {
    const policy = emptyPolicy();
    policy.skills.a = { ...emptySkillEntry(), baseline_bias: 3 };
    await savePolicy(policy);
    const scores = await scoreSkills('x', {}, { candidates: ['a'] });
    expect(scores.a).toBeGreaterThan(0.9);
  });

  it('selectSkills (module-level) applies defaults', async () => {
    const policy = emptyPolicy();
    policy.skills.a = { ...emptySkillEntry(), baseline_bias: 3 };
    await savePolicy(policy);
    const chosen = await selectSkills('x', {}, { candidates: ['a'], threshold: 0.5 });
    expect(chosen.length).toBe(1);
  });

  it('updatePolicy (module-level) round-trips', async () => {
    const out = await updatePolicy([
      { reward: 1, intent: 'x y z', skillsUsed: ['k'] },
      { reward: 0.5, intent: 'y z w', skillsUsed: ['k'] },
    ]);
    expect(out.metrics.skillsTouched).toBe(1);
  });
});

describe('determinism under NODE_ENV=test', () => {
  it('identical inputs produce identical policies (modulo snapshotId)', () => {
    const a = emptyPolicy();
    const b = emptyPolicy();
    const episodes = [
      { reward: 1, intent: 'test foo', skillsUsed: ['s'] },
      { reward: -0.5, intent: 'fix bar', skillsUsed: ['s'] },
      { reward: 0.3, intent: 'refactor baz', skillsUsed: ['s'] },
    ];
    trainBatch(a, episodes, { learningRate: 0.1 });
    trainBatch(b, episodes, { learningRate: 0.1 });
    expect(a.skills.s.baseline_bias).toBeCloseTo(b.skills.s.baseline_bias, 10);
    for (const k of Object.keys(a.skills.s.triggerWeights)) {
      expect(a.skills.s.triggerWeights[k]).toBeCloseTo(b.skills.s.triggerWeights[k], 10);
    }
  });
});
