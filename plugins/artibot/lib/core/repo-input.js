/**
 * Repo-input validation for the `/repo` benchmark pipeline.
 *
 * Pure policy layer: this module decides **whether an input is an acceptable
 * clone source and what its cache key is**. It never touches the filesystem,
 * never spawns a process, and never resolves a home directory — every export
 * is a total function of its arguments. The acquisition side effects live one
 * layer up in `lib/git/repo-acquire.js`.
 *
 * Why a module and not prose: the same clone rules were previously stated in
 * three documents (`commands/repo.md` § Security, `skills/repo-benchmarking/
 * SKILL.md` § Clone and Isolation Protocol, `agents/repo-benchmarker.md`
 * § Process) with no executable owner. Prose cannot reject `file://`.
 *
 * The rules encoded here are copied from, not invented beside, those docs:
 *   - HTTPS only; `git@…` (scp form), `ssh://`, `file://`, and relative paths
 *     are rejected.
 *   - Repo names are sanitized against `..`, shell metacharacters and NUL.
 *   - 500MB size ceiling; 7-day cache staleness threshold; `--depth 1`.
 *
 * **Everything is an allowlist.** Host labels and path segments must match a
 * positive character class; anything unlisted is refused. A deny-list of
 * "dangerous characters" fails open the moment a new one appears, which is
 * exactly the failure mode this module exists to close.
 *
 * Layer 1 (core): zero non-builtin imports and no imports from any higher
 * layer, so `lib/git` (L2) can depend on it without inverting the hierarchy.
 *
 * @module lib/core/repo-input
 */

// ---------------------------------------------------------------------------
// Policy constants (single source of truth for the numbers in the /repo docs)
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on a cloned tree, in bytes. 500MB, from
 * `skills/repo-benchmarking/SKILL.md` § *Clone and Isolation Protocol*
 * ("Max repo size: 500MB (abort if exceeded)") and `commands/repo.md`
 * § *Security* rule 4.
 */
export const MAX_REPO_BYTES = 500 * 1024 * 1024;

/**
 * Default clone depth. `--deep` is the only way to get full history
 * (SKILL.md § *Large Repo Handling*).
 */
export const DEFAULT_CLONE_DEPTH = 1;

/**
 * Cache staleness threshold: 7 days (SKILL.md § *Cache Strategy*).
 * Staleness is advisory — it suggests a refresh, it does not force one.
 */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Upper bound on a sanitized cache directory name. Not a security control —
 * a defence against path-length limits on Windows, where the cache root is
 * already ~40 characters deep before the repo name is appended.
 */
export const MAX_CACHE_KEY_LENGTH = 100;

/**
 * Every rejection reason this module can produce. Exported so callers and
 * tests can assert on a stable identifier instead of on message text.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const REPO_INPUT_ERRORS = Object.freeze({
  EMPTY_INPUT: 'EMPTY_INPUT',
  NULL_BYTE: 'NULL_BYTE',
  NOT_ABSOLUTE_URL: 'NOT_ABSOLUTE_URL',
  SCHEME_NOT_HTTPS: 'SCHEME_NOT_HTTPS',
  CREDENTIALS_IN_URL: 'CREDENTIALS_IN_URL',
  QUERY_OR_FRAGMENT: 'QUERY_OR_FRAGMENT',
  HOST_INVALID: 'HOST_INVALID',
  PATH_EMPTY: 'PATH_EMPTY',
  PATH_TRAVERSAL: 'PATH_TRAVERSAL',
  PATH_CHAR_NOT_ALLOWED: 'PATH_CHAR_NOT_ALLOWED',
  NAME_EMPTY: 'NAME_EMPTY',
  SIZE_EXCEEDED: 'SIZE_EXCEEDED',
});

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown for every rejected input. Carries a stable `code` from
 * {@link REPO_INPUT_ERRORS} so callers branch on the code, never the message.
 */
