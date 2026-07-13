/**
 * Auto-update notification checker.
 * Fetches the latest release from GitHub and compares against the installed version.
 * Uses a 24-hour file cache to avoid hitting the API on every session start.
 * All errors are swallowed so a network failure never blocks session startup.
 * @module lib/core/version-checker
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertEgressAllowed } from './data-egress-guard.js';

const CACHE_FILE = 'update-check.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const GITHUB_API_URL =
  'https://api.github.com/repos/Yoodaddy0311/artibot/releases/latest';
// Primary version source: master's plugin.json — the exact content
// `claude plugin update` installs. The Releases API is only a fallback:
// publishing stopped after v4.30.0 while master moved on, so the release
// feed alone under-reports the latest version (2026-07-13 incident).
// URL is duplicated in scripts/update-marketplace.js on purpose — lib/core
// must not import from scripts/ (layer rule).
const MASTER_PLUGIN_JSON_URL =
  'https://raw.githubusercontent.com/Yoodaddy0311/artibot/master/plugins/artibot/.claude-plugin/plugin.json';
// Shorter timeout than update.js (5s) because this runs at session start and must not block.
// update.js uses 5s because the user explicitly requested a version check.
const FETCH_TIMEOUT_MS = 3000;

/**
 * Compare two semver strings (major.minor.patch only).
 * Pre-release suffixes (e.g. "-beta.1", "-rc.2") are stripped before comparison.
 * This means "1.5.0-beta.1" is treated as equivalent to "1.5.0".
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
 * Fetch a version string from one JSON endpoint, or null on any failure.
 * Shared by the master-manifest primary and Releases-API fallback paths.
 *
 * @param {string} url          - Allowlisted JSON endpoint
 * @param {string} currentVersion - Used only for the User-Agent header
 * @param {function(object): string|undefined} pick - Extract the raw version field
 * @returns {Promise<string|null>} bare semver (no 'v' prefix) or null
 */
async function fetchVersionFrom(url, currentVersion, pick) {
  try {
    // DATA POLICY: assertEgressAllowed enforces that only allowlisted GitHub
    // hosts can be reached; any other host throws EgressBlockedError.
    assertEgressAllowed(url, { reason: 'version-check' });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': `artibot/${currentVersion}` },
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      // Non-2xx (e.g. rate-limit 403, repo 404) — let the caller fall back
      return null;
    }

    const data = await response.json();
    const version = String(pick(data) || '').replace(/^v/, '');
    return version || null;
  } catch {
    return null;
  }
}

/**
 * Check whether a newer release of Artibot is available on GitHub.
 *
 * Algorithm:
 *  1. Look for a fresh on-disk cache entry (< 24 h old).
 *  2. If the cache is stale or absent, read master's plugin.json version
 *     (primary), falling back to the GitHub Releases API — each with a
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
    // Invalidate cache if installed version changed since last check (e.g., manual upgrade)
    if (cached.currentVersion && cached.currentVersion !== currentVersion) {
      // Version changed — cache is stale, re-check
    } else {
      return cached;
    }
  }

  // 2. Fetch the latest version — master plugin.json primary, Releases API fallback
  try {
    const latestVersion =
      (await fetchVersionFrom(MASTER_PLUGIN_JSON_URL, currentVersion, (d) => d.version)) ||
      (await fetchVersionFrom(GITHUB_API_URL, currentVersion, (d) => d.tag_name));

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
