/**
 * Failure-Pattern Surfacer — A↔B bridge.
 *
 * The code-loop (failure-categorizer + GRPO) accumulates a curated dictionary
 * of recurring failure patterns at `.artibot/failure-patterns.json`. Nothing
 * in that loop ever reaches the MODEL's prompt channel — the patterns live in
 * a JSON file the model never reads. This module is the bridge: it loads the
 * curated dictionary (reusing failure-categorizer's loader), ranks the top-N
 * patterns, and renders a compact markdown block suitable for appending to a
 * model-visible surface (SESSION-NOTES.md / HANDOFF.md / MEMORY.md).
 *
 * DATA POLICY: read-only, local filesystem only. No external I/O.
 *
 * Pure logic — file I/O happens in the caller (the Stop hook). The only
 * filesystem touch here is the categorizer's own injectable loader.
 *
 * @module lib/learning/failure-pattern-surfacer
 */

import { loadFailurePatterns } from './failure-categorizer.js';

/** Default number of patterns to surface. Kept small to bound prompt cost. */
const DEFAULT_TOP_N = 5;

/** Severity ranking — mirrors failure-categorizer's SEVERITY_RANK. */
const SEVERITY_RANK = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });

/** Sentinel markers so the block can be located + replaced idempotently. */
export const SURFACE_BEGIN = '<!-- artibot:failure-patterns:begin -->';
export const SURFACE_END = '<!-- artibot:failure-patterns:end -->';

/**
 * Rank categories: severity DESC → weight DESC → id ASC (stable).
 * @param {object[]} categories
 * @returns {object[]} new sorted array (input not mutated)
 */
function rankCategories(categories) {
  return [...categories].sort((a, b) => {
    const sevDiff = (SEVERITY_RANK[b.severity] ?? 1) - (SEVERITY_RANK[a.severity] ?? 1);
    if (sevDiff !== 0) return sevDiff;
    const wa = typeof a.weight === 'number' ? a.weight : 1.0;
    const wb = typeof b.weight === 'number' ? b.weight : 1.0;
    if (wb !== wa) return wb - wa;
    return String(a.id).localeCompare(String(b.id));
  });
}

/**
 * Render a single category as one markdown bullet (+ first fix hint).
 * @param {object} c
 * @returns {string}
 */
function renderCategory(c) {
  const sev = (c.severity || 'medium').toUpperCase();
  const label = c.label || c.id;
  const hint = Array.isArray(c.fixHints) && c.fixHints.length > 0
    ? c.fixHints[0]
    : null;
  const head = `- **[${sev}] ${c.id}** — ${label}`;
  return hint ? `${head}\n  - ↳ ${hint}` : head;
}

/**
 * Build the markdown block (between sentinels) for the top-N patterns.
 * Returns an empty string when there are no categories to surface.
 *
 * @param {object[]} categories - dict.categories
 * @param {{ topN?: number }} [opts]
 * @returns {string}
 */
export function renderSurfaceBlock(categories, opts = {}) {
  const list = Array.isArray(categories) ? categories : [];
  if (list.length === 0) return '';
  const topN = Number.isInteger(opts.topN) && opts.topN > 0 ? opts.topN : DEFAULT_TOP_N;
  const top = rankCategories(list).slice(0, topN);

  const lines = [
    SURFACE_BEGIN,
    `## ⚠️ Known failure patterns (top ${top.length})`,
    '',
    '> Curated by the artibot learning loop (`.artibot/failure-patterns.json`).',
    '> Avoid re-introducing these; the fix hint shows the canonical remedy.',
    '',
    ...top.map(renderCategory),
    '',
    SURFACE_END,
  ];
  return lines.join('\n');
}

/**
 * Replace an existing surfaced block in `existingText`, or return null if no
 * block is present. Idempotent: re-surfacing never stacks duplicate blocks.
 *
 * @param {string} existingText
 * @param {string} newBlock
 * @returns {string|null} updated text, or null when no block exists
 */
export function replaceSurfaceBlock(existingText, newBlock) {
  const text = typeof existingText === 'string' ? existingText : '';
  const start = text.indexOf(SURFACE_BEGIN);
  const end = text.indexOf(SURFACE_END);
  if (start === -1 || end === -1 || end < start) return null;
  const before = text.slice(0, start);
  const after = text.slice(end + SURFACE_END.length);
  return `${before}${newBlock}${after}`;
}

/**
 * Load the curated dictionary and render the surface block in one call.
 * Returns an empty string when the dictionary is missing/unreadable — the
 * bridge is best-effort and must never block the caller (Stop hook).
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd] - repo root (forwarded to loadFailurePatterns).
 * @param {object} [opts.fs] - injectable fs/promises (for tests).
 * @param {number} [opts.topN] - number of patterns to surface.
 * @returns {Promise<string>}
 */
export async function buildFailurePatternSurface(opts = {}) {
  try {
    const dict = await loadFailurePatterns({ cwd: opts.cwd, fs: opts.fs });
    return renderSurfaceBlock(dict.categories, { topN: opts.topN });
  } catch {
    // Missing dictionary, malformed JSON, unreadable file → surface nothing.
    return '';
  }
}
