/**
 * kill-switch.js#resetKillSwitch(config) vs a trip landing inside it.
 *
 * The global reset ran three steps: (1) clear the emergency state under ITS lock,
 * (2) clear the v1 state under its lock, (3) re-enable the master switch. A trip
 * (recordEmergencyFailure) sets `tripped` and flips the master switch OFF inside
 * the emergency lock. Between (1) releasing that lock and (3), a trip could land:
 * it disabled the master switch, then (3) re-enabled it — leaving a TRIPPED
 * emergency state with the master switch ON. The production gate asks the
 * per-feature state and `masterEnabled` only (self-control-gates.js passes
 * `feature`), so that trip had no effect at all.
 *
 * Deterministic interleaving, no sleeps on the parent side: a child process holds
 * the v1 lock (step 2), so step 1 has run and step 3 cannot run yet; the child
 * waits until it sees step 1's cleared state on disk, trips the switch, and only
 * then releases the v1 lock. `res.persisted === true` proves the hand-off (the
 * parent got the v1 lock from the child rather than timing out on it).
 *
 * The child records its v1 rows in a file of its own, so it never needs the v1
 * lock it is holding. Everything lives in a temp dir handed in as `pluginRoot`.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetKillSwitch } from '../../lib/learning/kill-switch.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KS_URL = pathToFileURL(path.join(PLUGIN_ROOT, 'lib', 'learning', 'kill-switch.js')).href;

/** Holds the v1 lock, waits for the reset's cleared emergency state, trips, releases. */
const TRIPPER = `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const [ksUrl, v1Path, emergencyPath, cfgJson, root, markerDir] = process.argv.slice(2);
const { recordFailure } = await import(ksUrl);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const lock = v1Path + '.lock';
fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'race-child', timestamp: Date.now() }), { flag: 'wx' });
fs.writeFileSync(path.join(markerDir, 'held'), '');
const until = Date.now() + 10000;
for (;;) {
  try {
    const s = JSON.parse(fs.readFileSync(emergencyPath, 'utf-8'));
    if (s.tripped === false && s.failures.length === 0) break;
  } catch { /* mid-rename: read again */ }
  if (Date.now() > until) { fs.unlinkSync(lock); process.exit(3); }
  await sleep(5);
}
const cfg = JSON.parse(cfgJson);
let last;
for (let i = 0; i < 3; i += 1) last = await recordFailure({ feature: 'race-' + i }, cfg, { pluginRoot: root });
fs.writeFileSync(path.join(markerDir, 'tripped'), JSON.stringify(last.emergency));
fs.unlinkSync(lock);
`;

let tmpDir;
let v1Path;
let emergencyPath;
let cfgPath;
let stderr;

function cfg(v1 = v1Path) {
  return {
    ago: {
      selfControl: {
        killSwitch: { threshold: 1000, windowMs: 60 * 60 * 1000, statePath: v1 },
        emergencyKillSwitch: { enabled: true, maxFailuresPerHour: 3, cooldownHours: 24, statePath: emergencyPath },
      },
    },
  };
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf-8'));

async function waitFor(file, ms = 15_000) {
  const until = Date.now() + ms;
  while (!existsSync(file)) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${file}`);
    await new Promise((r) => { setTimeout(r, 10); });
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'artibot-ks-reset-race-'));
  mkdirSync(path.join(tmpDir, 'runtime'), { recursive: true });
  v1Path = path.join(tmpDir, 'runtime', 'kill-switch.json');
  emergencyPath = path.join(tmpDir, 'runtime', 'kill-switch-state.json');
  cfgPath = path.join(tmpDir, 'artibot.config.json');
  // The state after an earlier trip: emergency tripped, master switch off.
  const now = Date.now();
  writeFileSync(emergencyPath, JSON.stringify({
    failures: [0, 1, 2].map((i) => ({ feature: `old-${i}`, error: null, timestamp: new Date(now - i * 1000).toISOString() })),
    tripped: true,
    trippedAt: new Date(now).toISOString(),
    cooldownUntil: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
  }));
  writeFileSync(v1Path, JSON.stringify({ features: {} }));
  writeFileSync(cfgPath, JSON.stringify({ ago: { selfControl: { masterEnabled: false } } }));
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderr.mockRestore();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('resetKillSwitch(config) — a trip inside the reset is not overridden', () => {
  it('a trip landing after the emergency state is cleared leaves the master switch OFF', async () => {
    const script = path.join(tmpDir, 'tripper.mjs');
    writeFileSync(script, TRIPPER, 'utf-8');
    const childCfg = JSON.stringify(cfg(path.join(tmpDir, 'runtime', 'kill-switch-child.json')));
    const child = spawn(process.execPath, [script, KS_URL, v1Path, emergencyPath, childCfg, tmpDir, tmpDir], {
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    });
    let childErr = '';
    child.stderr.on('data', (d) => { childErr += d; });
    const exited = new Promise((resolve) => { child.on('exit', resolve); });
    await waitFor(path.join(tmpDir, 'held'));

    const res = await resetKillSwitch(cfg(), undefined, { pluginRoot: tmpDir });

    expect(await exited, childErr).toBe(0);
    // Preconditions: the child tripped, and handed the v1 lock over (no timeout).
    expect(readJson(path.join(tmpDir, 'tripped')).tripped).toBe(true);
    expect(res.persisted).toBe(true);
    // The two must agree: a tripped emergency state with the master switch OFF.
    expect({
      emergencyTripped: readJson(emergencyPath).tripped,
      masterEnabled: readJson(cfgPath).ago.selfControl.masterEnabled,
    }).toEqual({ emergencyTripped: true, masterEnabled: false });
  }, 30_000);
});
