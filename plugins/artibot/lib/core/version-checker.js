/**
 * Auto-update notification checker.
 * Fetches the latest release from GitHub and compares against the installed version.
 * Uses a 24-hour file cache to avoid hitting the API on every session start.
 * All errors are swallowed so a network failure never blocks session startup.
 * Opt-out is two-tier — env `ARTIBOT_UPDATE_CHECK` beats `artibot.config.json`
 * `updateCheck.enabled`, and the check is ON by default; when it resolves to
 * off, `checkForUpdate` performs no cache I/O and no network egress at all.
 * @module lib/core/version-checker
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { safeFetch } from './data-egress-guard.js';

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

const UPDATE_CHECK_ENV_VAR = 'ARTIBOT_UPDATE_CHECK';
// Allowlists, deliberately not denylists: an unrecognised value falls through
// to config instead of being read as an opt-out. A denylist here would
// fail-open the moment someone typed `ARTIBOT_UPDATE_CHECK=disabled`.
const ENV_DISABLE_VALUES = new Set(['0', 'false', 'off', 'no']);
const ENV_ENABLE_VALUES = new Set(['1', 'true', 'on', 'yes']);

/**
 * Resolve whether the session-start update check may run.
 *
 * Precedence: env > config > default ON. Pure — reads no files and touches no
 * network, so callers can resolve the policy before paying for any I/O.
 *
 * @param {{ env?: NodeJS.ProcessEnv, config?: object }} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]    - Environment to read; defaults to process.env
 * @param {object} [opts.config]            - Parsed artibot.config.json (any shape; never throws)
 * @returns {{ enabled: boolean, source: 'env'|'config'|'default', reason: string }}
 */
export function resolveUpdateCheckPolicy({ env = process.env, config = {} } = {}) {
  const raw = env?.[UPDATE_CHECK_ENV_VAR];
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    // `reason` echoes the RAW value, not the normalised one, so an operator
    // debugging a stray space or odd casing sees what they actually set.
    if (ENV_DISABLE_VALUES.has(normalized)) {
      return { enabled: false, source: 'env', reason: `${UPDATE_CHECK_ENV_VAR}=${raw}` };
    }
    if (ENV_ENABLE_VALUES.has(normalized)) {
      return { enabled: true, source: 'env', reason: `${UPDATE_CHECK_ENV_VAR}=${raw}` };
    }
  }

  // config may be null, a string, a number — anything a malformed JSON file
  // can produce. Narrow before touching a property rather than try/catch.
  const updateCheck =
    config !== null && typeof config === 'object' ? config.updateCheck : null;
  if (
    updateCheck !== null &&
    typeof updateCheck === 'object' &&
    updateCheck.enabled === false
  ) {
    return {
      enabled: false,
      source: 'config',
      reason: 'artibot.config.json updateCheck.enabled=false',
    };
  }

  return { enabled: true, source: 'default', reason: 'default' };
}

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
    // DATA POLICY: safeFetch asserts the destination is allowlisted BEFORE any
    // network I/O and re-asserts every redirect hop; a non-allowlisted host
    // throws EgressBlockedError, which the catch below turns into `null`.
    //
    // The standalone `assertEgressAllowed(url, …)` that used to sit here was
    // removed rather than kept: it checked the same thing with the same reason
    // tag, and both outcomes were swallowed identically by that catch, so it
    // produced no observable behaviour of its own. (Contrast http-notify, which
    // keeps its pre-check because that one emits a distinct operator message.)
    // This is audit F-02 from .artibot/REPORTS/audit-core-config-security-2026-06-08.md.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response;
    try {
      response = await safeFetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': `artibot/${currentVersion}` },
      }, { reason: 'version-check' });
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
 *  0. Resolve the opt-out policy. If the check is disabled, return immediately
 *     without reading the cache, writing the cache, or opening a socket.
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
 * @param {{ env?: NodeJS.ProcessEnv, config?: object }} [opts] - Opt-out policy inputs;
 *   omitted means "read process.env", which keeps the legacy 2-argument call unchanged
 * @returns {Promise<{ hasUpdate: boolean, latestVersion?: string, currentVersion?: string,
 *   disabled?: boolean, source?: string, reason?: string }>}
 */
export async function checkForUpdate(currentVersion, cacheDir, opts = {}) {
  // 0. Opt-out gate, ahead of every side effect. Placed before the cache read
  //    on purpose: a user who opted out must stop seeing the banner at once,
  //    not up to 24 hours later when a stale "update available" entry expires.
  const policy = resolveUpdateCheckPolicy(opts);
  if (!policy.enabled) {
    return {
      hasUpdate: false,
      disabled: true,
      source: policy.source,
      reason: policy.reason,
    };
  }

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
