/**
 * The `ARTIBOT_STATE_DIR` override loses to the home it was not minted for —
 * whatever variable that home arrives in, and however it is spelled.
 *
 * `resolveArtibotDir()` compares `ARTIBOT_STATE_DIR_HOME` against
 * `getHomeDir()`, and `getHomeDir()` reads `USERPROFILE` before `HOME`
 * (`lib/core/platform.js#getHomeDir`). A child handed only `HOME` — the POSIX
 * idiom — therefore still resolves the parent's `USERPROFILE`, the comparison
 * finds no mismatch, and the inherited override wins over the sandbox the child
 * was actually given. Measured 2026-08-30: setting both isolates correctly,
 * setting `HOME` alone does not.
 *
 * The same comparison was a plain string equality, so a trailing separator or a
 * drive-letter case difference read as "a different home" and discarded a
 * perfectly good override — the mirror failure, and the one that puts writes
 * back in the real state directory.
 *
 * The pairing is now required rather than optional: an override with no
 * recorded home is not trusted. Census 2026-08-30 found exactly two setters in
 * the repo (`tests/setup/state-dir.js`, and this suite's sibling
 * `checkpoint-state-isolation.test.js`), both of which set the pair, so nothing
 * outside the seam relies on the old permissive default.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const ENV_KEYS = ['USERPROFILE', 'HOME', 'ARTIBOT_STATE_DIR', 'ARTIBOT_STATE_DIR_HOME'];

/** @type {Record<string, string|undefined>} */
let saved = {};

const HOME_A = path.join(path.sep, 'tmp', 'home-a');
const HOME_B = path.join(path.sep, 'tmp', 'home-b');
const STATE = path.join(path.sep, 'tmp', 'state-dir');

/** Load a fresh module graph so the env in force is the env observed. */
async function resolve() {
  vi.resetModules();
  const { resolveArtibotDir } = await import('../../lib/core/config.js');
  return resolveArtibotDir();
}

/** What the resolver should produce when it falls back to the home tree. */
function homeDerived(home) {
  return path.join(home, '.claude', 'artibot');
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  saved = {};
});

describe('resolveArtibotDir — override/home pairing', () => {
  it('honours an override minted for the current home', () => {
    // Baseline: the seam still works, or nothing below means anything.
    process.env.USERPROFILE = HOME_A;
    process.env.HOME = HOME_A;
    process.env.ARTIBOT_STATE_DIR = STATE;
    process.env.ARTIBOT_STATE_DIR_HOME = HOME_A;
    return expect(resolve()).resolves.toBe(STATE);
  });

  it('drops the override when only HOME moved', async () => {
    // The spawn shape that leaks: parent's pair inherited, child given HOME
    // alone. `getHomeDir()` prefers USERPROFILE, so the mismatch was invisible
    // and the inherited override kept winning.
    process.env.USERPROFILE = HOME_A;
    process.env.ARTIBOT_STATE_DIR = STATE;
    process.env.ARTIBOT_STATE_DIR_HOME = HOME_A;
    process.env.HOME = HOME_B;

    const got = await resolve();

    // What is fixed: the override no longer survives a home change it was not
    // minted for.
    expect(got).not.toBe(STATE);

    // What is NOT fixed here, deliberately: the fallback still follows the
    // platform's own precedence, so it lands under USERPROFILE rather than the
    // `HOME` the child asked for. Making `HOME` win would change `getHomeDir()`
    // for all 21 modules that read it — a separate decision, not this seam's.
    expect(got).toBe(homeDerived(HOME_A));
  });

  it('treats a trailing separator as the same home', async () => {
    // Mirror failure: an over-eager mismatch discards a good override and puts
    // writes back into the real state directory.
    process.env.USERPROFILE = HOME_A;
    process.env.HOME = HOME_A;
    process.env.ARTIBOT_STATE_DIR = STATE;
    process.env.ARTIBOT_STATE_DIR_HOME = `${HOME_A}${path.sep}`;

    await expect(resolve()).resolves.toBe(STATE);
  });

  it('requires a recorded home before trusting an override', async () => {
    // Default flipped: no proof of pairing, no trust.
    process.env.USERPROFILE = HOME_A;
    process.env.HOME = HOME_A;
    process.env.ARTIBOT_STATE_DIR = STATE;

    await expect(resolve()).resolves.toBe(homeDerived(HOME_A));
  });

  it('falls back to the home tree when no override is set at all', async () => {
    process.env.USERPROFILE = HOME_A;
    process.env.HOME = HOME_A;

    await expect(resolve()).resolves.toBe(homeDerived(HOME_A));
  });
});
