/**
 * Smart Goal-Contract template auto-suggestion (v4.11.0 Track K).
 *
 * Beginner-friendly: detect intent from the raw prompt and pick the most
 * appropriate template (`bugfix` | `refactor` | `feature`) without the user
 * ever typing a slash command. Pure, deterministic — no LLM.
 *
 * Public surface:
 *   - suggestTemplate(prompt, opts?)
 *   - enrichWithTemplate(goal, templateName, opts?)
 *   - recommendByHistory(prompt, recentSessions, opts?)
 *
 * @module lib/autopilot/template-suggester
 */

import { loadTemplate as defaultLoadTemplate } from './template-loader.js';

/** Bare template names this module ever returns. */
export const TEMPLATE_NAMES = Object.freeze(['bugfix', 'refactor', 'feature']);

/** History boost added when a similar past goal used template X successfully. */
export const HISTORY_BOOST = 2;

/** Minimum score gap for confidence='high'. */
const HIGH_CONFIDENCE_MARGIN = 3;

/**
 * Per-template keyword score table. Korean + English. Each hit adds its
 * weight; ties broken by template ordering in TEMPLATE_NAMES.
 *
 * Weights:
 *   3 = unambiguous verb (fix / extract / add)
 *   2 = strong noun cue  (bug / refactor / feature)
 *   1 = weak associative cue
 */
const KEYWORD_TABLE = Object.freeze({
  bugfix: Object.freeze([
    { w: 3, terms: ['fix', 'bugfix', 'patch', 'repair', 'hotfix', 'resolve'] },
    { w: 3, terms: ['고치', '수정', '버그', '에러', '오류'] },
    { w: 2, terms: ['bug', 'defect', 'broken', 'crash', 'failing', 'regression'] },
    { w: 1, terms: ['error', 'exception', 'throws', '실패'] },
  ]),
  refactor: Object.freeze([
    { w: 3, terms: ['refactor', 'extract', 'rename', 'restructure', 'reorganize'] },
    { w: 3, terms: ['리팩터', '리팩토링', '정리', '재구조'] },
    { w: 2, terms: ['cleanup', 'simplify', 'dedupe', 'consolidate', 'split'] },
    { w: 1, terms: ['rewrite', 'move', '추출', '분리', '통합'] },
  ]),
  feature: Object.freeze([
    { w: 3, terms: ['add', 'create', 'implement', 'build', 'introduce', 'ship'] },
    { w: 3, terms: ['추가', '구현', '개발', '도입'] },
    { w: 2, terms: ['feature', 'new', 'support', 'enable'] },
    { w: 1, terms: ['integrate', 'wire', '기능', '신규', '새로'] },
  ]),
});

/**
 * Suggest the most appropriate template name for a prompt.
 *
 * Returns `{ template, confidence, reasoning }` where:
 *   - template:    'bugfix'|'refactor'|'feature'|null
 *   - confidence:  'high' | 'medium' | 'low' | 'none'
 *   - reasoning:   short human-readable string explaining the pick
 *
 * @param {string} prompt user goal text
 * @param {{ recentSessions?: Array<object>, historyBoost?: number }} [opts]
 * @returns {{ template: string|null, confidence: 'high'|'medium'|'low'|'none', reasoning: string, scores: Record<string, number> }}
 */
export function suggestTemplate(prompt, opts = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return emptyResult('empty prompt');
  }
  const text = prompt.toLowerCase();
  const scores = baseScores(text);
  const boost = Number.isFinite(opts.historyBoost) ? opts.historyBoost : HISTORY_BOOST;
  if (Array.isArray(opts.recentSessions) && opts.recentSessions.length > 0) {
    const hist = recommendByHistory(prompt, opts.recentSessions, { boost });
    if (hist.template) scores[hist.template] = (scores[hist.template] || 0) + hist.boost;
  }
  return pickWinner(scores);
}

/**
 * Merge a named template into an existing partial Goal Contract object.
 * Caller's own fields win — template only fills holes — so explicit user
 * input is never overwritten.
 *
 * @param {object} goal partial Goal Contract (may be {} )
 * @param {string} templateName one of TEMPLATE_NAMES
 * @param {{ loadTemplate?: (name: string) => object }} [opts] DI for tests
 * @returns {object} new merged goal (immutable — input untouched)
 */
