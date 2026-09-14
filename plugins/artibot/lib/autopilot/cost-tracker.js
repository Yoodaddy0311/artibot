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
 *     thresholdsFired: { tokens: number[], usd: number[] },  // de-dup per unit
 *     receipts: string[]   // seen receiptIds, newest last, capped
 *   }
 *
 * Budgets are tracked in TWO independent units — tokens and USD. A legacy
 * `thresholdsFired: number[]` migrates into the `usd` list, because the
 * pre-F03 check compared USD spend only.
 *
 * DATA POLICY: 100% local file I/O; no external transmission. Korean-path safe
 * (delegates to session-store which uses path.join + atomic writes).
 *
 * @module lib/autopilot/cost-tracker
 */

import { loadSession as defaultLoadSession, saveSession as defaultSaveSession } from './session-store.js';
import { appendEvent as defaultAppendEvent } from './telemetry.js';
import { normalizeBudget, readUsage } from './safety.js';

const BUDGET_THRESHOLDS = Object.freeze([50, 80, 95]);

/** Max receiptIds retained per session (oldest dropped first). */
const RECEIPT_CAP = 200;

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
 * Keep only finite numbers from a possibly-malformed threshold list.
 * @param {unknown} list
 * @returns {number[]}
 */
function firedList(list) {
  return Array.isArray(list) ? list.filter((n) => Number.isFinite(n)) : [];
}

/**
 * Normalize `thresholdsFired` into the two-unit shape, migrating the legacy
 * `number[]` into `usd` — that list was written by the USD-only check, so
 * replaying it as token thresholds would silently re-fire or suppress alerts
 * in the wrong unit.
 * @param {unknown} src
 * @returns {{tokens:number[], usd:number[]}}
 */
function normalizeThresholds(src) {
  if (Array.isArray(src)) return { tokens: [], usd: firedList(src) };
  if (src && typeof src === 'object') {
    return { tokens: firedList(src.tokens), usd: firedList(src.usd) };
  }
  return { tokens: [], usd: [] };
}

/**
 * Return a normalized state.usage container, creating empty defaults when
 * absent or malformed. Never mutates the input.
 * @param {object|null|undefined} state
 * @returns {{ totals: {tokensIn:number, tokensOut:number, costUsd:number},
 *             phases: object, thresholdsFired: {tokens:number[], usd:number[]},
 *             receipts: string[], unknownWarnedAt?: string }}
 */
