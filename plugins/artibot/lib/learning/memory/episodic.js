/**
 * Episodic Memory Store (L2) — per-session narratives.
 *
 * Append-only JSONL-like storage keyed by session and timestamp. Supports
 * filtered recall (by session / time window) with cosine ranking reusing the
 * pure TF-IDF helpers from session-memory.js, provenance linkage to the
 * Semantic layer (signature hashes), and retention-policy archival (never
 * hard-deletes — archived blobs move to a dated archive directory).
 *
 * Storage layout:
 *   ~/.claude/artibot/episodic/
 *     ├─ episodes.json         (active records — trimmed by retention)
 *     ├─ links.json            (episodeId -> semantic signatureHash[])
 *     └─ archive/
 *        └─ YYYY-MM/episodes.json  (rolled-off retention blocks)
 *
 * Zero external deps. All writes go through atomic rename (crash-safe).
 *
 * @module lib/learning/memory/episodic
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  atomicWriteJson,
  ensureDir,
  readJsonFile,
} from '../../core/file.js';
import { ARTIBOT_DIR } from '../../core/config.js';
import { cosineSimilarity, tokenize } from '../session-memory.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_STORE_DIR = path.join(ARTIBOT_DIR, 'episodic');
const EPISODES_FILE = 'episodes.json';
const LINKS_FILE = 'links.json';
const ARCHIVE_DIR = 'archive';

const DEFAULT_LIMIT = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types (JSDoc)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} EpisodeRecord
 * @property {string} id - Unique episode id (ep-<base36>-<rand>)
 * @property {string} sessionId - Session that produced the episode
 * @property {number} timestamp - Creation epoch ms
 * @property {string} title - Short human-readable title
 * @property {string} summary - Compressed session narrative (buffer)
 * @property {string[]} keywords - Extracted keywords for fast filter
 * @property {Record<string, number>} vector - TF-IDF vector for cosine rank
 * @property {number} importanceScore - Derived during flush (see design 3.1)
 * @property {string} hash - Stable content hash (dedup)
 * @property {Array<string>} [links] - Semantic signatures this episode supports
 */

/**
 * @typedef {Object} EpisodicStore
 * @property {(record: object) => Promise<EpisodeRecord|null>} appendEpisode
 * @property {(query: string, opts?: object) => Promise<Array<{episode: EpisodeRecord, similarity: number}>>} findEpisodes
 * @property {(episodeId: string, signatureHash: string) => Promise<boolean>} linkToSemantic
 * @property {(date: Date|number) => Promise<number>} pruneBefore
 * @property {() => Promise<EpisodeRecord[]>} listEpisodes
 * @property {() => Promise<Record<string, string[]>>} getLinks
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function genId() {
  return `ep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function stableHash(text) {
  return createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

function coerceTimestamp(value, now) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return now();
}

function coerceCutoff(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toKeywords(text) {
  const freq = tokenize(text);
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([w]) => w);
}

function normaliseRecord(input, now) {
  const timestamp = coerceTimestamp(input.timestamp ?? input.createdAt, now);
  const summary = String(input.summary ?? input.buffer ?? '').slice(0, 4000);
  const title = String(input.title ?? summary.split('\n')[0] ?? 'episode').slice(0, 160);
  const source = [title, summary, ...(Array.isArray(input.keywords) ? input.keywords : [])]
    .filter(Boolean).join(' ');
  const vector = input.vector && typeof input.vector === 'object'
    ? input.vector
    : tokenize(source);
  const keywords = Array.isArray(input.keywords) && input.keywords.length
    ? input.keywords.slice(0, 20).map((k) => String(k))
    : toKeywords(source);
  const importanceScore = typeof input.importanceScore === 'number'
    ? input.importanceScore
    : 0;
  return Object.freeze({
    id: input.id || genId(),
    sessionId: input.sessionId ? String(input.sessionId) : 'unknown',
    timestamp,
    title,
    summary,
    keywords: Object.freeze(keywords),
    vector: Object.freeze({ ...vector }),
    importanceScore,
    hash: input.hash || stableHash(`${title}::${summary}`),
    links: Object.freeze(Array.isArray(input.links) ? input.links.slice() : []),
  });
}

function applyFilters(episodes, filters, now) {
  let list = episodes;
  if (filters.sessionId) {
    list = list.filter((e) => e.sessionId === filters.sessionId);
  }
  if (typeof filters.withinDays === 'number' && filters.withinDays > 0) {
    const cutoff = now() - filters.withinDays * DAY_MS;
    list = list.filter((e) => (e.timestamp ?? 0) >= cutoff);
  }
  return list;
}

function rankEpisodes(list, query, limit) {
  const queryVec = tokenize(query);
  if (Object.keys(queryVec).length === 0) {
    return list
      .slice(0, limit)
      .map((episode) => ({ episode, similarity: 0 }));
  }
  return list
    .map((episode) => ({
      episode,
      similarity: cosineSimilarity(queryVec, episode.vector || {}),
    }))
    .filter((r) => r.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an EpisodicStore bound to a directory.
 *
 * @param {object} [options]
 * @param {string} [options.storePath] - Root directory (default `ARTIBOT_DIR/episodic`)
 * @param {() => number} [options.now] - Clock injection for tests
 * @returns {EpisodicStore}
 */
