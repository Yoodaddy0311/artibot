/**
 * Character-ratio token estimate — the canonical one for lib/core.
 *
 * A LEAF ON PURPOSE: this module imports nothing. It used to be defined inside the
 * `lib/core/index.js` barrel, and two modules the barrel re-exports
 * (agent-memory-snapshot.js, instruction-budget.js) imported it back from './index.js' —
 * an import cycle through the barrel (2026-11-21 review L7). They import this file now,
 * and the barrel re-exports the same bindings, so `import { estimateTokens } from
 * 'lib/core/index.js'` keeps working unchanged.
 *
 * tests/core/token-estimate-leaf.test.js pins that this file has no static imports and
 * that no lib/core module imports the barrel.
 *
 * @module lib/core/token-estimate
 */

/** Approximate characters per token for budget estimation. */
export const CHARS_PER_TOKEN = 4;

/**
 * Estimate token count from character content.
 * Canonical implementation — other modules should import this.
 * @param {string} text - Raw text content
 * @param {number} [charsPerToken=4] - Characters-per-token ratio
 * @returns {number} Estimated token count
 */
export function estimateTokens(text, charsPerToken = CHARS_PER_TOKEN) {
  if (!text || typeof text !== 'string') return 0;
  return Math.ceil(text.length / charsPerToken) + 1;
}
