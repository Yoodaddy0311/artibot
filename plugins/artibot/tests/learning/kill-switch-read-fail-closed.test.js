/**
 * kill-switch.js — a state file that EXISTS but cannot be read answers
 * "tripped" (fail-closed). Owner decision 2026-11-22.
 *
 * Before: isKillSwitchTripped -> loadState -> core/file.js#readJsonFile, which
 * returns null on ANY error, so EBUSY (Windows, while another process renames
 * over the file), EACCES, EMFILE, … read as an empty state and the answer was
 * "not tripped" — fail-open on the one question the kill switch exists to answer.
 * The emergency branch did the same: getKillSwitchState's unlocked peek dropped
 * `readError`, and its locked expiry re-read fell back to defaults.
 *
 * The rule now matches the write path (kill-switch.js#readStateFile, an
 * allowlist via core/file.js#readTextAllowMissing):
 *   - ENOENT, or content that does not parse  -> defaults (not tripped), as before
 *   - EVERY other read error                  -> tripped, one stderr line
 * An allowlist, so a code nobody has seen yet is fail-closed too (EFUTURE below).
 *
 * The fault is injected into BOTH readFileSync and fs/promises#readFile on the
 * target path, so the pre-fix reader (async) and the fixed one (sync) see the
 * same error; every other read — lock files included — goes to the real fs.
 * Real files in a temp dir handed in as `pluginRoot`; the real config is never used.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fault } = vi.hoisted(() => ({ fault: { path: null, code: null, skip: 0, left: 0 } }));

/** @returns {Error|null} the injected error for this read of `p`, if one is armed */
function takeFault(p) {
  if (fault.left <= 0 || String(p) !== fault.path) return null;
  if (fault.skip > 0) { fault.skip -= 1; return null; }
  fault.left -= 1;
  return Object.assign(new Error(`${fault.code}: injected read failure, '${p}'`), { code: fault.code });
}

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal();
  const faultyReadFileSync = (p, ...rest) => {
    const err = takeFault(p);
    if (err) throw err;
    return real.readFileSync(p, ...rest);
  };
  return { ...real, readFileSync: faultyReadFileSync, default: { ...real.default, readFileSync: faultyReadFileSync } };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal();
  const readFile = (p, ...rest) => {
    const err = takeFault(p);
    return err ? Promise.reject(err) : real.readFile(p, ...rest);
  };
  return { ...real, readFile, default: { ...real.default, readFile } };
});

const { getKillSwitchState, isKillSwitchTripped, resetKillSwitch } = await import('../../lib/learning/kill-switch.js');

let tmpDir;
let v1Path;
let emergencyPath;
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

const warnings = () => stderr.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('treated as tripped'));

/** An untripped per-feature state: one failure on record, under the threshold. */
function writeUntrippedV1() {
  writeFileSync(v1Path, JSON.stringify({ features: { autoCommit: { failures: [{ at: Date.now(), error: 'x' }], trippedAt: null } } }));
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'artibot-ks-failclosed-'));
  mkdirSync(path.join(tmpDir, 'runtime'), { recursive: true });
  v1Path = path.join(tmpDir, 'runtime', 'kill-switch.json');
  emergencyPath = path.join(tmpDir, 'runtime', 'kill-switch-state.json');
  writeFileSync(path.join(tmpDir, 'artibot.config.json'), JSON.stringify({ ago: { selfControl: { masterEnabled: true } } }));
  fault.left = 0;
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  fault.left = 0;
  stderr.mockRestore();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('isKillSwitchTripped — per-feature state that cannot be read is tripped', () => {
  for (const code of ['EBUSY', 'EACCES', 'EPERM', 'EMFILE', 'EIO', 'EFUTURE']) {
    it(`${code}: true, with one stderr line naming the code`, async () => {
      writeUntrippedV1();
      failRead(v1Path, code);

      const tripped = await isKillSwitchTripped(cfg(), { feature: 'autoCommit', pluginRoot: tmpDir });

      expect(fault.left).toBe(0); // the injected failure was actually consumed
      expect(tripped).toBe(true);
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain(code);
    });
  }

  it('the any-feature form (no feature) is tripped by an unreadable v1 file too', async () => {
    writeUntrippedV1();
    failRead(v1Path, 'EBUSY');
    expect(await isKillSwitchTripped(cfg(), { pluginRoot: tmpDir })).toBe(true);
    expect(fault.left).toBe(0);
  });

  it('control — the same untripped file, readable: false, no warning', async () => {
    writeUntrippedV1();
    expect(await isKillSwitchTripped(cfg(), { feature: 'autoCommit', pluginRoot: tmpDir })).toBe(false);
    expect(warnings()).toHaveLength(0);
  });

  it('ENOENT is still "no state": false, no warning', async () => {
    expect(await isKillSwitchTripped(cfg(), { feature: 'autoCommit', pluginRoot: tmpDir })).toBe(false);
    expect(warnings()).toHaveLength(0);
  });

  it('content that does not parse is still defaults: false, no warning', async () => {
    writeFileSync(v1Path, '{ half-written');
    expect(await isKillSwitchTripped(cfg(), { feature: 'autoCommit', pluginRoot: tmpDir })).toBe(false);
    expect(warnings()).toHaveLength(0);
  });
});

