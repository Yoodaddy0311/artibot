/**
 * P3 — lib/cognitive/effort-policy-config.js unit tests.
 *
 * Verifies the safe-default config reader + learned-overlay resolution:
 *   - disabled config -> IDENTITY overlay
 *   - enabled + valid file -> normalized (clamped) overlay
 *   - missing / corrupt / version!=1 file -> IDENTITY overlay
 *   - clamp ranges for bandShifts ([-1,+1] int) and budgetMultipliers ([0.5,1.5])
 *   - 60s memo + force bypass + __setCachedConfigForTests seam
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

// In-memory disk for the overlay file reader.
const diskMap = new Map();
let configBlock; // value returned for config.learning.grpoRouting.effortPolicy

vi.mock('../../lib/core/config.js', () => ({
  loadConfig: vi.fn(async () => ({
    learning: { grpoRouting: { effortPolicy: configBlock } },
  })),
}));

vi.mock('../../lib/core/file.js', () => ({
  readJsonFile: vi.fn(async (p) => (diskMap.has(p) ? JSON.parse(diskMap.get(p)) : null)),
}));

vi.mock('../../lib/core/platform.js', () => ({
  getHomeDir: () => '/home/test',
}));

let mod;

beforeEach(async () => {
  diskMap.clear();
  configBlock = undefined;
  vi.resetModules();
  mod = await import('../../lib/cognitive/effort-policy-config.js');
  mod.resetEffortPolicyConfigCache();
});

afterEach(() => {
  vi.clearAllMocks();
});

// Absolute path used as the overlay policyPath so the reader skips `~` expansion
// and keys the (mocked) disk by an OS-normalized absolute path.
const OVERLAY_PATH = path.resolve(path.sep, 'tmp', 'effort-policy-v1.json');
const ENABLED_ABS = { enabled: true, policyPath: OVERLAY_PATH };

describe('getEffortPolicyConfig()', () => {
  it('defaults to disabled when block is missing', async () => {
    const cfg = await mod.getEffortPolicyConfig({ force: true });
    expect(cfg.enabled).toBe(false);
    expect(cfg.coldStartEpisodes).toBe(150);
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it('reads enabled flag and clamps numeric fields', async () => {
    configBlock = { enabled: true, coldStartEpisodes: -5, deltaL1Cap: 99 };
    const cfg = await mod.getEffortPolicyConfig({ force: true });
    expect(cfg.enabled).toBe(true);
    expect(cfg.coldStartEpisodes).toBe(150); // negative -> fallback default
    expect(cfg.deltaL1Cap).toBe(10); // clamped to max
  });

  it('memoizes for 60s and force bypasses', async () => {
    configBlock = { enabled: true };
    const a = await mod.getEffortPolicyConfig({ force: true });
    expect(a.enabled).toBe(true);
    configBlock = { enabled: false };
    const cached = await mod.getEffortPolicyConfig(); // within TTL -> stale memo
    expect(cached.enabled).toBe(true);
    const fresh = await mod.getEffortPolicyConfig({ force: true });
    expect(fresh.enabled).toBe(false);
  });

  it('__setCachedConfigForTests injects a normalized value', () => {
    const v = mod.__setCachedConfigForTests({ enabled: true });
    expect(v.enabled).toBe(true);
    expect(mod.getCachedEffortPolicyConfig().enabled).toBe(true);
  });

  it('getCachedEffortPolicyConfig returns disabled defaults when cold', () => {
    mod.resetEffortPolicyConfigCache();
    expect(mod.getCachedEffortPolicyConfig().enabled).toBe(false);
  });
});

describe('getEffortPolicyOverlay()', () => {
  it('returns IDENTITY when config disabled (no file read)', async () => {
    configBlock = { enabled: false };
    diskMap.set(OVERLAY_PATH, JSON.stringify({ version: 1, bandShifts: { implement: 1 } }));
    const overlay = await mod.getEffortPolicyOverlay({ force: true });
    expect(overlay.enabled).toBe(false);
    expect(overlay.bandShifts).toEqual({});
    expect(overlay.budgetMultipliers).toEqual({});
  });

  it('reads + normalizes a valid enabled overlay', async () => {
    configBlock = ENABLED_ABS;
    diskMap.set(OVERLAY_PATH, JSON.stringify({
      version: 1,
      bandShifts: { implement: 1, review: -1 },
      budgetMultipliers: { xhigh: 1.2, high: 0.8 },
    }));
    const overlay = await mod.getEffortPolicyOverlay({ force: true });
    expect(overlay.enabled).toBe(true);
    expect(overlay.bandShifts.implement).toBe(1);
    expect(overlay.bandShifts.review).toBe(-1);
    expect(overlay.budgetMultipliers.xhigh).toBe(1.2);
    expect(overlay.budgetMultipliers.high).toBe(0.8);
  });

  it('clamps out-of-range bandShifts to [-1,+1] int and multipliers to [0.5,1.5]', async () => {
    configBlock = ENABLED_ABS;
    diskMap.set(OVERLAY_PATH, JSON.stringify({
      version: 1,
      bandShifts: { a: 5, b: -9, c: 0.6 },
      budgetMultipliers: { xhigh: 9, high: 0.1, max: 1.3 },
    }));
    const overlay = await mod.getEffortPolicyOverlay({ force: true });
    expect(overlay.bandShifts.a).toBe(1);
    expect(overlay.bandShifts.b).toBe(-1);
    expect(overlay.bandShifts.c).toBe(1); // round(0.6)=1
    expect(overlay.budgetMultipliers.xhigh).toBe(1.5);
    expect(overlay.budgetMultipliers.high).toBe(0.5);
    expect(overlay.budgetMultipliers.max).toBe(1.3);
  });

  it('drops budget multipliers for unknown bands', async () => {
    configBlock = ENABLED_ABS;
    diskMap.set(OVERLAY_PATH, JSON.stringify({
      version: 1,
      budgetMultipliers: { notaband: 1.2, high: 1.1 },
    }));
    const overlay = await mod.getEffortPolicyOverlay({ force: true });
    expect('notaband' in overlay.budgetMultipliers).toBe(false);
    expect(overlay.budgetMultipliers.high).toBe(1.1);
  });

  it('returns IDENTITY when file is missing', async () => {
    configBlock = { enabled: true };
    const overlay = await mod.getEffortPolicyOverlay({ force: true });
    expect(overlay.enabled).toBe(false);
    expect(overlay.bandShifts).toEqual({});
  });

  it('returns IDENTITY when file is corrupt (no version)', async () => {
    configBlock = { enabled: true };
    diskMap.set(OVERLAY_PATH, JSON.stringify({ garbage: true, bandShifts: { x: 1 } }));
    const overlay = await mod.getEffortPolicyOverlay({ force: true });
    expect(overlay.enabled).toBe(false);
  });

  it('returns IDENTITY when version != 1', async () => {
    configBlock = { enabled: true };
    diskMap.set(OVERLAY_PATH, JSON.stringify({ version: 2, bandShifts: { x: 1 } }));
    const overlay = await mod.getEffortPolicyOverlay({ force: true });
    expect(overlay.enabled).toBe(false);
  });

  it('getCachedEffortPolicyOverlay returns IDENTITY when cold', () => {
    mod.resetEffortPolicyConfigCache();
    const overlay = mod.getCachedEffortPolicyOverlay();
    expect(overlay.enabled).toBe(false);
    expect(overlay.bandShifts).toEqual({});
  });

  it('memoizes the overlay for 60s', async () => {
    configBlock = ENABLED_ABS;
    diskMap.set(OVERLAY_PATH, JSON.stringify({ version: 1, bandShifts: { implement: 1 } }));
    await mod.getEffortPolicyOverlay({ force: true });
    const cached = mod.getCachedEffortPolicyOverlay();
    expect(cached.enabled).toBe(true);
    expect(cached.bandShifts.implement).toBe(1);
  });
});
