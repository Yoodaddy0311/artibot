/**
 * The evaluation store follows the state-dir resolver.
 *
 * WHY THIS FILE EXISTS. `getEvaluationsPath()` joined `~/.claude/artibot` itself
 * (`getHomeDir()` + `.claude/artibot`) instead of calling
 * `lib/core/config.js#resolveArtibotDir`. A hooked, non-interactive session that
 * was handed `ARTIBOT_STATE_DIR` (paired with its real home through
 * `ARTIBOT_STATE_DIR_HOME`) therefore still wrote its self-evaluation rows into
 * the REAL `~/.claude/artibot/evaluations.json`. Reported by the owner's promptfoo
 * PoC (2026-10-19): 4 records leaked that way (not re-measured here; the regression
 * below is what this file proves).
 *
 * WHAT IS PINNED. With the override honoured the file lands under the override and
 * NOT under the home-derived path; with no override (or one minted for another
 * home) the path is the home-derived one, byte for byte. Reader and writer share
 * the one function, so what `saveEvaluations` wrote is what `loadEvaluations`
 * reads back in either mode.
 *
 * The home is a throwaway directory: both `USERPROFILE` and `HOME` are repointed
 * (`getHomeDir()` reads them in that order), so the real home is never touched.
 *
 * WHAT THIS FILE CANNOT SEE: whether a hooked session in the wild still has some
 * OTHER writer that builds `~/.claude/artibot/...` itself. This pins this store only.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pointStateDirAt } from '../helpers/state-dir.js';
import {
  getEvaluationsPath,
  loadEvaluations,
  saveEvaluations,
} from '../../lib/learning/evaluation-store.js';

const ENV_KEYS = ['USERPROFILE', 'HOME', 'ARTIBOT_STATE_DIR', 'ARTIBOT_STATE_DIR_HOME'];

/** @type {Record<string, string|undefined>} */
let savedEnv;
let tmp;
let home;
let stateDir;

/** Where the file lives with nothing redirected, for the sandbox HOME. */
function homeDerivedPath() {
  return path.join(home, '.claude', 'artibot', 'evaluations.json');
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = mkdtempSync(path.join(os.tmpdir(), 'artibot-evalstore-'));
  home = path.join(tmp, 'home');
  stateDir = path.join(tmp, 'state');
  mkdirSync(home, { recursive: true });
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.USERPROFILE = home;
  process.env.HOME = home;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('evaluation store — override honoured', () => {
  it('names a file under the override, not under the home tree', () => {
    pointStateDirAt(stateDir);

    expect(getEvaluationsPath()).toBe(path.join(stateDir, 'evaluations.json'));
  });

  it('writes under the override and leaves the home tree untouched', async () => {
    pointStateDirAt(stateDir);

    await saveEvaluations([{ id: 'eval-1', overall: 4 }]);

    expect(existsSync(path.join(stateDir, 'evaluations.json'))).toBe(true);
    expect(existsSync(homeDerivedPath())).toBe(false);
    expect(existsSync(path.join(home, '.claude'))).toBe(false);
  });

  it('reads back what it wrote (reader and writer share the path)', async () => {
    pointStateDirAt(stateDir);

    await saveEvaluations([{ id: 'eval-1', overall: 4 }, { id: 'eval-2', overall: 3 }]);

    expect((await loadEvaluations()).map((r) => r.id)).toEqual(['eval-1', 'eval-2']);
    expect(JSON.parse(readFileSync(path.join(stateDir, 'evaluations.json'), 'utf-8'))).toHaveLength(2);
  });

  it('does not read the home tree while an override is in force', async () => {
    // Plant a row at the home-derived path first (nothing redirected yet).
    await saveEvaluations([{ id: 'planted-at-home', overall: 2 }]);
    expect(existsSync(homeDerivedPath())).toBe(true);

    pointStateDirAt(stateDir);

    expect(await loadEvaluations()).toEqual([]);
  });
});

describe('evaluation store — nothing redirected (production invariance)', () => {
  it('names ~/.claude/artibot/evaluations.json when no override is set', () => {
    expect(getEvaluationsPath()).toBe(homeDerivedPath());
  });

  it('writes and reads under the home tree when no override is set', async () => {
    await saveEvaluations([{ id: 'eval-9', overall: 5 }]);

    expect(existsSync(homeDerivedPath())).toBe(true);
    expect((await loadEvaluations()).map((r) => r.id)).toEqual(['eval-9']);
  });

  it('ignores an override minted for another home (a spawned child with its own HOME)', () => {
    process.env.ARTIBOT_STATE_DIR = stateDir;
    process.env.ARTIBOT_STATE_DIR_HOME = path.join(tmp, 'some-other-home');

    expect(getEvaluationsPath()).toBe(homeDerivedPath());
  });

  it('ignores an override that carries no recorded home', () => {
    process.env.ARTIBOT_STATE_DIR = stateDir;

    expect(getEvaluationsPath()).toBe(homeDerivedPath());
  });

  it('treats an override equal to the default location as that location', () => {
    pointStateDirAt(path.join(home, '.claude', 'artibot'));

    expect(getEvaluationsPath()).toBe(homeDerivedPath());
  });
});
