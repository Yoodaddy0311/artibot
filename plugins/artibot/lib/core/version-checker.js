/**
 * Auto-update notification checker.
 * Fetches the latest release from GitHub and compares against the installed version.
 * Uses a 24-hour file cache to avoid hitting the API on every session start.
 * All errors are swallowed so a network failure never blocks session startup.
 * @module lib/core/version-checker
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const CACHE_FILE = 'update-check.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const GITHUB_API_URL =
  'https://api.github.com/repos/Artience-co/artibot/releases/latest';
const FETCH_TIMEOUT_MS = 3000;

/**
 * Compare two semver strings (major.minor.patch, no pre-release parsing).
 * Returns true when `latest` is strictly newer than `current`.
 *
 * @param {string} current - Version currently installed, e.g. "1.4.0"
 * @param {string} latest  - Version from the release feed, e.g. "1.5.0"
 * @returns {boolean}
 */
export function isNewerVersion(current, latest) {
  const parse = (v) => {
    const parts = String(v).replace(/^v/, '').split('.').map((n) => {
      const num = parseInt(n, 10);
      return Number.isNaN(num) ? 0 : num;
    });
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  };

  const [cMaj, cMin, cPat] = parse(current);
  const [lMaj, lMin, lPat] = parse(latest);

  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPat > cPat;
}

/**
 * Read and validate the on-disk cache entry.
 * Returns the cached object if it is still fresh, otherwise null.
 *
 * @param {string} cacheFilePath - Absolute path to the cache JSON file
 * @returns {{ hasUpdate: boolean, latestVersion?: string, checkedAt: string } | null}
 */
function readCache(cacheFilePath) {
  if (!existsSync(cacheFilePath)) return null;
  try {
    const raw = readFileSync(cacheFilePath, 'utf-8');
    const cached = JSON.parse(raw);
    if (!cached.checkedAt) return null;
    const checkedAt = new Date(cached.checkedAt).getTime();
    if (Number.isNaN(checkedAt)) return null;
    const age = Date.now() - checkedAt;
    if (age > CACHE_TTL_MS) return null;
    return cached;
  } catch {
    return null;
  }
}

/**
 * Persist a check result to disk, creating the cache directory if needed.
 * Failures are silently ignored to keep the caller non-blocking.
 *
 * @param {string} cacheFilePath - Absolute path to write
 * @param {object} result        - The result object to store
 */
function writeCache(cacheFilePath, result) {
  try {
    mkdirSync(path.dirname(cacheFilePath), { recursive: true });
    writeFileSync(
      cacheFilePath,
      JSON.stringify({ ...result, checkedAt: new Date().toISOString() }, null, 2),
      'utf-8'
    );
  } catch {
    // Silently ignore write failures (read-only FS, permissions, etc.)
  }
}

/**
 * Check whether a newer release of Artibot is available on GitHub.
 *
 * Algorithm:
 *  1. Look for a fresh on-disk cache entry (< 24 h old).
 *  2. If the cache is stale or absent, query the GitHub Releases API with a
 *     3-second timeout.
 *  3. Persist the result back to disk for the next session.
 *  4. On any error (network, JSON parse, FS), return { hasUpdate: false } so
 *     the caller is never blocked.
 *
 * @param {string} currentVersion - Semver string of the installed plugin version
 * @param {string} cacheDir       - Directory used for the update-check cache file
 * @returns {Promise<{ hasUpdate: boolean, latestVersion?: string, currentVersion?: string }>}
 */
export async function checkForUpdate(currentVersion, cacheDir) {
  const cacheFilePath = path.join(cacheDir, CACHE_FILE);

  // 1. Try reading a valid cache entry first
  const cached = readCache(cacheFilePath);
  if (cached !== null) {
    return cached;
  }

  // 2. Fetch the latest release from GitHub
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(GITHUB_API_URL, {
        signal: controller.signal,
        headers: { 'User-Agent': `artibot/${currentVersion}` },
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      // Non-2xx from GitHub (e.g. rate-limit 403, repo 404) — skip silently
      return { hasUpdate: false };
    }

    const data = await response.json();
    // GitHub returns tag_name like "v1.5.0" or "1.5.0"
    const latestVersion = String(data.tag_name || '').replace(/^v/, '');

    if (!latestVersion) {
      return { hasUpdate: false };
    }

    const hasUpdate = isNewerVersion(currentVersion, latestVersion);
    const result = { hasUpdate, latestVersion, currentVersion };

    // 3. Persist for the next 24 hours
    writeCache(cacheFilePath, result);

    return result;
  } catch {
    // Network error, AbortError (timeout), JSON parse failure — all silently ignored
    return { hasUpdate: false };
  }
}
