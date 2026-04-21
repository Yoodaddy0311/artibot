/**
 * Tests for lib/learning/kill-switch (v1 per-feature + Wave-2 emergency).
 *
 * Uses per-test temp dirs. For Wave-2 tests we also write a minimal
 * artibot.config.json into the temp dir (acting as a faux pluginRoot) and
 * pass it via opts.pluginRoot so the module edits the temp copy instead
 * of the real project config.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getKillSwitchState,
  isKillSwitchTripped,
  recordFailure,
  resetKillSwitch,
} from '../../lib/learning/kill-switch.js';

// ---------------------------------------------------------------------------

let tmpDir;
let emergencyStatePath;
let v1StatePath;
let configJsonPath;

function buildCfg(overrides = {}) {
  return {
    ago: {
      selfControl: {
        masterEnabled: true,
        killSwitch: {
          threshold: 3,
          windowMs: 60 * 60 * 1000,
          statePath: v1StatePath,
        },
        emergencyKillSwitch: {
          enabled: true,
          maxFailuresPerHour: 3,
          cooldownHours: 24,
          statePath: emergencyStatePath,
          ...overrides.emergencyKillSwitch,
        },
      },
    },
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'artibot-kill-switch-'));
  mkdirSync(path.join(tmpDir, 'runtime'), { recursive: true });
  emergencyStatePath = path.join(tmpDir, 'runtime', 'kill-switch-state.json');
  v1StatePath = path.join(tmpDir, 'runtime', 'kill-switch.json');
  configJsonPath = path.join(tmpDir, 'artibot.config.json');

  // Seed faux config file for emergency tests (setMasterEnabled reads + writes here)
  writeFileSync(
    configJsonPath,
    JSON.stringify({
      version: 'test',
      ago: { selfControl: { masterEnabled: true } },
    }, null, 2),
    'utf-8',
  );
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// v1 per-feature semantics (backward compat)
// ---------------------------------------------------------------------------

describe('per-feature (v1) kill switch', () => {
  it('does not trip under threshold', async () => {
    const cfg = buildCfg();
    // Disable emergency branch for v1-focused tests so we don't mutate config
    cfg.ago.selfControl.emergencyKillSwitch.enabled = false;
    const r1 = await recordFailure({ feature: 'autoCommit', error: 'e1' }, cfg, { pluginRoot: tmpDir });
    const r2 = await recordFailure({ feature: 'autoCommit', error: 'e2' }, cfg, { pluginRoot: tmpDir });
    expect(r1.tripped).toBe(false);
    expect(r2.tripped).toBe(false);
    expect(r2.count).toBe(2);
    expect(await isKillSwitchTripped(cfg, { feature: 'autoCommit', pluginRoot: tmpDir })).toBe(false);
  });

  it('trips at threshold for the feature', async () => {
    const cfg = buildCfg();
    cfg.ago.selfControl.emergencyKillSwitch.enabled = false;
    await recordFailure({ feature: 'autoCommit', error: 'e1' }, cfg, { pluginRoot: tmpDir });
    await recordFailure({ feature: 'autoCommit', error: 'e2' }, cfg, { pluginRoot: tmpDir });
    const r3 = await recordFailure({ feature: 'autoCommit', error: 'e3' }, cfg, { pluginRoot: tmpDir });
    expect(r3.tripped).toBe(true);
    expect(await isKillSwitchTripped(cfg, { feature: 'autoCommit', pluginRoot: tmpDir })).toBe(true);
  });

  it('resetKillSwitch(feature, config) clears one feature only', async () => {
    const cfg = buildCfg();
    cfg.ago.selfControl.emergencyKillSwitch.enabled = false;
    for (let i = 0; i < 3; i += 1) {
      await recordFailure({ feature: 'autoCommit', error: 'x' }, cfg, { pluginRoot: tmpDir });
    }
    expect(await isKillSwitchTripped(cfg, { feature: 'autoCommit', pluginRoot: tmpDir })).toBe(true);
    const res = await resetKillSwitch('autoCommit', cfg, { pluginRoot: tmpDir });
    expect(res.reset).toBe(true);
    expect(await isKillSwitchTripped(cfg, { feature: 'autoCommit', pluginRoot: tmpDir })).toBe(false);
  });

  it('rejects prototype-polluting feature names', async () => {
    const cfg = buildCfg();
    cfg.ago.selfControl.emergencyKillSwitch.enabled = false;
    const r = await recordFailure({ feature: '__proto__' }, cfg, { pluginRoot: tmpDir });
    expect(r.tripped).toBe(false);
    expect(r.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Emergency (Wave 2) semantics
// ---------------------------------------------------------------------------

describe('emergency global kill switch', () => {
  it('does not trip below maxFailuresPerHour', async () => {
    const cfg = buildCfg();
    const r1 = await recordFailure({ feature: 'autoCommit', error: 'e1' }, cfg, { pluginRoot: tmpDir });
    const r2 = await recordFailure({ feature: 'autoCleanup', error: 'e2' }, cfg, { pluginRoot: tmpDir });
    expect(r1.emergency.tripped).toBe(false);
    expect(r2.emergency.tripped).toBe(false);
    expect(r2.emergency.failuresPast1h).toBe(2);

    const cfgOnDisk = JSON.parse(readFileSync(configJsonPath, 'utf-8'));
    expect(cfgOnDisk.ago.selfControl.masterEnabled).toBe(true);
  });

  it('trips at threshold and flips masterEnabled=false', async () => {
    const cfg = buildCfg();
    await recordFailure({ feature: 'autoCommit', error: 'e1' }, cfg, { pluginRoot: tmpDir });
    await recordFailure({ feature: 'autoCleanup', error: 'e2' }, cfg, { pluginRoot: tmpDir });
    const r3 = await recordFailure({ feature: 'autoCommit', error: 'e3' }, cfg, { pluginRoot: tmpDir });

    expect(r3.emergency.tripped).toBe(true);
    expect(r3.emergency.masterDisabled).toBe(true);
    expect(typeof r3.emergency.cooldownUntil).toBe('string');

    const cfgOnDisk = JSON.parse(readFileSync(configJsonPath, 'utf-8'));
    expect(cfgOnDisk.ago.selfControl.masterEnabled).toBe(false);
    expect(await isKillSwitchTripped(cfg, { pluginRoot: tmpDir })).toBe(true);
  });

  it('clears tripped state after cooldown expiry (masterEnabled NOT auto-restored)', async () => {
    const cfg = buildCfg();
    for (let i = 0; i < 3; i += 1) {
      await recordFailure({ feature: 'autoCommit', error: `e${i}` }, cfg, { pluginRoot: tmpDir });
    }
    const stateBefore = JSON.parse(readFileSync(emergencyStatePath, 'utf-8'));
    expect(stateBefore.tripped).toBe(true);

    // Simulate cooldown passing by rewriting cooldownUntil into the past
    const modified = { ...stateBefore, cooldownUntil: new Date(Date.now() - 1000).toISOString() };
    writeFileSync(emergencyStatePath, JSON.stringify(modified, null, 2), 'utf-8');

    const s = await getKillSwitchState(cfg, { pluginRoot: tmpDir });
    expect(s.tripped).toBe(false);
    expect(s.failuresPast1h).toBe(0);

    // masterEnabled stays false — user must manually reset
    const cfgOnDisk = JSON.parse(readFileSync(configJsonPath, 'utf-8'));
    expect(cfgOnDisk.ago.selfControl.masterEnabled).toBe(false);
  });

  it('resetKillSwitch(config) clears state and restores masterEnabled=true', async () => {
    const cfg = buildCfg();
    for (let i = 0; i < 3; i += 1) {
      await recordFailure({ feature: 'autoCommit', error: `e${i}` }, cfg, { pluginRoot: tmpDir });
    }
    expect((JSON.parse(readFileSync(configJsonPath, 'utf-8'))).ago.selfControl.masterEnabled).toBe(false);

    const res = await resetKillSwitch(cfg, undefined, { pluginRoot: tmpDir });
    expect(res.reset).toBe(true);
    expect(res.masterRestored).toBe(true);
    const cfgOnDisk = JSON.parse(readFileSync(configJsonPath, 'utf-8'));
    expect(cfgOnDisk.ago.selfControl.masterEnabled).toBe(true);
    const s = await getKillSwitchState(cfg, { pluginRoot: tmpDir });
    expect(s.tripped).toBe(false);
    expect(s.failuresPast1h).toBe(0);
  });

  it('returns inert state when emergencyKillSwitch.enabled=false', async () => {
    const cfg = buildCfg({ emergencyKillSwitch: { enabled: false } });
    const s = await getKillSwitchState(cfg, { pluginRoot: tmpDir });
    expect(s).toEqual({ tripped: false, failuresPast1h: 0, cooldownUntil: null });

    const r = await recordFailure({ feature: 'autoCommit', error: 'x' }, cfg, { pluginRoot: tmpDir });
    // v1 still runs but emergency branch stays inert → no `.emergency` key
    expect(r.emergency).toBeUndefined();
    const cfgOnDisk = JSON.parse(readFileSync(configJsonPath, 'utf-8'));
    expect(cfgOnDisk.ago.selfControl.masterEnabled).toBe(true);
  });

  it('ignores failures older than one hour when counting', async () => {
    const cfg = buildCfg();
    const oldTs = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    // Seed state file with two old failures
    writeFileSync(
      emergencyStatePath,
      JSON.stringify({
        failures: [
          { feature: 'autoCommit', error: 'old1', timestamp: oldTs },
          { feature: 'autoCommit', error: 'old2', timestamp: oldTs },
        ],
        tripped: false,
        trippedAt: null,
        cooldownUntil: null,
      }, null, 2),
      'utf-8',
    );

    const r = await recordFailure({ feature: 'autoCommit', error: 'new' }, cfg, { pluginRoot: tmpDir });
    expect(r.emergency.failuresPast1h).toBe(1);
    expect(r.emergency.tripped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Concurrency safety
// ---------------------------------------------------------------------------

describe('concurrency safety', () => {
  it('parallel recordFailure calls do not throw or corrupt state', async () => {
    const cfg = buildCfg();
    const promises = Array.from({ length: 5 }, (_, i) =>
      recordFailure({ feature: `feat-${i}`, error: `p${i}` }, cfg, { pluginRoot: tmpDir }),
    );
    const results = await Promise.all(promises);
    for (const r of results) {
      expect(r).toBeDefined();
      expect(typeof r.count).toBe('number');
    }
    // State file must still be parseable JSON
    const state = JSON.parse(readFileSync(emergencyStatePath, 'utf-8'));
    expect(Array.isArray(state.failures)).toBe(true);
  });
});
