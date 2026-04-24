/**
 * Semantic Memory Store — Layer 3 of hierarchical memory.
 *
 * Abstract, de-contextualised facts/rules/preferences with no session
 * timestamp dependency. TF-IDF cosine retrieval with recency (constant 0.7
 * for abstract facts) and frequency (log(1+usageCount)) boosts.
 *
 * Never-delete invariant: archive only — moved to archive/YYYY-MM/ gzipped.
 *
 * Zero external deps. Atomic writes only. Reuses lib/core/file.js.
 *
 * @module lib/learning/memory/semantic
 */

import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import {
  ensureDir,
  readJsonFile,
  atomicWriteJson,
} from '../../core/file.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORE_FILENAME = 'semantic.json';
const ARCHIVE_DIR_NAME = 'archive';
const LAYER = 'semantic';

// Constant recency boost per Section 4.2 — abstract facts aren't "recent".
const SEMANTIC_RECENCY_BOOST = 0.7;

const DEFAULT_LIMIT = 10;
const MIN_SCORE = 0.0001;

const STOP_WORDS = Object.freeze(new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of',
  'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'and', 'or', 'not',
  'it', 'its', 'this', 'that', 'these', 'those',
]));

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Tokenize a string into a term-frequency map with stop-word filter.
 * @param {string} text
 * @returns {Record<string, number>}
 */
export function tokenize(text) {
  if (!text || typeof text !== 'string') return {};
  const words = text.toLowerCase().replace(/[^a-z0-9가-힣\s]/g, ' ').split(/\s+/);
  const freq = Object.create(null);
  for (const w of words) {
    if (w.length < 2 || STOP_WORDS.has(w)) continue;
    freq[w] = (freq[w] || 0) + 1;
  }
  return freq;
}

/**
 * Stable SHA-256 signature hash for an entry payload.
 * @param {object} data
 * @returns {string}
 */
export function signatureHash(data) {
  const canonical = JSON.stringify(data, Object.keys(data ?? {}).sort());
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Cosine similarity for two term-frequency vectors.
 * @param {Record<string, number>} vecA
 * @param {Record<string, number>} vecB
 * @returns {number}
 */
export function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB) return 0;
  const keysA = Object.keys(vecA);
  if (keysA.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const k of keysA) {
    const a = vecA[k];
    magA += a * a;
    if (vecB[k] !== undefined) dot += a * vecB[k];
  }
  for (const k of Object.keys(vecB)) {
    magB += vecB[k] * vecB[k];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Walk a data object and extract a flat lowercase keyword string used as the
 * basis for TF-IDF search — mirrors extractTags in memory-manager.
 * @param {unknown} data
 * @returns {string}
 */
export function extractSearchText(data) {
  const parts = [];
  const walk = (v) => {
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(data);
  return parts.join(' ');
}

/**
 * Generate a time-ordered entry id.
 * @param {number} now
 * @returns {string}
 */
function nextId(now) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `sem_${now}_${rand}`;
}

/**
 * Produce a new frozen entry record.
 * @param {object} raw
 * @param {number} now
 * @returns {Readonly<object>}
 */
function buildEntry(raw, now) {
  const data = raw.data ?? {};
  const hash = raw.signatureHash ?? signatureHash(data);
  const iso = new Date(now).toISOString();
  const entry = {
    id: raw.id ?? nextId(now),
    layer: LAYER,
    type: raw.type ?? 'preference',
    data,
    signatureHash: hash,
    source: raw.source ?? 'system',
    tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 64) : [],
    createdAt: raw.createdAt ?? iso,
    updatedAt: iso,
    usageCount: typeof raw.usageCount === 'number' ? raw.usageCount : 0,
    distinctSessions: typeof raw.distinctSessions === 'number' ? raw.distinctSessions : 1,
    occurrenceCount: typeof raw.occurrenceCount === 'number' ? raw.occurrenceCount : 1,
    promotedFrom: raw.promotedFrom ?? null,
  };
  return Object.freeze(entry);
}

// ---------------------------------------------------------------------------
// Store I/O
// ---------------------------------------------------------------------------

async function loadStore(storePath) {
  const data = await readJsonFile(storePath);
  if (!data || !Array.isArray(data.entries)) {
    return {
      entries: [],
      metadata: { createdAt: new Date().toISOString() },
    };
  }
  return data;
}

async function persistStore(storePath, store) {
  await ensureDir(path.dirname(storePath));
  const updated = {
    ...store,
    metadata: { ...(store.metadata ?? {}), updatedAt: new Date().toISOString() },
  };
  await atomicWriteJson(storePath, updated);
}

// ---------------------------------------------------------------------------
// Factory — returns the SemanticStore interface
// ---------------------------------------------------------------------------

/**
 * Create a SemanticStore instance bound to a storage path.
 *
 * @param {object} options
 * @param {string} options.storePath - Absolute path to semantic.json
 * @param {() => number} [options.now] - Clock injector for tests
 * @returns {object} SemanticStore interface: put/find/match/occurrences/archive/export
 */
