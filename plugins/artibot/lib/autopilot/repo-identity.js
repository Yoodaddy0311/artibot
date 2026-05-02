/**
 * Repo Identity & Autopilot Allowlist (v4.4.0+).
 *
 * Implements "Capture-Only Mode": all artibot autopilot hooks (save/close/
 * session/guard/setup) call `isAutopilotAllowed(cwd)` before performing any
 * git-side write (commit, push, autopilot.json refresh). Repos NOT in the
 * allowlist receive ZERO git artifacts from this plugin — but all other
 * subsystems (lifelong-learner, GRPO, swarm uploads, telemetry) continue
 * normally, so the plugin still learns from work done in those projects.
 *
 * Allowlist file: `~/.claude/artibot/autopilot-allowlist.json`. Optional —
 * if absent the in-memory `DEFAULT_ALLOWLIST` is used. The file is read-only
 * from this module's perspective; it is bootstrapped during install/sync,
 * never written from runtime hooks.
 *
 * Remote-URL normalization handles the four common forms:
 *   - https://github.com/Yoodaddy0311/artibot.git
 *   - https://user@github.com/Yoodaddy0311/artibot.git
 *   - git@github.com:Yoodaddy0311/artibot.git
 *   - ssh://git@github.com/Yoodaddy0311/artibot.git
 * All collapse to canonical `Yoodaddy0311/artibot`.
 *
 * @module lib/autopilot/repo-identity
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Default allowlist used when the on-disk file is missing or invalid.
 * Edit `~/.claude/artibot/autopilot-allowlist.json` to extend at runtime
 * — modifying this constant in source requires a rebuild.
 */
export const DEFAULT_ALLOWLIST = Object.freeze({
  version: 1,
  repos: ['Yoodaddy0311/artibot', 'Yoodaddy0311/artibot-swarm'],
  notes:
    'Repos where artibot autopilot may write commits / push / refresh config. ' +
    'Other repos still receive full learning capture (tool patterns, GRPO, ' +
    'swarm uploads) — only git-side artifacts are suppressed. Edit "repos" ' +
    '(one "owner/name" entry per line, no .git suffix) to extend.',
});

/**
 * @returns {string} Absolute path to the user-level allowlist file.
 */
export function getAllowlistPath() {
  return path.join(homedir(), '.claude', 'artibot', 'autopilot-allowlist.json');
}

/**
 * Read the allowlist file. Returns DEFAULT_ALLOWLIST on any error or absence.
 * Pure read — never writes.
 *
 * @param {string} [filePath] Override (used in tests).
 * @returns {{version:number, repos:string[], notes?:string}}
 */
export function loadAllowlist(filePath = getAllowlistPath()) {
  if (!existsSync(filePath)) return DEFAULT_ALLOWLIST;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (!parsed || !Array.isArray(parsed.repos)) return DEFAULT_ALLOWLIST;
    return parsed;
  } catch {
    return DEFAULT_ALLOWLIST;
  }
}

/**
 * Read `git config --get remote.origin.url`. Empty string on any failure
 * (no remote, not a repo, missing git, etc.).
 *
 * @param {string} cwd
 * @returns {string}
 */
export function getRemoteUrl(cwd) {
  try {
    return execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Normalize any common git remote URL form to `owner/name`.
 *
 * @param {string} url
 * @returns {string} Canonical `owner/name`, or `''` if unparseable.
 */
export function normalizeRepoId(url) {
  if (!url || typeof url !== 'string') return '';
  return url
    .trim()
    .replace(/\.git\/?$/i, '')
    .replace(/^git@[^:]+:/, '')
    .replace(/^https?:\/\/(?:[^@/]+@)?[^/]+\//i, '')
    .replace(/^ssh:\/\/(?:[^@/]+@)?[^/]+\//i, '')
    .replace(/\/+$/, '');
}

/**
 * Pure check: is `url` listed in `allowlist.repos`?
 * Exported separately so tests can drive without filesystem.
 *
 * @param {string} url Raw remote URL.
 * @param {{repos:string[]}} [allowlist]
 * @returns {boolean}
 */
export function isRepoInAllowlist(url, allowlist = loadAllowlist()) {
  if (!url) return false;
  const id = normalizeRepoId(url);
  if (!id) return false;
  return Array.isArray(allowlist?.repos) && allowlist.repos.includes(id);
}

/**
 * Top-level gate used by all five autopilot hooks. Capture-only mode:
 * if this returns false, the hook MUST NOT perform any git write
 * (commit / push / pull / autopilot.json refresh). All other subsystems
 * (learning, telemetry, swarm) operate independently of this gate.
 *
 * @param {string} cwd Repo working tree root.
 * @returns {boolean}
 */
export function isAutopilotAllowed(cwd) {
  return isRepoInAllowlist(getRemoteUrl(cwd));
}
