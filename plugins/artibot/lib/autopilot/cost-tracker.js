/**
 * Autopilot per-phase cost/token tracker (PRD v4.9 autopilot cost integration).
 *
 * Default-ON contract: integrated into the regular /autopilot default flow,
 * NOT a sub-command. Engine.js stays untouched; integration goes through
 * _engine-helpers thin wrappers so the engine 800-line cap is preserved.
 *
 * Public surface (all best-effort — never throw into engine hot path):
 *   - recordPhaseUsage(sessionId, phase, usage)
 *   - getSessionCost(sessionId)
 *   - checkBudgetThreshold(sessionId, opts)
 *   - renderCostBlock(summary)
 *   - renderCostInline(summary)
 *
 * State shape (mutates `state.usage`):
 *   state.usage = {
 *     totals: { tokensIn, tokensOut, costUsd },
 *     phases: { [phase]: { tokensIn, tokensOut, costUsd, model?, lastTs } },
 *     thresholdsFired: number[]   // de-dup 50/80/95 alerts
 *   }
 *
 * DATA POLICY: 100% local file I/O; no external transmission. Korean-path safe
 * (delegates to session-store which uses path.join + atomic writes).
 *
 * @module lib/autopilot/cost-tracker
 */

import { loadSession as defaultLoadSession, saveSession as defaultSaveSession } from './session-store.js';
import { appendEvent as defaultAppendEvent } from './telemetry.js';

const BUDGET_THRESHOLDS = Object.freeze([50, 80, 95]);

/**
 * Coerce a numeric input into a non-negative finite number, treating
 * NaN / negative / non-numeric as 0.
 * @param {unknown} n
 * @returns {number}
 */
function safeNum(n) {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return v;
}

/**
 * Validate that a sessionId/phase pair is a usable non-empty string pair.
 * @param {unknown} sessionId
 * @param {unknown} phase
 * @returns {boolean}
 */
function isValidIds(sessionId, phase) {
  return typeof sessionId === 'string' && sessionId.length > 0
    && typeof phase === 'string' && phase.length > 0;
}

/**
 * Return a normalized state.usage container, creating empty defaults when
 * absent or malformed. Never mutates the input.
 * @param {object|null|undefined} state
 * @returns {{ totals: {tokensIn:number, tokensOut:number, costUsd:number},
 *             phases: object, thresholdsFired: number[] }}
 */
function normalizeUsage(state) {
  const src = state && typeof state.usage === 'object' && state.usage !== null
    ? state.usage : {};
  const totals = src.totals && typeof src.totals === 'object' ? src.totals : {};
  const phases = src.phases && typeof src.phases === 'object' ? src.phases : {};
  const fired = Array.isArray(src.thresholdsFired)
    ? src.thresholdsFired.filter((n) => Number.isFinite(n))
    : [];
  return {
    totals: {
      tokensIn: safeNum(totals.tokensIn),
      tokensOut: safeNum(totals.tokensOut),
      costUsd: safeNum(totals.costUsd),
    },
    phases,
    thresholdsFired: fired,
  };
}

/**
 * Merge an incoming usage delta into the state.usage container in-place.
 * @param {ReturnType<typeof normalizeUsage>} usage
 * @param {string} phase
 * @param {{tokensIn:number, tokensOut:number, costUsd:number, model?:string}} delta
 * @returns {void}
 */
function applyDelta(usage, phase, delta) {
  const prev = usage.phases[phase] && typeof usage.phases[phase] === 'object'
    ? usage.phases[phase] : { tokensIn: 0, tokensOut: 0, costUsd: 0 };
  const next = {
    tokensIn: safeNum(prev.tokensIn) + delta.tokensIn,
    tokensOut: safeNum(prev.tokensOut) + delta.tokensOut,
    costUsd: safeNum(prev.costUsd) + delta.costUsd,
    lastTs: new Date().toISOString(),
  };
  if (typeof delta.model === 'string' && delta.model.length > 0) {
    next.model = delta.model;
  } else if (typeof prev.model === 'string') {
    next.model = prev.model;
  }
  usage.phases[phase] = next;
  usage.totals.tokensIn += delta.tokensIn;
  usage.totals.tokensOut += delta.tokensOut;
  usage.totals.costUsd += delta.costUsd;
}