function normalizeUsage(state) {
  const src = state && typeof state.usage === 'object' && state.usage !== null
    ? state.usage : {};
  const totals = src.totals && typeof src.totals === 'object' ? src.totals : {};
  const phases = src.phases && typeof src.phases === 'object' ? src.phases : {};
  const receipts = Array.isArray(src.receipts)
    ? src.receipts.filter((r) => typeof r === 'string' && r.length > 0)
    : [];
  const out = {
    totals: {
      tokensIn: safeNum(totals.tokensIn),
      tokensOut: safeNum(totals.tokensOut),
      costUsd: safeNum(totals.costUsd),
    },
    phases,
    thresholdsFired: normalizeThresholds(src.thresholdsFired),
    receipts: receipts.slice(-RECEIPT_CAP),
  };
  // Carried through so a usage write does not reset the engine's
  // once-per-session unknown-usage warning flag.
  if (typeof src.unknownWarnedAt === 'string') out.unknownWarnedAt = src.unknownWarnedAt;
  return out;
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
 * A payload carrying a `receiptId` is recorded at most once: a retried or
 * replayed usage event must not inflate the totals the budget gate reads.
 * Payloads without a `receiptId` keep the original always-record behavior.
 *
 * @param {string} sessionId
 * @param {string} phase
 * @param {{tokensIn?:number, tokensOut?:number, costUsd?:number, model?:string,
 *          receiptId?:string}} usage
 * @param {{loadSession?:Function, saveSession?:Function, appendEvent?:Function}} [opts]
 * @returns {{tokensIn:number, tokensOut:number, costUsd:number}|null} null when
 *   the payload was a duplicate or the write failed
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
  const receiptId = typeof u.receiptId === 'string' && u.receiptId.length > 0
    ? u.receiptId : null;
  const load = typeof opts.loadSession === 'function' ? opts.loadSession : defaultLoadSession;
  const save = typeof opts.saveSession === 'function' ? opts.saveSession : defaultSaveSession;
  const tel = typeof opts.appendEvent === 'function' ? opts.appendEvent : defaultAppendEvent;
  try {
    const state = load(sessionId);
    if (!state || typeof state !== 'object') return null;
    const usageState = normalizeUsage(state);
    if (receiptId !== null && usageState.receipts.includes(receiptId)) {
      try {
        tel(sessionId, {
          phase, type: 'usage-duplicate', level: 'info',
          message: `usage receipt ${receiptId} already recorded — ignored`,
          data: { receiptId, phase },
        });
      } catch { /* telemetry best-effort */ }
      return null;
    }
    applyDelta(usageState, phase, delta);
    if (receiptId !== null) {
      usageState.receipts = [...usageState.receipts, receiptId].slice(-RECEIPT_CAP);
    }
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
 * Build one `{limit, used, percent}` block, or null when the unit has no
 * limit. `used`/`percent` are null when usage was never measured.
 * @param {number|null} limit
 * @param {number|null} used
 * @returns {{limit:number, used:number|null, percent:number|null}|null}
 */
function usageBlock(limit, used) {
  if (limit === null) return null;
  if (used === null || !Number.isFinite(used)) return { limit, used: null, percent: null };
  return { limit, used, percent: Math.round((used / limit) * 1000) / 10 };
}

/**
 * Compute the two-unit budget usage block for a session state.
 * Returns null only when neither unit has a limit configured (no-budget mode).
 *
 * @param {object} state - live session state
 * @returns {{tokens:object|null, usd:object|null, usageKnown:boolean,
 *            source:string, measuredAt:string|null}|null}
 */
function computeBudgetUsage(state) {
  const { budgetTokens, budgetUsd, source } = normalizeBudget(state?.options);
  if (budgetTokens === null && budgetUsd === null) return null;
  const usage = readUsage(state);
  return {
    tokens: usageBlock(budgetTokens, usage.known ? usage.tokens : null),
    usd: usageBlock(budgetUsd, usage.known ? usage.usd : null),
    usageKnown: usage.known,
    source,
    measuredAt: usage.measuredAt,
  };
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
 *   budgetUsage:{tokens:object|null, usd:object|null, usageKnown:boolean,
 *                source:string, measuredAt:string|null}|null
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
  const budgetUsage = computeBudgetUsage(state);
  return {
    totalTokens,
    totalCostUsd: usage.totals.costUsd,
    perPhase,
    budgetUsage,
  };
}

/**
 * Evaluate one unit against its own fired list.
 * @param {number|null} limit
 * @param {number|null} used
 * @param {number[]} fired
 * @returns {{block:object|null, fired:number[], changed:boolean}}
 */
function evaluateUnit(limit, used, fired) {
  if (limit === null || used === null || !Number.isFinite(used)) {
    return { block: null, fired, changed: false };
  }
  const percent = Math.round((used / limit) * 1000) / 10;
  const seen = new Set(fired);
  let crossed = null;
  for (const t of BUDGET_THRESHOLDS) {
    if (percent >= t && !seen.has(t)) {
      crossed = t;
      seen.add(t);
    }
  }
  return {
    block: {
      crossed, limit, used, percent,
    },
    fired: [...seen].sort((a, b) => a - b),
    changed: crossed !== null,
  };
}

/**
 * Resolve the limits to check: explicit opts overrides win over the limits
 * declared on the session state.
 * @param {object} state
 * @param {{limitTokens?:number, limitUsd?:number}} opts
 * @returns {{limitTokens:number|null, limitUsd:number|null}}
 */
function resolveLimits(state, opts) {
  const declared = normalizeBudget(state.options);
  const overrideTokens = safeNum(opts.limitTokens);
  const overrideUsd = safeNum(opts.limitUsd);
  return {
    limitTokens: overrideTokens > 0 ? overrideTokens : declared.budgetTokens,
    limitUsd: overrideUsd > 0 ? overrideUsd : declared.budgetUsd,
  };
}

/**
 * Pick the reported crossing: the largest newly-crossed line, with tokens
 * breaking a tie (it is the documented primary unit). When nothing crossed,
 * `used`/`percent` still report a measured unit so callers can log it.
 * @param {object|null} tokens - tokens block
 * @param {object|null} usd - usd block
 * @returns {{crossed:number|null, unit:string|null, used:number, percent:number}}
 */
function pickCrossing(tokens, usd) {
  const tokCrossed = tokens && tokens.crossed !== null ? tokens.crossed : -1;
  const usdCrossed = usd && usd.crossed !== null ? usd.crossed : -1;
  if (tokCrossed < 0 && usdCrossed < 0) {
    const fallback = tokens || usd;
    return {
      crossed: null,
      unit: null,
      used: fallback ? fallback.used : 0,
      percent: fallback ? fallback.percent : 0,
    };
  }
  const winner = tokCrossed >= usdCrossed
    ? { unit: 'tokens', block: tokens }
    : { unit: 'usd', block: usd };
  return {
    crossed: winner.block.crossed,
    unit: winner.unit,
    used: winner.block.used,
    percent: winner.block.percent,
  };
}

/**
 * Check whether the session just crossed a 50/80/95% budget line, in either
 * unit. Tokens and USD are evaluated independently against their own fired
 * lists, so a session with both limits gets both alert streams.
 *
 * Limits default to `normalizeBudget(state.options)`; `opts.limitTokens` /
 * `opts.limitUsd` are explicit overrides. Usage that was never measured
 * crosses nothing (`usageKnown:false`) — an unmeasured session is unknown,
 * not under budget.
 *
 * `thresholdsFired` is persisted so each line fires at most once per unit.
 *
 * @param {string} sessionId
 * @param {{limitTokens?:number, limitUsd?:number, loadSession?:Function,
 *          saveSession?:Function}} [opts]
 * @returns {{crossed: 50|80|95|null, unit:'tokens'|'usd'|null, used:number,
 *            percent:number, byUnit:{tokens:object|null, usd:object|null},
 *            usageKnown:boolean}}
 */
export function checkBudgetThreshold(sessionId, opts = {}) {
  const empty = {
    crossed: null,
    unit: null,
    used: 0,
    percent: 0,
    byUnit: { tokens: null, usd: null },
    usageKnown: false,
  };
  if (typeof sessionId !== 'string' || sessionId.length === 0) return empty;
  const load = typeof opts.loadSession === 'function' ? opts.loadSession : defaultLoadSession;
  const save = typeof opts.saveSession === 'function' ? opts.saveSession : defaultSaveSession;
  let state;
  try { state = load(sessionId); } catch { state = null; }
  if (!state || typeof state !== 'object') return empty;

  const { limitTokens, limitUsd } = resolveLimits(state, opts);
  if (limitTokens === null && limitUsd === null) return empty;

  const usage = normalizeUsage(state);
  const measured = readUsage(state);
  const tok = evaluateUnit(limitTokens, measured.known ? measured.tokens : null, usage.thresholdsFired.tokens);
  const usd = evaluateUnit(limitUsd, measured.known ? measured.usd : null, usage.thresholdsFired.usd);

  if (tok.changed || usd.changed) {
    try {
      usage.thresholdsFired = { tokens: tok.fired, usd: usd.fired };
      state.usage = usage;
      save(state);
    } catch { /* best-effort */ }
  }

  return {
    ...pickCrossing(tok.block, usd.block),
    byUnit: { tokens: tok.block, usd: usd.block },
    usageKnown: measured.known,
  };
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
 * Render the budget block as one string per configured unit.
 *
 * Unmeasured usage renders `unknown usage` rather than `0%` — a 0% budget
 * line on a session with no telemetry is the exact false reassurance F03 was
 * about.
 *
 * @param {object|null} budgetUsage - summary.budgetUsage (two-unit shape)
 * @returns {string[]}
 */
function budgetParts(budgetUsage) {
  const b = budgetUsage && typeof budgetUsage === 'object' ? budgetUsage : null;
  if (!b) return [];
  const hasLimit = (b.tokens && Number.isFinite(b.tokens.limit))
    || (b.usd && Number.isFinite(b.usd.limit));
  if (!hasLimit) return [];
  if (b.usageKnown === false) return ['unknown usage'];
  const parts = [];
  if (b.tokens && Number.isFinite(b.tokens.limit) && Number.isFinite(b.tokens.used)) {
    parts.push(`${fmtTok(b.tokens.used)} / ${fmtTok(b.tokens.limit)} tokens (${b.tokens.percent}%)`);
  }
  if (b.usd && Number.isFinite(b.usd.limit) && Number.isFinite(b.usd.used)) {
    parts.push(`${fmtUsd(b.usd.used)} / ${fmtUsd(b.usd.limit)} (${b.usd.percent}%)`);
  }
  return parts.length > 0 ? parts : ['unknown usage'];
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
  const parts = budgetParts(s.budgetUsage);
  const budget = parts.length > 0 ? `\n**Budget**: ${parts.join(' | ')}` : '';
  const body = rows.length > 0
    ? [head, sep, ...rows].join('\n')
    : '_(usage 데이터 없음 — phase별 토큰 기록 없음)_';
  return `${header}\n\n${body}${total}${budget}`;
}

/**
 * Render a one-line TUI footer summary. Returns '' when there's nothing to show.
 *   `cost: $0.23 — budget: 2.1M / 2.0M tokens (105%) — INTAKE 12k/2k`
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
  const parts = budgetParts(s.budgetUsage);
  const head = parts.length > 0
    ? `cost: ${fmtUsd(s.totalCostUsd)} — budget: ${parts.join(' | ')}`
    : `cost: ${fmtUsd(s.totalCostUsd)}`;
  const perPhase = Array.isArray(s.perPhase) ? s.perPhase : [];
  const last = perPhase[perPhase.length - 1];
  if (!last) return head;
  const tail = `${last.phase} ${fmtTok(last.tokensIn)}/${fmtTok(last.tokensOut)}`;
  return `${head} \u2014 ${tail}`;
}
