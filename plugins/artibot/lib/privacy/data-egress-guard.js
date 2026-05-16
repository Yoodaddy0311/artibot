/**
 * DATA POLICY runtime egress guard.
 *
 * Enforces Artibot's DATA POLICY at runtime: outbound HTTP requests are
 * blocked unless the destination host is explicitly allowlisted. Localhost
 * variants (`localhost`, `127.0.0.1`, `::1`, `*.local`) are always allowed
 * because they cannot exfiltrate data outside the user's machine.
 *
 * Fail-closed contract:
 *   - Empty allowlist = every non-localhost host is blocked.
 *   - Unknown protocols (file://, data://, javascript:) = blocked.
 *   - Malformed URLs = throw EgressBlockedError (never silently pass).
 *
 * Allowlist sources (merged + deduped, case-insensitive):
 *   1. `lib/privacy/allowlist.json` → `{ "domains": ["api.github.com"] }`
 *   2. Environment variable `ARTIBOT_ALLOW_EGRESS=host1,host2,host3`
 *
 * Hostname match is EXACT only — `api.github.com` in the allowlist does
 * NOT grant access to `github.com` or `evil.api.github.com`. This is
 * intentional: wildcard matching has historically been the source of
 * SSRF-style policy bypasses.
 *
 * @module lib/privacy/data-egress-guard
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Thrown when an outbound HTTP request is blocked by the egress guard.
 * Callers should catch this explicitly and degrade gracefully — hooks must
 * never propagate it up as an unhandled rejection.
 */
export class EgressBlockedError extends Error {
  /**
   * @param {string} message - Human-readable reason for the block
   */
  constructor(message) {
    super(message);
    this.name = 'EgressBlockedError';
  }
}

// ---------------------------------------------------------------------------
// Localhost detection
// ---------------------------------------------------------------------------

/**
 * Bracketed IPv6 localhost forms emitted by `new URL().hostname`.
 * Node strips brackets for canonical IPv6 hosts, but defensive matching
 * keeps the guard resilient if a caller passes the bracketed string.
 */
const LOCALHOST_NAMES = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  '0.0.0.0',
]);

/**
 * Check whether a hostname refers to the local machine.
 *
 * Returns true for:
 *   - `localhost`
 *   - `127.0.0.1` and any other `127.x.x.x` loopback
 *   - `::1` (IPv6 loopback, with or without brackets)
 *   - `*.local` (mDNS / Bonjour, e.g. `mymachine.local`)
 *
 * @param {string} hostname - Hostname extracted from a URL
 * @returns {boolean}
 */
export function isLocalhost(hostname) {
  if (typeof hostname !== 'string' || hostname.length === 0) return false;
  const lower = hostname.toLowerCase();
  if (LOCALHOST_NAMES.has(lower)) return true;
  if (lower.startsWith('127.')) return true;
  if (lower.endsWith('.local')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Allowlist loading
// ---------------------------------------------------------------------------

/** Resolve the bundled `allowlist.json` next to this module. */
function resolveAllowlistPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, 'allowlist.json');
}

/**
 * Parse a comma-separated list of hostnames from the env var.
 * Empty / whitespace-only entries are dropped, case is normalized to lower.
 *
 * @param {string|undefined} raw
 * @returns {string[]}
 */
function parseEnvAllowlist(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * Read the static allowlist from disk. Returns an empty array if the file
 * is missing or unparseable — fail-closed means a broken file just blocks
 * everything (except localhost), never accidentally opens egress.
 *
 * @returns {string[]}
 */
function readStaticAllowlist() {
  try {
    const raw = readFileSync(resolveAllowlistPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.domains)) return [];
    return parsed.domains
      .filter((d) => typeof d === 'string' && d.trim().length > 0)
      .map((d) => d.trim().toLowerCase());
  } catch {
    return [];
  }
}

/**
 * Load the combined egress allowlist from disk + environment.
 *
 * Result is a `Set<string>` of lowercase hostnames, deduplicated across
 * sources. Callers can pass a pre-built set into `assertEgressAllowed` to
 * skip re-reading disk on every check.
 *
 * @returns {Set<string>}
 */
export function loadAllowlist() {
  const fromDisk = readStaticAllowlist();
  const fromEnv = parseEnvAllowlist(process.env.ARTIBOT_ALLOW_EGRESS);
  return new Set([...fromDisk, ...fromEnv]);
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

/**
 * Coerce the allowlist option into a lowercase Set for O(1) lookups.
 *
 * @param {Iterable<string>|undefined|null} allowlist
 * @returns {Set<string>}
 */
function normalizeAllowlist(allowlist) {
  if (allowlist instanceof Set) {
    // Defensive copy + lowercase to avoid mutating the caller's Set
    return new Set([...allowlist].map((s) => String(s).toLowerCase()));
  }
  if (Array.isArray(allowlist)) {
    return new Set(allowlist.map((s) => String(s).toLowerCase()));
  }
  return loadAllowlist();
}

/**
 * Assert that a URL is allowed for outbound HTTP egress.
 *
 * Pass criteria (any one):
 *   - URL parses as `http:` or `https:` AND hostname `isLocalhost(...)`.
 *   - URL parses as `http:` or `https:` AND hostname is in the allowlist.
 *
 * Anything else throws `EgressBlockedError`.
 *
 * @param {string} url - Full URL string (e.g. `https://api.github.com/repos/...`)
 * @param {object} [options]
 * @param {Iterable<string>} [options.allowlist] - Pre-loaded allowlist; defaults to `loadAllowlist()`
 * @param {string} [options.reason] - Context tag for log messages (e.g. `'update-check'`)
 * @returns {true} when the URL is allowed
 * @throws {EgressBlockedError} when the URL is blocked
 */
export function assertEgressAllowed(url, options = {}) {
  const reason = options.reason ? ` [${options.reason}]` : '';

  if (typeof url !== 'string' || url.length === 0) {
    throw new EgressBlockedError(
      `egress blocked${reason}: URL must be a non-empty string`,
    );
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new EgressBlockedError(`egress blocked${reason}: invalid URL '${url}'`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EgressBlockedError(
      `egress blocked${reason}: protocol '${parsed.protocol}' not allowed (http/https only)`,
    );
  }

  const hostname = parsed.hostname.toLowerCase();

  if (isLocalhost(hostname)) return true;

  const allowlist = normalizeAllowlist(options.allowlist);
  if (allowlist.has(hostname)) return true;

  throw new EgressBlockedError(
    `egress blocked${reason}: host '${hostname}' not in allowlist (DATA POLICY). ` +
      `Set ARTIBOT_ALLOW_EGRESS or edit lib/privacy/allowlist.json to permit.`,
  );
}

/**
 * Convenience wrapper: assert egress, then `fetch`.
 *
 * Use this anywhere production code would normally call `fetch` directly.
 * Throws `EgressBlockedError` before any network I/O when the URL is denied.
 *
 * @param {string} url - Target URL
 * @param {RequestInit} [init] - Standard fetch init
 * @param {object} [guardOptions]
 * @param {Iterable<string>} [guardOptions.allowlist] - Optional pre-loaded allowlist
 * @param {string} [guardOptions.reason] - Context tag for log messages
 * @returns {Promise<Response>}
 */
export async function safeFetch(url, init, guardOptions = {}) {
  assertEgressAllowed(url, {
    allowlist: guardOptions.allowlist ?? loadAllowlist(),
    reason: guardOptions.reason,
  });
  return fetch(url, init);
}
