/**
 * Multi-session aggregator (v3.9.0).
 *
 * Streams a JSONL event file (see hook-event-emitter envelope schema v1) and
 * computes cross-session rollups for the Aggregates / Sessions dashboard tabs.
 *
 * Contract:
 *  - Pure functions; no global mutation, no network.
 *  - Loopback-only policy inherited from the host server.
 *  - Ignores malformed lines (best-effort tailing of append-only logs).
 *
 * @module lib/runtime/dashboard/aggregator
 */

import { existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Default histogram buckets for token totals. Edges are exclusive on the
 * upper bound except the last bucket which is "+Inf".
 * @type {ReadonlyArray<number>}
 */
export const DEFAULT_TOKEN_BUCKETS = Object.freeze([
  0, 100, 500, 1000, 5000, 10000, 50000, 100000,
]);

/**
 * Read all JSONL envelopes from a file. Returns [] for missing files.
 * @param {string} file
 * @returns {Promise<Array<object>>}
 */
export async function readEnvelopes(file) {
  if (!file || !existsSync(file)) return [];
  const out = [];
  const rl = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') out.push(obj);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

/**
 * Extract token count from an envelope, returning 0 when unknown.
 * Scans common shapes emitted by PostToolUse / SessionEnd payloads.
 * @param {object} env
 * @returns {number}
 */
export function extractTokens(env) {
  const p = env?.payload;
  if (!p || typeof p !== 'object') return 0;
  if (typeof p.tokens === 'number' && Number.isFinite(p.tokens)) return p.tokens;
  if (typeof p.totalTokens === 'number' && Number.isFinite(p.totalTokens)) return p.totalTokens;
  if (p.usage && typeof p.usage === 'object') {
    const input = Number(p.usage.input_tokens ?? p.usage.inputTokens ?? 0);
    const output = Number(p.usage.output_tokens ?? p.usage.outputTokens ?? 0);
    const total = input + output;
    if (Number.isFinite(total)) return total;
  }
  return 0;
}

/**
 * Parse the envelope timestamp into a finite epoch-ms number, or NaN.
 * @param {object} env
 * @returns {number}
 */
export function envTime(env) {
  const t = env?.timestamp;
  if (typeof t !== 'string') return Number.NaN;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/**
 * Group envelopes by sessionId and summarize.
 * @param {Array<object>} envelopes
 * @returns {Array<{sessionId: string, startedAt: string|null, endedAt: string|null, durationMs: number, eventCount: number, toolCount: number, errorCount: number, tokenTotal: number}>}
 */
export function groupSessions(envelopes) {
  /** @type {Map<string, any>} */
  const map = new Map();
  for (const env of envelopes) {
    const id = typeof env?.sessionId === 'string' && env.sessionId.length > 0
      ? env.sessionId : 'system';
    let s = map.get(id);
    if (!s) {
      s = {
        sessionId: id,
        firstMs: Number.POSITIVE_INFINITY,
        lastMs: Number.NEGATIVE_INFINITY,
        eventCount: 0,
        toolCount: 0,
        errorCount: 0,
        tokenTotal: 0,
      };
      map.set(id, s);
    }
    s.eventCount += 1;
    const ms = envTime(env);
    if (Number.isFinite(ms)) {
      if (ms < s.firstMs) s.firstMs = ms;
      if (ms > s.lastMs) s.lastMs = ms;
    }
    if (env?.event === 'PostToolUse') {
      s.toolCount += 1;
      if (env?.payload?.ok === false) s.errorCount += 1;
    }
    if (env?.event === 'ErrorRaised') s.errorCount += 1;
    s.tokenTotal += extractTokens(env);
  }
  const sessions = [];
  for (const s of map.values()) {
    const startedAt = Number.isFinite(s.firstMs) ? new Date(s.firstMs).toISOString() : null;
    const endedAt = Number.isFinite(s.lastMs) ? new Date(s.lastMs).toISOString() : null;
    const durationMs = Number.isFinite(s.firstMs) && Number.isFinite(s.lastMs)
      ? Math.max(0, s.lastMs - s.firstMs)
      : 0;
    sessions.push({
      sessionId: s.sessionId,
      startedAt,
      endedAt,
      durationMs,
      eventCount: s.eventCount,
      toolCount: s.toolCount,
      errorCount: s.errorCount,
      tokenTotal: s.tokenTotal,
    });
  }
  // Most recent first.
  sessions.sort((a, b) => {
    const at = a.endedAt ? Date.parse(a.endedAt) : 0;
    const bt = b.endedAt ? Date.parse(b.endedAt) : 0;
    return bt - at;
  });
  return sessions;
}

/**
 * Top N tools by PostToolUse frequency.
 * @param {Array<object>} envelopes
 * @param {number} [n=10]
 * @returns {Array<{tool: string, count: number, errorCount: number, errorRate: number}>}
 */
export function getToolUsageTop(envelopes, n = 10) {
  const counts = new Map();
  for (const env of envelopes) {
    if (env?.event !== 'PostToolUse') continue;
    const tool = typeof env.tool === 'string' && env.tool.length > 0 ? env.tool : 'unknown';
    let c = counts.get(tool);
    if (!c) { c = { count: 0, errorCount: 0 }; counts.set(tool, c); }
    c.count += 1;
    if (env?.payload?.ok === false) c.errorCount += 1;
  }
  const entries = Array.from(counts.entries()).map(([tool, c]) => ({
    tool,
    count: c.count,
    errorCount: c.errorCount,
    errorRate: c.count === 0 ? 0 : Math.round((c.errorCount / c.count) * 1000) / 10,
  }));
  entries.sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
  const limit = Number.isInteger(n) && n > 0 ? n : 10;
  return entries.slice(0, limit);
}

/**
 * Error-rate trend bucketed by day (UTC YYYY-MM-DD).
 * Only PostToolUse envelopes count toward tool totals; ErrorRaised adds to the
 * error numerator but not the tool denominator.
 * @param {Array<object>} envelopes
 * @param {number} [windowDays=7]
 * @returns {Array<{day: string, total: number, errors: number, rate: number}>}
 */
export function getErrorRateTrend(envelopes, windowDays = 7) {
  const days = Number.isInteger(windowDays) && windowDays > 0 ? windowDays : 7;
  const now = Date.now();
  const cutoff = now - days * DAY_MS;
  /** @type {Map<string, {total: number, errors: number}>} */
  const byDay = new Map();
  for (const env of envelopes) {
    const ms = envTime(env);
    if (!Number.isFinite(ms) || ms < cutoff) continue;
    const day = new Date(ms).toISOString().slice(0, 10);
    let d = byDay.get(day);
    if (!d) { d = { total: 0, errors: 0 }; byDay.set(day, d); }
    if (env?.event === 'PostToolUse') {
      d.total += 1;
      if (env?.payload?.ok === false) d.errors += 1;
    } else if (env?.event === 'ErrorRaised') {
      d.errors += 1;
    }
  }
  const series = Array.from(byDay.entries()).map(([day, v]) => ({
    day,
    total: v.total,
    errors: v.errors,
    rate: v.total === 0 ? 0 : Math.round((v.errors / v.total) * 1000) / 10,
  }));
  series.sort((a, b) => a.day.localeCompare(b.day));
  return series;
}

/**
 * Bucket per-session token totals into a histogram.
 * @param {Array<object>} envelopes
 * @param {ReadonlyArray<number>} [buckets]
 * @returns {Array<{label: string, lower: number, upper: number|null, count: number}>}
 */
export function getTokenHistogram(envelopes, buckets = DEFAULT_TOKEN_BUCKETS) {
  const edges = Array.isArray(buckets) && buckets.length > 0
    ? [...buckets].map(Number).filter(Number.isFinite).sort((a, b) => a - b)
    : [...DEFAULT_TOKEN_BUCKETS];
  const sessions = groupSessions(envelopes);
  const out = [];
  for (let i = 0; i < edges.length; i++) {
    const lower = edges[i];
    const upper = i + 1 < edges.length ? edges[i + 1] : null;
    const label = upper === null ? `${lower}+` : `${lower}-${upper}`;
    out.push({ label, lower, upper, count: 0 });
  }
  for (const s of sessions) {
    const v = s.tokenTotal;
    // Find last bucket whose lower <= v.
    let idx = 0;
    for (let i = 0; i < edges.length; i++) {
      if (v >= edges[i]) idx = i;
    }
    out[idx].count += 1;
  }
  return out;
}

/**
 * Factory for a read-only aggregator bound to an event file.
 *
 * @param {object} opts
 * @param {string} opts.eventFile absolute JSONL path
 * @param {number} [opts.windowDays=7] trend window in days
 * @returns {{
 *   getSessions: () => Promise<Array<object>>,
 *   getToolUsageTop: (n?: number) => Promise<Array<object>>,
 *   getErrorRateTrend: () => Promise<Array<object>>,
 *   getTokenHistogram: (buckets?: ReadonlyArray<number>) => Promise<Array<object>>,
 *   getAll: () => Promise<{sessions: Array<object>, toolUsageTop: Array<object>, errorRateTrend: Array<object>, tokenHistogram: Array<object>}>,
 * }}
 */
export function createAggregator(opts = {}) {
  const eventFile = typeof opts.eventFile === 'string' ? opts.eventFile : '';
  const windowDays = Number.isInteger(opts.windowDays) && opts.windowDays > 0
    ? opts.windowDays : 7;

  async function load() {
    return readEnvelopes(eventFile);
  }

  return {
    async getSessions() {
      return groupSessions(await load());
    },
    async getToolUsageTop(n = 10) {
      return getToolUsageTop(await load(), n);
    },
    async getErrorRateTrend() {
      return getErrorRateTrend(await load(), windowDays);
    },
    async getTokenHistogram(buckets) {
      return getTokenHistogram(await load(), buckets);
    },
    async getAll() {
      const envs = await load();
      return {
        sessions: groupSessions(envs),
        toolUsageTop: getToolUsageTop(envs, 10),
        errorRateTrend: getErrorRateTrend(envs, windowDays),
        tokenHistogram: getTokenHistogram(envs),
      };
    },
  };
}
