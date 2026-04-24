/**
 * 3-Layer Memory Retriever (L1/L2/L3) — Section 4 of
 * `_design/hierarchical-memory-2026-04-24.md`.
 *
 * Parallel scan across Working (L1) / Episodic (L2) / Semantic (L3) stores,
 * merge-by-score, deduplicate by episode/signature hash, top-K truncate.
 *
 *   score(entry) = layer_weight
 *                × base_similarity
 *                × (1 + recency_boost)
 *                × (1 + 0.1 * frequency_boost)
 *
 * Design contract:
 *   - Zero external runtime deps.
 *   - `workingStore` is OPTIONAL (WC1 owns `working.js`; gracefully skip when
 *     null so the retriever can be unit-tested and released before WC1 lands).
 *   - `metrics` recorder is OPTIONAL (record one `recordQuery(layer, hits)`
 *     per layer scan when present).
 *   - Public API: `createRetriever(deps)` → `{ search(query, opts) }`.
 *   - Returned results are frozen and annotated with `{layer, score,
 *     provenance}`.
 *
 * @module lib/learning/memory/retriever
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LAYERS = Object.freeze(['working', 'episodic', 'semantic']);

const DEFAULT_LIMIT = 10;

const DEFAULT_WEIGHTS = Object.freeze({
  working: 0.50,
  episodic: 0.30,
  semantic: 0.20,
});

const DEFAULT_RECENCY_BOOST = Object.freeze({
  working: 1.0,
  // Episodic is derived per-entry (exp(-age/30)); constant is a fallback.
  episodic: 0.5,
  semantic: 0.7,
});

const EPISODIC_RECENCY_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Merge configured weights on top of the Section 4 defaults. Invalid or
 * out-of-range numbers fall back to the default for that layer.
 * @param {object} [override]
 * @returns {{working: number, episodic: number, semantic: number}}
 */
export function resolveWeights(override) {
  const safe = override && typeof override === 'object' ? override : {};
  const out = {};
  for (const layer of LAYERS) {
    const v = Number(safe[layer]);
    out[layer] = Number.isFinite(v) && v >= 0 ? v : DEFAULT_WEIGHTS[layer];
  }
  return Object.freeze(out);
}

/**
 * Recency boost per layer — episodic uses exp(-age_days/30), others use a
 * layer-specific constant.
 * @param {string} layer
 * @param {object} entry
 * @param {number} [nowMs]
 * @returns {number}
 */
export function recencyBoost(layer, entry, nowMs = Date.now()) {
  if (layer === 'working') return DEFAULT_RECENCY_BOOST.working;
  if (layer === 'semantic') return DEFAULT_RECENCY_BOOST.semantic;
  if (layer === 'episodic') {
    const ts = typeof entry?.timestamp === 'number' ? entry.timestamp : null;
    if (ts === null) return DEFAULT_RECENCY_BOOST.episodic;
    const ageDays = Math.max(0, (nowMs - ts) / DAY_MS);
    return Math.exp(-ageDays / EPISODIC_RECENCY_WINDOW_DAYS);
  }
  return 0;
}

/**
 * Frequency boost — log(1 + count). Working never contributes frequency.
 * @param {string} layer
 * @param {object} entry
 * @returns {number}
 */
export function frequencyBoost(layer, entry) {
  if (layer === 'working') return 0;
  if (layer === 'episodic') {
    const c = Number(entry?.recallCount ?? entry?.accessCount ?? 0);
    return Math.log(1 + Math.max(0, c));
  }
  if (layer === 'semantic') {
    const c = Number(entry?.usageCount ?? 0);
    return Math.log(1 + Math.max(0, c));
  }
  return 0;
}

/**
 * Combine per-layer candidates into a single scored list. Each input item
 * is `{entry, similarity, layer}`; the output replaces `similarity` with the
 * fully-weighted `score` and annotates `{layer, score, provenance}`.
 *
 * @param {Array<{entry: object, similarity: number, layer: string}>} candidates
 * @param {object} weights
 * @param {number} nowMs
 * @returns {Array<{entry: object, score: number, layer: string, provenance: object}>}
 */
