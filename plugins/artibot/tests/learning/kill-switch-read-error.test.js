/**
 * kill-switch.js — read failures and reset results (F2, review-fixes
 * 2026-11-21, cross-check xcB MED-1 / LOW-3 / LOW-4).
 *
 * MED-1. `lockedUpdate` re-reads the state file under the lock. The readers
 * used to swallow every error as "missing file", so one transient read
 * failure (EBUSY on Windows while another process renames over the file,
 * EACCES, EMFILE, ...) wrote the defaults plus one row over the real state:
 * a tripped feature was un-tripped, and the result said `persisted: true`.
 * The contract pinned here (allowlist): ENOENT -> defaults, unparseable JSON ->
 * defaults (replaced, as before), ANY other read error -> write nothing and
 * report `persisted: false`.
 *
 * LOW-3. `resetKillSwitch(feature)` dropped whether its write landed.
 * LOW-4. The global `resetKillSwitch()` wrote both files without the lock, so
 * a `recordFailure` in flight could write its stale read back over the reset.
 *
 * Real files in a temp dir; ONE injected readFileSync failure on the target
 * path, every other read (the lock file's included) goes to the real fs.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fault } = vi.hoisted(() => ({ fault: { path: null, code: null, skip: 0, left: 0 } }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal();
  const faultyReadFileSync = (p, ...rest) => {
    if (fault.left > 0 && String(p) === fault.path) {
      if (fault.skip > 0) {
        fault.skip -= 1;
      } else {
        fault.left -= 1;
        throw Object.assign(new Error(`${fault.code}: injected read failure, '${p}'`), { code: fault.code });
      }
    }
    return real.readFileSync(p, ...rest);
  };
  return { ...real, readFileSync: faultyReadFileSync, default: { ...real.default, readFileSync: faultyReadFileSync } };
});

const { getKillSwitchState, recordFailure, resetKillSwitch } = await import('../../lib/learning/kill-switch.js');

let tmpDir;
let v1Path;
let emergencyPath;
let configJsonPath;
let stderr;

function cfg({ emergency = false } = {}) {
  return {
    ago: {
      selfControl: {
        killSwitch: { threshold: 3, windowMs: 60 * 60 * 1000, statePath: v1Path },
        emergencyKillSwitch: { enabled: emergency, maxFailuresPerHour: 3, cooldownHours: 24, statePath: emergencyPath },
      },
    },
  };
}

/** Arm one read failure on `file`, after letting `skip` reads of it through. */
function failRead(file, code, skip = 0) {
  Object.assign(fault, { path: file, code, skip, left: 1 });
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf-8'));
const masterEnabled = () => readJson(configJsonPath).ago.selfControl.masterEnabled;

/** Hold `file`'s lock as a live holder on this host (never stale). */
function holdLock(file) {
  writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, host: hostname(), token: 'other', timestamp: Date.now() }));
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'artibot-ks-readerr-'));
  mkdirSync(path.join(tmpDir, 'runtime'), { recursive: true });
  v1Path = path.join(tmpDir, 'runtime', 'kill-switch.json');
  emergencyPath = path.join(tmpDir, 'runtime', 'kill-switch-state.json');
  configJsonPath = path.join(tmpDir, 'artibot.config.json');
  writeFileSync(configJsonPath, JSON.stringify({ ago: { selfControl: { masterEnabled: true } } }));
  fault.left = 0;
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  fault.left = 0;
  stderr.mockRestore();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function tripV1(feature) {
  const opts = { pluginRoot: tmpDir };
  for (let i = 0; i < 3; i += 1) await recordFailure({ feature }, cfg(), opts);
  expect(readJson(v1Path).features[feature].trippedAt).toBeTruthy();
}

describe('per-feature state — a failed re-read under the lock never overwrites', () => {
  for (const code of ['EBUSY', 'EACCES', 'EPERM', 'EMFILE', 'EIO']) {
    it(`${code}: persisted:false, the tripped feature stays tripped on disk`, async () => {
      await tripV1('autoCommit');
      const before = readFileSync(v1Path, 'utf-8');
      failRead(v1Path, code);

      const res = await recordFailure({ feature: 'other' }, cfg(), { pluginRoot: tmpDir });

      expect(fault.left).toBe(0); // the injected failure was actually consumed
      expect(res.persisted).toBe(false);
      expect(readFileSync(v1Path, 'utf-8')).toBe(before);
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain(code);
    });
  }

  it('a missing file is still "no state": the row is written', async () => {
    const res = await recordFailure({ feature: 'x' }, cfg(), { pluginRoot: tmpDir });
    expect(res.persisted).toBe(true);
    expect(readJson(v1Path).features.x.failures).toHaveLength(1);
  });

  it('an unparseable file is still replaced', async () => {
    writeFileSync(v1Path, '{ half-written');
    const res = await recordFailure({ feature: 'x' }, cfg(), { pluginRoot: tmpDir });
    expect(res.persisted).toBe(true);
    expect(readJson(v1Path).features.x.failures).toHaveLength(1);
  });
});

