import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  getRoutingBias,
  getCachedRoutingBias,
  primeRoutingBiasCache,
  resetRoutingBiasCache,
} from '../../lib/cognitive/grpo-bridge.js';
import {
  applyGrpoBlending,
  applyExploration,
  routeWithPolicy,
  isDeterministicEnv,
  DEFAULT_BLEND_ALPHA,
  ALPHA_FLOOR,
  BLEND_DECISION_THRESHOLD,
} from '../../lib/cognitive/grpo-routing.js';

// ---------------------------------------------------------------------------
// GR-C Phase C — bridge + routing helper coverage
// Contract: every function must return safe values when the policy file is
// missing, malformed, or the feature vector is invalid; never throw.
// NODE_ENV=test forces deterministic exploration (epsilon=0).
// ---------------------------------------------------------------------------

describe('grpo-routing/applyGrpoBlending', () => {
  it('뉴트럴 bias(confidence=0) → 휴리스틱 통과', () => {
    const out = applyGrpoBlending({
      heuristicScore: 0.42,
      bias: { p_s2: 0.5, confidence: 0 },
    });
    expect(out.blended).toBe(false);
    expect(out.finalScore).toBe(0.42);
    expect(out.alphaApplied).toBe(1.0);
  });

  it('blended=true 시 finalScore는 선형 결합', () => {
    const out = applyGrpoBlending({
      heuristicScore: 0.2,
      bias: { p_s2: 0.8, confidence: 0.9 },
      alpha: 0.7,
    });
    expect(out.blended).toBe(true);
    // 0.7 * 0.2 + 0.3 * 0.8 = 0.14 + 0.24 = 0.38
    expect(out.finalScore).toBeCloseTo(0.38, 5);
  });

  it('alpha는 [ALPHA_FLOOR, 1.0]으로 clamp된다', () => {
    const tooLow = applyGrpoBlending({
      heuristicScore: 0.5,
      bias: { p_s2: 0.9, confidence: 0.5 },
      alpha: 0.01,
    });
    expect(tooLow.alphaApplied).toBe(ALPHA_FLOOR);
    const tooHigh = applyGrpoBlending({
      heuristicScore: 0.5,
      bias: { p_s2: 0.9, confidence: 0.5 },
      alpha: 5.0,
    });
    expect(tooHigh.alphaApplied).toBe(1.0);
  });

  it('heuristicScore는 [0,1]로 clamp된다', () => {
    const out = applyGrpoBlending({
      heuristicScore: 2.5,
      bias: { p_s2: 0.0, confidence: 0.9 },
    });
    // heuristic clamped to 1.0 → 0.7 * 1 + 0.3 * 0 = 0.7
    expect(out.finalScore).toBeCloseTo(0.7, 5);
  });

  it('bias가 null/undefined → 휴리스틱만', () => {
    expect(applyGrpoBlending({ heuristicScore: 0.3, bias: null }).blended).toBe(false);
    expect(applyGrpoBlending({ heuristicScore: 0.3, bias: undefined }).blended).toBe(false);
  });

  it('bias.p_s2가 NaN → fallback', () => {
    const out = applyGrpoBlending({
      heuristicScore: 0.4,
      bias: { p_s2: Number.NaN, confidence: 0.8 },
    });
    expect(out.blended).toBe(false);
    expect(out.finalScore).toBe(0.4);
  });

  it('DEFAULT_BLEND_ALPHA 적용', () => {
    const out = applyGrpoBlending({
      heuristicScore: 0.4,
      bias: { p_s2: 0.6, confidence: 0.5 },
    });
    // 0.7 * 0.4 + 0.3 * 0.6 = 0.46
    expect(out.alphaApplied).toBe(DEFAULT_BLEND_ALPHA);
    expect(out.finalScore).toBeCloseTo(0.46, 5);
  });
});

describe('grpo-routing/applyExploration (determinism in tests)', () => {
  it('NODE_ENV=test면 epsilon=0 강제', () => {
    expect(isDeterministicEnv()).toBe(true);
    const out = applyExploration({ system: 1 }, 0.9, () => 0);
    expect(out.explored).toBe(false);
    expect(out.epsilonApplied).toBe(0);
    expect(out.system).toBe(1);
  });

  it('system이 2일 때도 explored=false', () => {
    const out = applyExploration({ system: 2 }, 0.9);
    expect(out.system).toBe(2);
    expect(out.explored).toBe(false);
  });

  it('decision 객체가 이상해도 안전하게 1로 fallback', () => {
    const out = applyExploration({}, 0);
    expect([1, 2]).toContain(out.system);
  });
});

describe('grpo-routing/applyExploration (non-test env simulation)', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalVitest = process.env.VITEST;
  beforeEach(() => {
    // Force non-deterministic env for this block only
    delete process.env.NODE_ENV;
    delete process.env.VITEST;
  });
  afterEach(() => {
    if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
    if (originalVitest !== undefined) process.env.VITEST = originalVitest;
  });

  it('RNG=0.01, epsilon=0.05 → explored 발생', () => {
    const out = applyExploration({ system: 1 }, 0.05, () => 0.01);
    expect(out.explored).toBe(true);
    expect(out.system).toBe(2);
  });

  it('RNG=0.99, epsilon=0.05 → 유지', () => {
    const out = applyExploration({ system: 1 }, 0.05, () => 0.99);
    expect(out.explored).toBe(false);
    expect(out.system).toBe(1);
  });

  it('epsilon=0이면 어떤 RNG에서도 explored=false', () => {
    const out = applyExploration({ system: 2 }, 0, () => 0);
    expect(out.explored).toBe(false);
  });
});