/**
 * Record token + cost usage for a single (sessionId, phase) tuple.
 * Appends a `usage` telemetry event and persists the updated state.
 * Silent no-op on invalid ids or persistence failure (hot-path safe).
 *
 * @param {string} sessionId
 * @param {string} phase
 * @param {{tokensIn?:number, tokensOut?:number, costUsd?:number, model?:string}} usage
 * @param {{loadSession?:Function, saveSession?:Function, appendEvent?:Function}} [opts]
 * @returns {{tokensIn:number, tokensOut:number, costUsd:number}|null}
 */
export function recordPhaseUsage(sessionId, phase, usage, opts = {}) {
  if (!isValidIds(sessionId, phase)) return null;
  const u = usage && typeof usage === 'object' ? usage : {};
  const delta = {
    tokensIn: safeNum(u.tokensIn),
    tokensOut: safeNum(u.tokensOut),
    costUsd: safeNum(u.costUsd),
    model: typeof u.model === 'string' ? u.model : undefined,
  };
  const load = typeof opts.loadSession === 'function' ? opts.loadSession : defaultLoadSession;
  const save = typeof opts.saveSession === 'function' ? opts.saveSession : defaultSaveSession;
  const tel = typeof opts.appendEvent === 'function' ? opts.appendEvent : defaultAppendEvent;
  try {
    const state = load(sessionId);
    if (!state || typeof state !== 'object') return null;
    const usageState = normalizeUsage(state);
    applyDelta(usageState, phase, delta);
    state.usage = usageState;
    save(state);
    try {
      tel(sessionId, {
        phase, type: 'usage', level: 'info',
        message: `usage +${delta.tokensIn}/+${delta.tokensOut} tok, +$${delta.costUsd.toFixed(4)}`,
        data: { ...delta },
      });
    } catch { /* telemetry best-effort */ }
    return delta;
  } catch {
    return null;
  }
}

/**
 * Build per-phase breakdown array sorted by phase insertion order.
 * @param {object} phases
 * @returns {Array<{phase:string, tokensIn:number, tokensOut:number, costUsd:number}>}
 */
function perPhaseArray(phases) {
  const out = [];
  for (const [phase, entry] of Object.entries(phases || {})) {
    if (!entry || typeof entry !== 'object') continue;
    out.push({
      phase,
      tokensIn: safeNum(entry.tokensIn),
      tokensOut: safeNum(entry.tokensOut),
      costUsd: safeNum(entry.costUsd),
    });
  }
  return out;
}

/**
 * Compute budget usage block from totals and a numeric limit.
 * Returns null when limit is missing / <= 0 (no-budget mode).
 * @param {number} costUsd
 * @param {unknown} limit
 * @returns {{limit:number, used:number, percent:number}|null}
 */
function computeBudgetUsage(costUsd, limit) {
  const lim = safeNum(limit);
  if (lim <= 0) return null;
  const used = safeNum(costUsd);
  const percent = Math.round((used / lim) * 1000) / 10; // one decimal
  return { limit: lim, used, percent };
}

/**
 * Get full cost summary for a session.
 * Returns zeroed empty summary when session is missing.
 *
 * @param {string} sessionId
 * @param {{loadSession?:Function}} [opts]
 * @returns {{
 *   totalTokens:number, totalCostUsd:number,
 *   perPhase:Array<{phase:string, tokensIn:number, tokensOut:number, costUsd:number}>,
 *   budgetUsage:{limit:number, used:number, percent:number}|null
 * }}
 */
export function getSessionCost(sessionId, opts = {}) {
  const empty = { totalTokens: 0, totalCostUsd: 0, perPhase: [], budgetUsage: null };
  if (typeof sessionId !== 'string' || sessionId.length === 0) return empty;
  const load = typeof opts.loadSession === 'function' ? opts.loadSession : defaultLoadSession;
  let state;
  try { state = load(sessionId); } catch { state = null; }
  if (!state || typeof state !== 'object') return empty;
  const usage = normalizeUsage(state);
  const perPhase = perPhaseArray(usage.phases);
  const totalTokens = usage.totals.tokensIn + usage.totals.tokensOut;
  const budgetUsage = computeBudgetUsage(usage.totals.costUsd, state.options?.budget);
  return {
    totalTokens,
    totalCostUsd: usage.totals.costUsd,
    perPhase,
    budgetUsage,
  };
}

/**
 * Check whether the session's cumulative spend just crossed a 50/80/95% line.
 * Returns the largest newly-crossed threshold or null if none.
 * Persists `thresholdsFired` so each threshold fires at most once per session.
 *
 * @param {string} sessionId
 * @param {{limitUsd:number, loadSession?:Function, saveSession?:Function}} opts
 * @returns {{crossed: 50|80|95|null, used:number, percent:number}}
 */
