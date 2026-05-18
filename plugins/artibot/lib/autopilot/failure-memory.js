/**
 * Persistent cross-session failure memory (v4.11.0 Track K).
 *
 * Stores failure clusters per-repo under `~/.artibot/failure-memory/{repoHash}.json`
 * so the autopilot engine can warn a beginner about past recurring failures
 * BEFORE the same goal is attempted again.
 *
 * Storage shape (per file):
 *   {
 *     version: 1,
 *     repoHash: "...",
 *     entries: [
 *       {
 *         signature: string,
 *         count: number,
 *         firstSeen: string|null,   // ISO-8601
 *         lastSeen:  string|null,   // ISO-8601 — refreshed on every record()
 *         sampleMessage: string,
 *         sessions: string[],
 *         updatedAt: string         // ISO-8601 — LRU sort key
 *       },
 *       ...
 *     ]
 *   }
 *
 * DATA POLICY: local-only writes under user's home dir; never sent off-host.
 * Korean-path safe via `os.homedir()` + `path.join`.
 *
 * Public surface:
 *   - computeRepoHash(cwd)
 *   - getMemoryPath(repoHash, opts?)
 *   - recordFailureMemory(repoHash, cluster, opts?)
 *   - recallRelevantFailures(repoHash, prompt, opts?)
 *   - pruneOldMemory(repoHash, maxAgeMs, opts?)
 *
 * @module lib/autopilot/failure-memory
 */

import path from 'node:path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

/** Schema version stamped on every written file. */
export const FAILURE_MEMORY_SCHEMA_VERSION = 1;

/** LRU cap — oldest `updatedAt` entries are evicted past this size. */
export const DEFAULT_MAX_ENTRIES = 100;

/** Default TTL = 90 days in ms. */
export const DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** Default recall limit returned by recallRelevantFailures. */
export const DEFAULT_RECALL_LIMIT = 3;

/** Minimum keyword overlap (in chars) to count a prompt token as a hit. */
const MIN_TOKEN_LEN = 3;

/**
 * Resolve the on-disk path for a repo's failure-memory file.
 * Uses `os.homedir()` + `path.join`; safe for Korean / spaced paths.
 *
 * @param {string} repoHash 40-char sha1 hex (validated)
 * @param {{ storeDir?: string }} [opts]
 * @returns {string}
 */
export function getMemoryPath(repoHash, opts = {}) {
  if (!isValidHash(repoHash)) {
    throw new TypeError('repoHash must be a sha1 hex string');
  }
  const dir = opts.storeDir || defaultStoreDir();
  return path.join(dir, `${repoHash}.json`);
}

/**
 * Stable per-repo hash. Prefers the git remote URL (so a repo on multiple
 * machines collapses to the same bucket); falls back to the absolute cwd
 * path so repos without a remote still get a stable id.
 *
 * @param {string} cwd
 * @param {{ remoteResolver?: (cwd: string) => string }} [opts] DI for tests
 * @returns {string} 40-char sha1 hex
 */
export function computeRepoHash(cwd, opts = {}) {
  const resolver = typeof opts.remoteResolver === 'function'
    ? opts.remoteResolver
    : safeGitRemote;
  const remote = typeof cwd === 'string' ? resolver(cwd) : '';
  const source = remote && remote.trim()
    ? `remote:${remote.trim()}`
    : `cwd:${typeof cwd === 'string' ? cwd : ''}`;
  return createHash('sha1').update(source).digest('hex');
}

/**
 * Append (or refresh) a cluster into the repo-specific memory file.
 * Idempotent on `cluster.signature`: re-recording bumps `count`, `lastSeen`,
 * and `updatedAt` instead of creating a duplicate entry.
 *
 * After write, enforces the LRU cap by `updatedAt` (oldest evicted first).
 *
 * @param {string} repoHash
 * @param {{ signature: string, count?: number, firstSeen?: string|null, lastSeen?: string|null, sampleMessage?: string, sessions?: string[] }} cluster
 * @param {{ storeDir?: string, now?: () => Date, maxEntries?: number }} [opts]
 * @returns {{ written: boolean, total: number, evicted: number }}
 */
export function recordFailureMemory(repoHash, cluster, opts = {}) {
  if (!cluster || typeof cluster !== 'object' || typeof cluster.signature !== 'string' || !cluster.signature) {
    return { written: false, total: 0, evicted: 0 };
  }
  const max = positiveInt(opts.maxEntries, DEFAULT_MAX_ENTRIES);
  const now = nowIso(opts.now);
  const file = getMemoryPath(repoHash, opts);
  const state = readState(file, repoHash);
  const idx = state.entries.findIndex((e) => e.signature === cluster.signature);
  if (idx >= 0) {
    state.entries[idx] = mergeEntry(state.entries[idx], cluster, now);
  } else {
    state.entries.push(buildEntry(cluster, now));
  }
  const evicted = enforceLru(state.entries, max);
  writeStateAtomic(file, state);
  return { written: true, total: state.entries.length, evicted };
}

/**
 * Return up to `limit` past failure entries whose signature shares tokens
 * with the supplied prompt. Sorted by descending overlap then descending
 * count. Returns `[]` when no file exists.
 *
 * @param {string} repoHash
 * @param {string} prompt
 * @param {{ storeDir?: string, limit?: number }} [opts]
 * @returns {Array<{ signature: string, count: number, firstSeen: string|null, lastSeen: string|null, sampleMessage: string, sessions: string[], updatedAt: string, overlap: number }>}
 */
