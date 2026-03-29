/**
 * Neural Session Memory.
 * Local TF-IDF vector-based session memory with cosine similarity recall.
 * Captures events during sessions, compresses to summaries at session end,
 * and retrieves relevant memories at session start via keyword similarity.
 *
 * Storage: ~/.claude/artibot/session-memories.json (memories)
 *          ~/.claude/artibot/session-memories-index.json (reverse index)
 *
 * Zero external dependencies. Pure TF-IDF — no embedding API calls.
 *
 * @module lib/learning/session-memory
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import { ensureDir, readJsonFile, writeJsonFile } from '../core/file.js';
import { ARTIBOT_DIR } from '../core/config.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MEMORIES_PATH = path.join(ARTIBOT_DIR, 'session-memories.json');
const INDEX_PATH = path.join(ARTIBOT_DIR, 'session-memories-index.json');

const MAX_MEMORIES = 500;
const MAX_BUFFER_EVENTS = 200;
const MAX_KEYWORDS = 20;
const MAX_SUMMARY_LINES = 10;
const DEFAULT_TOP_K = 5;
const DEFAULT_MAX_AGE_DAYS = 30;
const PROMOTE_RECALL_THRESHOLD = 3;

/** Common stop words filtered from tokenization */
const STOP_WORDS = Object.freeze(new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'up',
  'down', 'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both',
  'each', 'all', 'any', 'few', 'more', 'most', 'other', 'some', 'such',
  'no', 'only', 'own', 'same', 'than', 'too', 'very', 'just', 'because',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'me', 'my',
  'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them', 'their',
]));

// ---------------------------------------------------------------------------
// TF-IDF Helpers (pure, exported for testing)
// ---------------------------------------------------------------------------

/**
 * Tokenize text into a term-frequency map, filtering stop words.
 *
 * @param {string} text
 * @returns {Record<string, number>} Term → frequency
 */
export function tokenize(text) {
  if (!text || typeof text !== 'string') return {};
  const words = text.toLowerCase().replace(/[^a-z0-9가-힣\s]/g, ' ').split(/\s+/);
  const freq = {};
  for (const w of words) {
    if (w.length < 2 || STOP_WORDS.has(w)) continue;
    freq[w] = (freq[w] || 0) + 1;
  }
  return freq;
}

/**
 * Compute cosine similarity between two term-frequency vectors.
 *
 * @param {Record<string, number>} vecA
 * @param {Record<string, number>} vecB
 * @returns {number} Similarity in [0, 1]
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
    if (vecB[k]) dot += a * vecB[k];
  }
  for (const v of Object.values(vecB)) {
    magB += v * v;
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Extract top-N keywords from a term-frequency map by frequency descending.
 *
 * @param {Record<string, number>} freq
 * @param {number} [n=MAX_KEYWORDS]
 * @returns {string[]}
 */
export function extractKeywords(freq, n = MAX_KEYWORDS) {
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([word]) => word);
}

/**
 * Build a reverse index from memories: keyword -> [memoryId, ...]
 *
 * @param {Array<{id: string, keywords: string[]}>} memories
 * @returns {Record<string, string[]>}
 */
