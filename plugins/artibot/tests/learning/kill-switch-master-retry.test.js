/**
 * kill-switch.js — an emergency trip whose master-switch write fails is retried on
 * the next failure until it lands (fail-closed). Lane D cross-review 2026-11-22,
 * ported from its probe (scratchpad/probe-master-ebusy.test.js).
 *
 * Why it matters: the production gate reads `ago.selfControl.masterEnabled` and the
 * PER-FEATURE state only (self-control-gates.js#resolveSelfControlGates passes
 * `feature`, so isKillSwitchTripped never consults the emergency state there). The
 * master switch is therefore the emergency trip's ONLY effect.
 *
 * Before: one transient read error on artibot.config.json INSIDE the config lock at
 * trip time left `masterEnabled: true` while the emergency state was saved as
 * tripped, and `!state.tripped` meant no later failure ever tried again — the trip
 * did nothing for its whole cooldown (lane D measured this on a copy; HEAD too).
 *
 * Now the emergency state records `masterDisabled` at the trip; while it is `false`
 * on a tripped state, every later failure retries the flip until it lands. Once it
 * has landed nothing re-flips it (a manual re-enable after that is respected, as
 * before). A state written before this field existed is not retried — unknown is
 * not "failed", and retrying it could undo a manual re-enable.
 *
 * Real files in a temp dir handed in as `pluginRoot`; ONE injected readFileSync
 * failure on the config path, every other read (lock files included) is real.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fault } = vi.hoisted(() => ({ fault: { path: null, code: null, left: 0 } }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal();
  const faultyReadFileSync = (p, ...rest) => {
    if (fault.left > 0 && String(p) === fault.path) {
      fault.left -= 1;
      throw Object.assign(new Error(`${fault.code}: injected read failure, '${p}'`), { code: fault.code });
    }
    return real.readFileSync(p, ...rest);
  };
  return { ...real, readFileSync: faultyReadFileSync, default: { ...real.default, readFileSync: faultyReadFileSync } };
});

const { recordFailure } = await import('../../lib/learning/kill-switch.js');

let dir;
let cfgPath;
let emergencyPath;
let stderr;

const config = () => ({
  ago: {
    selfControl: {
      killSwitch: { threshold: 1e9, statePath: path.join(dir, 'runtime', 'kill-switch.json') },
      emergencyKillSwitch: { enabled: true, maxFailuresPerHour: 3, cooldownHours: 24, statePath: emergencyPath },
    },
  },
});

const master = () => JSON.parse(readFileSync(cfgPath, 'utf-8')).ago.selfControl.masterEnabled;
const emergencyFile = () => JSON.parse(readFileSync(emergencyPath, 'utf-8'));
const fail = () => recordFailure({ feature: 'a' }, config(), { pluginRoot: dir });

/** Two failures, then the tripping third with ONE EBUSY on the config read inside its lock. */
async function tripWithFailedFlip() {
  await fail();
  await fail();
  Object.assign(fault, { path: cfgPath, code: 'EBUSY', left: 1 });
  const third = await fail();
  expect(fault.left).toBe(0); // the injected failure was actually consumed
  return third;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'artibot-ks-master-retry-'));
  mkdirSync(path.join(dir, 'runtime'), { recursive: true });
  cfgPath = path.join(dir, 'artibot.config.json');
  emergencyPath = path.join(dir, 'runtime', 'kill-switch-state.json');
  writeFileSync(cfgPath, JSON.stringify({ ago: { selfControl: { masterEnabled: true } } }));
  fault.left = 0;
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  fault.left = 0;
  stderr.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

