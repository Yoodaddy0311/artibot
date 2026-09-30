/**
 * A throwaway plugin root that still resolves the REAL modules.
 *
 * Several hooks `import()` their lib modules under `getPluginRoot()` at call
 * time, so pointing `CLAUDE_PLUGIN_ROOT` at an empty directory sends every
 * dynamic import into its catch block — and an assertion like "nothing was
 * written to the plugin root" then passes for the wrong reason. The sandbox
 * here LINKS the real `lib/`, `commands/`, `skills/` and `agents/` (junctions on
 * Windows, which need no privilege) and copies the real `artibot.config.json`,
 * so the real code runs and only the writable part of the tree is fresh.
 *
 * Laid out like a marketplace cache entry when given a version
 * (`<base>/cache/artibot/artibot/<version>`): its basename is a semver, which is
 * what `lib/core/runtime-state.js` keys its "previous version sits next to me"
 * migration on.
 *
 * @module tests/helpers/linked-plugin-root
 */

import { copyFileSync, mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Read-only directories the hooks resolve through `getPluginRoot()` at runtime. */
export const LINKED_DIRS = Object.freeze(['lib', 'commands', 'skills', 'agents']);

/**
 * @param {string} root - Absolute directory to turn into a plugin root (created).
 * @returns {string} the same `root`
 */
export function makeLinkedPluginRoot(root) {
  mkdirSync(root, { recursive: true });
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const dir of LINKED_DIRS) {
    symlinkSync(path.join(PLUGIN_ROOT, dir), path.join(root, dir), linkType);
  }
  copyFileSync(path.join(PLUGIN_ROOT, 'artibot.config.json'), path.join(root, 'artibot.config.json'));
  return root;
}

/**
 * @param {string} base - Scratch directory.
 * @param {string} version - e.g. '4.70.0'.
 * @returns {string} `<base>/cache/artibot/artibot/<version>`, linked as above.
 */
export function makeVersionRoot(base, version) {
  return makeLinkedPluginRoot(path.join(base, 'cache', 'artibot', 'artibot', version));
}