export function buildIndex(memories) {
  const index = {};
  for (const mem of memories) {
    for (const kw of mem.keywords || []) {
      if (!index[kw]) index[kw] = [];
      if (!index[kw].includes(mem.id)) index[kw].push(mem.id);
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function generateId() {
  return `smem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function hashContent(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function compressEvents(events) {
  const lines = [];
  const typeCounts = {};
  for (const e of events) {
    const t = e.type || 'unknown';
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }
  lines.push(`Events: ${Object.entries(typeCounts).map(([t, c]) => `${t}(${c})`).join(', ')}`);

  const toolNames = [...new Set(events.filter((e) => e.tool).map((e) => e.tool))];
  if (toolNames.length > 0) lines.push(`Tools: ${toolNames.join(', ')}`);

  const errors = events.filter((e) => e.type === 'error');
  if (errors.length > 0) {
    lines.push(`Errors: ${errors.slice(0, 3).map((e) => e.message || e.data?.message || 'unknown').join('; ')}`);
  }

  const successes = events.filter((e) => e.type === 'success');
  if (successes.length > 0) {
    lines.push(`Successes: ${successes.slice(0, 3).map((e) => e.message || e.category || 'completed').join('; ')}`);
  }

  const prompts = events.filter((e) => e.type === 'prompt').map((e) => e.text || e.data?.text || '');
  if (prompts.length > 0) {
    lines.push(`Topics: ${prompts.slice(0, 5).join('; ').slice(0, 200)}`);
  }

  return lines.slice(0, MAX_SUMMARY_LINES).join('\n');
}

function trimMemories(memories) {
  if (memories.length <= MAX_MEMORIES) return memories;
  return memories.slice(memories.length - MAX_MEMORIES);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a session memory instance.
 *
 * @param {object} [options]
 * @param {string} [options.sessionId] - Current session identifier
 * @param {() => number} [options.now] - Clock injection for tests
 * @param {string} [options.memoriesPath] - Override storage path
 * @param {string} [options.indexPath] - Override index path
 * @returns {SessionMemory}
 */
export function createSessionMemory(options = {}) {
  const now = options.now || Date.now;
  const sessionId = options.sessionId || `sess-${now().toString(36)}`;
  const memoriesPath = options.memoriesPath || MEMORIES_PATH;
  const indexPath = options.indexPath || INDEX_PATH;

  /** @type {Array<object>} In-memory event buffer for current session */
  const buffer = [];

  /** @type {Map<string, number>} Memory recall counter (memoryId -> count) */
  const recallCounts = new Map();

  return Object.freeze({
    get sessionId() { return sessionId; },
    get bufferSize() { return buffer.length; },

    /**
     * Capture an event into the session buffer.
     *
     * @param {object} event - Event data (type, tool, message, data, etc.)
     * @returns {object} The captured event with timestamp
     */
    capture(event) {
      if (!event || typeof event !== 'object') return null;
      const entry = Object.freeze({
        ...event,
        timestamp: event.timestamp || now(),
        sessionId,
      });
      if (buffer.length < MAX_BUFFER_EVENTS) buffer.push(entry);
      return entry;
    },

    /**
     * Compress the event buffer into a memory record and persist.
     * Call at session end.
     *
     * @returns {Promise<object|null>} The compressed memory record, or null if buffer empty
     */
    async compress() {
      if (buffer.length === 0) return null;

      const summary = compressEvents(buffer);
      const allText = buffer.map((e) => [
        e.text, e.message, e.type, e.tool, e.category,
        typeof e.data === 'string' ? e.data : '',
      ].filter(Boolean).join(' ')).join(' ');

      const vector = tokenize(allText);
      const keywords = extractKeywords(vector);

      const memory = Object.freeze({
        id: generateId(),
        sessionId,
        summary,
        keywords,
        vector,
        hash: hashContent(summary),
        eventCount: buffer.length,
        score: 1.0,
        recallCount: 0,
        createdAt: now(),
      });

      await ensureDir(path.dirname(memoriesPath));
      const store = await readJsonFile(memoriesPath) || { memories: [] };
      const existing = Array.isArray(store.memories) ? store.memories : [];

      // Deduplicate by hash
      if (existing.some((m) => m.hash === memory.hash)) return null;

      const updated = trimMemories([...existing, memory]);
      await writeJsonFile(memoriesPath, { memories: updated });

      // Rebuild and persist index
      const index = buildIndex(updated);
      await writeJsonFile(indexPath, index);

      buffer.length = 0;
      return memory;
    },

    /**
     * Recall top-K most relevant memories for a given query.
     *
     * @param {string} query - Search query text
     * @param {number} [topK=5] - Number of results
     * @returns {Promise<Array<{memory: object, similarity: number}>>}
     */
    async recall(query, topK = DEFAULT_TOP_K) {
      if (!query || typeof query !== 'string') return [];

      const store = await readJsonFile(memoriesPath);
      const memories = Array.isArray(store?.memories) ? store.memories : [];
      if (memories.length === 0) return [];

      const queryVec = tokenize(query);
      if (Object.keys(queryVec).length === 0) return [];

      const scored = memories
        .map((mem) => ({
          memory: mem,
          similarity: cosineSimilarity(queryVec, mem.vector || {}),
        }))
        .filter((r) => r.similarity > 0)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, topK);

      for (const r of scored) {
        const count = (recallCounts.get(r.memory.id) || 0) + 1;
        recallCounts.set(r.memory.id, count);
      }

      return scored;
    },

    /**
     * Promote a frequently recalled memory to an instinct (lifelong-learner pattern).
     * Returns the promotion record if threshold met, null otherwise.
     *
     * @param {string} memoryId
     * @returns {Promise<object|null>} Promotion record or null
     */
    async promote(memoryId) {
      const count = recallCounts.get(memoryId) || 0;
      if (count < PROMOTE_RECALL_THRESHOLD) return null;

      const store = await readJsonFile(memoriesPath);
      const memories = Array.isArray(store?.memories) ? store.memories : [];
      const target = memories.find((m) => m.id === memoryId);
      if (!target) return null;

      return Object.freeze({
        type: 'session-memory-promotion',
        memoryId,
        summary: target.summary,
        keywords: target.keywords,
        recallCount: count,
        promotedAt: now(),
      });
    },

    /**
     * Prune memories older than maxAgeDays.
     *
     * @param {number} [maxAgeDays=30]
     * @returns {Promise<number>} Number of pruned memories
     */
    async prune(maxAgeDays = DEFAULT_MAX_AGE_DAYS) {
      const cutoff = now() - maxAgeDays * 24 * 60 * 60 * 1000;

      await ensureDir(path.dirname(memoriesPath));
      const store = await readJsonFile(memoriesPath) || { memories: [] };
      const memories = Array.isArray(store.memories) ? store.memories : [];
      const kept = memories.filter((m) => (m.createdAt || 0) >= cutoff);
      const pruned = memories.length - kept.length;

      if (pruned > 0) {
        await writeJsonFile(memoriesPath, { memories: kept });
        const index = buildIndex(kept);
        await writeJsonFile(indexPath, index);
      }

      return pruned;
    },

    /**
     * Get session memory statistics.
     *
     * @returns {Promise<object>}
     */
    async getStats() {
      const store = await readJsonFile(memoriesPath) || { memories: [] };
      const memories = Array.isArray(store.memories) ? store.memories : [];

      const sessions = new Set(memories.map((m) => m.sessionId));
      const totalEvents = memories.reduce((sum, m) => sum + (m.eventCount || 0), 0);
      const avgScore = memories.length > 0
        ? memories.reduce((sum, m) => sum + (m.score || 0), 0) / memories.length
        : 0;

      return Object.freeze({
        totalMemories: memories.length,
        totalSessions: sessions.size,
        totalEvents,
        avgScore: Math.round(avgScore * 100) / 100,
        bufferSize: buffer.length,
        oldestAt: memories.length > 0 ? memories[0].createdAt : null,
        newestAt: memories.length > 0 ? memories[memories.length - 1].createdAt : null,
      });
    },
  });
}