export class RepoInputError extends Error {
  /**
   * @param {string} code - A value from {@link REPO_INPUT_ERRORS}.
   * @param {string} message - Human-readable reason, safe to show a user.
   */
  constructor(code, message) {
    super(message);
    this.name = 'RepoInputError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Character allowlists
// ---------------------------------------------------------------------------

/**
 * One DNS label: alphanumeric, internal hyphens only. Applied per label so a
 * leading/trailing hyphen or an empty label (`a..b`) is rejected.
 */
const HOST_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * The last host label (the TLD) must start with a letter. This is what
 * excludes IPv4 **literals** — `127.0.0.1` and `192.168.1.5` otherwise
 * satisfy {@link HOST_LABEL} label-by-label and would sail through.
 *
 * Scope, precisely: this rejects the numeric *spelling* of an address. It
 * does **not** resolve anything, so a name that resolves to a loopback or
 * private address still passes — `127.0.0.1.nip.io` is a valid hostname by
 * this rule. Closing that would require DNS resolution at validation time,
 * which this module does not do and is not the place for.
 */
const HOST_TLD = /^[a-z][a-z0-9-]*$/;

/**
 * One path segment. Deliberately narrow: git forge paths need only these
 * four classes. Percent-encoding is NOT accepted — refusing `%` outright is
 * simpler than deciding which encodings are safe to decode.
 */
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Everything outside this class is stripped by {@link sanitizeRepoName}. */
const NAME_DISALLOWED = /[^A-Za-z0-9._-]/g;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * @param {string} code
 * @param {string} message
 * @returns {never}
 */
function reject(code, message) {
  throw new RepoInputError(code, message);
}

/**
 * Validate a hostname against the label allowlist.
 *
 * Bracketed IPv6 (`[::1]`) fails on the label class (`[`/`]`/`:` are outside
 * it); IPv4 literals fail on {@link HOST_TLD}, which is the only reason they
 * fail — measured 2026-08-22, `127.0.0.1` passes the per-label check.
 *
 * This is a check on the *shape of the name*, not on where the name points.
 * No DNS lookup happens here, so a hostname that resolves to a loopback or
 * private address is accepted.
 *
 * @param {string} host - Already lowercased hostname.
 * @returns {boolean}
 */
function isAllowedHost(host) {
  if (host.length === 0 || host.length > 253) return false;
  const labels = host.split('.');
  if (labels.length < 2) return false; // a forge host always has a TLD
  if (!HOST_TLD.test(labels[labels.length - 1])) return false;
  return labels.every((label) => label.length <= 63 && HOST_LABEL.test(label));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reduce an arbitrary string to a safe single path component.
 *
 * Strips every character outside the allowlist, then strips leading dots so
 * the result can never be `.`, `..`, or a hidden directory such as `.git`.
 * Callers get a name that is safe to `path.join` onto the cache root.
 *
 * @param {string} name - Raw repository name (`.git` suffix already removed).
 * @returns {string} Sanitized single path component.
 * @throws {RepoInputError} `NAME_EMPTY` when nothing survives sanitization.
 * @example
 * sanitizeRepoName('my repo; rm -rf ~'); // 'myreporm-rf'
 * sanitizeRepoName('../../etc');         // throws NAME_EMPTY
 */
export function sanitizeRepoName(name) {
  if (typeof name !== 'string') {
    reject(REPO_INPUT_ERRORS.NAME_EMPTY, 'Repo name must be a string.');
  }
  const cleaned = name
    .normalize('NFKC')
    .replace(NAME_DISALLOWED, '')
    .replace(/^\.+/, '');
  if (cleaned === '') {
    reject(
      REPO_INPUT_ERRORS.NAME_EMPTY,
      `Repo name "${name}" contains no characters allowed in a cache directory name.`,
    );
  }
  return cleaned.slice(0, MAX_CACHE_KEY_LENGTH);
}

/**
 * Parse and validate a clone source.
 *
 * Rejection is by exception on purpose: the caller in `lib/git/repo-acquire.js`
 * runs this **before** it creates a directory or spawns git, so a thrown error
 * is the guarantee that no side effect happened. A boolean return would let a
 * caller forget to check it.
 *
 * @param {string} input - Candidate clone source, as typed by the user.
 * @returns {Readonly<{
 *   sourceUrl: string, host: string, owner: string|null,
 *   repoName: string, cacheKey: string, pathSegments: readonly string[]
 * }>} Frozen descriptor. `sourceUrl` is normalized (no trailing slash) and is
 *   what should be handed to `git clone`; `cacheKey` is the directory name
 *   under the repos cache root, per SKILL.md § *Cache Strategy*
 *   (`~/.claude/artibot/repos/[repo-name]/`).
 * @throws {RepoInputError} With a {@link REPO_INPUT_ERRORS} code.
 * @example
 * parseRepoInput('https://github.com/google/magika.git').cacheKey; // 'magika'
 * parseRepoInput('git@github.com:google/magika.git'); // throws NOT_ABSOLUTE_URL
 */
export function parseRepoInput(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    reject(REPO_INPUT_ERRORS.EMPTY_INPUT, 'Repo input must be a non-empty string.');
  }
  const raw = input.trim();
  if (raw.includes('\0')) {
    reject(REPO_INPUT_ERRORS.NULL_BYTE, 'Repo input contains a NUL byte.');
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    // Covers the scp form (`git@host:owner/repo`), bare hostnames, and every
    // relative path — none of them carry a parseable scheme.
    reject(
      REPO_INPUT_ERRORS.NOT_ABSOLUTE_URL,
      `"${raw}" is not an absolute URL. Only https:// clone sources are accepted (SSH/scp form and local paths are blocked).`,
    );
  }

  if (url.protocol !== 'https:') {
    reject(
      REPO_INPUT_ERRORS.SCHEME_NOT_HTTPS,
      `Scheme "${url.protocol}" is not allowed. /repo clones over https only.`,
    );
  }
  if (url.username !== '' || url.password !== '') {
    reject(
      REPO_INPUT_ERRORS.CREDENTIALS_IN_URL,
      'Clone URL carries embedded credentials; pass a credential-free https URL.',
    );
  }
  if (url.search !== '' || url.hash !== '') {
    reject(
      REPO_INPUT_ERRORS.QUERY_OR_FRAGMENT,
      'Clone URL must not carry a query string or fragment.',
    );
  }

  const host = url.hostname.toLowerCase();
  if (!isAllowedHost(host)) {
    reject(REPO_INPUT_ERRORS.HOST_INVALID, `Host "${url.hostname}" is not a valid hostname (letter-initial TLD required; IP literals are not accepted).`);
  }

  const segments = url.pathname.split('/').filter((s) => s !== '');
  if (segments.length === 0) {
    reject(REPO_INPUT_ERRORS.PATH_EMPTY, `"${raw}" has no repository path.`);
  }
  for (const segment of segments) {
    // Backstop, and honest about it: measured 2026-08-22 on Node 20/22, the
    // WHATWG URL parser collapses `.` and `..` (and their `%2e` spellings)
    // during construction, so no such segment survives to here — the branch
    // is currently unreachable through this function. It stays because the
    // module's contract is "no traversal component ever leaves parseRepoInput"
    // and that must not depend on a parser detail; the acceptance tests assert
    // the collapsing behaviour directly, so a change in it fails loudly there
    // rather than silently here.
    if (segment === '.' || segment === '..') {
      reject(REPO_INPUT_ERRORS.PATH_TRAVERSAL, `Path segment "${segment}" escapes the repository path.`);
    }
    if (!PATH_SEGMENT.test(segment)) {
      reject(
        REPO_INPUT_ERRORS.PATH_CHAR_NOT_ALLOWED,
        `Path segment "${segment}" contains characters outside the allowed set [A-Za-z0-9._-].`,
      );
    }
  }

  const last = segments[segments.length - 1];
  const bareName = last.toLowerCase().endsWith('.git') ? last.slice(0, -4) : last;
  const cacheKey = sanitizeRepoName(bareName);

  return Object.freeze({
    // `url.origin` keeps a non-default port, which `url.host` would too but
    // `url.hostname` would drop — self-hosted forges stay addressable.
    sourceUrl: `${url.origin}/${segments.join('/')}`,
    host,
    owner: segments.length >= 2 ? segments[segments.length - 2] : null,
    repoName: bareName,
    cacheKey,
    pathSegments: Object.freeze([...segments]),
  });
}

/**
 * Non-throwing wrapper around {@link parseRepoInput}, for batch parsing where
 * one bad URL should not abort the whole `/repo` invocation.
 *
 * @param {string} input
 * @returns {{ok: true, value: ReturnType<typeof parseRepoInput>}
 *          |{ok: false, code: string, reason: string}}
 */
export function tryParseRepoInput(input) {
  try {
    return { ok: true, value: parseRepoInput(input) };
  } catch (err) {
    if (err instanceof RepoInputError) {
      return { ok: false, code: err.code, reason: err.message };
    }
    throw err;
  }
}

/**
 * Enforce the clone size ceiling.
 *
 * @param {number} bytes - Measured size of the cloned tree.
 * @param {number} [maxBytes] - Override, for tests that must reach the cap
 *   with a small fixture (a fixture that cannot reach the failure region
 *   proves nothing).
 * @returns {number} `bytes`, so this can be used inline.
 * @throws {RepoInputError} `SIZE_EXCEEDED`.
 */
export function assertRepoSize(bytes, maxBytes = MAX_REPO_BYTES) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    reject(REPO_INPUT_ERRORS.SIZE_EXCEEDED, `Repo size ${bytes} is not a measurable byte count.`);
  }
  if (bytes > maxBytes) {
    reject(
      REPO_INPUT_ERRORS.SIZE_EXCEEDED,
      `Cloned tree is ${bytes} bytes, over the ${maxBytes}-byte ceiling. Aborting per /repo Security rule 4.`,
    );
  }
  return bytes;
}

/**
 * Cache staleness check (SKILL.md § *Cache Strategy*, 7-day threshold).
 * Advisory: a stale cache is still usable, it just warrants a refresh.
 *
 * @param {number|null|undefined} fetchedAtMs - Epoch ms of the last fetch.
 * @param {number} [nowMs] - Injectable clock.
 * @param {number} [thresholdMs]
 * @returns {boolean} True when unknown or older than the threshold.
 */
export function isStaleCache(fetchedAtMs, nowMs = Date.now(), thresholdMs = STALE_AFTER_MS) {
  if (!Number.isFinite(fetchedAtMs)) return true;
  return nowMs - /** @type {number} */ (fetchedAtMs) > thresholdMs;
}
