/**
 * Tests for scripts/benchmark-policy.mjs — linear vs MLP benchmark harness.
 *
 * Covers:
 *   1. createRng      — seeded PRNG determinism + distinct seeds diverge
 *   2. generateEpisodes — identical seeds produce identical corpora
 *   3. splitEpisodes  — deterministic train/held-out slices
 *   4. heuristicLabel — monotonic in complexity features
 *   5. paramCount     — correct arithmetic for linear + MLP
 *   6. renderMarkdown — stable table + pending-NL1 footer when MLP absent
 *   7. parseArgs      — every flag round-trips
 *   8. runBenchmark   — dry-run short-circuits, full-run produces finite metrics
 *   9. runBenchmark   — identical seed ⇒ identical linear metrics (determinism)
 *  10. loadNeuralPolicyModule — returns null gracefully when module missing
 *  11. main --output  — writes JSON to disk, emits Markdown to stdout
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';

import {
  createRng,
  generateEpisodes,
  heuristicLabel,
  loadNeuralPolicyModule,
  main,
  paramCount,
  parseArgs,
  renderMarkdown,
  runBenchmark,
  splitEpisodes,
} from '../../scripts/benchmark-policy.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(prefix) {
  const dir = path.join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// 1. createRng determinism
// ---------------------------------------------------------------------------

describe('createRng', () => {
  it('returns the same stream for the same seed', () => {
    const a = createRng(7);
    const b = createRng(7);
    for (let i = 0; i < 20; i++) {
      expect(a()).toBe(b());
    }
  });

  it('returns different streams for different seeds', () => {
    const a = createRng(1);
    const b = createRng(2);
    const firstA = [a(), a(), a(), a()];
    const firstB = [b(), b(), b(), b()];
    expect(firstA).not.toEqual(firstB);
  });

  it('produces values in [0, 1)', () => {
    const rng = createRng(123);
    for (let i = 0; i < 50; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. generateEpisodes determinism
// ---------------------------------------------------------------------------

describe('generateEpisodes', () => {
  it('produces identical corpora for identical seeds', () => {
    const a = generateEpisodes({ count: 20, seed: 99 });
    const b = generateEpisodes({ count: 20, seed: 99 });
    expect(a).toEqual(b);
  });

  it('produces different corpora for different seeds', () => {
    const a = generateEpisodes({ count: 20, seed: 1 });
    const b = generateEpisodes({ count: 20, seed: 2 });
    expect(a[0]).not.toEqual(b[0]);
  });

  it('yields expected episode shape', () => {
    const eps = generateEpisodes({ count: 5, seed: 5 });
    for (const e of eps) {
      expect(e.classification).toBeDefined();
      expect(e.classification.factors).toMatchObject({
        steps: expect.any(Number),
        domains: expect.any(Number),
        uncertainty: expect.any(Number),
        risk: expect.any(Number),
        novelty: expect.any(Number),
      });
      expect([1, 2]).toContain(e.classification.system);
      expect(typeof e.reward).toBe('number');
      expect(Number.isFinite(e.reward)).toBe(true);
      expect(typeof e.intentFamily).toBe('string');
      expect(typeof e.isExploration).toBe('boolean');
    }
  });

  it('respects the requested count', () => {
    const eps = generateEpisodes({ count: 37, seed: 11 });
    expect(eps).toHaveLength(37);
  });
});

// ---------------------------------------------------------------------------
// 3. splitEpisodes
// ---------------------------------------------------------------------------

describe('splitEpisodes', () => {
  it('splits by the requested ratio', () => {
    const arr = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const { train, heldOut } = splitEpisodes(arr, 0.8);
    expect(train).toHaveLength(80);
    expect(heldOut).toHaveLength(20);
    expect(train[0].id).toBe(0);
    expect(heldOut[0].id).toBe(80);
  });

  it('handles empty input', () => {
    const { train, heldOut } = splitEpisodes([], 0.8);
    expect(train).toHaveLength(0);
    expect(heldOut).toHaveLength(0);
  });

  it('defaults ratio to 0.8', () => {
    const arr = Array.from({ length: 10 }, (_, i) => i);
    const { train, heldOut } = splitEpisodes(arr);
    expect(train).toHaveLength(8);
    expect(heldOut).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 4. heuristicLabel monotonicity
// ---------------------------------------------------------------------------

describe('heuristicLabel', () => {
  it('returns 0 for low complexity', () => {
    const label = heuristicLabel({
      steps: 0, domains: 0, uncertainty: 0, risk: 0, novelty: 0,
    });
    expect(label).toBe(0);
  });

  it('returns 1 for high complexity', () => {
    const label = heuristicLabel({
      steps: 1, domains: 1, uncertainty: 1, risk: 1, novelty: 1,
    });
    expect(label).toBe(1);
  });

  it('crosses threshold near the middle', () => {
    const lo = heuristicLabel({
      steps: 0.3, domains: 0.3, uncertainty: 0.3, risk: 0.3, novelty: 0.3,
    });
    const hi = heuristicLabel({
      steps: 0.8, domains: 0.8, uncertainty: 0.8, risk: 0.8, novelty: 0.8,
    });
    expect(lo).toBe(0);
    expect(hi).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. paramCount
// ---------------------------------------------------------------------------

describe('paramCount', () => {
  it('linear equals feature dimension', () => {
    expect(paramCount('linear', { featureDim: 9 })).toBe(9);
  });

  it('mlp counts every weight and bias', () => {
    // 9 -> 16 -> 1 : (9*16=144) + 16 bias + (16*1=16) + 1 bias = 177
    expect(paramCount('mlp', { featureDim: 9, hiddenDim: 16, outputDim: 1 })).toBe(177);
  });

  it('mlp uses default hidden/output dims', () => {
    // default hiddenDim=16, outputDim=1 → same as above
    expect(paramCount('mlp', { featureDim: 9 })).toBe(177);
  });
});

// ---------------------------------------------------------------------------
// 6. renderMarkdown
// ---------------------------------------------------------------------------

describe('renderMarkdown', () => {
  const baseConfig = {
    episodes: 200, seed: 42, iterations: 20, trainRatio: 0.8,
    targetLogLoss: 0.4, hiddenDim: 16,
  };

  it('renders a full table when both policies succeed', () => {
    const md = renderMarkdown({
      config: baseConfig,
      linear: {
        logLoss: 0.32, accuracyVsHeuristic: 0.91,
        trainingTimeMs: 12.5, convergenceIters: 8, paramCount: 9,
      },
      mlp: {
        logLoss: 0.28, accuracyVsHeuristic: 0.93,
        trainingTimeMs: 45.1, convergenceIters: 6, paramCount: 177,
      },
    });
    expect(md).toContain('| Metric | Linear (v3.4) | MLP (NL1) |');
    expect(md).toContain('logLoss');
    expect(md).toContain('0.3200');
    expect(md).toContain('0.2800');
    expect(md).toContain('Config: episodes=200, seed=42');
    expect(md).not.toContain('pending NL1');
    expect(md).not.toContain('neural-policy.js');
  });

  it('appends pending-NL1 footer when MLP metrics are null', () => {
    const md = renderMarkdown({
      config: baseConfig,
      linear: {
        logLoss: 0.32, accuracyVsHeuristic: 0.91,
        trainingTimeMs: 12.5, convergenceIters: 8, paramCount: 9,
      },
      mlp: null,
    });
    expect(md).toContain('N/A');
    expect(md).toContain('neural-policy.js');
    expect(md).toContain('NL1');
  });

  it('prints N/A for NaN / Infinity metrics', () => {
    const md = renderMarkdown({
      config: baseConfig,
      linear: {
        logLoss: Number.NaN, accuracyVsHeuristic: Number.POSITIVE_INFINITY,
        trainingTimeMs: 1, convergenceIters: -1, paramCount: 9,
      },
      mlp: null,
    });
    expect(md).toContain('N/A');
  });
});

// ---------------------------------------------------------------------------
// 7. parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('returns defaults when empty', () => {
    const a = parseArgs([]);
    expect(a).toMatchObject({
      episodes: 400, seed: 42, iterations: 30,
      output: null, dryRun: false, help: false,
    });
  });

  it('parses every flag', () => {
    const a = parseArgs([
      '--episodes', '1000',
      '--seed', '7',
      '--iterations', '50',
      '--output', '/tmp/out.json',
      '--dry-run',
    ]);
    expect(a.episodes).toBe(1000);
    expect(a.seed).toBe(7);
    expect(a.iterations).toBe(50);
    expect(a.output).toBe('/tmp/out.json');
    expect(a.dryRun).toBe(true);
  });

  it('--help short form', () => {
    const a = parseArgs(['-h']);
    expect(a.help).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. runBenchmark (dry-run and full)
// ---------------------------------------------------------------------------

describe('runBenchmark', () => {
  it('dry-run skips training and returns a stub result', async () => {
    const res = await runBenchmark({ dryRun: true });
    expect(res.skipped).toBe(true);
    expect(res.linear).toBeNull();
    expect(res.mlp).toBeNull();
    expect(res.episodesGenerated).toBe(0);
    expect(res.config.episodes).toBeGreaterThan(0);
  });

  it('full run yields finite linear metrics when neural module is absent', async () => {
    const res = await runBenchmark({
      episodes: 80,
      seed: 42,
      iterations: 10,
      neuralMod: null,
    });
    expect(res.skipped).toBe(false);
    expect(res.linear).not.toBeNull();
    expect(Number.isFinite(res.linear.logLoss)).toBe(true);
    expect(res.linear.logLoss).toBeGreaterThanOrEqual(0);
    expect(res.linear.accuracyVsHeuristic).toBeGreaterThanOrEqual(0);
    expect(res.linear.accuracyVsHeuristic).toBeLessThanOrEqual(1);
    expect(res.linear.paramCount).toBe(9);
    expect(res.mlp).toBeNull();
  });

  it('produces identical linear metrics for identical seeds (determinism)', async () => {
    const opts = { episodes: 60, seed: 123, iterations: 5, neuralMod: null };
    const r1 = await runBenchmark(opts);
    const r2 = await runBenchmark(opts);
    expect(r1.linear.logLoss).toBeCloseTo(r2.linear.logLoss, 10);
    expect(r1.linear.accuracyVsHeuristic).toBeCloseTo(r2.linear.accuracyVsHeuristic, 10);
    expect(r1.linear.paramCount).toBe(r2.linear.paramCount);
    expect(r1.linear.convergenceIters).toBe(r2.linear.convergenceIters);
  });

  it('respects a stubbed MLP module', async () => {
    const stubNeural = {
      createNeuralPolicy() {
        return {
          trainOne() { /* no-op */ },
          evaluate() {
            return { logLoss: 0.35, accuracyVsHeuristic: 0.88 };
          },
        };
      },
    };
    const res = await runBenchmark({
      episodes: 60,
      seed: 9,
      iterations: 4,
      neuralMod: stubNeural,
    });
    expect(res.mlp).not.toBeNull();
    expect(res.mlp.logLoss).toBeCloseTo(0.35, 6);
    expect(res.mlp.paramCount).toBe(
      paramCount('mlp', { featureDim: 9, hiddenDim: 16 }),
    );
    expect(res.mlp.convergenceIters).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 9. loadNeuralPolicyModule graceful fallback
