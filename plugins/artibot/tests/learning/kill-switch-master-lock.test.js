/**
 * kill-switch.js#setMasterEnabled — the artibot.config.json read-modify-write
 * runs under the config file's lock, like every state-file write in this module
 * (lib/core/file-lock.js#withFileLock, see kill-switch.js#lockedUpdate).
 *
 * Before (2026-11-22): read, flip `ago.selfControl.masterEnabled`, atomic write —
 * no lock, so a writer that changed the file between that read and that write was
 * overwritten, or overwrote it.
 *
 * What the lock covers, and what it does not:
 *   - Covered: every kill-switch flip (trip and reset), and any other writer that
 *     takes the same lock — the cooperating child below.
 *   - NOT covered: the other writers of artibot.config.json in this repo
 *     (lib/learning/macro-learner.js, scripts/swarm-init.js) take no lock today, so
 *     a race with them is unchanged by this test going green.
 *
 * When the lock is not taken the two directions differ on purpose: re-enabling
 * writes nothing (masterRestored:false), while the trip still disables, unlocked —
 * the production gate asks the per-feature state only
 * (self-control-gates.js#resolveSelfControlGates passes `feature`), so the master
 * switch is the emergency trip's only effect.
 *
 * Every file lives in a temp dir handed in as `pluginRoot`; the real
 * artibot.config.json is never read or written.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recordFailure, resetKillSwitch } from '../../lib/learning/kill-switch.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE_LOCK_URL = pathToFileURL(path.join(PLUGIN_ROOT, 'lib', 'core', 'file-lock.js')).href;

/** A writer that cooperates: takes the config lock, reads, holds, writes its own key. */
const COOPERATING_WRITER = `
import { readFileSync, writeFileSync } from 'node:fs';
const [lockUrl, cfgPath, marker, holdMs] = process.argv.slice(2);
const { withFileLock } = await import(lockUrl);
withFileLock(cfgPath, () => {
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
  writeFileSync(marker, 'inside');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
  cfg.macros = { fromCooperatingWriter: true };
  writeFileSync(cfgPath, JSON.stringify(cfg));
});
`;

let tmpDir;
let cfgPath;
let stderr;

function cfg() {
  return {
    ago: {
      selfControl: {
        killSwitch: { threshold: 3, windowMs: 60 * 60 * 1000, statePath: path.join(tmpDir, 'runtime', 'kill-switch.json') },
        emergencyKillSwitch: {
          enabled: true, maxFailuresPerHour: 3, cooldownHours: 24,
          statePath: path.join(tmpDir, 'runtime', 'kill-switch-state.json'),
        },
      },
    },
  };
}

const readCfg = () => JSON.parse(readFileSync(cfgPath, 'utf-8'));
const stderrText = () => stderr.mock.calls.map((c) => String(c[0])).join('');

/** A live holder on this host (this pid, fresh timestamp): never stale, so the wait runs out. */
function holdConfigLock() {
  writeFileSync(`${cfgPath}.lock`, JSON.stringify({ pid: process.pid, host: hostname(), token: 'held-by-test', timestamp: Date.now() }));
}

async function waitFor(file, ms = 15_000) {
  const until = Date.now() + ms;
  while (!existsSync(file)) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${file}`);
    await new Promise((r) => { setTimeout(r, 20); });
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'artibot-ks-master-lock-'));
  mkdirSync(path.join(tmpDir, 'runtime'), { recursive: true });
  cfgPath = path.join(tmpDir, 'artibot.config.json');
  writeFileSync(cfgPath, JSON.stringify({ ago: { selfControl: { masterEnabled: false } } }));
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderr.mockRestore();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('setMasterEnabled — the config write runs under the config lock', () => {
  it('waits for a cooperating writer that holds the lock, then keeps its change', async () => {
    const script = path.join(tmpDir, 'writer.mjs');
    const marker = path.join(tmpDir, 'writer-inside');
    writeFileSync(script, COOPERATING_WRITER, 'utf-8');
    const child = spawn(process.execPath, [script, FILE_LOCK_URL, cfgPath, marker, '800'], { stdio: 'ignore', windowsHide: true });
    const exited = new Promise((resolve) => { child.on('exit', resolve); });
    await waitFor(marker);

    const res = await resetKillSwitch(cfg(), undefined, { pluginRoot: tmpDir });

    expect(await exited).toBe(0);
    expect(res.masterRestored).toBe(true);
    const after = readCfg();
    expect(after.macros).toEqual({ fromCooperatingWriter: true });
    expect(after.ago.selfControl.masterEnabled).toBe(true);
  }, 30_000);

  it('reset: lock held past its wait -> masterEnabled left as is, masterRestored:false', async () => {
    holdConfigLock();
    const before = readFileSync(cfgPath, 'utf-8');

    const res = await resetKillSwitch(cfg(), undefined, { pluginRoot: tmpDir });

    expect(res.masterRestored).toBe(false);
    expect(readFileSync(cfgPath, 'utf-8')).toBe(before);
    expect(stderrText()).toContain('config lock not taken');
  }, 10_000);

  it('trip: lock held past its wait -> still disabled (the safe side), and said so', async () => {
    writeFileSync(cfgPath, JSON.stringify({ ago: { selfControl: { masterEnabled: true } }, keep: 1 }));
    holdConfigLock();

    let res;
    for (let i = 0; i < 3; i += 1) res = await recordFailure({ feature: `f${i}` }, cfg(), { pluginRoot: tmpDir });

    expect(res.emergency.tripped).toBe(true);
    expect(res.emergency.masterDisabled).toBe(true);
    expect(readCfg()).toEqual({ ago: { selfControl: { masterEnabled: false } }, keep: 1 });
    expect(stderrText()).toContain('config lock not taken');
  }, 10_000);
});
