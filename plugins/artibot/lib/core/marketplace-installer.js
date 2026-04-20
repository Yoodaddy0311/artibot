/**
 * Marketplace Installer — installs Artibot extensions from local paths
 * (and, placeholder, from Artibot-owned GitHub releases).
 *
 * DATA POLICY: Only local `file://` URLs and Artibot-owned
 * `https://github.com/Yoodaddy0311/` URLs are allow-listed. Remote tarball
 * installation is intentionally a placeholder (`throw`) because Artibot
 * keeps a zero-runtime-deps invariant and has not yet ported a pure-Node
 * tar extractor. Everything else is rejected on sight.
 *
 * No external registry is contacted. No telemetry. All installed extensions
 * live under `~/.claude/plugins/artibot-ext-<name>/`.
 *
 * @module lib/core/marketplace-installer
 */

import { cp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadExtension, validateManifest } from './extension-loader.js';

const ARTIBOT_GH_PREFIX = 'https://github.com/Yoodaddy0311/';
const INSTALL_ROOT = path.join(homedir(), '.claude', 'plugins');
const EXT_PREFIX = 'artibot-ext-';

/**
 * Check if a path exists (any type).
 * @param {string} p
 * @returns {Promise<boolean>}
 */
async function pathExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

/**
 * Registry install is not yet wired up. Kept as an explicit stub so callers
 * get a clear error instead of silent no-op.
 *
 * @param {string} pkgName
 * @param {object} [options]
 * @returns {Promise<never>}
 */
// eslint-disable-next-line no-unused-vars
export async function installFromRegistry(pkgName, options) {
  throw new Error('Registry not yet available');
}

/**
 * Parse a `file://` URL into an absolute OS path. Handles Windows drive
 * letters and Korean-path percent-encoding.
 *
 * @param {URL} url
 * @returns {string}
 */
function fileUrlToLocalPath(url) {
  try {
    return fileURLToPath(url);
  } catch {
    // Fallback: strip leading slashes for Windows
    let p = decodeURIComponent(url.pathname);
    if (process.platform === 'win32' && /^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
    return p;
  }
}

/**
 * Install an extension from a URL.
 *
 * Supported:
 *   - `file://...` — copied recursively from the local directory.
 *   - `https://github.com/Yoodaddy0311/...` — allow-listed but not yet
 *     implemented (pending zero-deps tar support).
 *
 * Every other URL is rejected synchronously.
 *
 * @param {string} tarballUrl
 * @param {{force?: boolean, installRoot?: string}} [options]
 * @returns {Promise<{installed: boolean, path: string, manifest: object}>}
 */
export async function installFromUrl(tarballUrl, options = {}) {
  if (typeof tarballUrl !== 'string' || tarballUrl.length === 0) {
    throw new Error('tarballUrl must be a non-empty string');
  }
  let url;
  try {
    url = new URL(tarballUrl);
  } catch {
    throw new Error(`invalid URL: ${tarballUrl}`);
  }

  if (url.protocol !== 'file:' && !tarballUrl.startsWith(ARTIBOT_GH_PREFIX)) {
    throw new Error(
      `URL not in allowlist: only file:// or ${ARTIBOT_GH_PREFIX}... are permitted`
    );
  }

  if (url.protocol !== 'file:') {
    throw new Error('Remote tarball install pending zero-deps tar support');
  }

  const srcDir = fileUrlToLocalPath(url);
  if (!(await pathExists(srcDir))) {
    throw new Error(`source directory not found: ${srcDir}`);
  }
  const srcStat = await stat(srcDir);
  if (!srcStat.isDirectory()) {
    throw new Error(`source must be a directory (file:// unpacked layout): ${srcDir}`);
  }

  const manifestPath = path.join(srcDir, 'artibot.ext.json');
  if (!(await pathExists(manifestPath))) {
    throw new Error(`artibot.ext.json not found in ${srcDir}`);
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
  const validation = validateManifest(manifest);
  if (!validation.valid) {
    throw new Error(`manifest invalid: ${validation.errors.join('; ')}`);
  }

  const installRoot = options.installRoot || INSTALL_ROOT;
  const destDir = path.join(installRoot, `${EXT_PREFIX}${manifest.name}`);

  if (await pathExists(destDir)) {
    if (!options.force) {
      throw new Error(`destination already exists: ${destDir} (pass force=true to overwrite)`);
    }
    await rm(destDir, { recursive: true, force: true });
  }

  await mkdir(installRoot, { recursive: true });
  await cp(srcDir, destDir, { recursive: true });

  // Re-verify after copy — defensive DATA POLICY recheck.
  const reloaded = await loadExtension(destDir);
  if (!reloaded.manifest) {
    await rm(destDir, { recursive: true, force: true });
    throw new Error(`post-copy validation failed: ${reloaded.errors.join('; ')}`);
  }

  return { installed: true, path: destDir, manifest: reloaded.manifest };
}

/**
 * Uninstall an extension by package name.
 *
 * @param {string} pkgName
 * @param {{installRoot?: string}} [options]
 * @returns {Promise<{removed: boolean, path: string}>}
 */
export async function uninstall(pkgName, options = {}) {
  if (typeof pkgName !== 'string' || pkgName.length === 0) {
    throw new Error('pkgName must be a non-empty string');
  }
  const installRoot = options.installRoot || INSTALL_ROOT;
  const target = path.join(installRoot, `${EXT_PREFIX}${pkgName}`);
  const existed = await pathExists(target);
  if (!existed) return { removed: false, path: target };
  await rm(target, { recursive: true, force: true });
  return { removed: true, path: target };
}

/**
 * List installed extensions under the install root. Invalid entries are
 * skipped silently so a single bad directory cannot break the listing.
 *
 * @param {{installRoot?: string}} [options]
 * @returns {Promise<Array<{name: string, version: string, dataPolicy: string, path: string}>>}
 */
export async function listInstalled(options = {}) {
  const installRoot = options.installRoot || INSTALL_ROOT;
  let entries;
  try {
    entries = await readdir(installRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(EXT_PREFIX)) continue;
    const extDir = path.join(installRoot, entry.name);
    const loaded = await loadExtension(extDir);
    if (!loaded.manifest) continue;
    out.push({
      name: loaded.manifest.name,
      version: loaded.manifest.version,
      dataPolicy: loaded.manifest.dataPolicy,
      path: extDir,
    });
  }
  return out;
}

export const _internals = Object.freeze({
  ARTIBOT_GH_PREFIX,
  INSTALL_ROOT,
  EXT_PREFIX,
  fileUrlToLocalPath,
});
