/**
 * BlenderBot-inspired long-term memory + RAG system.
 * Manages session memory, long-term memory, keyword-based RAG search,
 * memory summarization, and TTL-based expiration.
 * @module lib/learning/memory-manager
 */

import path from 'node:path';
import { readJsonFile, writeJsonFile, ensureDir } from '../core/file.js';
import { ARTIBOT_DIR } from '../core/config.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MEMORY_DIR_NAME = 'memory';
const STORE_FILES = {
  userPreferences: 'user-preferences.json',
  projectContexts: 'project-contexts.json',
  commandHistory: 'command-history.json',
  errorPatterns: 'error-patterns.json',
};

/** Default TTL values in milliseconds */
const TTL = {
  session: 4 * 60 * 60 * 1000, // 4 hours
  shortTerm: 7 * 24 * 60 * 60 * 1000, // 7 days
  longTerm: 90 * 24 * 60 * 60 * 1000, // 90 days
  permanent: Infinity,
};

const MAX_COMMAND_HISTORY = 500;
const MAX_ERROR_PATTERNS = 200;
const MAX_SUMMARY_LENGTH = 500;

// ---------------------------------------------------------------------------
// Path Helpers
// ---------------------------------------------------------------------------

/**
 * Get the base memory directory: ~/.claude/artibot/memory/
 * @returns {string}
 */
function getMemoryDir() {
  return path.join(ARTIBOT_DIR, MEMORY_DIR_NAME);
}

/**
 * Get the full path for a specific memory store file.
 * @param {string} storeKey - Key from STORE_FILES
 * @returns {string}
 */
function getStorePath(storeKey) {
  const filename = STORE_FILES[storeKey];
  if (!filename) throw new Error(`Unknown memory store: ${storeKey}`);
  return path.join(getMemoryDir(), filename);
}

// ---------------------------------------------------------------------------
// Low-Level Store Operations (Immutable)
// ---------------------------------------------------------------------------

/**
 * Load a memory store from disk.
 * @param {string} storeKey
 * @returns {Promise<object>}
 */
async function loadStore(storeKey) {
  const data = await readJsonFile(getStorePath(storeKey));
  return data ?? { entries: [], metadata: { createdAt: new Date().toISOString() } };
}

/**
 * Persist a memory store to disk.
 * @param {string} storeKey
 * @param {object} store
 * @returns {Promise<void>}
 */
async function persistStore(storeKey, store) {
  const updated = {
    ...store,
    metadata: { ...store.metadata, updatedAt: new Date().toISOString() },
  };
  await writeJsonFile(getStorePath(storeKey), updated);
}

// ---------------------------------------------------------------------------
// Memory Entry Factory
// ---------------------------------------------------------------------------

/**
 * Create a new memory entry with TTL and metadata.
 * @param {string} type - Memory type: 'preference' | 'context' | 'command' | 'error'
 * @param {object} data - The memory payload
 * @param {object} [options]
 * @param {string[]} [options.tags] - Searchable tags
 * @param {number} [options.ttl] - Custom TTL in ms
 * @param {string} [options.source] - Origin of the memory
 * @returns {object}
 */
