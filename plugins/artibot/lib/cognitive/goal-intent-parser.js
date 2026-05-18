/**
 * Goal Intent Parser (Track L — Claude /goal Native Integration, v4.11.0).
 *
 * Deterministic NLP parser that detects goal-like user intent in plain
 * prompts (Korean + English) and extracts a stopping condition phrase,
 * an optional validation command suggestion, and an iteration cap.
 *
 * Pure: no I/O, no async, no LLM calls, no external deps. The output
 * is a structured signal that callers (orchestrator, auto-launcher)
 * can act on to set up the Claude Code native `/goal` workflow
 * WITHOUT requiring the user to type the slash-command (per Artibot
 * Auto-invoke DNA).
 *
 * Design rules:
 *   - Regex + keyword scan; no statistics, no probabilistic models.
 *   - Korean and English markers treated symmetrically.
 *   - Confidence is a coarse signal (0..1) reflecting marker strength
 *     and length-sanity of the extracted condition.
 *   - HARD_MAX_ITERATIONS cap re-uses the goal-schema constant so the
 *     auto-launcher cannot accidentally exceed the safety bound.
 *
 * @module lib/cognitive/goal-intent-parser
 */

import { HARD_MAX_ITERATIONS } from '../autopilot/goal-schema.js';

/**
 * Default iteration count when the prompt does not specify one.
 */
export const DEFAULT_AUTO_MAX_ITERATIONS = 5;

/**
 * Trailing-condition markers: the stopping-condition phrase appears
 * AFTER the marker. e.g. "until <condition>", "될 때까지 <condition>".
 *
 * Each entry is `[regex, weight]`. Weights contribute additively to
 * the final confidence (capped 1.0). English markers are word-bounded;
 * Korean markers cannot use \b (no ASCII word breaks).
 */
const TRAILING_MARKERS = [
  // English — strong
  [/\biterate\s+until\b/i, 0.5],
  [/\brepeat\s+until\b/i, 0.5],
  [/\buntil\b/i, 0.45],
  [/\bas\s+long\s+as\b/i, 0.45],
  [/\bkeep\s+(going|iterating|trying)\b/i, 0.4],
  // English — weaker (need supporting context)
  [/\biterate\b/i, 0.25],
  [/\brepeat\b/i, 0.2],
  // Korean — strong
  [/조건이\s*만족할\s*때까지/, 0.5],
  [/될\s*때까지/, 0.45],
  [/반복해서\s*.+\s*(까지|때까지)/, 0.45],
  // Korean — weaker
  [/반복/, 0.25],
  [/계속해서/, 0.25],
  [/계속\s*(시도|돌려|돌리)/, 0.3],
];

/**
 * Enclosing-condition markers: the condition phrase is captured INSIDE
 * the marker regex (group 1). e.g. "when refactor is done" captures
 * "refactor is"; "테스트가 통과되면 멈춰" captures "테스트가 통과".
 *
 * Each entry is `[regex, weight]` where regex MUST have group 1 = the
 * condition substring.
 */
const ENCLOSING_MARKERS = [
  // English: "when <X> (done|met|passes|passing|green)"
  [/\bwhen\s+(.+?)\s+(?:is\s+)?(?:done|met|passes|passing|green)\b/i, 0.4],
  // Korean: "<X> 되면 (멈춰|중단|그만)"
  [/([^.!?\n]+?)\s*되면\s*(?:멈춰|중단|그만)/, 0.45],
];

/**
 * Sentence break characters used to bound the condition phrase.
 */
const SENTENCE_BREAK = /[.!?。．！？\n]/;

/**
 * Heuristic mapping from condition keywords to suggested validation
 * commands. Scanned in declared order; first hit wins.
 */
const VALIDATION_HEURISTICS = [
  [/\ball\s+checks?\s+(pass|green)\b/i, 'npm run ci'],
  [/\b(npm\s+run\s+)?ci\b/i, 'npm run ci'],
  [/\btests?\s+(pass|passing|green|succeed)\b/i, 'npm test'],
  [/\b테스트.*(통과|초록|성공)/, 'npm test'],
  [/\blint\s+(clean|pass|green)\b/i, 'npm run lint'],
  [/\b린트.*(통과|클린|초록)/, 'npm run lint'],
  [/\bbuild\s+(green|pass|succeed|ok)\b/i, 'npm run build'],
  [/\b빌드.*(성공|통과|초록)/, 'npm run build'],
  [/\btypecheck\b/i, 'npm run typecheck'],
  [/\b타입.*체크/, 'npm run typecheck'],
];

/**
 * Extract a maxIterations value from the prompt if explicitly stated.
 * Recognizes patterns like "max 3 iterations", "5번 반복", "up to 7
 * times". Returns null when no explicit value is found.
 *
 * @param {string} prompt
 * @returns {number|null}
 */
function extractMaxIterations(prompt) {
  const patterns = [
    /\bmax(?:imum)?\s+(\d{1,2})\s+(?:iterations?|times|tries|attempts)\b/i,
    /\bup\s+to\s+(\d{1,2})\s+(?:iterations?|times|tries)\b/i,
    /\b(\d{1,2})\s+(?:iterations?|times|tries|attempts)\s+max(?:imum)?\b/i,
    /(\d{1,2})\s*번\s*(?:반복|시도|까지)/,
    /최대\s*(\d{1,2})\s*(?:번|회)/,
  ];
  for (const re of patterns) {
    const m = prompt.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 1) return n;
    }
  }
  return null;
}

