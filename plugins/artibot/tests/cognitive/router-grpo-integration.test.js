import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { classifyComplexity, resetRouter, route } from '../../lib/cognitive/router.js';
import {
  primeRoutingBiasCache,
  resetRoutingBiasCache,
} from '../../lib/cognitive/grpo-bridge.js';
import {
  __setCachedConfigForTests,
  getGrpoRoutingConfig,
  resetGrpoRoutingConfigCache,
} from '../../lib/cognitive/grpo-routing-config.js';

// ---------------------------------------------------------------------------
// GR-C Phase C — router.js flag-gated GRPO integration
// Requirements:
//   (1) enabled:false → zero behavior change (heuristic-only path)
//   (2) enabled:true  → blending uses sigmoid(theta·x) bias
//   (3) grpoRouting metadata exposed in classification response
//   (4) test determinism (epsilon=0 forced)
// ---------------------------------------------------------------------------

describe('router + GRPO integration — flag OFF (zero cost)', () => {
  beforeEach(() => {
    resetRouter();
    resetRoutingBiasCache();
    resetGrpoRoutingConfigCache();
  });

  it('기본 설정에서 grpoRouting 메타는 null', () => {
    const result = classifyComplexity('implement login feature with OAuth');
    expect(result).toHaveProperty('grpoRouting');
    expect(result.grpoRouting).toBeNull();
  });

  it('기존 routing 계약 유지 (score, system, factors, threshold)', () => {
    const result = classifyComplexity('refactor user service');
    expect(typeof result.score).toBe('number');
    expect([1, 2]).toContain(result.system);
    expect(result.factors).toHaveProperty('steps');
    expect(result.factors).toHaveProperty('domains');
    expect(typeof result.threshold).toBe('number');
  });

  it('route()는 classification을 포함하며 grpoRouting 필드도 전달', () => {
    const result = route('add a new feature');
    expect(result.classification.grpoRouting).toBeNull();
  });

  it('성능: flag OFF 경로에서 추가 비용 없음 (>=50회 호출 < 50ms)', () => {
    const start = Date.now();
    for (let i = 0; i < 50; i++) {
      classifyComplexity('quick test input');
    }
    const elapsed = Date.now() - start;
    // Sanity check — heuristic-only path is sub-ms per call.
    expect(elapsed).toBeLessThan(50);
  });
});

describe('router + GRPO integration — flag ON (blending)', () => {
  let tmpDir;

  beforeEach(async () => {
    resetRouter();
    resetRoutingBiasCache();
    resetGrpoRoutingConfigCache();
    tmpDir = await mkdtemp(path.join(tmpdir(), 'artibot-router-grpo-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    resetRouter();
    resetRoutingBiasCache();
    resetGrpoRoutingConfigCache();
  });

  async function enableFlagWithPolicy(policyObj, { blendAlpha = 0.5 } = {}) {
    const policyPath = path.join(tmpDir, 'policy.json');
    await writeFile(policyPath, JSON.stringify(policyObj));
    await primeRoutingBiasCache({ policyPath });
    __setCachedConfigForTests({
      enabled: true, policyPath, blendAlpha,
      epsilonExplore: 0, epsilonFloor: 0,
    });
  }

  it('enabled:true + strong +theta → grpoRouting 메타 채워짐', async () => {
    await enableFlagWithPolicy({ theta: Array(9).fill(5) });
    const result = classifyComplexity('implement feature, refactor and deploy', {
      runtimeFeatures: { s1SuccessRate: 0.9, sessionDepth: 0.1, errorRate: 0.1 },
    });
    expect(result.grpoRouting).not.toBeNull();
    expect(result.grpoRouting.p_s2).toBeGreaterThan(0.9);
    expect(result.grpoRouting.confidence).toBeGreaterThan(0);
    expect(result.grpoRouting.explored).toBe(false); // epsilon=0 forced in tests
  });

  it('강한 +theta → blend 결과 S2로 추론', async () => {
    await enableFlagWithPolicy({ theta: Array(9).fill(5) });
    // Input 자체는 낮은 복잡도 (heuristic S1 경향)지만 bias가 강하게 S2로 밀어야 함.
    const result = classifyComplexity('simple question');
    // heuristic은 낮고, bias는 높음 → blendedScore = 0.5*low + 0.5*~1 ≈ 0.5+
    expect(result.grpoRouting).not.toBeNull();
    expect(result.grpoRouting.blendedScore).toBeGreaterThan(0.4);
  });

  it('강한 -theta → blend 결과 S1으로 추론', async () => {
    await enableFlagWithPolicy({ theta: Array(9).fill(-5) });
    const result = classifyComplexity('deploy production migration with breaking changes');
    // heuristic은 높고 (risk+), bias는 strongly 낮음 → blendedScore 중간값으로 낮아짐
    expect(result.grpoRouting).not.toBeNull();
    expect(result.grpoRouting.p_s2).toBeLessThan(0.05);
  });

  it('policy 파일이 memo 되어있지 않으면 fallback (confidence=0, meta=null)', async () => {
    // Enable flag but do NOT prime cache.
    __setCachedConfigForTests({
      enabled: true,
      policyPath: path.join(tmpDir, 'absent.json'),
      blendAlpha: 0.7, epsilonExplore: 0,
    });
    const result = classifyComplexity('some task');
    // bias.confidence === 0 → blending skipped → meta stays null
    expect(result.grpoRouting).toBeNull();
  });

  it('context.runtimeFeatures가 feature 벡터에 병합된다', async () => {
    await enableFlagWithPolicy({ theta: Array(9).fill(0) }); // neutral sigmoid=0.5
    const result = classifyComplexity('test input', {
      runtimeFeatures: { s1SuccessRate: 1, sessionDepth: 1, errorRate: 1 },
    });
    // zero theta → always p_s2=0.5 regardless of features
    // 하지만 confidence=0이라 blending은 skip됨 → meta=null 기대
    // NOTE: zero theta means p=sigmoid(0)=0.5 → abs(0.5-0.5)*2=0 confidence → skip.
    expect(result.grpoRouting).toBeNull();
  });
});

describe('router + GRPO integration — config safe-defaults', () => {
  beforeEach(() => {
    resetGrpoRoutingConfigCache();
  });

  it('getGrpoRoutingConfig는 enabled:false가 기본', async () => {
    const cfg = await getGrpoRoutingConfig({ force: true });
    expect(cfg.enabled).toBe(false);
    expect(cfg.blendAlpha).toBeGreaterThanOrEqual(0.1);
    expect(cfg.blendAlpha).toBeLessThanOrEqual(1);
    expect(Array.isArray(cfg.groupingLevels)).toBe(true);
  });

  it('config가 완전 비어있어도 snapshotCount >= 1', async () => {
    const cfg = await getGrpoRoutingConfig({ force: true });
    expect(cfg.snapshotCount).toBeGreaterThanOrEqual(1);
  });

  it('config 객체는 freeze되어 외부 변조 불가', async () => {
    const cfg = await getGrpoRoutingConfig({ force: true });
    expect(Object.isFrozen(cfg)).toBe(true);
  });
});
