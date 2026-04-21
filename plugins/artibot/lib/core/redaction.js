/**
 * Redaction utilities — centralized sensitive-token masking.
 *
 * Three modules originally ship their own near-duplicate redaction logic:
 *   - lib/core/decision-trail.js       (generic style: ***REDACTED***, {email})
 *   - lib/learning/macro-learner.js    (tagged style: [redacted:key], [redacted:path])
 *   - lib/learning/wakeup-scheduler.js (generic style, same as decision-trail)
 *
 * This module owns the canonical regex patterns and pure helpers. Callers
 * select the pattern style they need via options; existing output strings
 * are preserved exactly so downstream tests and persisted files are
 * backwards compatible.
 *
 * Design constraints:
 *   - Zero runtime deps
 *   - ESM only
 *   - Pure functions (no I/O, no mutation of inputs)
 *   - Prototype-pollution safe (rejects __proto__ / constructor / prototype)
 *
 * @module lib/core/redaction
 */

// ---------------------------------------------------------------------------
// Pattern catalogues
// ---------------------------------------------------------------------------

/**
 * Generic patterns — matches the legacy decision-trail.js / wakeup-scheduler.js
 * output format. Each entry is [RegExp, replacement].
 *
 * Replacement sentinels (stable public strings — DO NOT change):
 *   - `***REDACTED***` — api keys, tokens, secrets, passwords, bearer
 *   - `$1Users\{user}` — windows user home (preserves drive letter)
 *   - `/{home}/{user}` — posix user home
 *   - `{email}`        — email addresses
 *
 * @type {ReadonlyArray<readonly [RegExp, string]>}
 */
export const GENERIC_PATTERNS = Object.freeze([
  [/(?:api[_-]?key|token|secret|password|bearer)[\s=:]+[^\s"']+/gi, '***REDACTED***'],
  [/([A-Za-z]:[\\/])(?:Users|users)[\\/][^\\/"'\s]+/g, '$1Users\\{user}'],
  [/\/(?:home|Users)\/[^/\s"']+/g, '/{home}/{user}'],
  [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '{email}'],
]);

/**
 * Tagged patterns — matches the legacy macro-learner.js output format.
 * Uses narrower key prefixes (sk-, AIza, ghp_, AKIA, …) so generic English
 * prose ("my secret token is 42") is not over-redacted.
 *
 * @type {ReadonlyArray<{re: RegExp, tag: string}>}
 */
export const TAGGED_PATTERNS = Object.freeze([
  { re: /\b(sk|AIza|ghp|gho|ghu|AKIA)[A-Za-z0-9_-]{12,}\b/g, tag: '[redacted:key]' },
  { re: /Bearer\s+[A-Za-z0-9._-]{16,}/gi, tag: '[redacted:bearer]' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, tag: '[redacted:jwt]' },
  { re: /\b[A-Z]:[\\/][^\s"'`]{2,}/g, tag: '[redacted:path]' },
  { re: /\/(Users|home)\/[^\s"'`/]+\/[^\s"'`]*/g, tag: '[redacted:path]' },
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, tag: '[redacted:email]' },
]);

/**
 * The default pattern set used by redactString / redactObject when no
 * explicit `patterns` option is supplied. Aliases GENERIC_PATTERNS.
 */
export const DEFAULT_PATTERNS = GENERIC_PATTERNS;

// Keys that must never appear in a sanitized object — prototype pollution guard.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ---------------------------------------------------------------------------
// Internal normalizers
// ---------------------------------------------------------------------------

/**
 * Normalize a pattern collection into a uniform [RegExp, string] list.
 * Accepts:
 *   - Array of [RegExp, string]    (generic style)
 *   - Array of {re, tag}           (tagged style)
 *   - Array of RegExp              (uses `replacement` option as fallback)
 *
 * @param {unknown} patterns
 * @param {string} replacement - fallback when a bare RegExp is provided
 * @returns {Array<[RegExp, string]>}
 */
function normalizePatterns(patterns, replacement) {
  if (!Array.isArray(patterns)) return [];
  const out = [];
  for (const entry of patterns) {
    if (entry instanceof RegExp) {
      out.push([entry, replacement]);
    } else if (Array.isArray(entry) && entry[0] instanceof RegExp) {
      out.push([entry[0], typeof entry[1] === 'string' ? entry[1] : replacement]);
    } else if (entry && typeof entry === 'object' && entry.re instanceof RegExp) {
      out.push([entry.re, typeof entry.tag === 'string' ? entry.tag : replacement]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Redact sensitive tokens from a string. Pure — does not mutate input.
 * Non-string inputs return an empty string (matches prior macro-learner
 * behavior) unless the input is null/undefined, in which case the original
 * value is returned (matches prior wakeup-scheduler behavior via String()).
 *
 * @param {string} input
 * @param {object} [options]
 * @param {ReadonlyArray<[RegExp, string]|{re: RegExp, tag: string}|RegExp>} [options.patterns]
 *   Override pattern set. Defaults to {@link DEFAULT_PATTERNS}.
 * @param {string} [options.replacement] - Fallback tag for bare-RegExp entries.
 * @returns {string}
 */
export function redactString(input, options = {}) {
  if (typeof input !== 'string' || input.length === 0) return '';
  const replacement = typeof options.replacement === 'string'
    ? options.replacement
    : '***REDACTED***';
  const patterns = normalizePatterns(
    options.patterns ?? DEFAULT_PATTERNS,
    replacement,
  );
  let out = input;
  for (const [re, repl] of patterns) {
    out = out.replace(re, repl);
  }
  return out;
}

/**
 * Recursively redact all string fields inside a plain value. Returns a new
 * structure — never mutates `value`. Drops prototype-pollution keys.
 * Functions / symbols / undefined are dropped (not serializable).
 *
 * @param {unknown} value
 * @param {object} [options] - same shape as {@link redactString}
 * @returns {unknown}
 */
export function redactObject(value, options = {}) {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string') return redactString(value, options);
  if (t === 'number' || t === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => redactObject(v, options));
  if (t === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      if (UNSAFE_KEYS.has(key)) continue;
      out[key] = redactObject(value[key], options);
    }
    return out;
  }
  return undefined;
}
