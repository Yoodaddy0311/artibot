/**
 * scripts/hooks/session-start-sweep.mjs — sweeps the directories hooks now write to (O2).
 *
 * The hook had no test ("zero importers, no table entry, no test" —
 * scripts/ci/readme-claims-registry.js) and is STILL not registered in
 * hooks/dispatch-table.json (measured 2026-09-30: `grep sweep hooks/*.json` finds
 * nothing), so nothing runs it today. `session-start.js` calls the session sweep
 * itself for that reason. This file pins the script for the day it is registered: it
 * must look where the state lives NOW — `<state dir>/runtime/` and each
 * `runtime/sessions/<id>/` — and not only in `<pluginRoot>/runtime/`, where it used
 * to look and where no hook writes any more.
 *
 * The script is copied into a tmp plugin layout (with `lib/` linked) so that "its"
 * plugin root — the legacy `runtime/` it also sweeps — is a throwaway directory, not
 * this repository's.
 *
 * WHAT THIS CANNOT SEE: that anything starts the hook. It runs it by hand.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getHomeDir } from '../../lib/core/platform.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let base;
let pluginCopy;
let stateDir;

beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'artibot-sweep-'));
  stateDir = path.join(base, 'state');
  mkdirSync(stateDir, { recursive: true });
  pluginCopy = path.join(base, 'plugin');
  const hooks = path.join(pluginCopy, 'scripts', 'hooks');
  mkdirSync(hooks, { recursive: true });
  copyFileSync(path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'session-start-sweep.mjs'), path.join(hooks, 'session-start-sweep.mjs'));
  // copied, not linked, so isMainEntry compares two real paths
  copyFileSync(path.join(PLUGIN_ROOT, 'scripts', 'hooks', '_main-entry.js'), path.join(hooks, '_main-entry.js'));
  symlinkSync(path.join(PLUGIN_ROOT, 'lib'), path.join(pluginCopy, 'lib'), process.platform === 'win32' ? 'junction' : 'dir');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function touch(file, ageMs, content = '{}') {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  const t = new Date(Date.now() - ageMs);
  utimesSync(file, t, t);
  return file;
}

function ageDir(dir, ageMs) {
  const t = new Date(Date.now() - ageMs);
  utimesSync(dir, t, t);
}

function runSweep(payload) {
  return spawnSync(process.execPath, [path.join(pluginCopy, 'scripts', 'hooks', 'session-start-sweep.mjs')], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: base,
    env: {
      ...process.env,
      ARTIBOT_STATE_DIR: stateDir,
      ARTIBOT_STATE_DIR_HOME: getHomeDir(),
      ARTIBOT_DEBUG: '1',
    },
  });
}

describe('session-start-sweep.mjs', () => {
  it('answers {"continue":true} and exits 0 — it never blocks a session', () => {
    const r = runSweep({ session_id: 'mine' });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ continue: true });
  });

  it('removes orphan atomic-write tmp files older than an hour from the STATE dir runtime/', () => {
    const old = touch(path.join(stateDir, 'runtime', 'first-run-state.json.tmp.4242'), 2 * HOUR);
    const oldTs = touch(path.join(stateDir, 'runtime', 'user-profile.json.tmp.4242.1790000000000'), 2 * HOUR);
    const fresh = touch(path.join(stateDir, 'runtime', 'first-run-state.json.tmp.9999'), 5 * 60 * 1000);
    const real = touch(path.join(stateDir, 'runtime', 'first-run-state.json'), 2 * HOUR, '{"globalRuns":3}');

    runSweep({ session_id: 'mine' });

    expect(existsSync(old)).toBe(false);
    expect(existsSync(oldTs)).toBe(false);
    expect(existsSync(fresh)).toBe(true); // a writer may still be in flight
    expect(existsSync(real)).toBe(true); // only the tmp signature is ever touched
  });

  it('also sweeps each session directory, one level deep', () => {
    const old = touch(path.join(stateDir, 'runtime', 'sessions', 'sess-A', 'current-teammates.json.tmp.1'), 2 * HOUR);
    const keep = touch(path.join(stateDir, 'runtime', 'sessions', 'sess-A', 'current-teammates.json'), 2 * HOUR);
    const deep = touch(path.join(stateDir, 'runtime', 'sessions', 'sess-A', 'nested', 'x.json.tmp.1'), 2 * HOUR);

    runSweep({ session_id: 'sess-A' });

    expect(existsSync(old)).toBe(false);
    expect(existsSync(keep)).toBe(true);
    expect(existsSync(deep)).toBe(true);
  });

  it('still sweeps the legacy <pluginRoot>/runtime/, where hooks wrote before O2', () => {
    const legacy = touch(path.join(pluginCopy, 'runtime', 'current-effort.json.tmp.77'), 3 * HOUR);

    runSweep({ session_id: 'mine' });

    expect(existsSync(legacy)).toBe(false);
  });

  it('removes idle session directories but never the one in its own payload', () => {
    const idle = touch(path.join(stateDir, 'runtime', 'sessions', 'idle', 'current-effort.json'), 30 * DAY);
    ageDir(path.dirname(idle), 30 * DAY);
    const mine = touch(path.join(stateDir, 'runtime', 'sessions', 'mine', 'current-effort.json'), 30 * DAY);
    ageDir(path.dirname(mine), 30 * DAY);
    const busy = touch(path.join(stateDir, 'runtime', 'sessions', 'busy', 'current-effort.json'), 1 * HOUR);

    const r = runSweep({ session_id: 'mine' });

    expect(existsSync(path.dirname(idle))).toBe(false);
    expect(existsSync(path.dirname(mine))).toBe(true);
    expect(existsSync(path.dirname(busy))).toBe(true);
    expect(r.stderr).toMatch(/sessions\(scanned=3 removed=1 kept=2\)/);
  });

  it('survives a payload that is not JSON, and an empty one', () => {
    for (const input of ['', 'not json', '[]']) {
      const r = spawnSync(process.execPath, [path.join(pluginCopy, 'scripts', 'hooks', 'session-start-sweep.mjs')], {
        input,
        encoding: 'utf8',
        cwd: base,
        env: { ...process.env, ARTIBOT_STATE_DIR: stateDir, ARTIBOT_STATE_DIR_HOME: getHomeDir() },
      });
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ continue: true });
    }
  });
});