export function recallRelevantFailures(repoHash, prompt, opts = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()) return [];
  const file = getMemoryPath(repoHash, opts);
  if (!existsSync(file)) return [];
  const state = readState(file, repoHash);
  const tokens = tokenize(prompt);
  if (tokens.size === 0) return [];
  const limit = positiveInt(opts.limit, DEFAULT_RECALL_LIMIT);
  const scored = [];
  for (const entry of state.entries) {
    const overlap = countOverlap(entry, tokens);
    if (overlap > 0) scored.push({ ...entry, overlap });
  }
  scored.sort((a, b) => (b.overlap - a.overlap) || (b.count - a.count));
  return scored.slice(0, limit);
}

/**
 * Drop entries whose `updatedAt` is older than `maxAgeMs`. Rewrites the
 * file atomically iff at least one entry was removed. Returns counts.
 *
 * @param {string} repoHash
 * @param {number} [maxAgeMs] default 90d
 * @param {{ storeDir?: string, now?: () => Date }} [opts]
 * @returns {{ pruned: number, remaining: number }}
 */
export function pruneOldMemory(repoHash, maxAgeMs = DEFAULT_MAX_AGE_MS, opts = {}) {
  const file = getMemoryPath(repoHash, opts);
  if (!existsSync(file)) return { pruned: 0, remaining: 0 };
  const state = readState(file, repoHash);
  const cutoff = (resolveNow(opts.now)).getTime() - positiveInt(maxAgeMs, DEFAULT_MAX_AGE_MS);
  const before = state.entries.length;
  state.entries = state.entries.filter((e) => entryAgeOk(e, cutoff));
  const pruned = before - state.entries.length;
  if (pruned > 0) writeStateAtomic(file, state);
  return { pruned, remaining: state.entries.length };
}

// ─── helpers ───────────────────────────────────────────────────────────

function defaultStoreDir() {
  return path.join(homedir(), '.artibot', 'failure-memory');
}

function isValidHash(h) {
  return typeof h === 'string' && /^[0-9a-f]{40}$/i.test(h);
}

function safeGitRemote(cwd) {
  try {
    return execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    return '';
  }
}

function resolveNow(nowFn) {
  if (typeof nowFn === 'function') {
    const v = nowFn();
    return v instanceof Date ? v : new Date(v);
  }
  return new Date();
}

function nowIso(nowFn) {
  return resolveNow(nowFn).toISOString();
}

function positiveInt(v, fallback) {
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

function readState(file, repoHash) {
  if (!existsSync(file)) return emptyState(repoHash);
  try {
    const raw = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
      return emptyState(repoHash);
    }
    return {
      version: FAILURE_MEMORY_SCHEMA_VERSION,
      repoHash,
      entries: parsed.entries.filter((e) => e && typeof e.signature === 'string'),
    };
  } catch {
    return emptyState(repoHash);
  }
}

function emptyState(repoHash) {
  return { version: FAILURE_MEMORY_SCHEMA_VERSION, repoHash, entries: [] };
}

function writeStateAtomic(file, state) {
  const dir = path.dirname(file);
  try { mkdirSync(dir, { recursive: true }); } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const payload = JSON.stringify(state, null, 2);
  try {
    writeFileSync(tmp, payload, 'utf-8');
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* tmp may not exist */ }
    throw err;
  }
}

function buildEntry(cluster, now) {
  return {
    signature: cluster.signature,
    count: Number.isInteger(cluster.count) && cluster.count > 0 ? cluster.count : 1,
    firstSeen: cluster.firstSeen || now,
    lastSeen: cluster.lastSeen || now,
    sampleMessage: typeof cluster.sampleMessage === 'string' ? cluster.sampleMessage : '',
    sessions: Array.isArray(cluster.sessions) ? [...new Set(cluster.sessions)].sort() : [],
    updatedAt: now,
  };
}

function mergeEntry(prev, cluster, now) {
  const sessions = new Set(prev.sessions || []);
  if (Array.isArray(cluster.sessions)) {
    for (const s of cluster.sessions) sessions.add(s);
  }
  const incomingCount = Number.isInteger(cluster.count) && cluster.count > 0 ? cluster.count : 1;
  return {
    signature: prev.signature,
    count: prev.count + incomingCount,
    firstSeen: minIso(prev.firstSeen, cluster.firstSeen) || prev.firstSeen,
    lastSeen: maxIso(prev.lastSeen, cluster.lastSeen || now) || now,
    sampleMessage: cluster.sampleMessage || prev.sampleMessage,
    sessions: [...sessions].sort(),
    updatedAt: now,
  };
}

function minIso(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return a < b ? a : b;
}

function maxIso(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return a > b ? a : b;
}

function enforceLru(entries, max) {
  if (entries.length <= max) return 0;
  entries.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const removed = entries.splice(max);
  return removed.length;
}

function entryAgeOk(entry, cutoffMs) {
  const ts = entry.updatedAt || entry.lastSeen || entry.firstSeen;
  if (!ts) return true;
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return true;
  return t >= cutoffMs;
}

function tokenize(text) {
  const lowered = String(text).toLowerCase();
  const parts = lowered.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const out = new Set();
  for (const p of parts) {
    if (p.length >= MIN_TOKEN_LEN) out.add(p);
  }
  return out;
}

function countOverlap(entry, tokens) {
  const hay = `${entry.signature || ''} ${entry.sampleMessage || ''}`.toLowerCase();
  let hits = 0;
  for (const t of tokens) {
    if (hay.includes(t)) hits += 1;
  }
  return hits;
}
