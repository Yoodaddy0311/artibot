/**
 * Cross-session pattern learner for autopilot (v4.10.0 Track G).
 *
 * Scans recent local sessions, extracts common phase orderings, iteration
 * counts and contract-field usage, then recommends defaults for new goals
 * based on those patterns.
 *
 * DATA POLICY: only reads sessions persisted under runtime/autopilot via the
 * existing session-store API. Nothing leaves the machine.
 *
 * All collaborators are injectable for tests: `sessionLoader` defaults to
 * the real `listSessions` + `loadSession` pair but can be replaced with a
 * pure in-memory stub.
 *
 * Public surface:
 *   - scanRecentSessions(opts?)
 *   - extractSuccessPatterns(sessions)
 *   - recommendDefaults(goal, opts?)
 *
 * @module lib/autopilot/cross-session-learner
 */

import { listSessions, loadSession } from './session-store.js';
import { classifyTaskComplexity, recommendSkippablePhases } from './smart-skip.js';

/** Default max sessions to inspect — keeps the scan O(N) bounded. */
export const DEFAULT_SCAN_LIMIT = 20;

/**
 * Default session loader: thin wrapper around session-store. Tests inject
 * a stub instead.
 *
 * @returns {{ listIds: () => string[], load: (id: string) => object|null }}
 */
function defaultSessionLoader() {
  return {
    listIds: () => listSessions(),
    load: (id) => loadSession(id),
  };
}

/**
 * Decide whether a session counts as "successful" for pattern extraction.
 * We accept either an explicit success flag or a terminal phase of REPORT
 * with no `failedAt` marker.
 *
 * @param {object} session
 * @returns {boolean}
 */
function isSuccess(session) {
  if (!session || typeof session !== 'object') return false;
  if (session.success === true) return true;
  if (session.status === 'completed' || session.status === 'success') return true;
  if (session.failedAt) return false;
  return session.phase === 'REPORT' || session.phase === 'COMPLETED';
}

/**
 * Load the most recent N sessions, newest-first. Sessions that fail to load
 * (corrupt JSON, etc.) are skipped without throwing.
 *
 * Session IDs follow the `ap-YYYYMMDD-HHmmss-xxxx` pattern emitted by
 * `newSessionId()`, so lexicographic sort places newest last → we reverse.
 *
 * @param {{ limit?: number, sessionLoader?: { listIds: () => string[], load: (id: string) => object|null } }} [opts]
 * @returns {object[]} loaded session state objects (newest first)
 */
export function scanRecentSessions(opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_SCAN_LIMIT;
  const loader = opts.sessionLoader || defaultSessionLoader();
  let ids;
  try {
    ids = loader.listIds();
  } catch {
    return [];
  }
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const sorted = [...ids].sort().reverse().slice(0, limit);
  const out = [];
  for (const id of sorted) {
    let s;
    try {
      s = loader.load(id);
    } catch {
      continue;
    }
    if (s && typeof s === 'object') out.push(s);
  }
  return out;
}

/**
 * Extract phase ordering from a session. Falls back to `timeline` entries
 * when no explicit `phases` array is present.
 *
 * @param {object} session
 * @returns {string[]}
 */
function phaseOrderingOf(session) {
  if (Array.isArray(session.phases) && session.phases.length > 0) {
    return session.phases
      .map((p) => (p && typeof p === 'object' ? p.name : p))
      .filter((n) => typeof n === 'string' && n.length > 0);
  }
  // A `session.timeline` fallback used to sit here. It was unreachable in
  // practice: nothing ever wrote phase records into that field, so it was
  // either absent or an empty array and this branch returned []. `state.phases`
  // above is the live record; sessions without it have no ordering to report.
  return [];
}

/**
 * Find the most frequent value in a list. Returns `null` for empty input.
 *
 * @template T
 * @param {T[]} values
 * @returns {T|null}
 */
