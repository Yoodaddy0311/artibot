/**
 * DATA POLICY runtime egress guard.
 *
 * Enforces Artibot's DATA POLICY at runtime: outbound HTTP requests are
 * blocked unless the destination host is explicitly allowlisted. Loopback
 * hosts (`localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`) are always allowed
 * because a request to them cannot leave the user's machine.
 *
 * `*.local` (mDNS) and `fe80::/10` (IPv6 link-local) are NOT in that set. They
 * name OTHER machines on the LAN, so allowing them by default made the policy
 * depend on how a host was spelled: `http://exfil.local/collect` passed while
 * `http://192.168.1.50/collect` was blocked. Both are blocked now; reach a LAN
 * host by putting it in the allowlist like any other destination.
 *
 * Fail-closed contract:
 *   - Empty allowlist = every non-localhost host is blocked.
 *   - Unknown protocols (file://, data://, javascript:) = blocked.
 *   - Malformed URLs = throw EgressBlockedError (never silently pass).
 *
 * Allowlist sources (merged + deduped, case-insensitive):
 *   1. `lib/core/allowlist.json` → `{ "domains": ["api.github.com"] }`
 *   2. Environment variable `ARTIBOT_ALLOW_EGRESS=host1,host2,host3`
 *
 * Hostname match is EXACT only — `api.github.com` in the allowlist does
 * NOT grant access to `github.com` or `evil.api.github.com`. This is
 * intentional: wildcard matching has historically been the source of
 * SSRF-style policy bypasses.
 *
 * Layer 1 (core) module: pure policy guard with zero non-builtin imports. Lives in core so lower-layer modules (e.g. version-checker) can enforce egress without an upward L1->L2 dependency.
 *
 * @module lib/core/data-egress-guard
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

/** Exact IPv4 loopback (127.0.0.0/8) — all four octets in 0-255 range. */
const IPV4_LOOPBACK_RE = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Check whether a hostname refers to the LOCAL MACHINE — i.e. a request to it
 * cannot leave this host. This is the only question the egress policy cares
 * about; "is it nearby" is not the same question.
 *
 * Returns true ONLY for exact matches against:
 *   - `localhost`
 *   - `127.0.0.0/8` (IPv4 loopback, all four octets validated 0-255)
 *   - `::1` (IPv6 loopback, with or without brackets)
 *   - `0.0.0.0` — the unspecified address; as a CONNECT target the supported
 *     platforms route it to loopback, so it cannot reach another machine.
 *
 * Deliberately NOT included:
 *   - `*.local` (mDNS) — resolves to another machine on the LAN. Treating it as
 *     local let `http://exfil.local/collect` through while the same box's
 *     `http://192.168.1.50/collect` was blocked, so the policy could be
 *     defeated by spelling the destination differently. The webhook in
 *     `scripts/hooks/http-notify.js` posts session payloads to an operator-set
 *     URL, which made that reachable in practice.
 *   - `fe80::/10` (IPv6 link-local) — another machine on the link, same
 *     reasoning. It used to be accepted here and then blocked anyway by the
 *     bracketed-URL form; that accident is now the deliberate answer.
 *
 * Reach either kind by allowlisting it explicitly, like any other host.
 *
 * `lib/runtime/dashboard/server.mjs#LOOPBACK_HOSTS` draws the line in the same
 * place but is STRICTLY NARROWER — measured 2026-08-30 it is exactly
 * `new Set(['127.0.0.1', '::1', 'localhost'])`, with no `[::1]`, no `0.0.0.0`,
 * and no 127.0.0.0/8 beyond the one literal. It is an inbound bind check, not
 * an outbound egress policy, so it has no reason to accept the extra forms.
 * Do not read the two as one definition.
 *
 * Hardened against DNS-rebinding-style impostors such as `127.evil.com`,
 * `localhost.evil.com`, and `foo.local.evil.com` — all return false.
 *
 * @param {string} hostname - Hostname extracted from a URL
 * @returns {boolean}
 */