describe('grpo-routing/routeWithPolicy', () => {
  it('낮은 bias confidence → heuristicSystem passthrough', () => {
    const r = routeWithPolicy({
      heuristicSystem: 1, heuristicScore: 0.2,
      bias: { p_s2: 0.99, confidence: 0 },
    });
    expect(r.system).toBe(1);
    expect(r.meta).toBeNull();
  });

  it('blended finalScore >= 0.5 → system 2', () => {
    const r = routeWithPolicy({
      heuristicSystem: 1, heuristicScore: 0.45,
      bias: { p_s2: 0.95, confidence: 0.9 }, alpha: 0.5,
    });
    // 0.5 * 0.45 + 0.5 * 0.95 = 0.7 → S2
    expect(r.system).toBe(2);
    expect(r.meta.p_s2).toBeCloseTo(0.95, 5);
    expect(r.meta.blendedScore).toBeCloseTo(0.7, 5);
  });

  it('meta에 explored 플래그 포함', () => {
    const r = routeWithPolicy({
      heuristicSystem: 1, heuristicScore: 0.1,
      bias: { p_s2: 0.9, confidence: 0.8 }, alpha: 0.5, epsilon: 0,
    });
    expect(r.meta).toHaveProperty('explored', false);
  });
});

describe('grpo-bridge/getRoutingBias', () => {
  let tmpDir;
  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'artibot-grpo-bias-'));
    resetRoutingBiasCache();
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    resetRoutingBiasCache();
  });

  it('정책 파일 없음 → neutral fallback', async () => {
    const out = await getRoutingBias(
      { steps: 0.5, domains: 0.3 },
      { policyPath: path.join(tmpDir, 'nonexistent.json') },
    );
    expect(out).toEqual({ p_s2: 0.5, confidence: 0, source: 'fallback' });
  });

  it('잘못된 JSON → neutral fallback', async () => {
    const bad = path.join(tmpDir, 'bad.json');
    await writeFile(bad, '{ not json');
    const out = await getRoutingBias({}, { policyPath: bad });
    expect(out.source).toBe('fallback');
    expect(out.confidence).toBe(0);
  });

  it('theta 길이 불일치 → neutral fallback', async () => {
    const bad = path.join(tmpDir, 'short.json');
    await writeFile(bad, JSON.stringify({ theta: [0.1, 0.2] }));
    const out = await getRoutingBias({ steps: 0.5 }, { policyPath: bad });
    expect(out.source).toBe('fallback');
  });

  it('theta 유효 → sigmoid(theta·x) 반환', async () => {
    // 9 features + bias = 10. All zeros except bias(1.0) gives sigmoid(0) = 0.5.
    const ok = path.join(tmpDir, 'zero-theta.json');
    await writeFile(ok, JSON.stringify({ version: 1, theta: Array(10).fill(0) }));
    const out = await getRoutingBias({}, { policyPath: ok });
    expect(out.source).toBe('policy');
    expect(out.p_s2).toBeCloseTo(0.5, 5);
    expect(out.confidence).toBeCloseTo(0, 5);
  });

  it('강한 양수 theta → p_s2 높음, confidence 높음', async () => {
    const strong = path.join(tmpDir, 'strong.json');
    // theta = [5,5,5,5,5,5,5,5,5,5], x·theta large positive
    await writeFile(strong, JSON.stringify({ theta: Array(10).fill(5) }));
    const out = await getRoutingBias(
      { steps: 1, domains: 1, uncertainty: 1, risk: 1, novelty: 1 },
      { policyPath: strong },
    );
    expect(out.p_s2).toBeGreaterThan(0.95);
    expect(out.confidence).toBeGreaterThan(0.9);
  });

  it('60초 memoization: 두 번째 호출은 cache hit', async () => {
    const ok = path.join(tmpDir, 'cache-test.json');
    await writeFile(ok, JSON.stringify({ theta: Array(10).fill(0.1) }));
    const spy = vi.spyOn(await import('node:fs/promises'), 'readFile');
    await getRoutingBias({}, { policyPath: ok });
    const callsAfterFirst = spy.mock.calls.length;
    await getRoutingBias({}, { policyPath: ok });
    // Second call within TTL → no additional readFile
    expect(spy.mock.calls.length).toBe(callsAfterFirst);
    spy.mockRestore();
  });

  it('never throws — 모든 예외는 fallback으로 전환', async () => {
    await expect(
      getRoutingBias(null, { policyPath: '/this/path/does/not/exist' }),
    ).resolves.toBeDefined();
    await expect(
      getRoutingBias({ steps: 'string' }, { policyPath: '/nope' }),
    ).resolves.toBeDefined();
  });
});

describe('grpo-bridge/getCachedRoutingBias (sync hot path)', () => {
  let tmpDir;
  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'artibot-grpo-cache-'));
    resetRoutingBiasCache();
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    resetRoutingBiasCache();
  });

  it('cache cold → neutral fallback', () => {
    const out = getCachedRoutingBias({ steps: 0.5 });
    expect(out).toEqual({ p_s2: 0.5, confidence: 0, source: 'fallback' });
  });

  it('prime 후 동기 호출 → policy 응답', async () => {
    const ok = path.join(tmpDir, 'theta.json');
    await writeFile(ok, JSON.stringify({ theta: Array(10).fill(0) }));
    await primeRoutingBiasCache({ policyPath: ok });
    const out = getCachedRoutingBias({});
    expect(out.source).toBe('policy');
  });
});
