/**
 * Hierarchical memory dispatch (Phase C wiring) — holds the retriever
 * singleton + layer-store caches used by `lib/learning/memory-manager.js`.
 *
 * Kept in its own module so memory-manager.js stays under the 800-line gate
 * and the singletons are easy to reset from tests.
 *
 * @module lib/learning/memory/dispatch
 */

import path from 'node:path';
import { createSemanticStore } from './semantic.js';
import { createEpisodicStore } from './episodic.js';
import { createRetriever } from './retriever.js';

const SEMANTIC_STORE_FILENAME = 'semantic.json';
const EPISODIC_STORE_DIRNAME = 'episodic';

/**
 * Legacy-store mapping used to translate hierarchical hits back to the
 * `{store: <key>}` shape `getRelevantContext` expects.
 * @param {{entry: object, layer: string}} hit
 * @returns {string}
 */
function inferStoreKey(hit) {
  if (hit.layer === 'working') return 'workingLayer';
  if (hit.layer === 'episodic') return 'projectContexts';
  const t = hit.entry?.type;
  if (t === 'error') return 'errorPatterns';
  if (t === 'command') return 'commandHistory';
  if (t === 'context') return 'projectContexts';
  return 'userPreferences';
}

/**
 * Create a dispatcher tied to a memory-dir resolver. Exposes:
 *   - `getSemanticStore()` / `getEpisodicStore()` (lazy singletons)
 *   - `searchMemoryHierarchical(query, opts)` — calls the retriever
 *   - Test seams: `__setSemanticStore`, `__setEpisodicStore`,
 *     `__setWorkingStore`, `__setRetriever`, `__setRetrieverConfig`, `reset`
 *
 * @param {object} deps
 * @param {() => string} deps.getMemoryDir
 * @param {(type: string) => string} deps.typeToStoreKey
 * @returns {object}
 */
export function createMemoryDispatcher({ getMemoryDir, typeToStoreKey }) {
  let semanticStore = null;
  let episodicStore = null;
  let workingStoreOverride = null;
  let retriever = null;
  let retrieverConfig = null;

  function invalidate() { retriever = null; }

  function getSemanticStore() {
    if (semanticStore) return semanticStore;
    semanticStore = createSemanticStore({
      storePath: path.join(getMemoryDir(), SEMANTIC_STORE_FILENAME),
    });
    return semanticStore;
  }

  function getEpisodicStore() {
    if (episodicStore) return episodicStore;
    episodicStore = createEpisodicStore({
      storePath: path.join(getMemoryDir(), EPISODIC_STORE_DIRNAME),
    });
    return episodicStore;
  }

  async function tryLoadWorkingStore() {
    if (workingStoreOverride) return workingStoreOverride;
    try {
      const mod = await import('./working.js');
      if (mod && typeof mod.createWorkingStore === 'function') {
        return mod.createWorkingStore();
      }
      return null;
    } catch {
      return null;
    }
  }

  async function getOrCreateRetriever() {
    if (retriever) return retriever;
    const workingStore = await tryLoadWorkingStore();
    retriever = createRetriever({
      workingStore,
      episodicStore: getEpisodicStore(),
      semanticStore: getSemanticStore(),
      config: retrieverConfig ?? undefined,
    });
    return retriever;
  }

  async function searchMemoryHierarchical(query, options = {}) {
    try {
      const r = await getOrCreateRetriever();
      const res = await r.search(query, { limit: options.limit ?? 10 });
      if (!res || !Array.isArray(res.results)) return null;
      const threshold = typeof options.threshold === 'number' ? options.threshold : 0;
      const typeFilter = Array.isArray(options.types) && options.types.length > 0
        ? new Set(options.types.map((t) => typeToStoreKey(t)))
        : null;
      return res.results
        .filter((entry) => entry.score >= threshold)
        .map((entry) => ({
          entry: entry.entry,
          score: entry.score,
          store: inferStoreKey(entry),
          layer: entry.layer,
        }))
        .filter((entry) => (typeFilter ? typeFilter.has(entry.store) : true));
    } catch {
      return null;
    }
  }

  return {
    getSemanticStore,
    getEpisodicStore,
    searchMemoryHierarchical,
    __setSemanticStore(store) { semanticStore = store; invalidate(); },
    __setEpisodicStore(store) { episodicStore = store; invalidate(); },
    __setWorkingStore(store) { workingStoreOverride = store ?? null; invalidate(); },
    __setRetriever(instance) { retriever = instance; },
    __setRetrieverConfig(cfg) { retrieverConfig = cfg ?? null; invalidate(); },
    reset() {
      semanticStore = null;
      episodicStore = null;
      workingStoreOverride = null;
      retriever = null;
      retrieverConfig = null;
    },
  };
}
