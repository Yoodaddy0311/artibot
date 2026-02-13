/**
 * Platform detection and environment utilities.
 * @module lib/core/platform
 */

import { platform, arch, version } from 'node:os';
import { versions } from 'node:process';
import path from 'node:path';

/** Detected OS platform info */
export function getPlatform() {
  return {
    os: platform(),
    arch: arch(),
    isWindows: platform() === 'win32',
    isMac: platform() === 'darwin',
    isLinux: platform() === 'linux',
  };
}

/** Node.js version info and minimum check */
export function getNodeInfo() {
  const raw = versions.node;
  const [major, minor, patch] = raw.split('.').map(Number);
  return { raw, major, minor, patch };
}

/** Check that Node.js version meets minimum (default 18) */
export function checkNodeVersion(minMajor = 18) {
  const { major } = getNodeInfo();
  if (major < minMajor) {
    throw new Error(`Node.js >= ${minMajor} required, found ${major}`);
  }
  return true;
}

/**
 * Resolve CLAUDE_PLUGIN_ROOT.
 * Falls back to 2 levels up from this file (lib/core -> plugin root).
 */
export function getPluginRoot() {
  const envRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (envRoot) return path.resolve(envRoot);
  // Fallback: this file lives in <root>/lib/core/platform.js
  return path.resolve(new URL('..', new URL('..', import.meta.url)).pathname.replace(/^\/([A-Z]:)/i, '$1'));
}

/**
 * Resolve a path relative to the plugin root.
 * Uses path.join for Windows compatibility.
 */
export function resolveFromRoot(...segments) {
  return path.join(getPluginRoot(), ...segments);
}
