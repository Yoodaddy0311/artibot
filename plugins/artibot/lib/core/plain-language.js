/**
 * Plain-language translation layer (D-dimension UX).
 * Converts developer-facing jargon into beginner-friendly phrasing per locale.
 * Non-intrusive: only activates when skillLevel='novice' AND plainLanguage.enabled=true.
 *
 * @module lib/core/plain-language
 */

// ---------------------------------------------------------------------------
// Default dictionaries (immutable, frozen after build)
// ---------------------------------------------------------------------------

/** @type {Record<string, Record<string, string>>} */
const BASE_DICTIONARIES = {
  ko: {
    'guardrail=denied': '\uC548\uC804 \uADDC\uCE59 \uB54C\uBB38\uC5D0 \uCC28\uB2E8\uB410\uC5B4\uC694',
    'lint errors': '\uBB38\uBC95\uC5D0 \uB2E4\uB4EC\uC744 \uACF3\uC774 \uC788\uC5B4\uC694',
    '0 errors': '\uAE68\uB057\uD574\uC694',
    'tests passing': '\uD14C\uC2A4\uD2B8\uAC00 \uBAA8\uB450 \uD1B5\uACFC\uD588\uC5B4\uC694',
    'coverage drop': '\uD14C\uC2A4\uD2B8 \uCEE4\uBC84 \uBC94\uC704\uAC00 \uC904\uC5C8\uC5B4\uC694',
    'build failed': '\uBE4C\uB4DC \uACFC\uC815\uC5D0 \uBB38\uC81C\uAC00 \uC0DD\uACBC\uC5B4\uC694',
    'type error': '\uD0C0\uC785(\uC790\uB8CC\uD615)\uC774 \uB9DE\uC9C0 \uC54A\uC544\uC694',
    'module not found': '\uCC3E\uC744 \uC218 \uC5C6\uB294 \uD30C\uC77C\uC774\uB098 \uBAA8\uB4C8\uC774 \uC788\uC5B4\uC694',
    'permission denied': '\uAD8C\uD55C\uC774 \uC5C6\uC5B4\uC11C \uB9C9\uD614\uC5B4\uC694',
    'rate limit': '\uC694\uCCAD\uC774 \uB108\uBB34 \uB9CE\uC544\uC11C \uC7A0\uAE50 \uAE30\uB2E4\uB824\uC57C \uD574\uC694',
    'token limit': '\uD55C \uBC88\uC5D0 \uCC98\uB9AC\uD560 \uC218 \uC788\uB294 \uC591\uC744 \uB118\uC5B4\uC12C\uC5B4\uC694',
    'conflict': '\uB3D9\uC2DC\uC5D0 \uBC14\uB01C \uACF3\uC774 \uACB9\uCB65\uC5B4\uC694',
    'stale': '\uC624\uB798\uB41C \uC0C1\uD0DC\uB77C \uC0C8\uB85C \uB9DE\uCDB0\uC57C \uD574\uC694',
  },
  en: {},
  ja: {},
};

/** @type {Map<string, Map<string, string>>} */
const runtimeDicts = new Map();

// Seed runtime dicts from base
for (const [locale, entries] of Object.entries(BASE_DICTIONARIES)) {
  runtimeDicts.set(locale, new Map(Object.entries(entries)));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Escape a string for use in a RegExp pattern.
 * @param {string} str
 * @returns {string}
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Decide whether a match position should be treated as a word boundary.
 * Ascii-aware: if the phrase starts/ends with an alphanumeric char we require
 * a non-word char (or string edge) on the outside. Non-ascii (e.g., Korean)
 * phrases skip the boundary check.
 *
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @param {string} phrase
 * @returns {boolean}
 */
function isWordBoundary(text, start, end, phrase) {
  const asciiStart = /^[A-Za-z0-9]/.test(phrase);
  const asciiEnd = /[A-Za-z0-9]$/.test(phrase);
  if (asciiStart) {
    const prev = start > 0 ? text[start - 1] : '';
    if (/[A-Za-z0-9_]/.test(prev)) return false;
  }
  if (asciiEnd) {
    const next = end < text.length ? text[end] : '';
    if (/[A-Za-z0-9_]/.test(next)) return false;
  }
  return true;
}

/**
 * Apply dictionary substitutions to text with case-insensitive matching and
 * word-boundary awareness. Longer phrases are replaced first to avoid partial
 * collisions.
 *
 * @param {string} text
 * @param {Map<string, string>} dict
 * @returns {string}
 */
function applyDictionary(text, dict) {
  if (!text || dict.size === 0) return text;

  // Sort phrases by length descending — longer phrases first
  const phrases = [...dict.keys()].sort((a, b) => b.length - a.length);

  let result = text;
  for (const phrase of phrases) {
    const replacement = dict.get(phrase);
    if (replacement === undefined) continue;
    const regex = new RegExp(escapeRegex(phrase), 'gi');
    result = result.replace(regex, (match, offset) => {
      if (!isWordBoundary(result, offset, offset + match.length, phrase)) {
        return match;
      }
      return replacement;
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Translate developer-facing terms to plain language per locale.
 * Returns the original text unchanged when skillLevel !== 'novice'.
 *
 * @param {string} text - Source text (mixed technical)
 * @param {object} [options]
 * @param {'ko'|'en'|'ja'} [options.locale='ko']
 * @param {'novice'|'pro'} [options.skillLevel='novice']
 * @returns {string}
 */
export function toPlainLanguage(text, options = {}) {
  if (typeof text !== 'string') return text;
  const { locale = 'ko', skillLevel = 'novice' } = options;
  if (skillLevel !== 'novice') return text;
  const dict = runtimeDicts.get(locale);
  if (!dict) return text;
  return applyDictionary(text, dict);
}

/**
 * Retrieve a snapshot of the active dictionary for a locale.
 * Returns a plain-object copy — callers cannot mutate internal state.
 *
 * @param {string} [locale]
 * @returns {Record<string, Record<string, string>> | Record<string, string>}
 */
export function getDictionary(locale) {
  if (locale) {
    const dict = runtimeDicts.get(locale);
    return dict ? Object.fromEntries(dict) : {};
  }
  const all = {};
  for (const [loc, dict] of runtimeDicts) {
    all[loc] = Object.fromEntries(dict);
  }
  return all;
}

/**
 * Merge user-provided dictionary overrides for a locale.
 * Creates the locale bucket if missing. Non-mutating: callers receive the
 * resulting dictionary snapshot.
 *
 * @param {string} locale
 * @param {Record<string, string>} entries
 * @returns {Record<string, string>} Updated dictionary snapshot
 */
export function registerDictionary(locale, entries) {
  if (!locale || !entries || typeof entries !== 'object') {
    return getDictionary(locale) || {};
  }
  const dict = runtimeDicts.get(locale) ?? new Map();
  for (const [key, value] of Object.entries(entries)) {
    if (typeof key === 'string' && typeof value === 'string') {
      dict.set(key, value);
    }
  }
  runtimeDicts.set(locale, dict);
  return Object.fromEntries(dict);
}

/**
 * Reset runtime dictionaries back to base (test helper).
 * Not exported by default — consumers should not rely on it in production.
 *
 * @returns {void}
 */
export function _resetDictionaries() {
  runtimeDicts.clear();
  for (const [locale, entries] of Object.entries(BASE_DICTIONARIES)) {
    runtimeDicts.set(locale, new Map(Object.entries(entries)));
  }
}
