/**
 * `getStatePath()` follows the state-dir resolver.
 *
 * WHY THIS FILE EXISTS. The shared team-state file is `~/.claude/artibot-state.json`
 * — one level ABOVE the artibot state dir (`~/.claude/artibot`) — and
 * `getStatePath()` built it from `getClaudeDir()` without asking
 * `lib/core/config.js#resolveArtibotDir` anything. A hooked, non-interactive
 * session handed `ARTIBOT_STATE_DIR` (paired with its real home through
 * `ARTIBOT_STATE_DIR_HOME`) therefore still read-modify-wrote the REAL file: the
 * owner's promptfoo PoC (2026-10-19) saw its top-level `sessionId`/`cwd` and one
 * `agents` row overwritten. Seven hooks go through this one function
 * (`pre-compact`, `session-end`, `session-start`, `subagent-handler`,
 * `team-idle-handler`, `workflow-status`, `_team-state`), so a single answer here
 * keeps their reads and writes on one file.
 *
 * THE DECISION PINNED. Redirected (the resolver answers something other than the
 * home-derived `~/.claude/artibot`): `<resolved dir>/artibot-state.json`, inside
 * the sandbox the override names. Not redirected (no override, one minted for
 * another home, one without a recorded home, or one that names the default
 * location itself): `~/.claude/artibot-state.json`, byte for byte as before.
 *
 * Every case uses throwaway homes: `USERPROFILE` and `HOME` are both repointed
 * (`getHomeDir()` reads them in that order), so the real one is never touched.
 *
 * WHAT THIS FILE CANNOT SEE: the hooks themselves — see
 * `tests/hooks/team-idle-handler-state-dir.test.js` for a real child process.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { getStatePath } from '../../lib/core/hook-utils.js';
import { pointStateDirAt } from '../helpers/state-dir.js';

const ENV_KEYS = ['USERPROFILE', 'HOME', 'ARTIBOT_STATE_DIR', 'ARTIBOT_STATE_DIR_HOME'];

const HOME_A = path.join(path.sep, 'tmp', 'sp-home-a');
const HOME_B = path.join(path.sep, 'tmp', 'sp-home-b');
const STATE = path.join(path.sep, 'tmp', 'sp-state');

/** @type {Record<string, string|undefined>} */
let saved = {};

const homeDerived = (home) => path.join(home, '.claude', 'artibot-state.json');

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

describe('getStatePath — override honoured', () => {
  it('names the file inside the override, not ~/.claude', () => {
    pointStateDirAt(STATE);

    expect(getStatePath()).toBe(path.join(STATE, 'artibot-state.json'));
  });

  it('follows the override when it changes between calls (read at call time)', () => {
    const restore = pointStateDirAt(STATE);
    const first = getStatePath();
    restore();

    expect(getStatePath()).toBe(homeDerived(HOME_A));
    expect(first).toBe(path.join(STATE, 'artibot-state.json'));
  });
});

describe('getStatePath — nothing redirected (production invariance)', () => {
  it('names ~/.claude/artibot-state.json when no override is set', () => {
    expect(getStatePath()).toBe(homeDerived(HOME_A));
  });

  it('ignores an override minted for another home (a child handed its own HOME)', () => {
    process.env.ARTIBOT_STATE_DIR = STATE;
    process.env.ARTIBOT_STATE_DIR_HOME = HOME_B;

    expect(getStatePath()).toBe(homeDerived(HOME_A));
  });

  it('ignores an override that carries no recorded home', () => {
    process.env.ARTIBOT_STATE_DIR = STATE;

    expect(getStatePath()).toBe(homeDerived(HOME_A));
  });

  it('keeps ~/.claude/artibot-state.json when the override names the default state dir itself', () => {
    // Not "redirected": the sandbox IS the real location. The file must stay where it
    // always was, not move into ~/.claude/artibot.
    pointStateDirAt(path.join(HOME_A, '.claude', 'artibot'));

    expect(getStatePath()).toBe(homeDerived(HOME_A));
  });

  it('follows the home in force when HOME changes (no override)', () => {
    process.env.USERPROFILE = HOME_B;
    process.env.HOME = HOME_B;

    expect(getStatePath()).toBe(homeDerived(HOME_B));
  });
});