/**
 * Suggest a validation command by scanning the condition phrase against
 * known heuristics. Returns null when no heuristic matches — caller
 * then falls back to Haiku-based evaluation.
 *
 * @param {string} condition
 * @returns {string|null}
 */
function suggestValidationCommand(condition) {
  if (!condition || typeof condition !== 'string') return null;
  for (const [re, cmd] of VALIDATION_HEURISTICS) {
    if (re.test(condition)) return cmd;
  }
  return null;
}

/**
 * Find the strongest marker match in the prompt. Scans both trailing
 * and enclosing marker sets. Returns:
 *   - kind: 'trailing' (condition extracted from text AFTER marker) or
 *           'enclosing' (condition is the matched regex group 1).
 *   - endIdx: position where condition starts (trailing only).
 *   - extractedCondition: captured group (enclosing only).
 *   - weight: total confidence (sum of all matched marker weights, ≤1).
 *   - marker: the raw matched marker text (for debugging).
 *
 * @param {string} prompt
 * @returns {{
 *   kind: 'trailing'|'enclosing',
 *   endIdx: number,
 *   extractedCondition: string|null,
 *   weight: number,
 *   marker: string
 * }|null}
 */
function findMarker(prompt) {
  let best = null;
  let totalWeight = 0;
  for (const [re, weight] of TRAILING_MARKERS) {
    const m = prompt.match(re);
    if (!m) continue;
    totalWeight += weight;
    if (!best || weight > best.weight) {
      best = {
        kind: 'trailing',
        endIdx: m.index + m[0].length,
        extractedCondition: null,
        weight,
        marker: m[0],
      };
    }
  }
  for (const [re, weight] of ENCLOSING_MARKERS) {
    const m = prompt.match(re);
    if (!m) continue;
    totalWeight += weight;
    if (!best || weight > best.weight) {
      best = {
        kind: 'enclosing',
        endIdx: m.index + m[0].length,
        extractedCondition: (m[1] || '').trim(),
        weight,
        marker: m[0],
      };
    }
  }
  if (!best) return null;
  return { ...best, weight: Math.min(1, totalWeight) };
}

/**
 * Extract the condition phrase that follows a marker — bounded by the
 * next sentence break or end-of-prompt. Trims trailing connectors.
 *
 * @param {string} prompt
 * @param {number} startIdx index just past the marker
 * @returns {string}
 */
function extractConditionPhrase(prompt, startIdx) {
  const tail = prompt.slice(startIdx);
  const breakMatch = tail.match(SENTENCE_BREAK);
  const slice = breakMatch
    ? tail.slice(0, breakMatch.index)
    : tail;
  return slice
    .trim()
    .replace(/^[,;:-]+/, '')
    .replace(/[,;:-]+$/, '')
    .trim();
}

/**
 * Parse a user prompt for goal-like intent.
 *
 * @param {string} prompt the raw user prompt
 * @param {{ defaultMaxIterations?: number }} [opts]
 * @returns {{
 *   found: boolean,
 *   condition: string|null,
 *   maxIterations: number,
 *   suggestedValidationCommand: string|null,
 *   confidence: number,
 *   marker: string|null
 * }}
 */
export function parseGoalIntent(prompt, opts = {}) {
  const defaultMax = Number.isInteger(opts.defaultMaxIterations)
    ? opts.defaultMaxIterations
    : DEFAULT_AUTO_MAX_ITERATIONS;
  const fallback = {
    found: false,
    condition: null,
    maxIterations: Math.min(defaultMax, HARD_MAX_ITERATIONS),
    suggestedValidationCommand: null,
    confidence: 0,
    marker: null,
  };

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return fallback;
  }

  const marker = findMarker(prompt);
  if (!marker) return fallback;

  const condition = marker.kind === 'enclosing'
    ? (marker.extractedCondition || '').replace(/^[,;:-]+/, '')
        .replace(/[,;:-]+$/, '')
        .trim()
    : extractConditionPhrase(prompt, marker.endIdx);
  if (!condition || condition.length < 2) {
    // Marker present but no meaningful tail → low-confidence signal,
    // not a usable goal contract.
    return { ...fallback, confidence: Math.min(0.3, marker.weight) };
  }

  const explicitMax = extractMaxIterations(prompt);
  const maxIterations = Math.min(
    explicitMax ?? defaultMax,
    HARD_MAX_ITERATIONS,
  );

  // Length sanity bonus: very short or very long conditions are less
  // trustworthy. Sweet spot 8..120 chars.
  const len = condition.length;
  const lenBonus = len >= 8 && len <= 120 ? 0.15 : 0;
  const confidence = Math.min(1, marker.weight + lenBonus);

  return {
    found: true,
    condition,
    maxIterations,
    suggestedValidationCommand: suggestValidationCommand(condition),
    confidence: Number(confidence.toFixed(2)),
    marker: marker.marker,
  };
}