function createEntry(type, data, options = {}) {
  const now = Date.now();
  const ttl = options.ttl ?? getTTLForType(type);
  return {
    id: `${type}_${now}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    data,
    tags: options.tags ?? extractTags(data),
    source: options.source ?? 'system',
    createdAt: new Date(now).toISOString(),
    expiresAt: ttl === Infinity ? null : new Date(now + ttl).toISOString(),
    accessCount: 0,
    lastAccessedAt: null,
  };
}

/**
 * Get default TTL for a memory type.
 * @param {string} type
 * @returns {number}
 */
function getTTLForType(type) {
  switch (type) {
    case 'preference':
      return TTL.permanent;
    case 'context':
      return TTL.longTerm;
    case 'command':
      return TTL.shortTerm;
    case 'error':
      return TTL.longTerm;
    default:
      return TTL.shortTerm;
  }
}

// ---------------------------------------------------------------------------
// Tag Extraction (Simple Keyword-Based)
// ---------------------------------------------------------------------------

/**
 * Extract searchable tags from a data object.
 * Walks string values and splits into lowercase tokens.
 * @param {object} data
 * @returns {string[]}
 */
function extractTags(data) {
  const tokens = new Set();
  const walk = (value) => {
    if (typeof value === 'string') {
      value
        .toLowerCase()
        .split(/[\s,./\\:;|_\-@#]+/)
        .filter((t) => t.length >= 2 && t.length <= 40)
        .forEach((t) => tokens.add(t));
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };
  walk(data);
  return [...tokens].slice(0, 50);
}

// ---------------------------------------------------------------------------
// RAG Search (TF-IDF + Relevance Scoring)
// ---------------------------------------------------------------------------

/**
 * Compute TF-IDF score for a term against a document (entry tags).
 * TF = term frequency in document, IDF = log(N / df) where df = doc frequency.
 * @param {string} term - Query term
 * @param {string[]} docTags - Tags of the candidate entry
 * @param {string[][]} allDocTags - Tags of all candidate entries (corpus)
 * @returns {number} TF-IDF score
 */
function computeTfIdf(term, docTags, allDocTags) {
  // TF: fraction of doc tags matching the term
  const tf = docTags.length > 0
    ? docTags.filter((t) => t === term).length / docTags.length
    : 0;

  if (tf === 0) return 0;

  // IDF: log(N / (1 + df)) where df = number of docs containing the term
  const N = allDocTags.length;
  const df = allDocTags.filter((tags) => tags.includes(term)).length;
  const idf = Math.log((N + 1) / (df + 1)) + 1; // smoothed IDF

  return tf * idf;
}

/**
 * Score a memory entry against a search query using TF-IDF relevance.
 * Combines TF-IDF score, recency, and access frequency.
 * @param {object} entry
 * @param {string[]} queryTokens
 * @param {string[][]} allDocTags - Tags of all entries in corpus for IDF calculation
 * @returns {number} Relevance score 0-1
 */
function scoreEntry(entry, queryTokens, allDocTags = []) {
  if (queryTokens.length === 0) return 0;

  const docTags = entry.tags || [];

  // TF-IDF score: sum TF-IDF for each query token, then normalize
  let tfidfSum = 0;
  for (const term of queryTokens) {
    tfidfSum += computeTfIdf(term, docTags, allDocTags.length > 0 ? allDocTags : [docTags]);
  }
  // Normalize by query length; cap at 1.0
  const tfidfScore = Math.min(1.0, tfidfSum / queryTokens.length);

  // Recency score (0-1): newer entries score higher
  const ageMs = Date.now() - new Date(entry.createdAt).getTime();
  const maxAge = 90 * 24 * 60 * 60 * 1000; // 90 days
  const recencyScore = Math.max(0, 1 - ageMs / maxAge);

  // Access frequency bonus (0-0.2)
  const accessBonus = Math.min(0.2, (entry.accessCount || 0) * 0.02);

  // Weighted combination: TF-IDF 60%, recency 25%, access bonus up to 15%
  return tfidfScore * 0.6 + recencyScore * 0.25 + accessBonus + 0.15 * (tfidfScore > 0 ? 1 : 0);
}

/**
 * Tokenize a search query into normalized tokens.
 * @param {string} query
 * @returns {string[]}
 */
function tokenizeQuery(query) {
  return query
    .toLowerCase()
    .split(/[\s,./\\:;|_\-@#]+/)
    .filter((t) => t.length >= 2);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Save a memory entry to the appropriate store.
 * @param {'preference'|'context'|'command'|'error'} type
 * @param {object} data
 * @param {object} [options] - tags, ttl, source
 * @returns {Promise<object>} The saved entry
 */
export async function saveMemory(type, data, options = {}) {
  await ensureDir(getMemoryDir());

  const storeKey = typeToStoreKey(type);
  const store = await loadStore(storeKey);
  const entry = createEntry(type, data, options);

  // For preferences, deduplicate by data.key if present
  let entries = store.entries;
  if (type === 'preference' && data.key) {
    entries = entries.filter((e) => e.data.key !== data.key);
  }

  // Enforce size limits for history-type stores
  const maxEntries = type === 'command' ? MAX_COMMAND_HISTORY : MAX_ERROR_PATTERNS;
  if (type === 'command' || type === 'error') {
    entries = entries.slice(-(maxEntries - 1));
  }

  const updatedStore = {
    ...store,
    entries: [...entries, entry],
  };

  await persistStore(storeKey, updatedStore);
  return entry;
}

/**
 * Search memories across all stores using keyword-based RAG.
 * @param {string} query - Natural language search query
 * @param {object} [options]
 * @param {string[]} [options.types] - Filter by memory types
 * @param {number} [options.limit] - Max results (default: 10)
 * @param {number} [options.threshold] - Min relevance score (default: 0.1)
 * @returns {Promise<Array<{entry: object, score: number, store: string}>>}
 */
export async function searchMemory(query, options = {}) {
  const { types, limit = 10, threshold = 0.1 } = options;
  const queryTokens = tokenizeQuery(query);
  if (queryTokens.length === 0) return [];

  const storeKeys = types ? types.map(typeToStoreKey) : Object.keys(STORE_FILES);
  const results = [];

  for (const storeKey of storeKeys) {
    const store = await loadStore(storeKey);
    const now = Date.now();

    // Collect all non-expired entry tags for IDF calculation (corpus)
    const activeEntries = store.entries.filter(
      (e) => !e.expiresAt || new Date(e.expiresAt).getTime() >= now,
    );
    const allDocTags = activeEntries.map((e) => e.tags || []);

    for (const entry of activeEntries) {
      const score = scoreEntry(entry, queryTokens, allDocTags);
      if (score >= threshold) {
        results.push({ entry, score, store: storeKey });
      }
    }
  }

  // Sort by score descending, take top N
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/**
 * Get relevant context for the current working state.
 * Searches across all stores for entries matching the provided context hints.
 * @param {object} context
 * @param {string} [context.cwd] - Current working directory
 * @param {string} [context.command] - Current command being executed
 * @param {string} [context.project] - Project name
 * @param {string[]} [context.keywords] - Additional keywords
 * @returns {Promise<object>} Aggregated relevant context
 */
export async function getRelevantContext(context = {}) {
  const queryParts = [];
  if (context.cwd) queryParts.push(path.basename(context.cwd));
  if (context.command) queryParts.push(context.command);
  if (context.project) queryParts.push(context.project);
  if (context.keywords) queryParts.push(...context.keywords);

  const query = queryParts.join(' ');
  if (!query) return { preferences: [], projectContext: [], recentCommands: [], errorPatterns: [] };

  const results = await searchMemory(query, { limit: 20 });

  return {
    preferences: results
      .filter((r) => r.store === 'userPreferences')
      .map((r) => r.entry.data),
    projectContext: results
      .filter((r) => r.store === 'projectContexts')
      .map((r) => r.entry.data),
    recentCommands: results
      .filter((r) => r.store === 'commandHistory')
      .map((r) => r.entry.data),
    errorPatterns: results
      .filter((r) => r.store === 'errorPatterns')
      .map((r) => r.entry.data),
  };
}

/**
 * Summarize a session into a compact memory entry.
 * Extracts key actions, decisions, and outcomes from session history.
 * @param {object} sessionData
 * @param {string} [sessionData.sessionId]
 * @param {string} [sessionData.project]
 * @param {Array<{event: string, data?: object}>} [sessionData.history]
 * @param {object} [sessionData.metadata]
 * @returns {Promise<object>} The saved summary entry
 */
export async function summarizeSession(sessionData = {}) {
  const { sessionId, project, history = [], metadata = {} } = sessionData;

  // Extract key events from history
  const commands = history.filter((h) => h.event === 'command').map((h) => h.data?.command || h.event);
  const errors = history.filter((h) => h.event === 'error');
  const completions = history.filter((h) => h.event === 'task_completed');

  const summary = {
    sessionId,
    project,
    commandCount: commands.length,
    uniqueCommands: [...new Set(commands)],
    errorCount: errors.length,
    completedTasks: completions.length,
    duration: metadata.duration || null,
    timestamp: new Date().toISOString(),
  };

  // Truncate summary text if needed
  const summaryText = JSON.stringify(summary);
  const truncated =
    summaryText.length > MAX_SUMMARY_LENGTH
      ? { ...summary, uniqueCommands: summary.uniqueCommands.slice(0, 10) }
      : summary;

  return saveMemory('context', truncated, {
    tags: ['session-summary', project, ...(summary.uniqueCommands || [])].filter(Boolean),
    source: 'session-summarizer',
    ttl: TTL.longTerm,
  });
}

/**
 * Remove all expired memories across all stores.
 * @returns {Promise<{pruned: number, stores: object}>}
 */
export async function pruneOldMemories() {
  const now = Date.now();
  let totalPruned = 0;
  const storeResults = {};

  for (const storeKey of Object.keys(STORE_FILES)) {
    const store = await loadStore(storeKey);
    const before = store.entries.length;

    const kept = store.entries.filter(
      (entry) => !entry.expiresAt || new Date(entry.expiresAt).getTime() > now,
    );

    const pruned = before - kept.length;
    totalPruned += pruned;
    storeResults[storeKey] = { before, after: kept.length, pruned };

    if (pruned > 0) {
      await persistStore(storeKey, { ...store, entries: kept });
    }
  }

  return { pruned: totalPruned, stores: storeResults };
}

/**
 * Load all memories of a given type (non-expired).
 * @param {'preference'|'context'|'command'|'error'} type
 * @returns {Promise<object[]>}
 */
export async function loadMemories(type) {
  const storeKey = typeToStoreKey(type);
  const store = await loadStore(storeKey);
  const now = Date.now();
  return store.entries.filter(
    (entry) => !entry.expiresAt || new Date(entry.expiresAt).getTime() > now,
  );
}

/**
 * Clear all memories of a given type.
 * @param {'preference'|'context'|'command'|'error'} type
 * @returns {Promise<void>}
 */
export async function clearMemories(type) {
  const storeKey = typeToStoreKey(type);
  await persistStore(storeKey, {
    entries: [],
    metadata: { createdAt: new Date().toISOString(), clearedAt: new Date().toISOString() },
  });
}

/**
 * Get memory system statistics.
 * @returns {Promise<object>}
 */
export async function getMemoryStats() {
  const stats = {};
  const now = Date.now();

  for (const storeKey of Object.keys(STORE_FILES)) {
    const store = await loadStore(storeKey);
    const active = store.entries.filter(
      (e) => !e.expiresAt || new Date(e.expiresAt).getTime() > now,
    );
    const expired = store.entries.length - active.length;

    stats[storeKey] = {
      total: store.entries.length,
      active: active.length,
      expired,
      lastUpdated: store.metadata?.updatedAt || null,
    };
  }

  return { memoryDir: getMemoryDir(), stores: stats };
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Map a memory type to its store key.
 * @param {string} type
 * @returns {string}
 */
function typeToStoreKey(type) {
  const mapping = {
    preference: 'userPreferences',
    context: 'projectContexts',
    command: 'commandHistory',
    error: 'errorPatterns',
  };
  return mapping[type] || 'projectContexts';
}
