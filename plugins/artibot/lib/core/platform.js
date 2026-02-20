/**
 * Platform detection and environment utilities.
 * @module lib/core/platform
 */

import { arch, homedir, platform } from 'node:os';
import { versions } from 'node:process';
import path from 'node:path';

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
 * Resolve the plugin root directory path.
 * Uses the `CLAUDE_PLUGIN_ROOT` environment variable if set,
 * otherwise falls back to 2 levels up from this file (`lib/core` -> plugin root).
 *
 * @returns {string} Absolute path to the plugin root directory.
 * @example
 * const root = getPluginRoot();
 * // '/home/user/.claude/plugins/artibot'
 */
export function getPluginRoot() {
  const envRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (envRoot) return path.resolve(envRoot);
  // Fallback: this file lives in <root>/lib/core/platform.js
  return path.resolve(new URL('..', new URL('..', import.meta.url)).pathname.replace(/^\/([A-Z]:)/i, '$1'));
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
