/**
 * Pre-intake cost / duration prediction for autopilot goals (PRD v4.10.0 Track E).
 *
 * Reads historical `usage` and phase-timing events from prior sessions via
 * telemetry.js `readEvents`, then projects an estimate for a new goal based
 * on:
 *   - goal text length (chars) × historical avg tokens/char
 *   - complexity multiplier inferred from keyword heuristics
 *   - graceful degrade to a conservative default when no history is present
 *
 * Pure prediction module — no engine coupling, no external HTTP.
 * Returns `{estimatedTokens, estimatedDurationMs, confidence, basedOnNSessions}`.
 *
 * Public surface:
 *   - predictCost(goal, opts)
 *
 * @module lib/autopilot/cost-predictor
 */

import {
  listSessions as defaultListSessions,
} from './session-store.js';
import {
  readEvents as defaultReadEvents,
} from './telemetry.js';

// Conservative defaults used when there is zero usable history.
// Sized for a small ~1k-char goal at opus-4.7 mixed-phase typical spend.
const DEFAULT_TOKENS_PER_CHAR = 12;          // empirical lower bound: prompt + tool round-trips
const DEFAULT_DURATION_MS = 30 * 60 * 1000;  // 30 minutes
const DEFAULT_MIN_TOKENS = 8000;             // floor estimate for trivial goal
const HISTORY_SESSION_CAP = 50;              // limit IO churn when many sessions exist

const COMPLEXITY_KEYWORDS = Object.freeze({
  // each tier multiplies the baseline char-derived token estimate
  high: ['migrate', 'refactor', 'overhaul', 'redesign', 'rewrite', 'architecture'],
  medium: ['implement', 'add feature', 'integrate', 'restructure', 'optimize'],
  low: ['fix', 'typo', 'rename', 'docs', 'comment'],
});
const COMPLEXITY_MULT = Object.freeze({ low: 0.75, medium: 1.0, high: 1.6 });

/**
 * Coerce to non-negative finite number; NaN / negative → 0.
 * @param {unknown} n
 * @returns {number}
 */
function safeNum(n) {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return v;
}

/**
 * Classify a goal string into a complexity tier via keyword match.
 * Keyword precedence: high > medium > low > medium (default).
 *
 * @param {string} task
 * @returns {'low'|'medium'|'high'}
 */
export function classifyComplexity(task) {
  const text = typeof task === 'string' ? task.toLowerCase() : '';
  if (!text) return 'medium';
  for (const tier of /** @type {Array<'high'|'medium'|'low'>} */ (['high', 'medium', 'low'])) {
    for (const kw of COMPLEXITY_KEYWORDS[tier]) {
      if (text.includes(kw)) return tier;
    }
  }
  return 'medium';
}

/**
 * Pull `usage` and phase-timing events for one session and return aggregates.
 * Returns null when nothing usable is present.
 *
 * @param {string} sessionId
 * @param {Function} readEvents
 * @returns {{totalTokens:number, durationMs:number, taskChars:number}|null}
 */
function aggregateSession(sessionId, readEvents) {
  let events;
  try { events = readEvents(sessionId); } catch { return null; }
  if (!Array.isArray(events) || events.length === 0) return null;
  let totalTokens = 0;
  let firstTs = null;
  let lastTs = null;
  let taskChars = 0;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const ts = typeof ev.ts === 'string' ? Date.parse(ev.ts) : NaN;
    if (Number.isFinite(ts)) {
      if (firstTs === null || ts < firstTs) firstTs = ts;
      if (lastTs === null || ts > lastTs) lastTs = ts;
    }
    if (ev.type === 'usage' && ev.data && typeof ev.data === 'object') {
      totalTokens += safeNum(ev.data.tokensIn) + safeNum(ev.data.tokensOut);
    }
    if (ev.type === 'session-start' && ev.data && typeof ev.data.task === 'string') {
      taskChars = ev.data.task.length;
    }
  }
  if (totalTokens === 0 && (firstTs === null || lastTs === null)) return null;
  return {
    totalTokens,
    durationMs: firstTs !== null && lastTs !== null ? Math.max(0, lastTs - firstTs) : 0,
    taskChars,
  };
}