export function createSemanticStore({ storePath, now = () => Date.now() } = {}) {
  if (!storePath || typeof storePath !== 'string') {
    throw new Error('createSemanticStore: storePath required');
  }
  const archiveRoot = path.join(path.dirname(storePath), ARCHIVE_DIR_NAME);

  /**
   * Insert or update an entry — dedup by `data.key` OR signatureHash.
   * @param {object} raw - { data, type?, tags?, source? }
   * @returns {Promise<object>} the persisted (frozen) entry
   */
  async function put(raw) {
    if (!raw || typeof raw !== 'object') {
      throw new Error('semantic.put: entry object required');
    }
    const store = await loadStore(storePath);
    const ts = now();
    const hash = raw.signatureHash ?? signatureHash(raw.data ?? {});
    const dataKey = raw.data?.key;

    const existing = store.entries.find((e) => (
      (dataKey && e.data?.key === dataKey) || e.signatureHash === hash
    ));

    let entry;
    if (existing) {
      entry = buildEntry({
        ...existing,
        ...raw,
        id: existing.id,
        createdAt: existing.createdAt,
        signatureHash: hash,
        usageCount: existing.usageCount ?? 0,
        occurrenceCount: (existing.occurrenceCount ?? 1) + 1,
        distinctSessions: raw.sessionId && raw.sessionId !== existing.lastSessionId
          ? (existing.distinctSessions ?? 1) + 1
          : (existing.distinctSessions ?? 1),
      }, ts);
    } else {
      entry = buildEntry({ ...raw, signatureHash: hash }, ts);
    }

    const kept = store.entries.filter((e) => e.id !== (existing?.id ?? '__none__'));
    const nextStore = { ...store, entries: [...kept, entry] };
    await persistStore(storePath, nextStore);
    return entry;
  }

  /**
   * TF-IDF cosine retrieval with recency (constant 0.7) + frequency boost.
   * @param {string} query
   * @param {object} [opts]
   * @param {number} [opts.limit=10]
   * @returns {Promise<Array<{entry: object, score: number, layer: string}>>}
   */
  async function find(query, opts = {}) {
    const limit = typeof opts.limit === 'number' && opts.limit > 0
      ? opts.limit
      : DEFAULT_LIMIT;
    if (!query || typeof query !== 'string') return [];

    const store = await loadStore(storePath);
    if (store.entries.length === 0) return [];

    const qVec = tokenize(query);
    if (Object.keys(qVec).length === 0) return [];

    const scored = store.entries.map((entry) => {
      const text = extractSearchText(entry.data);
      const eVec = tokenize(text);
      const sim = cosineSimilarity(qVec, eVec);
      const freqBoost = Math.log(1 + (entry.usageCount ?? 0));
      // score = base_sim × (1 + recency_boost) × (1 + 0.1·freqBoost)
      const score = sim * (1 + SEMANTIC_RECENCY_BOOST) * (1 + 0.1 * freqBoost);
      return { entry, score, layer: LAYER };
    })
      .filter((r) => r.score > MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return Object.freeze(scored.map((r) => Object.freeze({ ...r })));
  }

  /**
   * Direct signature-hash lookup.
   * @param {string} hash
   * @returns {Promise<object|null>}
   */
  async function match(hash) {
    if (!hash || typeof hash !== 'string') return null;
    const store = await loadStore(storePath);
    return store.entries.find((e) => e.signatureHash === hash) ?? null;
  }

  /**
   * Count promotion candidate occurrences for a given signature.
   * @param {string} hash
   * @returns {Promise<number>}
   */
  async function occurrences(hash) {
    const entry = await match(hash);
    return entry ? (entry.occurrenceCount ?? 1) : 0;
  }

  /**
   * Archive an entry — move to archive/YYYY-MM/ gzipped. No hard delete from
   * entries array; the entry gains an archivedAt marker so retrieval can
   * filter it out.
   * @param {string} id
   * @returns {Promise<{archivedPath: string} | null>}
   */
  async function archive(id) {
    const store = await loadStore(storePath);
    const target = store.entries.find((e) => e.id === id);
    if (!target) return null;

    const ts = new Date(now());
    const yyyy = ts.getUTCFullYear();
    const mm = String(ts.getUTCMonth() + 1).padStart(2, '0');
    const monthDir = path.join(archiveRoot, `${yyyy}-${mm}`);
    await ensureDir(monthDir);

    const archivedPath = path.join(monthDir, `${id}.json.gz`);
    const payload = JSON.stringify({ ...target, archivedAt: ts.toISOString() });
    await fs.writeFile(archivedPath, gzipSync(Buffer.from(payload, 'utf-8')));

    const markedEntries = store.entries.map((e) => (
      e.id === id ? Object.freeze({ ...e, archivedAt: ts.toISOString() }) : e
    ));
    await persistStore(storePath, { ...store, entries: markedEntries });

    return { archivedPath };
  }

  /**
   * Export abstract signatures + usage counts only — no raw payloads.
   * Stub for v3.3 swarm/DP; returns a shape the future DP noiser can consume.
   * @param {object} [opts]
   * @param {boolean} [opts.withDifferentialPrivacy=false]
   * @returns {Promise<Array<{signature: string, usageCount: number, distinctSessions: number}>>}
   */
  async function exportSignatures(opts = {}) {
    const { withDifferentialPrivacy = false } = opts;
    const store = await loadStore(storePath);
    const rows = store.entries
      .filter((e) => !e.archivedAt)
      .map((e) => ({
        signature: e.signatureHash,
        usageCount: e.usageCount ?? 0,
        distinctSessions: e.distinctSessions ?? 1,
      }));
    if (!withDifferentialPrivacy) return rows;
    // DP stub — v3.3 will apply Laplace noise + k-anonymity. For now return
    // rows unchanged but tagged so callers know DP was requested.
    return rows.map((r) => ({ ...r, dp: 'stub' }));
  }

  /**
   * Read-only listing of active (non-archived) entries — useful for
   * migration checks and façade bridging.
   * @returns {Promise<object[]>}
   */
  async function list() {
    const store = await loadStore(storePath);
    return store.entries.filter((e) => !e.archivedAt);
  }

  return Object.freeze({
    put,
    find,
    match,
    occurrences,
    archive,
    export: exportSignatures,
    list,
  });
}
