import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  getCachedRoutingBias,
  getRoutingBias,
  primeRoutingBiasCache,
  resetRoutingBiasCache,
} from '../../lib/cognitive/grpo-bridge.js';

// ---------------------------------------------------------------------------
// GR-C Phase C — bridge coverage (family B/C — grpo-bridge.js)
// Contract: every function must return safe values when the policy file is
// missing, malformed, or the feature vector is invalid; never throw.
//
// NOTE: The family-A routing-bias blending helpers (grpo-routing.js:
// applyGrpoBlending / applyExploration / routeWithPolicy) were retired in the
// T4β-min routing-bias retirement. Their describe blocks were removed with the
// module. The grpo-bridge.js policy-reader surface below is preserved (it is
// family B/C: getRoutingBias / getCachedRoutingBias remain part of the bridge).
// ---------------------------------------------------------------------------

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
    await writeFile(ok, JSON.stringify({ version: 1, theta: Array(9).fill(0) }));
    const out = await getRoutingBias({}, { policyPath: ok });
    expect(out.source).toBe('policy');
    expect(out.p_s2).toBeCloseTo(0.5, 5);
    expect(out.confidence).toBeCloseTo(0, 5);
  });

  it('강한 양수 theta → p_s2 높음, confidence 높음', async () => {
    const strong = path.join(tmpDir, 'strong.json');
    // theta = [5,5,5,5,5,5,5,5,5,5], x·theta large positive
    await writeFile(strong, JSON.stringify({ theta: Array(9).fill(5) }));
    const out = await getRoutingBias(
      { steps: 1, domains: 1, uncertainty: 1, risk: 1, novelty: 1 },
      { policyPath: strong },
    );
    expect(out.p_s2).toBeGreaterThan(0.95);
    expect(out.confidence).toBeGreaterThan(0.9);
  });

  it('60초 memoization: 파일 삭제 후에도 cache에서 서빙', async () => {
    const ok = path.join(tmpDir, 'cache-test.json');
    await writeFile(ok, JSON.stringify({ theta: Array(9).fill(0.1) }));
    const first = await getRoutingBias({}, { policyPath: ok });
    expect(first.source).toBe('policy');
    // Delete the file; second call within TTL must still hit memo, not re-read.
    await rm(ok, { force: true });
    const second = await getRoutingBias({}, { policyPath: ok });
    expect(second.source).toBe('policy');
    expect(second.p_s2).toBeCloseTo(first.p_s2, 5);
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
    await writeFile(ok, JSON.stringify({ theta: Array(9).fill(0) }));
    await primeRoutingBiasCache({ policyPath: ok });
    const out = getCachedRoutingBias({});
    expect(out.source).toBe('policy');
  });
});
