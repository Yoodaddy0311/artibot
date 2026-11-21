/**
 * M3 (review-fixes 2026-11-21): kill-switch failure recording must not lose
 * rows to concurrent writers, and must say when it could not persist.
 *
 *   - recordFailure / recordEmergencyFailure were unlocked read-modify-writes:
 *     N processes recording at once each read the same old file and the last
 *     writer erased the rest — so a burst of real failures could stay under the
 *     trip threshold. Checked here with N real child processes.
 *   - A failed write was swallowed by `catch {}` and the caller saw a normal
 *     result. It now reports `persisted: false` (v1) and
 *     `emergency.persisted: false`.
 *
 * Not covered: artibot.config.json's own read-modify-write in setMasterEnabled
 * (it is only written at trip time), and cross-host locking.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recordFailure } from '../../lib/learning/kill-switch.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.resolve(HERE, '..', 'helpers', 'kill-switch-record-child.mjs');

const N = 12;
const ROUNDS = 3;

let tmpDir;

/**
 * Thresholds far above N so nothing trips and every row is kept.
 * @param {string} dir
 */
function buildCfg(dir) {
  return {
    ago: {
      selfControl: {
        masterEnabled: true,
        killSwitch: { threshold: 1000, windowMs: 60 * 60 * 1000, statePath: path.join(dir, 'runtime', 'kill-switch.json') },
        emergencyKillSwitch: {
          enabled: true,
          maxFailuresPerHour: 1000,
          cooldownHours: 24,
          statePath: path.join(dir, 'runtime', 'kill-switch-state.json'),
        },
      },
    },
  };
}

/**
 * @param {object} cfg
 * @param {string} root
 * @returns {Promise<number|null>} exit code
 */
function runChild(cfg, root) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD, JSON.stringify(cfg), root], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.on('exit', (code) => resolve(code));
  });
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'artibot-ks-conc-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe(`recordFailure under ${N} concurrent processes`, () => {
  it(`keeps all ${N} rows in both state files (${ROUNDS} rounds)`, async () => {
    const results = [];
    for (let r = 0; r < ROUNDS; r += 1) {
      const dir = path.join(tmpDir, `round-${r}`);
      mkdirSync(path.join(dir, 'runtime'), { recursive: true });
      writeFileSync(path.join(dir, 'artibot.config.json'), '{"ago":{"selfControl":{"masterEnabled":true}}}');
      const cfg = buildCfg(dir);
      const codes = await Promise.all(Array.from({ length: N }, () => runChild(cfg, dir)));
      const v1 = JSON.parse(readFileSync(cfg.ago.selfControl.killSwitch.statePath, 'utf-8'));
      const em = JSON.parse(readFileSync(cfg.ago.selfControl.emergencyKillSwitch.statePath, 'utf-8'));
      results.push({
        exits: codes.every((c) => c === 0),
        v1: v1.features['concurrent-feature'].failures.length,
        emergency: em.failures.length,
      });
    }
    expect(results).toEqual(Array.from({ length: ROUNDS }, () => ({ exits: true, v1: N, emergency: N })));
  }, 120_000);
});

describe('recordFailure reports a write it could not make', () => {
  it('returns persisted:false for both files when their directory cannot be created', async () => {
    // A regular FILE where the state directory should be: mkdir fails (ENOTDIR /
    // EEXIST), so neither state file can be written.
    const blocker = path.join(tmpDir, 'not-a-dir');
    writeFileSync(blocker, 'x');
    writeFileSync(path.join(tmpDir, 'artibot.config.json'), '{"ago":{"selfControl":{"masterEnabled":true}}}');
    const cfg = {
      ago: {
        selfControl: {
          killSwitch: { threshold: 3, windowMs: 60_000, statePath: path.join(blocker, 'kill-switch.json') },
          emergencyKillSwitch: {
            enabled: true,
            maxFailuresPerHour: 3,
            statePath: path.join(blocker, 'kill-switch-state.json'),
          },
        },
      },
    };

    const r = await recordFailure({ feature: 'autoCommit', error: 'x' }, cfg, { pluginRoot: tmpDir });

    expect(r.persisted).toBe(false);
    expect(r.count).toBe(1);
    expect(r.emergency.persisted).toBe(false);
  });

  it('returns persisted:true on a normal write', async () => {
    mkdirSync(path.join(tmpDir, 'runtime'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'artibot.config.json'), '{"ago":{"selfControl":{"masterEnabled":true}}}');
    const r = await recordFailure({ feature: 'autoCommit', error: 'x' }, buildCfg(tmpDir), { pluginRoot: tmpDir });
    expect(r.persisted).toBe(true);
    expect(r.emergency.persisted).toBe(true);
  });
});
