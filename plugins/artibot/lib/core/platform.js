/**
 * Platform detection and environment utilities.
 * @module lib/core/platform
 */

import { arch, homedir, platform } from 'node:os';
import { versions } from 'node:process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Detect the current OS platform and architecture.
 *
 * @returns {{ os: string, arch: string, isWindows: boolean, isMac: boolean, isLinux: boolean }}
 *   Object containing OS identifier, CPU architecture, and boolean flags for common platforms.
 * @example
 * const info = getPlatform();
 * // { os: 'win32', arch: 'x64', isWindows: true, isMac: false, isLinux: false }
 * if (info.isWindows) {
 *   // Windows-specific logic
 * }
 */
export function getPlatform() {
  return {
    os: platform(),
    arch: arch(),
    isWindows: platform() === 'win32',
    isMac: platform() === 'darwin',
    isLinux: platform() === 'linux',
  };
}

/**
 * Retrieve the current Node.js version, parsed into components.
 *
 * @returns {{ raw: string, major: number, minor: number, patch: number }}
 *   Object with the raw version string and numeric major/minor/patch values.
 * @example
 * const node = getNodeInfo();
 * // { raw: '20.11.0', major: 20, minor: 11, patch: 0 }
 * console.log(`Node.js v${node.major}`);
 */
export function getNodeInfo() {
  const raw = versions.node;
  const [major, minor, patch] = raw.split('.').map(Number);
  return { raw, major, minor, patch };
}

/**
 * Check that the current Node.js version meets a minimum major version.
 * Throws an error if the requirement is not satisfied.
 *
 * @param {number} [minMajor=18] - Minimum required Node.js major version.
 * @returns {boolean} `true` if the version requirement is met.
 * @throws {Error} If the current Node.js major version is below `minMajor`.
 * @example
 * checkNodeVersion(18); // returns true on Node 20
 * checkNodeVersion(22); // throws Error on Node 20
 */
export function checkNodeVersion(minMajor = 18) {
  const { major } = getNodeInfo();
  if (major < minMajor) {
    throw new Error(`Node.js >= ${minMajor} required, found ${major}`);
  }
  return true;
}

/**
 * Normalize a plugin-root candidate by stripping a duplicated trailing
 * `plugins/artibot/plugins/artibot` segment. This guards against worktree
 * setups and stale env vars that sometimes produce the doubled path
 * (root has typo'd nested copy or CLAUDE_PLUGIN_ROOT was set relative to
 * another plugin root).
 *
 * @param {string} candidate - Resolved path candidate.
 * @returns {string} Path with redundant trailing `plugins/artibot` removed if duplicated.
 */
function normalizePluginRoot(candidate) {
  if (!candidate) return candidate;
  // Use forward-slash form for matching (works on Windows + POSIX)
  const forward = candidate.replace(/\\/g, '/');
  const dup = /\/plugins\/artibot\/plugins\/artibot\/?$/i;
  if (dup.test(forward)) {
    const stripped = forward.replace(/\/plugins\/artibot\/?$/i, '');
    return path.normalize(stripped);
  }
  return candidate;
}

/**
 * Resolve the plugin root directory path.
 * Uses the `CLAUDE_PLUGIN_ROOT` environment variable if set,
 * otherwise falls back to 2 levels up from this file (`lib/core` -> plugin root).
 *
 * Both the env-var path and the fallback are normalized to strip a
 * duplicated `plugins/artibot/plugins/artibot` tail that can appear in
 * worktrees or when the env var is set incorrectly.
 *
 * @returns {string} Absolute path to the plugin root directory.
 * @example
 * const root = getPluginRoot();
 * // '/home/user/.claude/plugins/artibot'
 */
export function getPluginRoot() {
  const envRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (envRoot) {
    const resolved = normalizePluginRoot(path.resolve(envRoot));
    // Validate: warn if artibot.config.json is missing (may indicate stale env var)
    const configPath = path.join(resolved, 'artibot.config.json');
    if (!existsSync(configPath) && existsSync(resolved)) {
      // Directory exists but missing config — likely a stale or wrong CLAUDE_PLUGIN_ROOT
      // Still return it to avoid breaking callers, but other modules should handle gracefully
    }
    return resolved;
  }
  // Fallback: this file lives in <root>/lib/core/platform.js
  const fallback = fileURLToPath(new URL('../..', import.meta.url));
  return normalizePluginRoot(fallback);
}

/**
 * Resolve the user home directory cross-platform.
 * Prefers USERPROFILE (Windows) then HOME (Unix), falling back to os.homedir().
 *
 * @returns {string} Absolute path to the user's home directory.
 * @example
 * const home = getHomeDir();
 * // 'C:\\Users\\username' on Windows, '/home/username' on Linux
 */
export function getHomeDir() {
  return process.env.USERPROFILE || process.env.HOME || homedir();
}

/**
 * Bring a directory path to a single comparable, stat-able form.
 *
 * The reason this exists is that the same directory reaches us spelled several
 * ways. Git Bash — the shell this repo is developed in — hands a child
 * `/c/Users/x` where Windows means `C:\Users\x`, and Node cannot stat the first
 * form: `existsSync` reports "no" for a directory that is plainly there.
 * Measured 2026-08-30, that alone silenced the `sensitive-file` guard for the
 * Artibot repo itself, because the repo-detection check could not see its own
 * markers. Trailing separators and drive-letter case are the same class of
 * difference and are folded out by `path.resolve`.
 *
 * @param {unknown} input - Candidate path.
 * @returns {string|null} Absolute normalized path, or null when the input is
 *   not a usable path string.
 */
export function normalizeDirPath(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  let candidate = trimmed;
  if (process.platform === 'win32') {
    // `/c/Users/x` (and `/C/Users/x`) → `C:\Users\x`. Anchored so a genuine
    // POSIX root path on a POSIX host is never rewritten.
    const msys = /^\/([A-Za-z])(?:\/(.*))?$/.exec(candidate);
    if (msys) {
      const rest = (msys[2] || '').split('/').join(path.sep);
      candidate = `${msys[1].toUpperCase()}:${path.sep}${rest}`;
    }
  }

  try {
    return path.resolve(candidate);
  } catch {
    return null;
  }
}

/**
 * Compare two directory paths for identity, tolerating spelling differences.
 *
 * Case-insensitive on Windows, where `C:\Users` and `c:\users` are one
 * directory; exact elsewhere, where they are two. Returns false when either
 * side cannot be normalized — an unusable path is not evidence of a match.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function sameDirPath(a, b) {
  const na = normalizeDirPath(a);
  const nb = normalizeDirPath(b);
  if (!na || !nb) return false;
  return process.platform === 'win32'
    ? na.toLowerCase() === nb.toLowerCase()
    : na === nb;
}

/**
 * Resolve a path relative to the plugin root directory.
 * Uses `path.join` for cross-platform (Windows/Unix) compatibility.
 *
 * @param {...string} segments - Path segments to join onto the plugin root.
 * @returns {string} Absolute path resolved from the plugin root.
 * @example
 * const configPath = resolveFromRoot('artibot.config.json');
 * // '/home/user/.claude/plugins/artibot/artibot.config.json'
 *
 * const agentPath = resolveFromRoot('agents', 'orchestrator.md');
 * // '/home/user/.claude/plugins/artibot/agents/orchestrator.md'
 */
export function resolveFromRoot(...segments) {
  return path.join(getPluginRoot(), ...segments);
}
