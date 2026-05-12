/**
 * Citation formatter — normalizes inline source citations and strips
 * Unicode lenticular brackets (【】) that LLMs emit during web-search /
 * RAG augmented generation.
 *
 * Background:
 *   - GPT-4 search and Chinese-trained models often emit raw 【1】【2】 tokens
 *     that leak through to user output. This module sanitizes them.
 *   - source-driven-development skill mandates URL citations; this module
 *     gives a programmatic way to format those citations consistently.
 *
 * Design constraints:
 *   - ESM only, zero runtime deps
 *   - Pure functions (no I/O, no input mutation)
 *   - Stable output: identical input → identical output
 *
 * @module lib/core/citation-formatter
 */

/**
 * Citation rendering modes.
 *
 * - `NUMBER`            → `[1]`                                plain numeric
 * - `NUMBER_HYPERLINK`  → `[1](https://react.dev/...)`         markdown hyperlink, numeric label
 * - `DOMAIN`            → `[react.dev]`                        domain only
 * - `DOMAIN_HYPERLINK`  → `[react.dev](https://react.dev/...)` markdown hyperlink, domain label
 * - `DOMAIN_ID`         → `[react.dev:1]`                      domain + index
 *
 * @readonly
 * @enum {string}
 */
export const CitationMode = Object.freeze({
  NUMBER: 'NUMBER',
  NUMBER_HYPERLINK: 'NUMBER_HYPERLINK',
  DOMAIN: 'DOMAIN',
  DOMAIN_HYPERLINK: 'DOMAIN_HYPERLINK',
  DOMAIN_ID: 'DOMAIN_ID',
});

/** Backwards-compatible alias retained for callers using plural form. */
export const CITATION_MODES = CitationMode;

// Unicode lenticular brackets emitted by OpenAI search / Chinese-trained models.
// Matches 【1】, 【react.dev】, 【1†source】, 【react.dev:1】, etc.
const LENTICULAR_RE = /【([^【】]*)】/g;

// Markdown hyperlink pattern used by hyperlink modes.
const URL_RE = /^https?:\/\//i;

/**
 * Extract a domain (no protocol, no www, no path) from a URL string.
 * Returns null when the input is not a parseable absolute URL.
 *
 * @param {string} url
 * @returns {string|null}
 */
export function extractDomain(url) {
  if (typeof url !== 'string' || !URL_RE.test(url)) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return null;
  }
}

/**
 * Strip Unicode lenticular brackets 【...】 from a text body.
 * Empty brackets and bracket-only fragments collapse to empty string.
 * The inner content is preserved as a plain `[...]` token so callers
 * that already used it as a citation marker keep their reference.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripLenticularBrackets(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  return text.replace(LENTICULAR_RE, (_match, inner) => {
    const trimmed = inner.trim();
    if (trimmed === '') return '';
    // Drop OpenAI-search internal markers like "1†source" — keep only "1"
    const cleaned = trimmed.replace(/†.*$/, '').trim();
    return cleaned === '' ? '' : `[${cleaned}]`;
  });
}

/**
 * Deduplicate a list of citation source URLs while preserving first-seen order.
 * Returns a frozen array. Non-string entries are filtered out. Trailing
 * slashes and fragment-only differences are normalized away.
 *
 * @param {ReadonlyArray<string>} sources
 * @returns {ReadonlyArray<string>}
 */
export function dedupeSources(sources) {
  if (!Array.isArray(sources)) return Object.freeze([]);
  const seen = new Set();
  const out = [];
  for (const raw of sources) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const key = normalizeUrlForDedup(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return Object.freeze(out);
}

/** Alias matching the spec naming. */
export const dedupeCitations = dedupeSources;

function normalizeUrlForDedup(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    let s = u.toString();
    if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
    return s.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Render a single citation token in the requested mode.
 *
 * @param {object} args
 * @param {string} args.url        - Source URL (or any string for fallback)
 * @param {number} args.index      - 1-based citation number
 * @param {keyof typeof CitationMode} [args.mode=NUMBER]
 * @returns {string}
 */
export function renderCitation({ url, index, mode = CitationMode.NUMBER }) {
  const idx = Number.isInteger(index) && index >= 1 ? index : 1;
  const domain = extractDomain(url) ?? 'source';
  switch (mode) {
    case CitationMode.NUMBER:
      return `[${idx}]`;
    case CitationMode.DOMAIN:
      return `[${domain}]`;
    case CitationMode.DOMAIN_ID:
      return `[${domain}:${idx}]`;
    case CitationMode.NUMBER_HYPERLINK:
      return URL_RE.test(url) ? `[${idx}](${url})` : `[${idx}]`;
    case CitationMode.DOMAIN_HYPERLINK:
      return URL_RE.test(url) ? `[${domain}](${url})` : `[${domain}]`;
    default:
      return `[${idx}]`;
  }
}

// Matches "(Source 1)", "(source 12)", "(Sources 3)" — case-insensitive.
const SOURCE_PAREN_RE = /\(\s*sources?\s+(\d+)\s*\)/gi;

/**
 * Format a body of text by:
 *   1. Stripping any 【...】 lenticular brackets (LLM-emitted artifacts)
 *   2. Normalizing `(Source N)` parenthetical markers into `[N]`
 *   3. Replacing every `[N]` numeric marker with the requested mode using
 *      the deduped `sources` array as the index lookup
 *   4. Optionally appending a numbered "Sources" footer
 *
 * Unknown numeric markers (index out of range) are left untouched.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {ReadonlyArray<string>} [options.sources=[]] - URLs in citation order
 * @param {keyof typeof CitationMode} [options.mode=NUMBER]
 * @param {boolean} [options.appendFooter=false] - Append "Sources" list
 * @returns {string}
 */
export function formatCitations(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) return '';
  const mode = options.mode ?? CitationMode.NUMBER;
  const sources = dedupeSources(options.sources ?? []);
  const appendFooter = options.appendFooter === true;

  const stripped = stripLenticularBrackets(text);
  const normalized = stripped.replace(SOURCE_PAREN_RE, (_m, n) => `[${n}]`);

  const reMarker = /\[(\d+)\]/g;
  const replaced = normalized.replace(reMarker, (match, numStr) => {
    const n = Number(numStr);
    if (!Number.isInteger(n) || n < 1 || n > sources.length) return match;
    return renderCitation({ url: sources[n - 1], index: n, mode });
  });

  if (!appendFooter || sources.length === 0) return replaced;

  const footer = ['', '', 'Sources:'];
  for (let i = 0; i < sources.length; i += 1) {
    footer.push(`${i + 1}. ${sources[i]}`);
  }
  return replaced + footer.join('\n');
}