describe('emergency branch — an unreadable emergency state is tripped', () => {
  it('EBUSY on the peek: getKillSwitchState says tripped, and so does isKillSwitchTripped()', async () => {
    writeUntrippedV1();
    writeFileSync(emergencyPath, JSON.stringify({ failures: [], tripped: false, trippedAt: null, cooldownUntil: null }));

    failRead(emergencyPath, 'EBUSY');
    const state = await getKillSwitchState(cfg({ emergency: true }), { pluginRoot: tmpDir });
    expect(fault.left).toBe(0);
    // Unknown count, and the file that could not be read — what a banner names.
    expect(state).toEqual({ tripped: true, failuresPast1h: null, cooldownUntil: null, statePath: emergencyPath });

    failRead(emergencyPath, 'EBUSY');
    expect(await isKillSwitchTripped(cfg({ emergency: true }), { pluginRoot: tmpDir })).toBe(true);
    expect(fault.left).toBe(0);
  });

  it('EBUSY on the locked expiry re-read (peek succeeded): tripped, file left as is', async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    writeFileSync(emergencyPath, JSON.stringify({
      failures: [{ feature: 'a', timestamp: old }], tripped: false, trippedAt: null, cooldownUntil: null,
    }));
    const before = readFileSync(emergencyPath, 'utf-8');
    failRead(emergencyPath, 'EBUSY', 1); // the peek reads fine; the re-read under the lock fails

    const state = await getKillSwitchState(cfg({ emergency: true }), { pluginRoot: tmpDir });

    expect(fault.left).toBe(0);
    expect(state.tripped).toBe(true);
    expect(readFileSync(emergencyPath, 'utf-8')).toBe(before);
  });

  it('control — readable and untripped: not tripped, no warning', async () => {
    writeFileSync(emergencyPath, JSON.stringify({ failures: [], tripped: false, trippedAt: null, cooldownUntil: null }));
    const state = await getKillSwitchState(cfg({ emergency: true }), { pluginRoot: tmpDir });
    expect(state).toEqual({ tripped: false, failuresPast1h: 0, cooldownUntil: null });
    expect(warnings()).toHaveLength(0);
  });
});

describe('resetKillSwitch(feature) — an unreadable pre-check does not mean "nothing to reset"', () => {
  it('EBUSY on the pre-check: falls through to the locked reset, which re-reads and clears the trip', async () => {
    writeFileSync(v1Path, JSON.stringify({ features: { autoCommit: { failures: [], trippedAt: '2026-11-22T00:00:00.000Z' } } }));
    failRead(v1Path, 'EBUSY'); // the first read of the file is the unlocked pre-check

    const res = await resetKillSwitch('autoCommit', cfg(), { pluginRoot: tmpDir });

    expect(fault.left).toBe(0);
    expect(res).toEqual({ reset: true, persisted: true });
    expect(JSON.parse(readFileSync(v1Path, 'utf-8')).features.autoCommit.trippedAt).toBeNull();
  });

  // Lane D cross-review 2026-11-22: with the pre-check unreadable, the locked reset ran
  // even when the fresh read showed no such feature — it created an empty entry and
  // answered reset:true. "Nothing to reset" is a fact once a read has shown it.
  it('EBUSY on the pre-check, feature absent on the locked re-read: reset:false, no entry created', async () => {
    writeFileSync(v1Path, JSON.stringify({ features: { other: { failures: [], trippedAt: null } } }));
    failRead(v1Path, 'EBUSY');

    const res = await resetKillSwitch('ghost', cfg(), { pluginRoot: tmpDir });

    expect(fault.left).toBe(0);
    expect(res).toEqual({ reset: false });
    expect(Object.keys(JSON.parse(readFileSync(v1Path, 'utf-8')).features)).toEqual(['other']);
  });
});