/**
 * Compute the rolling mean of tokens-per-char and duration across the most
 * recent N sessions. Sessions without usable usage are excluded from N.
 *
 * @param {{listSessions:Function, readEvents:Function, cap:number}} deps
 * @returns {{tokensPerChar:number, avgDurationMs:number, n:number}}
 */
function rollHistory(deps) {
  let ids;
  try { ids = deps.listSessions(); } catch { ids = []; }
  if (!Array.isArray(ids) || ids.length === 0) {
    return { tokensPerChar: 0, avgDurationMs: 0, n: 0 };
  }
  const recent = ids.slice(-deps.cap);
  let n = 0;
  let sumTokensPerChar = 0;
  let sumDuration = 0;
  for (const id of recent) {
    const agg = aggregateSession(id, deps.readEvents);
    if (!agg) continue;
    const chars = agg.taskChars > 0 ? agg.taskChars : 1000;
    const tpc = agg.totalTokens / chars;
    if (!Number.isFinite(tpc) || tpc <= 0) continue;
    sumTokensPerChar += tpc;
    sumDuration += agg.durationMs;
    n += 1;
  }
  if (n === 0) return { tokensPerChar: 0, avgDurationMs: 0, n: 0 };
  return {
    tokensPerChar: sumTokensPerChar / n,
    avgDurationMs: sumDuration / n,
    n,
  };
}

/**
 * Map sample-size `n` to a 0..1 confidence score. Linear ramp: 0 samples → 0,
 * 10+ samples → cap at 0.9 (never claim absolute certainty).
 *
 * @param {number} n
 * @returns {number}
 */
function confidenceFor(n) {
  if (n <= 0) return 0;
  if (n >= 10) return 0.9;
  return Math.round((n / 10) * 90) / 100;
}

/**
 * Predict token + duration cost of a goal before INTAKE runs.
 *
 * Heuristic chain:
 *   1. Extract task text + chars.
 *   2. Pull historical avg tokens/char from up to `cap` recent sessions.
 *   3. baseTokens = chars * (history.tokensPerChar || DEFAULT_TOKENS_PER_CHAR)
 *   4. Apply complexity multiplier.
 *   5. Floor at DEFAULT_MIN_TOKENS so trivial goals still reserve budget.
 *   6. Duration = history avg if available, else DEFAULT_DURATION_MS.
 *   7. Confidence scales with sample size (cap 0.9, default 0).
 *
 * @param {object|string} goal - `{task, options?}` or task string
 * @param {{
 *   listSessions?: Function,
 *   readEvents?: Function,
 *   cap?: number,
 * }} [opts]
 * @returns {{estimatedTokens:number, estimatedDurationMs:number,
 *   confidence:number, basedOnNSessions:number, complexity:string,
 *   tokensPerCharUsed:number}}
 */
export function predictCost(goal, opts = {}) {
  const src = typeof goal === 'string' ? { task: goal } : (goal && typeof goal === 'object' ? goal : {});
  const task = typeof src.task === 'string' ? src.task : '';
  const chars = task.length;
  const complexity = classifyComplexity(task);
  const mult = COMPLEXITY_MULT[complexity];
  const deps = {
    listSessions: typeof opts.listSessions === 'function' ? opts.listSessions : defaultListSessions,
    readEvents: typeof opts.readEvents === 'function' ? opts.readEvents : defaultReadEvents,
    cap: Number.isFinite(opts.cap) && opts.cap > 0 ? Math.floor(opts.cap) : HISTORY_SESSION_CAP,
  };
  const history = rollHistory(deps);
  const tokensPerCharUsed = history.tokensPerChar > 0 ? history.tokensPerChar : DEFAULT_TOKENS_PER_CHAR;
  const baseTokens = Math.max(chars, 1) * tokensPerCharUsed;
  const adjusted = baseTokens * mult;
  const estimatedTokens = Math.max(DEFAULT_MIN_TOKENS, Math.round(adjusted));
  const estimatedDurationMs = history.avgDurationMs > 0
    ? Math.round(history.avgDurationMs * mult)
    : DEFAULT_DURATION_MS;
  return {
    estimatedTokens,
    estimatedDurationMs,
    confidence: confidenceFor(history.n),
    basedOnNSessions: history.n,
    complexity,
    tokensPerCharUsed: Math.round(tokensPerCharUsed * 100) / 100,
  };
}
