/**
 * Memory bridge — exposes the 3-layer memory (Working / Episodic / Semantic)
 * plus the legacy flat memory-manager API to MCP tools.
 *
 * All responses pass through `lib/core/redaction.js` before leaving this
 * module — the MCP surface must never emit raw secrets, paths, or emails.
 * The GENERIC pattern set is used (same sentinels downstream tests rely on).
 *
 * Design contract:
 *   - Zero runtime deps.
 *   - Read-only: never mutates any store; never calls saveMemory.
 *   - Dependency-injected: stores and retriever can be stubbed in tests.
 *   - Returns `{ok: true, value}` / `{ok: false, error}` shapes.
 *
 * Public API:
 *   createMemoryBridge({retriever?, workingStore?, episodicStore?,
 *                       semanticStore?, memoryManager?, redactor?})
 *     → { getMemoryStats, searchMemory }
 *
 * @module lib/mcp/bridge/memory-bridge
 */

import { redactObject, redactString } from '../../core/redaction.js';

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Tolerant count reader — accepts `size()` functions, numeric `size`, or
 * `count` fields. Returns null when nothing is readable so the caller can
 * omit the field cleanly.
 * @param {object|null|undefined} store
 * @returns {Promise<number|null>}
 */
async function safeCount(store) {
  if (!store) return null;
  try {
    if (typeof store.size === 'function') return Number(await store.size()) || 0;
    if (typeof store.count === 'function') return Number(await store.count()) || 0;
    if (typeof store.size === 'number') return store.size;
    if (typeof store.count === 'number') return store.count;
  } catch {
    return null;
  }
  return null;
}

/**
 * Redact a retriever result. Retrieved entries can carry arbitrary payload
 * data; walk the object and strip secrets. Preserves score / layer /
 * provenance so callers can reason about ranking.
 *
 * @param {unknown} result
 * @param {(v: unknown) => unknown} redact
 * @returns {object}
 */
function redactRetrievalResult(result, redact) {
  if (!result || typeof result !== 'object') return {};
  const entry = result.entry ? redact(result.entry) : null;
  return {
    entry,
    score: Number.isFinite(result.score) ? result.score : 0,
    layer: typeof result.layer === 'string' ? result.layer : null,
    provenance: result.provenance ? redact(result.provenance) : null,
  };
}

/**
 * Shape a metrics snapshot into per-layer hit-rate summary.
 * @param {object|null} snapshot
 * @returns {object}
 */
function shapeMetricsSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { working: null, episodic: null, semantic: null };
  }
  const pick = (layer) => {
    const b = snapshot[layer];
    if (!b || typeof b !== 'object') return null;
    return {
      hits: b.hits | 0,
      queries: b.queries | 0,
      rate: Number.isFinite(b.rate) ? b.rate : 0,
    };
  };
  return {
    date: typeof snapshot.date === 'string' ? snapshot.date : null,
    working: pick('working'),
    episodic: pick('episodic'),
    semantic: pick('semantic'),
  };
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create a memory bridge.
 *
 * @param {object} [deps]
 * @param {object} [deps.retriever]     - Object exposing `search(query, opts)`
 *   (see `lib/learning/memory/retriever.js`).
 * @param {object} [deps.workingStore]  - L1 store (optional)
 * @param {object} [deps.episodicStore] - L2 store (optional)
 * @param {object} [deps.semanticStore] - L3 store (optional)
 * @param {object} [deps.metrics]       - Metrics recorder exposing `snapshot()`
 * @param {object} [deps.memoryManager] - Fallback; exposes `getMemoryStats()`
 *   and `searchMemory(query, opts)` (the flat v3.1 API).
 * @param {(value: unknown) => unknown} [deps.redactor] - Override redaction.
 *
 * @returns {{
 *   getMemoryStats: () => Promise<{ok: boolean, value?: object, error?: string}>,
 *   searchMemory:   (args: {query: string, limit?: number}) => Promise<{ok: boolean, value?: object, error?: string}>,
 * }}
 */
export function createMemoryBridge(deps = {}) {
  const {
    retriever,
    workingStore,
    episodicStore,
    semanticStore,
    metrics,
    memoryManager,
  } = deps;

  const redact = typeof deps.redactor === 'function'
    ? deps.redactor
    : (value) => redactObject(value);

  async function getMemoryStats() {
    try {
      const [working, episodic, semantic] = await Promise.all([
        safeCount(workingStore),
        safeCount(episodicStore),
        safeCount(semanticStore),
      ]);
      let flatStats = null;
      if (memoryManager && typeof memoryManager.getMemoryStats === 'function') {
        try {
          flatStats = await memoryManager.getMemoryStats();
        } catch {
          flatStats = null;
        }
      }
      let metricsSnapshot = null;
      if (metrics && typeof metrics.snapshot === 'function') {
        try {
          metricsSnapshot = shapeMetricsSnapshot(metrics.snapshot());
        } catch {
          metricsSnapshot = null;
        }
      }
      return {
        ok: true,
        value: {
          counts: { working, episodic, semantic },
          hitRates: metricsSnapshot,
          flat: flatStats ? redact(flatStats) : null,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async function searchMemory(args = {}) {
    const { query } = args || {};
    if (typeof query !== 'string' || query.trim() === '') {
      return { ok: false, error: 'query required' };
    }
    const safeQuery = redactString(query);
    let limit = DEFAULT_SEARCH_LIMIT;
    if (Number.isFinite(args.limit) && args.limit > 0) {
      limit = Math.min(MAX_SEARCH_LIMIT, Math.floor(args.limit));
    }

    // Prefer the 3-layer retriever when available.
    if (retriever && typeof retriever.search === 'function') {
      try {
        const raw = await retriever.search(safeQuery, { limit });
        const results = Array.isArray(raw?.results) ? raw.results : [];
        const redacted = results.map((r) => redactRetrievalResult(r, redact));
        return {
          ok: true,
          value: {
            query: safeQuery,
            mode: 'retriever',
            results: redacted,
            metrics: raw?.metrics ? shapeMetricsSnapshot(raw.metrics) : null,
          },
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // Fall back to the flat memory-manager API.
    if (memoryManager && typeof memoryManager.searchMemory === 'function') {
      try {
        const raw = await memoryManager.searchMemory(safeQuery, { limit });
        const results = Array.isArray(raw) ? raw : [];
        const redacted = results.map((r) => ({
          entry: r?.entry ? redact(r.entry) : null,
          score: Number.isFinite(r?.score) ? r.score : 0,
          store: typeof r?.store === 'string' ? r.store : null,
        }));
        return {
          ok: true,
          value: {
            query: safeQuery,
            mode: 'flat',
            results: redacted,
            metrics: null,
          },
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return { ok: false, error: 'no retriever or memoryManager dependency configured' };
  }

  return Object.freeze({ getMemoryStats, searchMemory });
}
