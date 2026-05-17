/**
 * Smart-skip heuristics for autopilot phases (v4.10.0 Track G).
 *
 * Classifies goal complexity from a plain-text task description and
 * recommends which optional phases can be safely skipped for trivial work.
 *
 * Pure function module: deterministic, no I/O, no LLM calls. Returns
 * recommendations only — the engine decides whether to act on them.
 *
 * Public surface:
 *   - classifyTaskComplexity(goal)
 *   - recommendSkippablePhases(complexity)
 *   - COMPLEXITY_LEVELS
 *   - SKIPPABLE_PHASES
 *
 * @module lib/autopilot/smart-skip
 */

/** @typedef {'trivial'|'simple'|'medium'|'complex'} ComplexityLevel */

/**
 * Ordered list of complexity levels (ascending). Exposed for callers that
 * need to render scales or perform comparisons.
 */
export const COMPLEXITY_LEVELS = Object.freeze(['trivial', 'simple', 'medium', 'complex']);

/**
 * Phases that may be skipped when complexity allows. CROSS_CHECK and IMPROVE
 * are non-essential for trivial fixes; EXECUTE / VERIFY / REPORT are always
 * required for the engine to terminate cleanly.
 */
export const SKIPPABLE_PHASES = Object.freeze(['CROSS_CHECK', 'IMPROVE']);

const COMPLEX_KEYWORDS = Object.freeze([
  'refactor', 'rewrite', 'migration', 'migrate', 'overhaul',
  'redesign', 'architecture', 'restructure', 'port to', 'rip out',
  'breaking change', 'cross-cutting', 'multi-package',
]);

const MEDIUM_KEYWORDS = Object.freeze([
  'feature', 'implement', 'integrate', 'add support', 'new endpoint',
  'pipeline', 'workflow', 'middleware', 'subsystem',
]);

const TRIVIAL_KEYWORDS = Object.freeze([
  'typo', 'rename', 'comment', 'whitespace', 'format only',
  'lint fix', 'docs typo',
]);

/**
 * Count file-path-like tokens in a goal string. Used as a coarse signal for
 * scope width — many file mentions suggest a wider change.
 *
 * @param {string} text
 * @returns {number}
 */
function countFileHints(text) {
  if (typeof text !== 'string' || !text) return 0;
  const matches = text.match(/\b[\w./@-]+\.(?:js|mjs|ts|tsx|jsx|md|yaml|yml|json|css|html|py|rs|go|rb|java|sh)\b/gi);
  return matches ? matches.length : 0;
}

/**
 * Count keyword hits within a goal string, case-insensitive whole-substring.
 *
 * @param {string} lower lower-cased goal
 * @param {readonly string[]} keywords
 * @returns {string[]} matched keywords (for `factors` reporting)
 */
function matchedKeywords(lower, keywords) {
  const hits = [];
  for (const kw of keywords) {
    if (lower.includes(kw)) hits.push(kw);
  }
  return hits;
}

/**
 * Compute a numeric complexity score (0..100) plus the structured factors
 * that contributed to it. Score boundaries map deterministically to the
 * four levels:
 *   <  15 → trivial
 *   < 35  → simple
 *   < 65  → medium
 *   >= 65 → complex
 *
 * Length contributes up to 20 points (capped); keyword class adds 25 / 15;
 * file-hint count adds 5 per match up to 25; explicit "and" / list separators
 * add 5 per up to 15.
 *
 * @param {string} goal
 * @returns {{ level: ComplexityLevel, score: number, factors: string[] }}
 */
export function classifyTaskComplexity(goal) {
  if (typeof goal !== 'string' || !goal.trim()) {
    return { level: 'trivial', score: 0, factors: ['empty-goal'] };
  }
  const text = goal.trim();
  const lower = text.toLowerCase();
  const factors = [];
  let score = 0;

  const trivialHits = matchedKeywords(lower, TRIVIAL_KEYWORDS);
  const complexHits = matchedKeywords(lower, COMPLEX_KEYWORDS);
  const mediumHits = matchedKeywords(lower, MEDIUM_KEYWORDS);

  // Length signal (cap at 20).
  const lengthPts = Math.min(20, Math.floor(text.length / 25));
  if (lengthPts > 0) {
    score += lengthPts;
    factors.push(`length=${text.length}(+${lengthPts})`);
  }

  // Keyword class signals.
  if (complexHits.length > 0) {
    score += 25;
    factors.push(`complex-kw:${complexHits.join(',')}(+25)`);
  } else if (mediumHits.length > 0) {
    score += 15;
    factors.push(`medium-kw:${mediumHits.join(',')}(+15)`);
  }
  if (trivialHits.length > 0) {
    // Trivial keywords subtract to overcome accidental medium hits.
    score -= 15;
    factors.push(`trivial-kw:${trivialHits.join(',')}(-15)`);
  }

  // File-path signal (cap at 25).
  const fileHints = countFileHints(text);
  if (fileHints > 0) {
    const pts = Math.min(25, fileHints * 5);
    score += pts;
    factors.push(`files=${fileHints}(+${pts})`);
  }

  // Multi-clause signal (cap at 15).
  const clauseHits = (lower.match(/\b(?:and|then|plus|also|,)\b/g) || []).length;
  if (clauseHits > 0) {
    const pts = Math.min(15, clauseHits * 5);
    score += pts;
    factors.push(`clauses=${clauseHits}(+${pts})`);
  }

  score = Math.max(0, Math.min(100, score));

  let level;
  if (score < 15) level = 'trivial';
  else if (score < 35) level = 'simple';
  else if (score < 65) level = 'medium';
  else level = 'complex';

  return { level, score, factors };
}

/**
 * Map a complexity classification to a set of phases the caller MAY skip.
 *
 *   trivial → skip CROSS_CHECK + IMPROVE
 *   simple  → skip IMPROVE only
 *   medium  → skip nothing
 *   complex → skip nothing (force full pipeline)
 *
 * Returns a recommendation envelope so callers can log / display the
 * rationale alongside the action.
 *
 * @param {{ level?: ComplexityLevel }} complexity
 * @returns {{
 *   skip: string[],
 *   keep: string[],
 *   rationale: string,
 * }}
 */
export function recommendSkippablePhases(complexity) {
  const level = complexity && typeof complexity === 'object' && typeof complexity.level === 'string'
    ? complexity.level
    : null;
  if (!COMPLEXITY_LEVELS.includes(level)) {
    return {
      skip: [],
      keep: [...SKIPPABLE_PHASES],
      rationale: 'unknown complexity → run all phases',
    };
  }
  if (level === 'trivial') {
    return {
      skip: ['CROSS_CHECK', 'IMPROVE'],
      keep: [],
      rationale: 'trivial change — cross-check and improve add no value',
    };
  }
  if (level === 'simple') {
    return {
      skip: ['IMPROVE'],
      keep: ['CROSS_CHECK'],
      rationale: 'simple change — keep cross-check, drop improvement pass',
    };
  }
  return {
    skip: [],
    keep: [...SKIPPABLE_PHASES],
    rationale: `${level} change — full pipeline required`,
  };
}