export function enrichWithTemplate(goal, templateName, opts = {}) {
  if (!templateName || !TEMPLATE_NAMES.includes(templateName)) {
    return { ...(goal || {}) };
  }
  const loader = typeof opts.loadTemplate === 'function'
    ? opts.loadTemplate
    : defaultLoadTemplate;
  let template;
  try {
    template = loader(templateName) || {};
  } catch {
    return { ...(goal || {}) };
  }
  const base = goal && typeof goal === 'object' ? { ...goal } : {};
  for (const key of Object.keys(template)) {
    if (base[key] === undefined || base[key] === null || base[key] === '') {
      base[key] = template[key];
    }
  }
  return base;
}

/**
 * Inspect prior sessions to see which template was most recently used for a
 * similar goal that completed successfully. Used as an additional signal on
 * top of the static keyword table.
 *
 * Each recentSession entry is expected to expose at least:
 *   { goalText?: string, templateUsed?: string, success?: boolean }
 *
 * @param {string} prompt
 * @param {Array<object>} recentSessions
 * @param {{ boost?: number }} [opts]
 * @returns {{ template: string|null, boost: number, reasoning: string }}
 */
export function recommendByHistory(prompt, recentSessions, opts = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return { template: null, boost: 0, reasoning: 'empty prompt' };
  }
  if (!Array.isArray(recentSessions) || recentSessions.length === 0) {
    return { template: null, boost: 0, reasoning: 'no history' };
  }
  const promptTokens = tokenize(prompt);
  if (promptTokens.size === 0) {
    return { template: null, boost: 0, reasoning: 'no tokens' };
  }
  const boost = Number.isFinite(opts.boost) && opts.boost > 0 ? opts.boost : HISTORY_BOOST;
  let bestTemplate = null;
  let bestOverlap = 0;
  for (const s of recentSessions) {
    if (!s || typeof s !== 'object') continue;
    if (s.success === false) continue;
    if (!s.templateUsed || !TEMPLATE_NAMES.includes(s.templateUsed)) continue;
    const goalText = typeof s.goalText === 'string' ? s.goalText : '';
    if (!goalText) continue;
    const overlap = overlapCount(promptTokens, tokenize(goalText));
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestTemplate = s.templateUsed;
    }
  }
  if (!bestTemplate) return { template: null, boost: 0, reasoning: 'no similar past goal' };
  return {
    template: bestTemplate,
    boost,
    reasoning: `past goal used "${bestTemplate}" successfully (overlap=${bestOverlap})`,
  };
}

// ─── helpers ───────────────────────────────────────────────────────────

function emptyResult(reason) {
  return {
    template: null,
    confidence: 'none',
    reasoning: reason,
    scores: { bugfix: 0, refactor: 0, feature: 0 },
  };
}

function baseScores(text) {
  const scores = { bugfix: 0, refactor: 0, feature: 0 };
  for (const name of TEMPLATE_NAMES) {
    const groups = KEYWORD_TABLE[name];
    for (const { w, terms } of groups) {
      for (const term of terms) {
        if (text.includes(term)) scores[name] += w;
      }
    }
  }
  return scores;
}

function pickWinner(scores) {
  let winner = null;
  let winnerScore = 0;
  let runnerUp = 0;
  for (const name of TEMPLATE_NAMES) {
    const s = scores[name] || 0;
    if (s > winnerScore) {
      runnerUp = winnerScore;
      winnerScore = s;
      winner = name;
    } else if (s > runnerUp) {
      runnerUp = s;
    }
  }
  if (!winner || winnerScore === 0) {
    return { template: null, confidence: 'none', reasoning: 'no keyword match', scores };
  }
  const margin = winnerScore - runnerUp;
  let confidence;
  if (margin >= HIGH_CONFIDENCE_MARGIN && winnerScore >= 3) confidence = 'high';
  else if (winnerScore >= 3 || margin >= 2) confidence = 'medium';
  else confidence = 'low';
  return {
    template: winner,
    confidence,
    reasoning: `score=${winnerScore} margin=${margin}`,
    scores,
  };
}

function tokenize(text) {
  const lowered = String(text).toLowerCase();
  const parts = lowered.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const out = new Set();
  for (const p of parts) {
    if (p.length >= 3) out.add(p);
  }
  return out;
}

function overlapCount(a, b) {
  let n = 0;
  for (const t of a) if (b.has(t)) n += 1;
  return n;
}
