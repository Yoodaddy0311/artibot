/**
 * Install-mode detection.
 *
 * Distinguishes how Artibot is installed so callers that assume the LEGACY
 * layout do not misfire under a NATIVE marketplace install:
 *
 *   - **legacy**  — `git clone` + `bash install.sh`, which flat-copies the
 *     plugin payload into `~/.claude/artibot/` and leaves a git source repo.
 *     The self-updater (scripts/update.js) and setup scripts are built for this.
 *   - **native**  — installed through the Claude Code marketplace; the plugin
 *     runs from `~/.claude/plugins/cache/artibot/…`. Updates are owned by
 *     Claude Code via `/plugin marketplace update artibot`; the git-pull +
 *     install.sh flow makes wrong path assumptions here.
 *   - **ambiguous** — both signals present, or neither. Callers should stay
 *     conservative (keep legacy behavior) and surface a one-line warning.
 *
 * Zero dependencies (node:fs + node:path only).
 * @module lib/core/install-mode
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

/** User-facing command that updates a native marketplace install. */
export const NATIVE_UPDATE_HINT = '/plugin marketplace update artibot';

/**
 * Normalize a path for substring comparison: forward slashes, lowercase, no
 * trailing slash. Returns '' for falsy input.
 * @param {string} p
 * @returns {string}
 */
function norm(p) {
  return String(p || '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}

/**
 * Classify the current install layout.
 *
 * NATIVE signal: the running plugin root (or `CLAUDE_PLUGIN_ROOT`) resolves
 * under the Claude marketplace plugin cache (`~/.claude/plugins/cache`).
 *
 * LEGACY signal: the flat-copied plugin PAYLOAD exists at `~/.claude/artibot`
 * (install.sh / install.ps1 / scripts/ / hooks/hooks.json). We deliberately do
 * NOT treat the bare `~/.claude/artibot` directory as a legacy signal — it also
 * holds data-only files (autopilot allowlist, update-backup.json, learning
 * data) under a native install, so its mere existence proves nothing.
 *
 * @param {object} [opts]
 * @param {string} [opts.pluginRoot] - Resolved running plugin root (getPluginRoot()).
 * @param {string} [opts.home] - User home directory.
 * @param {object} [opts.env] - Environment (defaults to process.env).
 * @returns {{ mode: 'native'|'legacy'|'ambiguous', native: boolean, legacy: boolean, reason: string }}
 */
export function detectInstallMode(opts = {}) {
  const { pluginRoot = '', home = '', env = process.env } = opts;

  const cacheMarker = home ? norm(path.join(home, '.claude', 'plugins', 'cache')) : '';
  const rootN = norm(pluginRoot);
  const envRootN = norm(env?.CLAUDE_PLUGIN_ROOT);

  const native = Boolean(cacheMarker) && (
    (Boolean(rootN) && rootN.includes(cacheMarker)) ||
    (Boolean(envRootN) && envRootN.includes(cacheMarker))
  );

  const flatRoot = home ? path.join(home, '.claude', 'artibot') : '';
  const legacy = Boolean(flatRoot) && (
    existsSync(path.join(flatRoot, 'install.sh')) ||
    existsSync(path.join(flatRoot, 'install.ps1')) ||
    existsSync(path.join(flatRoot, 'scripts')) ||
    existsSync(path.join(flatRoot, 'hooks', 'hooks.json'))
  );

  if (native && !legacy) {
    return { mode: 'native', native, legacy, reason: 'plugin root under marketplace cache; no flat install payload' };
  }
  if (legacy && !native) {
    return { mode: 'legacy', native, legacy, reason: 'flat install payload present at ~/.claude/artibot' };
  }
  if (native && legacy) {
    return { mode: 'ambiguous', native, legacy, reason: 'both marketplace cache root and flat install payload present' };
  }
  return { mode: 'ambiguous', native, legacy, reason: 'neither marketplace cache nor flat install payload detected' };
}