// ---------------------------------------------------------------------------

describe('loadNeuralPolicyModule', () => {
  it('returns null when neural-policy.js is missing (current NL1 state)', async () => {
    // If NL1 ever lands, this test will surface that fact — adapt accordingly.
    const mod = await loadNeuralPolicyModule();
    // Accept either null (file missing) or a real module with createNeuralPolicy.
    expect(mod === null || typeof mod.createNeuralPolicy === 'function').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. main() CLI with --output
// ---------------------------------------------------------------------------

describe('main (CLI)', () => {
  let tmp;

  afterEach(async () => {
    if (tmp && existsSync(tmp)) {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('--help returns 0 and prints usage to stderr', async () => {
    const spyOut = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const spyErr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await main(['--help']);
    expect(code).toBe(0);
    expect(spyErr).toHaveBeenCalled();
    spyOut.mockRestore();
    spyErr.mockRestore();
  });

  it('--dry-run writes Markdown to stdout and exits 0', async () => {
    let stdoutBuf = '';
    const spyOut = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      stdoutBuf += s;
      return true;
    });
    const spyErr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await main(['--dry-run']);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain('| Metric |');
    spyOut.mockRestore();
    spyErr.mockRestore();
  });

  it('--output writes JSON to disk', async () => {
    tmp = await makeTmpDir('benchmark-policy-cli');
    const outPath = path.join(tmp, 'result.json');
    const spyOut = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const spyErr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await main([
      '--episodes', '40',
      '--iterations', '3',
      '--seed', '1',
      '--output', outPath,
    ]);
    expect(code).toBe(0);
    const raw = await readFile(outPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.config.episodes).toBe(40);
    expect(parsed.linear).not.toBeNull();
    spyOut.mockRestore();
    spyErr.mockRestore();
  });

  it('rejects invalid --episodes', async () => {
    const spyOut = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const spyErr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await main(['--episodes', '-5']);
    expect(code).toBe(1);
    spyOut.mockRestore();
    spyErr.mockRestore();
  });

  it('rejects NaN --iterations', async () => {
    const spyOut = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const spyErr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await main(['--iterations', 'not-a-number']);
    expect(code).toBe(1);
    spyOut.mockRestore();
    spyErr.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 11. Integration smoke: harness writes stable corpora at boundary sizes
// ---------------------------------------------------------------------------

describe('integration smoke', () => {
  it('single-episode corpus does not crash', () => {
    const eps = generateEpisodes({ count: 1, seed: 5 });
    expect(eps).toHaveLength(1);
  });

  it('large corpus remains deterministic', () => {
    const a = generateEpisodes({ count: 500, seed: 999 });
    const b = generateEpisodes({ count: 500, seed: 999 });
    // Deep equality check via length + spot-sample to avoid O(n) clones.
    expect(a.length).toBe(b.length);
    expect(a[0]).toEqual(b[0]);
    expect(a[250]).toEqual(b[250]);
    expect(a[499]).toEqual(b[499]);
  });
});
