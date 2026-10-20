/**
 * `getPostCompactPath()` and `getPostCompactDir()` follow the state-dir resolver.
 *
 * WHY THIS FILE EXISTS. `scripts/hooks/post-compact-rehydrate.js` saves two things per run — the
 * latest-run record `~/.claude/artibot-post-compact.json` (one level ABOVE the artibot state dir
 * `~/.claude/artibot`) and the bundle text `~/.claude/artibot/post-compact/post-compact-<stamp>.md`
 * (inside it) — and built both from the home alone. A hooked, non-interactive session handed
 * `ARTIBOT_STATE_DIR` (paired with its real home through `ARTIBOT_STATE_DIR_HOME`) that had turned
 * `split.contextLifecycle.enabled` on therefore wrote REAL files. The gate ships off, which is the only
 * reason the owner's promptfoo PoC (2026-10-19) did not show it; these were the last two outputs the
 * 2026-10-20 hook-writer census listed for this hook. `getPreCompactPath()` already answers the same
 * question for the snapshot (`tests/core/hook-utils-pre-compact-path.test.js`); this pins the same
 * decision for the record and adds the directory.
 *
 * THE DECISION PINNED. Redirected (the resolver answers something other than the home-derived
 * `~/.claude/artibot`): the record is `<resolved dir>/artibot-post-compact.json` and the bundle
 * directory is `<resolved dir>/post-compact`. Not redirected (no override, one minted for another home,
 * one without a recorded home, or one that names the default location itself): both are the paths they
 * always were, byte for byte.
 *
 * Every case uses throwaway homes: `USERPROFILE` and `HOME` are both repointed (`getHomeDir()` reads
 * them in that order), so the real one is never touched.
 *
 * WHAT THIS FILE CANNOT SEE: the hook itself — see `tests/hooks/post-compact-rehydrate-state-dir.test.js`
 * for a real child process.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { getPostCompactDir, getPostCompactPath } from '../../lib/core/hook-utils.js';
import { pointStateDirAt } from '../helpers/state-dir.js';

const ENV_KEYS = ['USERPROFILE', 'HOME', 'ARTIBOT_STATE_DIR', 'ARTIBOT_STATE_DIR_HOME'];

const HOME_A = path.join(path.sep, 'tmp', 'poc-home-a');
const HOME_B = path.join(path.sep, 'tmp', 'poc-home-b');
const STATE = path.join(path.sep, 'tmp', 'poc-state');

/** @type {Record<string, string|undefined>} */
let saved = {};

const homeRecord = (home) => path.join(home, '.claude', 'artibot-post-compact.json');
const homeBundleDir = (home) => path.join(home, '.claude', 'artibot', 'post-compact');

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.USERPROFILE = HOME_A;
  process.env.HOME = HOME_A;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('getPostCompactPath / getPostCompactDir — override honoured', () => {
  it('names the record and the bundle directory inside the override, not ~/.claude', () => {
    pointStateDirAt(STATE);

    expect(getPostCompactPath()).toBe(path.join(STATE, 'artibot-post-compact.json'));
    expect(getPostCompactDir()).toBe(path.join(STATE, 'post-compact'));
  });

  it('follows the override when it changes between calls (read at call time)', () => {
    const restore = pointStateDirAt(STATE);
    const firstRecord = getPostCompactPath();
    const firstDir = getPostCompactDir();
    restore();

    expect(getPostCompactPath()).toBe(homeRecord(HOME_A));
    expect(getPostCompactDir()).toBe(homeBundleDir(HOME_A));
    expect(firstRecord).toBe(path.join(STATE, 'artibot-post-compact.json'));
    expect(firstDir).toBe(path.join(STATE, 'post-compact'));
  });
});

describe('getPostCompactPath / getPostCompactDir — nothing redirected (production invariance)', () => {
  it('names the two ~/.claude paths when no override is set', () => {
    expect(getPostCompactPath()).toBe(homeRecord(HOME_A));
    expect(getPostCompactDir()).toBe(homeBundleDir(HOME_A));
  });

  it('ignores an override minted for another home (a child handed its own HOME)', () => {
    process.env.ARTIBOT_STATE_DIR = STATE;
    process.env.ARTIBOT_STATE_DIR_HOME = HOME_B;

    expect(getPostCompactPath()).toBe(homeRecord(HOME_A));
    expect(getPostCompactDir()).toBe(homeBundleDir(HOME_A));
  });

  it('ignores an override that carries no recorded home', () => {
    process.env.ARTIBOT_STATE_DIR = STATE;

    expect(getPostCompactPath()).toBe(homeRecord(HOME_A));
    expect(getPostCompactDir()).toBe(homeBundleDir(HOME_A));
  });

  it('keeps the record above the data dir when the override names the default state dir itself', () => {
    // Not "redirected": the sandbox IS the real location. The record must stay where it always
    // was, not move into ~/.claude/artibot.
    pointStateDirAt(path.join(HOME_A, '.claude', 'artibot'));

    expect(getPostCompactPath()).toBe(homeRecord(HOME_A));
    expect(getPostCompactDir()).toBe(homeBundleDir(HOME_A));
  });

  it('follows the home in force when HOME changes (no override)', () => {
    process.env.USERPROFILE = HOME_B;
    process.env.HOME = HOME_B;

    expect(getPostCompactPath()).toBe(homeRecord(HOME_B));
    expect(getPostCompactDir()).toBe(homeBundleDir(HOME_B));
  });
});
