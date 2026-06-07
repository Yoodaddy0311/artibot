/**
 * P3 — lib/learning/grpo/effort-policy-updater.js unit tests.
 *
 * Pure aggregation + derivation are tested in isolation; persistence + cold-start
 * + snapshot rotation use a real temp directory.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createEffortPolicyUpdater,
  deriveOverlay,
  EFFORT_TRAINER_DEFAULTS,
  loadEffortPolicy,
  resolveEffortPolicyPaths,
  rollupEffortEpisodes,
  saveEffortPolicy,
} from '../../../lib/learning/grpo/effort-policy-updater.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEpisodes({ command, effort, n, reward, tokensUsed, clipped = false }) {
  return Array.from({ length: n }, () => ({
    command, effort, reward, tokensUsed, clipped,
  }));
}

// ---------------------------------------------------------------------------
// rollupEffortEpisodes
// ---------------------------------------------------------------------------

describe('rollupEffortEpisodes()', () => {
  it('aggregates per-command mean reward + mean tokens', () => {
    const eps = [
      { command: 'implement', reward: 0.2, tokensUsed: 1000 },
      { command: 'implement', reward: 0.4, tokensUsed: 3000 },
      { command: 'review', reward: -0.1, tokensUsed: 500 },
    ];
    const r = rollupEffortEpisodes(eps);
    expect(r.perCommand.implement.count).toBe(2);
    expect(r.perCommand.implement.meanReward).toBeCloseTo(0.3, 6);
    expect(r.perCommand.implement.meanTokens).toBeCloseTo(2000, 6);
    expect(r.perCommand.review.count).toBe(1);
  });

  it('aggregates per-effort clipRate + mean reward', () => {
    const eps = [
      { effort: 'xhigh', reward: 1.2 },
      { effort: 'xhigh', reward: 0.3 },
      { effort: 'xhigh', reward: -1.5 },
      { effort: 'xhigh', reward: 0.5 },
    ];
    const r = rollupEffortEpisodes(eps);
    expect(r.perEffort.xhigh.count).toBe(4);
    expect(r.perEffort.xhigh.clipRate).toBeCloseTo(0.5, 6); // 1.2 and -1.5 clipped
  });

  it('skips episodes without a finite reward', () => {
    const r = rollupEffortEpisodes([
      { command: 'x', reward: NaN },
      { command: 'x', reward: 'bad' },
      null,
    ]);
    expect(r.perCommand.x).toBeUndefined();
  });

  it('ignores unknown effort bands', () => {
    const r = rollupEffortEpisodes([{ effort: 'turbo', reward: 0.5 }]);
    expect(r.perEffort.turbo).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deriveOverlay
// ---------------------------------------------------------------------------

describe('deriveOverlay()', () => {
  const minPerKey = EFFORT_TRAINER_DEFAULTS.minPerKey;

  it('shifts band -1 on negative reward + high token consumption', () => {
    const eps = makeEpisodes({ command: 'implement', n: minPerKey, reward: -0.5, tokensUsed: 0.9 });
    const overlay = deriveOverlay(rollupEffortEpisodes(eps), null);
    expect(overlay.bandShifts.implement).toBe(-1);
  });

  it('shifts band +1 on high reward', () => {
    const eps = makeEpisodes({ command: 'implement', n: minPerKey, reward: 0.5, tokensUsed: 0.1 });
    const overlay = deriveOverlay(rollupEffortEpisodes(eps), null);
    expect(overlay.bandShifts.implement).toBe(1);
  });

  it('excludes keys below minPerKey', () => {
    const eps = makeEpisodes({ command: 'implement', n: minPerKey - 1, reward: 0.5, tokensUsed: 0.1 });
    const overlay = deriveOverlay(rollupEffortEpisodes(eps), null);
    expect(overlay.bandShifts.implement).toBeUndefined();
  });

  it('clamps two consecutive -1 nudges to -1 (no overshoot)', () => {
    const eps = makeEpisodes({ command: 'implement', n: minPerKey, reward: -0.5, tokensUsed: 0.9 });
    const first = deriveOverlay(rollupEffortEpisodes(eps), null);
    expect(first.bandShifts.implement).toBe(-1);
    const second = deriveOverlay(rollupEffortEpisodes(eps), first);
    expect(second.bandShifts.implement).toBe(-1); // clamped, not -2
  });

  it('is idempotent when prev already equals target', () => {
    const eps = makeEpisodes({ command: 'implement', n: minPerKey, reward: 0.5, tokensUsed: 0.1 });
    const first = deriveOverlay(rollupEffortEpisodes(eps), null);
    const second = deriveOverlay(rollupEffortEpisodes(eps), first);
    expect(second.bandShifts.implement).toBe(first.bandShifts.implement);
  });

  it('raises budget multiplier on high clip rate', () => {
    const eps = [
      ...makeEpisodes({ effort: 'xhigh', n: Math.ceil(minPerKey * 0.6), reward: 1.2 }),
      ...makeEpisodes({ effort: 'xhigh', n: Math.floor(minPerKey * 0.4), reward: 0.3 }),
    ];
    const r = rollupEffortEpisodes(eps);
    expect(r.perEffort.xhigh.clipRate).toBeGreaterThan(0.25);
    const overlay = deriveOverlay(r, null);
    expect(overlay.budgetMultipliers.xhigh).toBeCloseTo(1.1, 6); // 1.0 + 0.1
  });

  it('caps the total L1 delta (KL-style scaling) when changes are large', () => {
    // Many commands each wanting +1 -> total L1 would exceed deltaL1Cap=1.5.
    const eps = [];
    for (const c of ['implement', 'team', 'tdd', 'spawn']) {
      eps.push(...makeEpisodes({ command: c, n: minPerKey, reward: 0.5, tokensUsed: 0.1 }));
    }
    const overlay = deriveOverlay(rollupEffortEpisodes(eps), null, { deltaL1Cap: 1.5 });
    const l1 = Object.values(overlay.bandShifts).reduce((s, v) => s + Math.abs(v), 0);
    expect(l1).toBeLessThanOrEqual(1.5 + 1e-9);
  });
});

// ---------------------------------------------------------------------------
// Persistence + facade (real temp dir)
// ---------------------------------------------------------------------------

describe('saveEffortPolicy + loadEffortPolicy', () => {
  let tmp;
  let policyPath;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'artibot-effort-'));
    policyPath = path.join(tmp, 'effort-policy-v1.json');
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('writes a versioned policy and round-trips via loadEffortPolicy', async () => {
    await saveEffortPolicy(
      { bandShifts: { implement: 1 }, budgetMultipliers: { xhigh: 1.2 } },
      { policyPath, trainedOnEpisodes: 200 },
    );
    expect(existsSync(policyPath)).toBe(true);
    const loaded = await loadEffortPolicy(policyPath);
    expect(loaded.version).toBe(1);
    expect(loaded.bandShifts.implement).toBe(1);
    expect(loaded.budgetMultipliers.xhigh).toBe(1.2);
    expect(loaded.trainedOnEpisodes).toBe(200);
  });

  it('resolveEffortPolicyPaths derives snapshot dir', () => {
    const { policyFile, snapshotDir } = resolveEffortPolicyPaths(policyPath);
    expect(policyFile).toBe(policyPath);
    expect(snapshotDir).toBe(path.join(tmp, 'snapshots'));
  });

  it('retains only snapshotCount snapshots after 4 saves', async () => {
    const overlay = { bandShifts: { implement: 1 }, budgetMultipliers: {} };
    // Injected monotonic fake clock -> distinct ISO stamps + snapshot ids per
    // save, no real sleep. Each tick advances 1s so trainedAt/snapshotId differ.
    let t = Date.UTC(2026, 0, 1, 0, 0, 0);
    const now = () => new Date((t += 1000));
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const saved = await saveEffortPolicy(overlay, { policyPath, snapshotCount: 3, now });
      ids.push(saved.snapshotId);
    }
    // Clock injection makes the four snapshot ids distinct (no collision).
    expect(new Set(ids).size).toBe(4);
    const snaps = readdirSync(path.join(tmp, 'snapshots')).filter((f) => f.endsWith('.json'));
    expect(snaps.length).toBe(3);
  });
});

describe('createEffortPolicyUpdater().trainFromEpisodes', () => {
  let tmp;
  let policyPath;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'artibot-effort-fac-'));
    policyPath = path.join(tmp, 'effort-policy-v1.json');
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('cold-start guard: below coldStartEpisodes -> no disk write', async () => {
    const updater = createEffortPolicyUpdater({ policyPath, config: { coldStartEpisodes: 150 } });
    const eps = makeEpisodes({ command: 'implement', n: 10, reward: 0.5, tokensUsed: 0.1 });
    const res = await updater.trainFromEpisodes(eps);
    expect(res.skipped).toBe(true);
    expect(res.episodesUsed).toBe(10);
    expect(existsSync(policyPath)).toBe(false);
  });

  it('trains + persists when episode count meets cold-start threshold', async () => {
    const updater = createEffortPolicyUpdater({
      policyPath,
      config: { coldStartEpisodes: 20, minPerKey: 20 },
    });
    const eps = makeEpisodes({ command: 'implement', n: 30, reward: 0.5, tokensUsed: 0.1 });
    const res = await updater.trainFromEpisodes(eps);
    expect(res.skipped).toBeUndefined();
    expect(res.coldStart).toBe(true);
    expect(res.overlay.bandShifts.implement).toBe(1);
    expect(existsSync(policyPath)).toBe(true);
  });
});