describe('emergency trip — a master-switch write that failed is retried', () => {
  it('the trip records the failed flip, and the next failure disables the master switch', async () => {
    const third = await tripWithFailedFlip();
    expect(third.emergency).toMatchObject({ tripped: true, masterDisabled: false });
    expect(master()).toBe(true);
    expect(emergencyFile()).toMatchObject({ tripped: true, masterDisabled: false });

    const fourth = await fail();

    expect(fourth.emergency.masterDisabled).toBe(true);
    expect(master()).toBe(false);
    expect(emergencyFile()).toMatchObject({ tripped: true, masterDisabled: true });
  });

  it('keeps retrying while the flip keeps failing', async () => {
    await tripWithFailedFlip();
    Object.assign(fault, { path: cfgPath, code: 'EBUSY', left: 1 });
    const fourth = await fail();
    expect(fault.left).toBe(0);
    expect(fourth.emergency.masterDisabled).toBe(false);
    expect(master()).toBe(true);

    const fifth = await fail();

    expect(fifth.emergency.masterDisabled).toBe(true);
    expect(master()).toBe(false);
  });

  it('stops once the flip has landed: a later manual re-enable is not undone (it re-arms, see below)', async () => {
    await tripWithFailedFlip();
    await fail(); // the retry lands
    writeFileSync(cfgPath, JSON.stringify({ ago: { selfControl: { masterEnabled: true } } }));

    const sixth = await fail();

    expect(sixth.emergency.masterDisabled).toBe(false); // nothing attempted
    expect(master()).toBe(true);
    expect(emergencyFile()).toMatchObject({ tripped: false }); // re-armed, counting from this failure
  });

  it('a tripped state written before the field existed is not retried (unknown is not "failed")', async () => {
    const now = Date.now();
    writeFileSync(emergencyPath, JSON.stringify({
      failures: [0, 1, 2].map((i) => ({ feature: 'a', error: null, timestamp: new Date(now - i * 1000).toISOString() })),
      tripped: true,
      trippedAt: new Date(now).toISOString(),
      cooldownUntil: new Date(now + 60 * 60 * 1000).toISOString(),
    }));

    const res = await fail();

    expect(res.emergency.masterDisabled).toBe(false);
    expect(master()).toBe(true);
  });
});

// Lane B cross-review 2026-11-22. Probe D: the pause banner tells the user to set
// masterEnabled back to true; doing that during a live trip left the switch inert for
// the rest of the cooldown (up to 24h) — `!state.tripped` blocked a new trip and
// `masterDisabled === true` blocked a retry. A manual re-enable now RE-ARMS it: the
// emergency state starts over and this failure is its first. "Re-enabled" is read from
// the config FILE (what the gate's next load sees), never from the caller's config
// object, which can be stale; a file that cannot be read does not re-arm (fail-closed).
// Probe A: a trip whose cooldown had passed but was not yet expired on disk still
// retried the flip — the master switch went off with no trip behind it. Expiry is now
// applied before any retry or re-arm decision.
describe('emergency switch — a manual re-enable re-arms it; an expired trip is expired first', () => {
  const H = 60 * 60 * 1000;

  /** A tripped emergency state on disk; `cooldownH` from now (negative = already past). */
  function writeTrip({ masterDisabled, cooldownH = 22 }) {
    const now = Date.now();
    writeFileSync(emergencyPath, JSON.stringify({
      failures: [],
      tripped: true,
      trippedAt: new Date(now - 2 * H).toISOString(),
      cooldownUntil: new Date(now + cooldownH * H).toISOString(),
      ...(masterDisabled === undefined ? {} : { masterDisabled }),
    }));
  }

  it('probe D: re-enabled by hand during a live trip — re-arms, and the next burst trips and disables again', async () => {
    writeTrip({ masterDisabled: true }); // the flip had landed; the user then turned it back on (beforeEach: true)

    const first = await fail();
    expect(first.emergency).toMatchObject({ tripped: false, failuresPast1h: 1 }); // started over
    expect(master()).toBe(true); // not switched straight back off
    await fail();
    expect(master()).toBe(true);

    const third = await fail();

    expect(third.emergency).toMatchObject({ tripped: true, masterDisabled: true });
    expect(master()).toBe(false);
  });

  it('the config FILE decides: a stale config object saying "enabled" does not re-arm', async () => {
    writeTrip({ masterDisabled: true });
    writeFileSync(cfgPath, JSON.stringify({ ago: { selfControl: { masterEnabled: false } } }));
    const staleObject = { ...config(), ago: { selfControl: { ...config().ago.selfControl, masterEnabled: true } } };

    const res = await recordFailure({ feature: 'a' }, staleObject, { pluginRoot: dir });

    expect(res.emergency.tripped).toBe(true);
    expect(master()).toBe(false);
  });

  it('a config file that cannot be read does not re-arm (fail-closed)', async () => {
    writeTrip({ masterDisabled: true });
    Object.assign(fault, { path: cfgPath, code: 'EBUSY', left: 1 });

    const res = await fail();

    expect(fault.left).toBe(0);
    expect(res.emergency.tripped).toBe(true);
    expect(emergencyFile()).toMatchObject({ tripped: true, masterDisabled: true });
  });

  it('probe A: a trip whose cooldown has passed is expired before the retry check — the master switch stays on', async () => {
    writeTrip({ masterDisabled: false, cooldownH: -1 });

    const res = await fail();

    expect(res.emergency).toMatchObject({ tripped: false, failuresPast1h: 1, masterDisabled: false });
    expect(master()).toBe(true);
  });
});