export function checkBudgetThreshold(sessionId, opts = {}) {
  const empty = { crossed: null, used: 0, percent: 0 };
  if (typeof sessionId !== 'string' || sessionId.length === 0) return empty;
  const limit = safeNum(opts.limitUsd);
  if (limit <= 0) return empty;
  const load = typeof opts.loadSession === 'function' ? opts.loadSession : defaultLoadSession;
  const save = typeof opts.saveSession === 'function' ? opts.saveSession : defaultSaveSession;
  let state;
  try { state = load(sessionId); } catch { state = null; }
  if (!state || typeof state !== 'object') return empty;
  const usage = normalizeUsage(state);
  const used = usage.totals.costUsd;
  const percent = Math.round((used / limit) * 1000) / 10;
  const fired = new Set(usage.thresholdsFired);
  let crossed = null;
  for (const t of BUDGET_THRESHOLDS) {
    if (percent >= t && !fired.has(t)) {
      crossed = t;
      fired.add(t);
    }
  }
  if (crossed !== null) {
    try {
      usage.thresholdsFired = [...fired].sort((a, b) => a - b);
      state.usage = usage;
      save(state);
    } catch { /* best-effort */ }
  }
  return { crossed, used, percent };
}

/**
 * Format a USD amount as `$0.0000` with 4-decimal precision (small costs
 * dominate per-phase usage, so 4 decimals avoids rounding to $0.00).
 * @param {number} n
 * @returns {string}
 */
function fmtUsd(n) {
  const v = safeNum(n);
  return `$${v.toFixed(4)}`;
}

/**
 * Format a token count as compact human string (e.g. 12.3k, 1.2M).
 * @param {number} n
 * @returns {string}
 */
function fmtTok(n) {
  const v = safeNum(n);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(Math.round(v));
}

/**
 * Render a getSessionCost summary as a GFM markdown block.
 * Returns an empty string when there's no usage to show (caller pattern is
 * `${costBlock ? `\n${costBlock}\n` : ''}` like phase-diff).
 *
 * @param {ReturnType<typeof getSessionCost>} summary
 * @returns {string}
 */
export function renderCostBlock(summary) {
  const s = summary && typeof summary === 'object' ? summary : null;
  if (!s) return '';
  const perPhase = Array.isArray(s.perPhase) ? s.perPhase : [];
  if (perPhase.length === 0 && safeNum(s.totalCostUsd) === 0) return '';
  const header = '## Phase Cost (auto-generated from usage events)';
  const head = '| Phase | tokens in | tokens out | cost |';
  const sep = '|---|---|---|---|';
  const rows = perPhase.map((p) => `| ${p.phase} | ${fmtTok(p.tokensIn)} | ${fmtTok(p.tokensOut)} | ${fmtUsd(p.costUsd)} |`);
  const total = `\n\n**Total**: ${fmtTok(safeNum(s.totalTokens))} tokens, ${fmtUsd(s.totalCostUsd)}`;
  const budget = s.budgetUsage
    ? `\n**Budget**: ${fmtUsd(s.budgetUsage.used)} / ${fmtUsd(s.budgetUsage.limit)} (${s.budgetUsage.percent}%)`
    : '';
  const body = rows.length > 0
    ? [head, sep, ...rows].join('\n')
    : '_(usage 데이터 없음 — phase별 토큰 기록 없음)_';
  return `${header}\n\n${body}${total}${budget}`;
}

/**
 * Render a one-line TUI footer summary. Returns '' when there's nothing to show.
 *   `cost: $0.23 / $5.00 (4.6%) — INTAKE 12k/2k`
 *
 * @param {ReturnType<typeof getSessionCost>} summary
 * @returns {string}
 */
export function renderCostInline(summary) {
  const s = summary && typeof summary === 'object' ? summary : null;
  if (!s) return '';
  if (safeNum(s.totalCostUsd) === 0 && (!Array.isArray(s.perPhase) || s.perPhase.length === 0)) {
    return '';
  }
  const head = s.budgetUsage
    ? `cost: ${fmtUsd(s.budgetUsage.used)} / ${fmtUsd(s.budgetUsage.limit)} (${s.budgetUsage.percent}%)`
    : `cost: ${fmtUsd(s.totalCostUsd)}`;
  const perPhase = Array.isArray(s.perPhase) ? s.perPhase : [];
  const last = perPhase[perPhase.length - 1];
  if (!last) return head;
  const tail = `${last.phase} ${fmtTok(last.tokensIn)}/${fmtTok(last.tokensOut)}`;
  return `${head} \u2014 ${tail}`;
}