function mode(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const counts = new Map();
  for (const v of values) {
    const key = JSON.stringify(v);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let bestKey = null;
  let bestCount = -1;
  for (const [k, c] of counts) {
    if (c > bestCount) {
      bestCount = c;
      bestKey = k;
    }
  }
  return bestKey === null ? null : JSON.parse(bestKey);
}

/**
 * Average a numeric array, rounded to one decimal. NaN/non-numbers ignored.
 *
 * @param {number[]} values
 * @returns {number|null}
 */
function avg(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (nums.length === 0) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return Math.round((sum / nums.length) * 10) / 10;
}

/**
 * Collect contract field usage across sessions. Only counts fields that the
 * Goal Contract schema knows about so unrelated state slots don't leak in.
 *
 * @param {object[]} sessions
 * @returns {Record<string, number>}
 */
function contractFieldFrequency(sessions) {
  const fields = ['objective', 'stoppingCondition', 'validationCommand', 'forbiddenChanges', 'maxIterations'];
  const counts = {};
  for (const f of fields) counts[f] = 0;
  for (const s of sessions) {
    const c = s && typeof s === 'object' ? s.goalContract || s.contract : null;
    if (!c || typeof c !== 'object') continue;
    for (const f of fields) {
      const v = c[f];
      if (v === undefined || v === null) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      if (typeof v === 'string' && v.trim() === '') continue;
      counts[f] += 1;
    }
  }
  return counts;
}

/**
 * Compute aggregate statistics from a list of session state objects.
 * Only sessions classified as successful contribute to phase-ordering and
 * iteration-count averages; all sessions feed `total` / `successCount`.
 *
 * @param {object[]} sessions
 * @returns {{
 *   total: number,
 *   successCount: number,
 *   commonPhaseOrdering: string[]|null,
 *   avgIterations: number|null,
 *   contractFields: Record<string, number>,
 * }}
 */
export function extractSuccessPatterns(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return {
      total: 0,
      successCount: 0,
      commonPhaseOrdering: null,
      avgIterations: null,
      contractFields: {},
    };
  }
  const successes = sessions.filter(isSuccess);
  const orderings = successes.map(phaseOrderingOf).filter((o) => o.length > 0);
  const iterations = successes
    .map((s) => (typeof s.iterations === 'number' ? s.iterations : (Array.isArray(s.iterationHistory) ? s.iterationHistory.length : null)))
    .filter((n) => Number.isFinite(n));
  return {
    total: sessions.length,
    successCount: successes.length,
    commonPhaseOrdering: mode(orderings),
    avgIterations: avg(iterations),
    contractFields: contractFieldFrequency(successes),
  };
}

/**
 * Recommend defaults for a new goal by combining cross-session patterns with
 * complexity-based smart-skip advice.
 *
 * The result is purely advisory — callers compose it into the contract or
 * surface it in the TUI. Nothing is auto-applied here.
 *
 * @param {string} goal
 * @param {{ limit?: number, sessionLoader?: { listIds: () => string[], load: (id: string) => object|null } }} [opts]
 * @returns {{
 *   complexity: { level: string, score: number, factors: string[] },
 *   skip: { skip: string[], keep: string[], rationale: string },
 *   suggestedMaxIterations: number|null,
 *   suggestedPhaseOrdering: string[]|null,
 *   contractFieldHints: Record<string, number>,
 *   sampledSessions: number,
 * }}
 */
export function recommendDefaults(goal, opts = {}) {
  const complexity = classifyTaskComplexity(goal);
  const skip = recommendSkippablePhases(complexity);
  const sessions = scanRecentSessions(opts);
  const patterns = extractSuccessPatterns(sessions);
  const suggestedIter = patterns.avgIterations !== null
    ? Math.max(1, Math.min(10, Math.round(patterns.avgIterations)))
    : null;
  return {
    complexity,
    skip,
    suggestedMaxIterations: suggestedIter,
    suggestedPhaseOrdering: patterns.commonPhaseOrdering,
    contractFieldHints: patterns.contractFields,
    sampledSessions: patterns.total,
  };
}