export function isLocalhost(hostname) {
  if (typeof hostname !== 'string' || hostname.length === 0) return false;
  const lower = hostname.toLowerCase();
  if (LOCALHOST_NAMES.has(lower)) return true;
  // IPv4 loopback — every octet must be a valid 0-255 number.
  const v4 = IPV4_LOOPBACK_RE.exec(lower);
  if (v4) {
    return [v4[1], v4[2], v4[3]].every((o) => {
      const n = Number(o);
      return Number.isInteger(n) && n >= 0 && n <= 255;
    });
  }
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

  // v4.8.0 audit L-1: reject URLs carrying embedded `user[:pass]@` credentials.
  // Even when the host is allowlisted, embedded creds leak through proxy and
  // server access logs. WHATWG URL exposes them on .username / .password and
  // any non-empty value indicates userinfo was present in the input.
  if (parsed.username !== '' || parsed.password !== '') {
    throw new EgressBlockedError(
      `egress blocked${reason}: URL must not contain embedded credentials`,
    );
  }

  const hostname = parsed.hostname.toLowerCase();

  if (isLocalhost(hostname)) return true;

  const allowlist = normalizeAllowlist(options.allowlist);
  if (allowlist.has(hostname)) return true;

  throw new EgressBlockedError(
    `egress blocked${reason}: host '${hostname}' not in allowlist (DATA POLICY). ` +
      `Set ARTIBOT_ALLOW_EGRESS or edit lib/core/allowlist.json to permit.`,
  );
}

/** Maximum redirect hops followed before giving up (fail-closed). */
const MAX_REDIRECT_HOPS = 5;

/** HTTP statuses that carry a `Location` the client is expected to follow. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Convenience wrapper: assert egress, then `fetch` — **re-asserting every
 * redirect hop**.
 *
 * Use this anywhere production code would normally call `fetch` directly.
 * Throws `EgressBlockedError` before any network I/O when the URL is denied.
 *
 * Redirects are followed MANUALLY (`redirect: 'manual'`), which is the whole
 * point of this wrapper. `fetch` defaults to `redirect: 'follow'`, so checking
 * only the first URL meant an allowlisted host answering `302` could send the
 * request — headers and bearer tokens included — anywhere it liked, which is
 * exactly the SSRF-style bypass this module claims to prevent. A caller-supplied
 * `init.redirect` is overridden on purpose: egress policy is not the caller's
 * to opt out of.
 *
 * Per-hop behaviour:
 *   - `Location` is resolved against the CURRENT url, so relative targets and
 *     protocol-relative `//host/path` (which changes host) are both normalized
 *     before being checked.
 *   - Each resolved hop goes through {@link assertEgressAllowed} BEFORE any
 *     request is made to it.
 *   - `303`, and `301`/`302` on a POST, become GET with no body — the same
 *     rewrite the fetch spec performs. `307`/`308` keep method and body.
 *   - A 30x with no `Location` is returned as-is; there is nothing to follow.
 *   - Exceeding {@link MAX_REDIRECT_HOPS} throws rather than returning the last
 *     response, so a redirect loop cannot be mistaken for a real answer.
 *
 * Known limit: within the allowlist, a hop from host A to host B still carries
 * the caller's headers to B. Every hop being allowlisted is a weaker statement
 * than every hop being entitled to the caller's credentials; stripping them
 * cross-origin is a separate decision and is not made here.
 *
 * @param {string} url - Target URL
 * @param {RequestInit} [init] - Standard fetch init (`redirect` is ignored)
 * @param {object} [guardOptions]
 * @param {Iterable<string>} [guardOptions.allowlist] - Optional pre-loaded allowlist
 * @param {string} [guardOptions.reason] - Context tag for log messages
 * @returns {Promise<Response>}
 */
export async function safeFetch(url, init, guardOptions = {}) {
  const allowlist = guardOptions.allowlist ?? loadAllowlist();
  const reason = guardOptions.reason;

  let currentUrl = url;
  let currentInit = { ...(init || {}), redirect: 'manual' };

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    assertEgressAllowed(currentUrl, { allowlist, reason });
    const response = await fetch(currentUrl, currentInit);

    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers?.get?.('location');
    if (!location) return response;

    let nextUrl;
    try {
      nextUrl = new URL(location, currentUrl).toString();
    } catch {
      throw new EgressBlockedError(
        `egress blocked${reason ? ` [${reason}]` : ''}: redirect to unparseable Location '${location}'`,
      );
    }

    const method = (currentInit.method || 'GET').toUpperCase();
    const downgradeToGet = response.status === 303
      || ((response.status === 301 || response.status === 302) && method === 'POST');
    if (downgradeToGet) {
      const { body, ...rest } = currentInit;
      void body;
      currentInit = { ...rest, method: 'GET' };
    }
    currentUrl = nextUrl;
  }

  throw new EgressBlockedError(
    `egress blocked${reason ? ` [${reason}]` : ''}: more than ${MAX_REDIRECT_HOPS} redirects from '${url}'`,
  );
}