describe('emergency state — a failed re-read under the lock never overwrites', () => {
  it('EBUSY on record: emergency.persisted:false, the trip stays on disk', async () => {
    const opts = { pluginRoot: tmpDir };
    for (let i = 0; i < 3; i += 1) await recordFailure({ feature: `f${i}` }, cfg({ emergency: true }), opts);
    expect(readJson(emergencyPath).tripped).toBe(true);
    const before = readFileSync(emergencyPath, 'utf-8');
    failRead(emergencyPath, 'EBUSY');

    const res = await recordFailure({ feature: 'f9' }, cfg({ emergency: true }), opts);

    expect(fault.left).toBe(0);
    expect(res.emergency.persisted).toBe(false);
    expect(readFileSync(emergencyPath, 'utf-8')).toBe(before);
  });

  it('EBUSY on the expiry re-read (peek succeeded): the file is left as is', async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    writeFileSync(emergencyPath, JSON.stringify({
      failures: [{ feature: 'a', timestamp: old }, { feature: 'b', timestamp: fresh }],
      tripped: false, trippedAt: null, cooldownUntil: null,
    }));
    const before = readFileSync(emergencyPath, 'utf-8');
    failRead(emergencyPath, 'EBUSY', 1); // the unlocked peek reads fine; the locked re-read fails

    await getKillSwitchState(cfg({ emergency: true }), { pluginRoot: tmpDir });

    expect(fault.left).toBe(0);
    expect(readFileSync(emergencyPath, 'utf-8')).toBe(before);
  });
});

describe('resetKillSwitch(feature) — returns whether the reset reached disk', () => {
  it('persisted:true when written', async () => {
    await tripV1('autoCommit');
    const res = await resetKillSwitch('autoCommit', cfg(), { pluginRoot: tmpDir });
    expect(res).toEqual({ reset: true, persisted: true });
    expect(readJson(v1Path).features.autoCommit.trippedAt).toBeNull();
  });

  it('persisted:false when the lock is held past its wait; the trip stays', async () => {
    await tripV1('autoCommit');
    holdLock(v1Path);
    const res = await resetKillSwitch('autoCommit', cfg(), { pluginRoot: tmpDir });
    expect(res).toEqual({ reset: true, persisted: false });
    expect(readJson(v1Path).features.autoCommit.trippedAt).toBeTruthy();
  }, 10_000);

  it('persisted:false on a read error under the lock; the other features stay', async () => {
    await tripV1('autoCommit');
    await recordFailure({ feature: 'keep' }, cfg(), { pluginRoot: tmpDir });
    const before = readFileSync(v1Path, 'utf-8');
    // The unlocked existence check goes through fs/promises (core/file.js#readJsonFile),
    // so the first readFileSync of this path is the locked re-read.
    failRead(v1Path, 'EBUSY');
    const res = await resetKillSwitch('autoCommit', cfg(), { pluginRoot: tmpDir });
    expect(fault.left).toBe(0);
    expect(res).toEqual({ reset: true, persisted: false });
    expect(readFileSync(v1Path, 'utf-8')).toBe(before);
  });
});

describe('resetKillSwitch(config) — global reset runs under the state locks', () => {
  async function tripEmergency() {
    const opts = { pluginRoot: tmpDir };
    for (let i = 0; i < 3; i += 1) await recordFailure({ feature: `f${i}` }, cfg({ emergency: true }), opts);
    expect(readJson(emergencyPath).tripped).toBe(true);
    expect(masterEnabled()).toBe(false);
  }

  it('resets both files and restores masterEnabled, persisted:true', async () => {
    await tripEmergency();
    const res = await resetKillSwitch(cfg({ emergency: true }), undefined, { pluginRoot: tmpDir });
    expect(res).toEqual({ reset: true, masterRestored: true, persisted: true });
    expect(readJson(emergencyPath)).toEqual({ failures: [], tripped: false, trippedAt: null, cooldownUntil: null });
    expect(readJson(v1Path)).toEqual({ features: {} });
    expect(masterEnabled()).toBe(true);
  });

  it('waits for a held emergency lock instead of writing past it; master stays off', async () => {
    await tripEmergency();
    const before = readFileSync(emergencyPath, 'utf-8');
    holdLock(emergencyPath);

    const res = await resetKillSwitch(cfg({ emergency: true }), undefined, { pluginRoot: tmpDir });

    expect(readFileSync(emergencyPath, 'utf-8')).toBe(before);
    expect(res.persisted).toBe(false);
    expect(res.masterRestored).toBe(false);
    expect(masterEnabled()).toBe(false);
  }, 10_000);

  it('a read error does not block the reset (it writes whole)', async () => {
    await tripEmergency();
    failRead(emergencyPath, 'EBUSY');
    const res = await resetKillSwitch(cfg({ emergency: true }), undefined, { pluginRoot: tmpDir });
    expect(res.persisted).toBe(true);
    fault.left = 0;
    expect(readJson(emergencyPath).tripped).toBe(false);
  });
});
