/**
 * update-marketplace.js - Marketplace-clone health + master-branch version source.
 *
 * Root incident this guards (2026-07-13): GitHub Releases stopped being
 * published after v4.30.0 while master moved on to v4.36.3, AND the
 * marketplace clone at ~/.claude/plugins/marketplaces/artibot sat dirty +
 * diverged (polluted by the pre-v4.36.4 install.sh mirror), so BOTH version
 * oracles lied — /update and `claude plugin update` each reported a stale
 * v4.32.0 as "latest". This module gives update.js two honest primitives:
 *
 *   1. fetchLatestMasterVersion() — read the version straight from
 *      master's plugin.json on raw.githubusercontent.com (the branch
 *      `claude plugin update` actually installs from), so the answer no
 *      longer depends on a release being published.
 *   2. inspectMarketplaceClone()  — surface the clone's version and git
 *      cleanliness so a stuck clone is diagnosed loudly instead of being
 *      reported as "already up to date".
 *
 * Zero dependencies. Node 18+ built-ins only. ESM module format.
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { assertEgressAllowed } from '../lib/core/data-egress-guard.js';

// The version truth is master's plugin manifest — the exact content
// `claude plugin update` installs — not the (optionally published) release feed.
export const MASTER_PLUGIN_JSON_URL =
  'https://raw.githubusercontent.com/Yoodaddy0311/artibot/master/plugins/artibot/.claude-plugin/plugin.json';

const FETCH_TIMEOUT_MS = 5000;

/**
 * Fetch the plugin version currently on the master branch.
 * Returns a bare semver string ("4.36.4") or null on any failure —
 * callers fall back to the GitHub Releases API.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] - injectable for tests
 * @param {number} [options.timeoutMs]
 * @returns {Promise<string|null>}
 */
export async function fetchLatestMasterVersion({ fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  try {
    // DATA POLICY: raw.githubusercontent.com must be in lib/core/allowlist.json.
    assertEgressAllowed(MASTER_PLUGIN_JSON_URL, { reason: 'version-check' });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(MASTER_PLUGIN_JSON_URL, {
        signal: controller.signal,
        headers: { 'User-Agent': 'artibot-update-script' },
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) return null;
    const data = await response.json();
    const version = String(data.version || '').replace(/^v/, '');
    return version || null;
  } catch {
    return null;
  }
}

/**
 * Read a plugin version from a marketplace clone's manifest, or null.
 * @param {string} cloneRoot
 * @returns {string|null}
 */
function readCloneVersion(cloneRoot) {
  const manifest = path.join(cloneRoot, 'plugins', 'artibot', '.claude-plugin', 'plugin.json');
  try {
    const version = JSON.parse(readFileSync(manifest, 'utf-8')).version;
    return version ? String(version).replace(/^v/, '') : null;
  } catch {
    return null;
  }
}

/**
 * Inspect the Claude Code-managed marketplace clone for artibot.
 *
 * dirty semantics: true/false when git answered, null when unknown
 * (not a clone, git missing, or the status call failed).
 *
 * @param {string} home - resolved home dir
 * @param {object} [options]
 * @param {typeof execFileSync} [options.exec] - injectable for tests
 * @returns {{ present: boolean, root: string|null, isGit: boolean, dirty: boolean|null, version: string|null }}
 */
export function inspectMarketplaceClone(home, { exec = execFileSync } = {}) {
  const root = path.join(home, '.claude', 'plugins', 'marketplaces', 'artibot');
  if (!existsSync(root)) {
    return { present: false, root: null, isGit: false, dirty: null, version: null };
  }

  const isGit = existsSync(path.join(root, '.git'));
  let dirty = null;
  if (isGit) {
    try {
      const out = exec('git', ['-C', root, 'status', '--porcelain'], {
        encoding: 'utf-8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      dirty = String(out).trim().length > 0;
    } catch {
      dirty = null;
    }
  }

  return { present: true, root, isGit, dirty, version: readCloneVersion(root) };
}

/**
 * Render a human-readable diagnosis of a stuck marketplace clone, with the
 * exact repair commands. Returns [] when nothing blocks the update path.
 *
 * @param {ReturnType<typeof inspectMarketplaceClone>} state
 * @param {object} args
 * @param {string} args.latestVersion - bare semver of the newest known version
 * @param {function(string, string): boolean} args.isNewerVersion
 * @returns {string[]} lines to print (empty = clone healthy or absent)
 */
export function renderMarketplaceDiagnosis(state, { latestVersion, isNewerVersion }) {
  if (!state.present) return [];

  const stale = state.version !== null && isNewerVersion(state.version, latestVersion);
  if (!stale && state.dirty !== true) return [];

  const lines = ['', 'Marketplace clone diagnosis:'];
  if (stale) {
    lines.push(`  clone version v${state.version} is behind latest v${latestVersion} — Claude Code's refresh is stuck.`);
  }
  if (state.dirty === true) {
    lines.push('  clone working tree is DIRTY — local writes block the git-based marketplace refresh.');
  }
  lines.push('  Repair (safe: the clone is a Claude Code-managed cache, not a working repo):');
  if (state.isGit && state.root) {
    lines.push(`    git -C "${state.root}" fetch origin && git -C "${state.root}" reset --hard origin/master`);
  }
  lines.push('    claude plugin marketplace update artibot');
  return lines;
}