export function applyScoring(candidates, weights, nowMs) {
  const out = [];
  for (const cand of candidates) {
    if (!cand || typeof cand !== 'object' || !cand.entry) continue;
    const { entry, similarity, layer } = cand;
    const sim = Number.isFinite(similarity) ? similarity : 0;
    const lw = weights[layer] ?? 0;
    const rec = recencyBoost(layer, entry, nowMs);
    const freq = frequencyBoost(layer, entry);
    const score = lw * sim * (1 + rec) * (1 + 0.1 * freq);
    out.push({
      entry,
      score,
      layer,
      provenance: Object.freeze({
        baseSimilarity: sim,
        recencyBoost: rec,
        frequencyBoost: freq,
        layerWeight: lw,
      }),
    });
  }
  return out;
}

/**
 * Dedup merged candidates by episode_hash / signature_hash. Working entries
 * never dedup (they represent the live session and may legitimately repeat).
 * @param {Array<{entry: object, score: number, layer: string, provenance: object}>} scored
 * @returns {Array<{entry: object, score: number, layer: string, provenance: object}>}
 */
export function dedupResults(scored) {
  const seen = new Set();
  const out = [];
  for (const r of scored) {
    if (r.layer === 'working') {
      out.push(r);
      continue;
    }
    const id = r.layer === 'semantic'
      ? r.entry?.signatureHash ?? r.entry?.signature ?? r.entry?.id
      : r.entry?.hash ?? r.entry?.id;
    const key = id ? `${r.layer}:${id}` : null;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Layer scanners — each returns {layer, results:[{entry,similarity,layer}]}
// ---------------------------------------------------------------------------

async function scanWorking(store, query, perLayerLimit) {
  if (!store) return { layer: 'working', results: [] };
  try {
    // Preferred: explicit search() — matches retriever contract.
    if (typeof store.search === 'function') {
      const raw = await store.search(query, { limit: perLayerLimit });
      const list = Array.isArray(raw) ? raw : [];
      return {
        layer: 'working',
        results: list.map((r) => ({
          entry: r.entry ?? r,
          similarity: Number(r.similarity ?? r.score ?? 0),
          layer: 'working',
        })),
      };
    }
    // Fallback: snapshot() — WC1's current surface. Rank by keyword overlap
    // so Working remains useful before a first-class search() lands.
    if (typeof store.snapshot === 'function') {
      const snap = store.snapshot();
      const entries = Array.isArray(snap?.entries) ? snap.entries : [];
      const qTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
      const scored = entries
        .map((entry) => {
          const text = JSON.stringify(entry).toLowerCase();
          const hits = qTokens.reduce((n, t) => (text.includes(t) ? n + 1 : n), 0);
          return {
            entry,
            similarity: qTokens.length ? hits / qTokens.length : 0,
            layer: 'working',
          };
        })
        .filter((r) => r.similarity > 0)
        .slice(0, perLayerLimit);
      return { layer: 'working', results: scored };
    }
    return { layer: 'working', results: [] };
  } catch {
    return { layer: 'working', results: [] };
  }
}

async function scanEpisodic(store, query, perLayerLimit) {
  if (!store || typeof store.findEpisodes !== 'function') {
    return { layer: 'episodic', results: [] };
  }
  try {
    const raw = await store.findEpisodes(query, { limit: perLayerLimit });
    const list = Array.isArray(raw) ? raw : [];
    const results = list.map((r) => ({
      entry: r.episode ?? r.entry ?? r,
      similarity: Number(r.similarity ?? r.score ?? 0),
      layer: 'episodic',
    }));
    return { layer: 'episodic', results };
  } catch {
    return { layer: 'episodic', results: [] };
  }
}

async function scanSemantic(store, query, perLayerLimit) {
  if (!store || typeof store.find !== 'function') {
    return { layer: 'semantic', results: [] };
  }
  try {
    const raw = await store.find(query, { limit: perLayerLimit });
    const list = Array.isArray(raw) ? raw : [];
    const results = list.map((r) => ({
      entry: r.entry ?? r,
      // semantic.find already applies its own recency/frequency; strip them
      // here to stay in the "base similarity" contract, using the raw cosine
      // when we can infer it, else the score as-is.
      similarity: Number(r.similarity ?? r.score ?? 0),
      layer: 'semantic',
    }));
    return { layer: 'semantic', results };
  } catch {
    return { layer: 'semantic', results: [] };
  }
}

// ---------------------------------------------------------------------------
// Metrics helper — best-effort, never throws
// ---------------------------------------------------------------------------

function emitMetrics(metrics, layerScans) {
  if (!metrics || typeof metrics.recordQuery !== 'function') return;
  for (const scan of layerScans) {
    try {
      metrics.recordQuery(scan.layer, scan.results.length);
    } catch {
      // metrics failures must never break retrieval
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a 3-layer retriever.
 *
 * @param {object} deps
 * @param {object|null} [deps.workingStore]   - L1 store (optional; WC1-owned)
 * @param {object|null} [deps.episodicStore]  - L2 store
 * @param {object|null} [deps.semanticStore]  - L3 store
 * @param {object} [deps.config]              - artibot config; reads
 *                                              `learning.hierarchicalMemory.weights`
 * @param {object} [deps.metrics]             - optional metrics recorder
 * @param {() => number} [deps.now]           - clock injector for tests
 * @returns {{search: (query: string, opts?: object) => Promise<object>}}
 */
export function createRetriever(deps = {}) {
  const {
    workingStore = null,
    episodicStore = null,
    semanticStore = null,
    config,
    metrics,
    now = () => Date.now(),
  } = deps;

  const defaultWeights = resolveWeights(
    config?.learning?.hierarchicalMemory?.weights,
  );

  /**
   * Parallel 3-layer search + merge.
   *
   * @param {string} query
   * @param {object} [opts]
   * @param {number} [opts.limit=10]         Final top-K after merge.
   * @param {object} [opts.layerWeights]     Per-call weight override.
   * @param {boolean} [opts.includeArchive]  Archive opt-in (semantic layer).
   * @returns {Promise<{results: Array, metrics: object|null}>}
   */
  async function search(query, opts = {}) {
    const limit = Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.floor(opts.limit) : DEFAULT_LIMIT;
    const perLayerLimit = Math.max(1, limit * 2);
    const weights = opts.layerWeights
      ? resolveWeights({ ...defaultWeights, ...opts.layerWeights })
      : defaultWeights;

    const q = typeof query === 'string' ? query : '';
    if (!q) {
      return Object.freeze({ results: [], metrics: metrics?.snapshot?.() ?? null });
    }

    // Phase 1 — parallel per-layer scan.
    const [wScan, eScan, sScan] = await Promise.all([
      scanWorking(workingStore, q, perLayerLimit),
      scanEpisodic(episodicStore, q, perLayerLimit),
      scanSemantic(semanticStore, q, perLayerLimit),
    ]);

    emitMetrics(metrics, [wScan, eScan, sScan]);

    // Phase 2 — merge + score + dedup + truncate.
    const allCandidates = [
      ...wScan.results,
      ...eScan.results,
      ...sScan.results,
    ];
    const scored = applyScoring(allCandidates, weights, now());
    scored.sort((a, b) => b.score - a.score);
    const deduped = dedupResults(scored);
    const top = deduped.slice(0, limit).map((r) => Object.freeze({
      entry: r.entry,
      score: r.score,
      layer: r.layer,
      provenance: r.provenance,
    }));

    return Object.freeze({
      results: Object.freeze(top),
      metrics: metrics?.snapshot?.() ?? null,
    });
  }

  return Object.freeze({ search });
}

export const __test__ = Object.freeze({
  LAYERS,
  DEFAULT_WEIGHTS,
  DEFAULT_RECENCY_BOOST,
  EPISODIC_RECENCY_WINDOW_DAYS,
});