export function createEpisodicStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const storePath = options.storePath || DEFAULT_STORE_DIR;
  const episodesPath = path.join(storePath, EPISODES_FILE);
  const linksPath = path.join(storePath, LINKS_FILE);

  async function readEpisodes() {
    const raw = await readJsonFile(episodesPath);
    const list = Array.isArray(raw?.episodes) ? raw.episodes : [];
    return list;
  }

  async function writeEpisodes(list) {
    await ensureDir(storePath);
    await atomicWriteJson(episodesPath, {
      episodes: list,
      updatedAt: new Date(now()).toISOString(),
    });
  }

  async function readLinks() {
    const raw = await readJsonFile(linksPath);
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  }

  async function writeLinks(map) {
    await ensureDir(storePath);
    await atomicWriteJson(linksPath, map);
  }

  async function appendEpisode(record) {
    if (!record || typeof record !== 'object') return null;
    const normalised = normaliseRecord(record, now);
    const existing = await readEpisodes();
    if (existing.some((e) => e.hash === normalised.hash)) return null;
    const next = [...existing, normalised];
    await writeEpisodes(next);
    return normalised;
  }

  async function findEpisodes(query, opts = {}) {
    const limit = typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;
    const list = await readEpisodes();
    if (list.length === 0) return [];
    const filtered = applyFilters(list, opts, now);
    if (!query) {
      return filtered
        .slice()
        .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
        .slice(0, limit)
        .map((episode) => ({ episode, similarity: 0 }));
    }
    return rankEpisodes(filtered, String(query), limit);
  }

  async function linkToSemantic(episodeId, signatureHash) {
    if (!episodeId || !signatureHash) return false;
    const map = await readLinks();
    const prior = Array.isArray(map[episodeId]) ? map[episodeId] : [];
    if (prior.includes(signatureHash)) return true;
    map[episodeId] = [...prior, signatureHash];
    await writeLinks(map);
    return true;
  }

  async function pruneBefore(date) {
    const cutoff = coerceCutoff(date);
    if (cutoff === null) return 0;
    const list = await readEpisodes();
    const keep = list.filter((e) => (e.timestamp ?? 0) >= cutoff);
    const archived = list.filter((e) => (e.timestamp ?? 0) < cutoff);
    if (archived.length === 0) return 0;
    const stamp = new Date(now());
    const bucket = `${stamp.getUTCFullYear()}-${String(stamp.getUTCMonth() + 1).padStart(2, '0')}`;
    const archiveDir = path.join(storePath, ARCHIVE_DIR, bucket);
    const archivePath = path.join(archiveDir, EPISODES_FILE);
    await ensureDir(archiveDir);
    const priorArchive = await readJsonFile(archivePath);
    const priorList = Array.isArray(priorArchive?.episodes) ? priorArchive.episodes : [];
    await atomicWriteJson(archivePath, {
      episodes: [...priorList, ...archived],
      archivedAt: new Date(now()).toISOString(),
    });
    await writeEpisodes(keep);
    return archived.length;
  }

  async function listEpisodes() {
    return readEpisodes();
  }

  async function getLinks() {
    return readLinks();
  }

  return Object.freeze({
    appendEpisode,
    findEpisodes,
    linkToSemantic,
    pruneBefore,
    listEpisodes,
    getLinks,
  });
}
