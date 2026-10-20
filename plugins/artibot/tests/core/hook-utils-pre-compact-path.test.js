/**
 * `getPreCompactPath()` follows the state-dir resolver.
 *
 * WHY THIS FILE EXISTS. `scripts/hooks/pre-compact.js` wrote the compaction snapshot to
 * `~/.claude/artibot-pre-compact.json` — one level ABOVE the artibot state dir
 * (`~/.claude/artibot`) — and `post-compact-rehydrate.js` read it back from the same
 * hand-built path. Neither asked `lib/core/config.js#resolveArtibotDir` anything, so a
 * hooked, non-interactive session handed `ARTIBOT_STATE_DIR` (paired with its real home
 * through `ARTIBOT_STATE_DIR_HOME`) still wrote the REAL file on every PreCompact event
 * (found by the 2026-10-20 hook-writer census after the owner's promptfoo PoC).
 * `getStatePath()` already answers the same question for `artibot-state.json`; this
 * pins the same decision for the snapshot, so the writer and the reader share one answer.
 *
 * THE DECISION PINNED. Redirected (the resolver answers something other than the
 * home-derived `~/.claude/artibot`): `<resolved dir>/artibot-pre-compact.json`. Not
 * redirected (no override, one minted for another home, one without a recorded home, or
 * one that names the default location itself): `~/.claude/artibot-pre-compact.json`,
 * byte for byte as before.
 *
 * Every case uses throwaway homes: `USERPROFILE` and `HOME` are both repointed
 * (`getHomeDir()` reads them in that order), so the real one is never touched.
 *
 * WHAT THIS FILE CANNOT SEE: the hooks themselves — see
 * `tests/hooks/pre-compact-state-dir.test.js` for a real child process.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { getPreCompactPath } from '../../lib/core/hook-utils.js';
import { pointStateDirAt } from '../helpers/state-dir.js';

const ENV_KEYS = ['USERPROFILE', 'HOME', 'ARTIBOT_STATE_DIR', 'ARTIBOT_STATE_DIR_HOME'];

const HOME_A = path.join(path.sep, 'tmp', 'pc-home-a');
const HOME_B = path.join(path.sep, 'tmp', 'pc-home-b');
const STATE = path.join(path.sep, 'tmp', 'pc-state');

/** @type {Record<string, string|undefined>} */
let saved = {};

const homeDerived = (home) => path.join(home, '.claude', 'artibot-pre-compact.json');

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

describe('getPreCompactPath — override honoured', () => {
  it('names the file inside the override, not ~/.claude', () => {
    pointStateDirAt(STATE);

    expect(getPreCompactPath()).toBe(path.join(STATE, 'artibot-pre-compact.json'));
  });

  it('follows the override when it changes between calls (read at call time)', () => {
    const restore = pointStateDirAt(STATE);
    const first = getPreCompactPath();
    restore();

    expect(getPreCompactPath()).toBe(homeDerived(HOME_A));
    expect(first).toBe(path.join(STATE, 'artibot-pre-compact.json'));
  });
});

describe('getPreCompactPath — nothing redirected (production invariance)', () => {
  it('names ~/.claude/artibot-pre-compact.json when no override is set', () => {
    expect(getPreCompactPath()).toBe(homeDerived(HOME_A));
  });

  it('ignores an override minted for another home (a child handed its own HOME)', () => {
    process.env.ARTIBOT_STATE_DIR = STATE;
    process.env.ARTIBOT_STATE_DIR_HOME = HOME_B;

    expect(getPreCompactPath()).toBe(homeDerived(HOME_A));
  });

  it('ignores an override that carries no recorded home', () => {
    process.env.ARTIBOT_STATE_DIR = STATE;

    expect(getPreCompactPath()).toBe(homeDerived(HOME_A));
  });

  it('keeps ~/.claude/artibot-pre-compact.json when the override names the default state dir itself', () => {
    // Not "redirected": the sandbox IS the real location. The file must stay where it
    // always was, not move into ~/.claude/artibot.
    pointStateDirAt(path.join(HOME_A, '.claude', 'artibot'));

    expect(getPreCompactPath()).toBe(homeDerived(HOME_A));
  });

  it('follows the home in force when HOME changes (no override)', () => {
    process.env.USERPROFILE = HOME_B;
    process.env.HOME = HOME_B;

    expect(getPreCompactPath()).toBe(homeDerived(HOME_B));
  });
});
