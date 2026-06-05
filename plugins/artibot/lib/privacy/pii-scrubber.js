/**
 * PII (Personally Identifiable Information) scrubber for federated learning.
 * Masks sensitive data in text before transmission to aggregation servers.
 * Uses regex-based pattern matching with configurable categories.
 *
 * Detection patterns are defined in pii-detector.js.
 *
 * Zero dependencies. ESM only.
 * @module lib/privacy/pii-scrubber
 */

import { getPlatform } from '../core/platform.js';
import {
  BUILTIN_PATTERNS,
  hintMatches,
  VALIDATION_CHECKS,
} from './pii-detector.js';
import { checkMixedScript, normalizeHomoglyphs } from './homoglyph-detector.js';

// ---------------------------------------------------------------------------
// Platform-Aware Path Detection
// ---------------------------------------------------------------------------

const { isWindows } = getPlatform();

/**
 * Build home directory patterns for the current platform.
 * @returns {RegExp[]}
 * @example
 * const patterns = buildHomePathPatterns();
 * // On Windows: patterns match C:\Users\<username>\...
 * // On Unix: patterns match /home/<username>/...
 */
export function buildHomePathPatterns() {
  const patterns = [];

  if (isWindows) {
    // C:\Users\<username>\... -> {USER_HOME}\...
    patterns.push(/[A-Z]:\\Users\\[^\\:*?"<>|\s]+/gi);
    // C:\Documents and Settings\<username>\...
    patterns.push(/[A-Z]:\\Documents and Settings\\[^\\:*?"<>|\s]+/gi);
  } else {
    // /home/<username>/... -> {USER_HOME}/...
    patterns.push(/\/home\/[a-zA-Z0-9._-]+/g);
    // /Users/<username>/... (macOS)
    patterns.push(/\/Users\/[a-zA-Z0-9._-]+/g);
  }

  // $HOME, %USERPROFILE%, %HOMEPATH%
  patterns.push(/\$HOME/g);
  patterns.push(/%USERPROFILE%/gi);
  patterns.push(/%HOMEPATH%/gi);

  return patterns;
}

// ---------------------------------------------------------------------------
// Scrubber State
// ---------------------------------------------------------------------------

/** @type {import('./pii-detector.js').ScrubPattern[]} */
let activePatterns = [...BUILTIN_PATTERNS];

/** Patterns pre-sorted by priority for scrub(). Rebuilt when activePatterns changes. */
let sortedPatterns = [...activePatterns].sort((a, b) => a.priority - b.priority);

/** Rebuild the cached sorted array after any mutation to activePatterns. */
function rebuildSortedPatterns() {
  sortedPatterns = [...activePatterns].sort((a, b) => a.priority - b.priority);
}

/** @type {{ totalScrubs: number, byCategory: Record<string, number>, byPattern: Record<string, number>, homoglyphNormalized: number }} */
let stats = createEmptyStats();

/**
 * Create empty statistics object.
 *
 * `homoglyphNormalized` counts mixed-script normalization passes separately
 * from `byCategory` so PII-category consumers are never polluted by a
 * "normalization fired" signal (WIRE-16).
 *
 * @returns {{ totalScrubs: number, byCategory: Record<string, number>, byPattern: Record<string, number>, homoglyphNormalized: number }}
 */
function createEmptyStats() {
  return { totalScrubs: 0, byCategory: {}, byPattern: {}, homoglyphNormalized: 0 };
}

// ---------------------------------------------------------------------------
// Core Scrubbing Functions
// ---------------------------------------------------------------------------

/**
 * Scrub all PII from a text string.
 * Applies patterns in priority order (lowest number first).
 * Uses indexOf/includes pre-tests to skip expensive regex when possible.
 *
 * @param {string} text - Input text to scrub
 * @returns {string} Scrubbed text with PII replaced by tokens
 * @example
 * const cleaned = scrub('Contact: user@example.com');
 * // cleaned: 'Contact: [EMAIL]'
 *
 * const safe = scrub('Server at 192.168.1.100:3000');
 * // safe: 'Server at [IP]:PORT'
 */
export function scrub(text) {
  if (!text || typeof text !== 'string') return text ?? '';

  // WIRE-16: defeat homoglyph / mixed-script spoofing before regex matching.
  // checkMixedScript().mixed is true only when Latin AND a known Cyrillic/Greek
  // lookalike co-occur, so disguised PII (e.g. 'usеr@evil.com' with Cyrillic е)
  // is normalized to Latin and then caught by the pattern pass below. Pure-Latin
  // or pure-non-Latin text (legit Korean/Russian/CJK) is left untouched, so
  // non-spoofing multilingual data is never corrupted. Counted on a dedicated
  // stat (not byCategory) so PII-category consumers stay clean.
  // scrub() is the egress chokepoint: scrubPattern (line 144) and scrubPatterns
  // (line 176) both recurse here for every string value.
  if (checkMixedScript(text).mixed) {
    text = normalizeHomoglyphs(text);
    stats.homoglyphNormalized += 1;
  }

  let result = text;
  let lower = text.toLowerCase();

  for (const pat of sortedPatterns) {
    // Fast path: skip regex if hint substring is not present
    if (!hintMatches(pat.hint, result, lower, pat.regex.ignoreCase)) continue;

    // Reset regex lastIndex for global patterns
    if (pat.regex.global) {
      pat.regex.lastIndex = 0;
    }

    const before = result;
    result = result.replace(pat.regex, pat.replacement);

    if (result !== before) {
      stats.totalScrubs += 1;
      stats.byCategory[pat.category] = (stats.byCategory[pat.category] || 0) + 1;
      stats.byPattern[pat.name] = (stats.byPattern[pat.name] || 0) + 1;
      // Update lowercased copy after replacement
      lower = result.toLowerCase();
    }
  }

  return result;
}

/**
 * Scrub sensitive information from a pattern object.
 * Recursively walks object properties and scrubs string values.
 *
 * @param {object} pattern - Object that may contain PII in string values
 * @returns {object} New object with PII scrubbed (immutable)
 * @example
 * const result = scrubPattern({ email: 'user@example.com', score: 0.9 });
 * // result: { email: '[EMAIL]', score: 0.9 }
 */
export function scrubPattern(pattern) {
  if (pattern === null || pattern === undefined) return pattern;

  if (typeof pattern === 'string') {
    return scrub(pattern);
  }

  if (Array.isArray(pattern)) {
    return pattern.map(scrubPattern);
  }

  if (typeof pattern === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(pattern)) {
      result[key] = scrubPattern(value);
    }
    return result;
  }

  // Primitives (numbers, booleans) pass through
  return pattern;
}

/**
 * Batch scrub an array of pattern objects.
 *
 * @param {object[]} patterns - Array of objects to scrub
 * @returns {object[]} New array with all PII scrubbed
 * @example
 * const results = scrubPatterns([
 *   { author: 'user@example.com', content: 'hello' },
 *   { author: 'admin@corp.io', content: 'world' },
 * ]);
 * // results[0].author === '[EMAIL]'
 * // results[1].author === '[EMAIL]'
 */
export function scrubPatterns(patterns) {
  if (!Array.isArray(patterns)) return [];
  return patterns.map(scrubPattern);
}

/**
 * Add a custom scrubbing pattern.
 *
 * @param {string} name - Unique pattern identifier
 * @param {RegExp} regex - Detection regex (should have 'g' flag)
 * @param {string} replacement - Replacement text
 * @param {object} [options]
 * @param {string} [options.category='custom'] - Category grouping
 * @param {number} [options.priority=90] - Application priority (0-100)
 * @returns {{ name: string, added: boolean }}
 * @example
 * const result = addCustomPattern('internal_id', /PROJ-\d{6}/g, '[INTERNAL_ID]', { category: 'identifiers' });
 * // result: { name: 'internal_id', added: true }
 */
export function addCustomPattern(name, regex, replacement, options = {}) {
  if (!name || !(regex instanceof RegExp) || typeof replacement !== 'string') {
    return { name, added: false };
  }

  // Remove existing pattern with same name
  activePatterns = activePatterns.filter((p) => p.name !== name);

  activePatterns.push({
    name,
    category: options.category || 'custom',
    regex,
    replacement,
    priority: options.priority ?? 90,
  });

  rebuildSortedPatterns();
  return { name, added: true };
}

/**
 * Remove a custom pattern by name.
 * Built-in patterns cannot be removed (only disabled).
 *
 * @param {string} name - Pattern identifier
 * @returns {{ name: string, removed: boolean }}
 * @example
 * const result = removeCustomPattern('internal_id');
 * // result: { name: 'internal_id', removed: true }
 */
export function removeCustomPattern(name) {
  const before = activePatterns.length;
  activePatterns = activePatterns.filter((p) => p.name !== name);
  if (activePatterns.length < before) rebuildSortedPatterns();
  return { name, removed: activePatterns.length < before };
}

/**
 * Get current scrubbing statistics.
 *
 * @returns {{ totalScrubs: number, byCategory: Record<string, number>, byPattern: Record<string, number>, homoglyphNormalized: number, patternCount: number }}
 * @example
 * const stats = getScrubStats();
 * // stats.totalScrubs === 15
 * // stats.byCategory === { auth: 8, personal: 5, paths: 2 }
 * // stats.homoglyphNormalized === 2
 * // stats.patternCount === 43
 */
export function getScrubStats() {
  return {
    ...stats,
    patternCount: activePatterns.length,
  };
}

/**
 * Reset scrubbing statistics.
 *
 * @example
 * resetStats();
 * // getScrubStats().totalScrubs === 0
 */
export function resetStats() {
  stats = createEmptyStats();
}

/**
 * Validate that text has been properly scrubbed.
 * Checks for residual sensitive patterns that may have been missed.
 *
 * @param {string} text - Previously scrubbed text to validate
 * @returns {{ clean: boolean, residual: string[] }}
 * @example
 * const result = validateScrubbed('All clean, key=[REDACTED_KEY]');
 * // result: { clean: true, residual: [] }
 *
 * const bad = validateScrubbed('Leaked: user@company.com');
 * // bad: { clean: false, residual: ['email'] }
 */
export function validateScrubbed(text) {
  if (!text || typeof text !== 'string') return { clean: true, residual: [] };

  const residual = [];

  for (const check of VALIDATION_CHECKS) {
    check.regex.lastIndex = 0;
    if (check.regex.test(text)) {
      residual.push(check.name);
    }
  }

  return { clean: residual.length === 0, residual };
}

/**
 * List all active patterns with metadata.
 *
 * @returns {Array<{ name: string, category: string, priority: number }>}
 * @example
 * const patterns = listPatterns();
 * // patterns[0]: { name: 'pem_private_key', category: 'credentials', priority: 0 }
 */
export function listPatterns() {
  return activePatterns
    .map(({ name, category, priority }) => ({ name, category, priority }))
    .sort((a, b) => a.priority - b.priority);
}

/**
 * Restore active patterns to built-in defaults.
 * Removes all custom patterns.
 *
 * @example
 * addCustomPattern('my-pattern', /test/g, '[TEST]');
 * resetPatterns();
 * // Custom pattern removed, only built-in patterns active
 */
export function resetPatterns() {
  activePatterns = [...BUILTIN_PATTERNS];
  rebuildSortedPatterns();
}

/**
 * Create a scoped scrubber with a subset of categories.
 * Useful for applying only path scrubbing or only auth scrubbing.
 *
 * @param {string[]} categories - Categories to include (e.g. ['auth', 'secrets'])
 * @returns {{ scrub: (text: string) => string }}
 * @example
 * const personalScrubber = createScopedScrubber(['personal']);
 * const result = personalScrubber.scrub('Email: user@example.com');
 * // result: 'Email: [EMAIL]'
 */
export function createScopedScrubber(categories) {
  const categorySet = new Set(categories);
  const scoped = activePatterns
    .filter((p) => categorySet.has(p.category))
    .sort((a, b) => a.priority - b.priority);

  return {
    scrub(text) {
      if (!text || typeof text !== 'string') return text ?? '';
      let result = text;
      let lower = text.toLowerCase();
      for (const pat of scoped) {
        if (!hintMatches(pat.hint, result, lower, pat.regex.ignoreCase)) continue;
        if (pat.regex.global) pat.regex.lastIndex = 0;
        const before = result;
        result = result.replace(pat.regex, pat.replacement);
        if (result !== before) lower = result.toLowerCase();
      }
      return result;
    },
  };
}
