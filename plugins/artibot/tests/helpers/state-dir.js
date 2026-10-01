/**
 * Point the artibot STATE directory at a throwaway path for ONE test.
 *
 * `lib/core/config.js#resolveArtibotDir` decides where GLOBAL and SESSION hook
 * state lives (`<state>/runtime/...`), and `ARTIBOT_STATE_DIR` is the seam that
 * redirects it (`tests/setup/state-dir.js` sets a per-worker default for every
 * suite). A test that needs its OWN directory — to assert on exact paths, or to
 * keep two cases from seeing each other's files — points the seam here instead
 * of passing a `pluginRoot`: since O2 a plugin root no longer decides where
 * state is written (see `lib/core/runtime-state.js`), so a tmp "plugin root"
 * handed to a writer is only the LEGACY location it may migrate from.
 *
 * The override is honoured only while the home it was minted for is still the
 * home in force (`resolveArtibotDir` drops a pair it cannot place), so the
 * pairing variable is stamped here too. Both variables are restored exactly —
 * `delete` for an originally-unset one, never an assignment of `undefined`,
 * which `process.env` would stringify into the literal path segment
 * "undefined".
 *
 * Pointing the state dir AT a tmp plugin root reproduces the install.sh layout,
 * where the state dir and the plugin root are the same directory; suites that
 * were written against `<root>/runtime/...` keep their assertions unchanged.
 *
 * @module tests/helpers/state-dir
 */

import { getHomeDir } from '../../lib/core/platform.js';

/**
 * @param {string} dir - Absolute directory to use as the state dir.
 * @returns {() => void} restore — call it from `afterEach` / `finally`.
 */
export function pointStateDirAt(dir) {
  const saved = {
    ARTIBOT_STATE_DIR: process.env.ARTIBOT_STATE_DIR,
    ARTIBOT_STATE_DIR_HOME: process.env.ARTIBOT_STATE_DIR_HOME,
  };
  process.env.ARTIBOT_STATE_DIR = dir;
  process.env.ARTIBOT_STATE_DIR_HOME = getHomeDir();
  return function restore() {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
