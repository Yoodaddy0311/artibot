/**
 * Autopilot Memory store (PRD v4.1 P0-1).
 *
 * Per-feature lesson archive as append-only JSONL:
 *   runtime/autopilot/memory/<featureKey>.jsonl
 *
 * DATA POLICY: 100% local file system; no network, no external SDK.
 * Korean-path safe (path.join + utf-8). Korean tokens via Unicode \p{L}
 * plus 2-char shingles for substring recall.
 *
 * Public surface:
 *   - getMemoryDir / getFeaturePath
 *   - extractKey
 *   - normalizeLesson / appendLesson
 *   - tokenize / jaccard / scoreLesson
 *   - recallLessons
 *   - compactFeature
 *
 * @module lib/autopilot/memory
 */

import path from 'node:path';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { getStoreDir } from './session-store.js';

const LESSON_MAX_CHARS = 240;
const KEY_MAX_CHARS = 64;
const DEFAULT_RECALL_LIMIT = 5;
const DEFAULT_COMPACT_THRESHOLD = 100;
const DEFAULT_COMPACT_KEEP = 50;
const HANGUL_RE = /[\u3131-\uD79D]/;

/**
 * Absolute directory holding all per-feature lesson files.
 * @returns {string}
 */
export function getMemoryDir() {
  return path.join(getStoreDir(), 'memory');
}

/**
 * Resolve the JSONL path for a given feature key.
 * @param {string} featureKey
 * @returns {string}
 */
export function getFeaturePath(featureKey) {
  if (!featureKey || typeof featureKey !== 'string') {
    throw new TypeError('featureKey must be a non-empty string');
  }
  return path.join(getMemoryDir(), `${featureKey}.jsonl`);
}

/**
 * Slugify a task or text into a stable feature key.
 * Korean-safe: keeps \p{L} (incl. Hangul) + digits, collapses whitespace
 * to hyphen, strips other symbols, lowercases, caps length.
 * @param {string} taskOrText
 * @returns {string}
 */
export function extractKey(taskOrText) {
  const src = typeof taskOrText === 'string' ? taskOrText : String(taskOrText ?? '');
  const lowered = src.toLowerCase().normalize('NFKC');
  const collapsed = lowered.replace(/\s+/g, '-');
  const cleaned = collapsed.replace(/[^\p{L}\p{N}-]+/gu, '');
  const trimmed = cleaned.replace(/-+/g, '-').replace(/^-|-$/g, '');
  const sliced = trimmed.slice(0, KEY_MAX_CHARS);
  return sliced || 'untitled';
}

/**
 * Stable 12-char hash for a string (sha256 prefix).
 * @param {string} input
 * @returns {string}
 */
function shortHash(input) {
  return createHash('sha256').update(String(input ?? '')).digest('hex').slice(0, 12);
}

/**
 * Truncate text to LESSON_MAX_CHARS to bound storage growth (R5).
 * @param {string} text
 * @returns {string}
 */
function clipLesson(text) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  return s.length > LESSON_MAX_CHARS ? s.slice(0, LESSON_MAX_CHARS) : s;
}

/**
 * Normalize a raw lesson input into the canonical schema.
 * Missing fields receive safe defaults; lesson body is truncated.
 * @param {object} input
 * @returns {object} normalized lesson
 */
export function normalizeLesson(input) {
  const src = input && typeof input === 'object' ? input : {};
  const lesson = clipLesson(src.lesson ?? '');
  const ts = typeof src.ts === 'string' && src.ts ? src.ts : new Date().toISOString();
  const taskHash = typeof src.taskHash === 'string' && src.taskHash ? src.taskHash : shortHash(lesson);
  const out = { ts, sessionId: src.sessionId ?? null, taskHash, lesson };
  if (src.errorPattern != null) out.errorPattern = String(src.errorPattern);
  if (src.successPattern != null) out.successPattern = String(src.successPattern);
  if (typeof src.tokenCost === 'number' && Number.isFinite(src.tokenCost)) out.tokenCost = src.tokenCost;
  if (src.sourcePhase != null) out.sourcePhase = String(src.sourcePhase);
  return out;
}

/**
 * Append a lesson to <featureKey>.jsonl atomically (single syscall, R1).
 * Creates the memory dir if missing.
 * @param {string} featureKey
 * @param {object} lesson
 * @returns {object} the normalized lesson written
 */
export function appendLesson(featureKey, lesson) {
  if (!featureKey || typeof featureKey !== 'string') {
    throw new TypeError('featureKey must be a non-empty string');
  }
  const dir = getMemoryDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const normalized = normalizeLesson(lesson);
  const line = JSON.stringify(normalized) + '\n';
  appendFileSync(getFeaturePath(featureKey), line, 'utf-8');
  return normalized;
}

/**
 * Tokenize text for similarity. Unicode-aware (\p{L}+) word match plus
 * 2-char shingles for any Hangul-bearing token (R2). Lowercased, deduped
 * via array (Jaccard set semantics handled by jaccard()).
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const src = typeof text === 'string' ? text : String(text ?? '');
  if (!src) return [];
  const lowered = src.toLowerCase();
  const words = lowered.match(/[\p{L}\p{N}]+/gu) || [];
  const tokens = [];
  for (const w of words) {
    if (w.length >= 2) tokens.push(w);
    if (HANGUL_RE.test(w)) {
      for (let i = 0; i < w.length - 1; i += 1) {
        tokens.push(w.slice(i, i + 2));
      }
    }
  }
  return tokens;
}

/**
 * Jaccard similarity over token sets. Returns 0 when both sets empty.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number}
 */
export function jaccard(a, b) {
  const setA = new Set(Array.isArray(a) ? a : []);
  const setB = new Set(Array.isArray(b) ? b : []);
  if (setA.size === 0 && setB.size === 0) return 0;
  let inter = 0;
  for (const t of setA) {
    if (setB.has(t)) inter += 1;
  }
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Score a lesson against pre-tokenized task tokens.
 * Base = jaccard(taskTokens, tokenize(lesson.lesson)); +0.1 if any task
 * token appears in errorPattern (encourages error-pattern recall).
 * @param {string[]} taskTokens
 * @param {object} lesson
 * @returns {number}
 */
export function scoreLesson(taskTokens, lesson) {
  if (!lesson || typeof lesson !== 'object') return 0;
  const lessonTokens = tokenize(lesson.lesson || '');
  let score = jaccard(taskTokens, lessonTokens);
  if (lesson.errorPattern) {
    const epTokens = new Set(tokenize(lesson.errorPattern));
    for (const t of taskTokens) {
      if (epTokens.has(t)) {
        score += 0.1;
        break;
      }
    }
  }
  return score;
}

/**
 * Read JSONL safely, skipping malformed lines with a stderr warning.
 * @param {string} filePath
 * @returns {object[]}
 */
function readLessonFile(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  const out = [];
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      process.stderr.write(`[autopilot.memory] skipped malformed line in ${filePath}\n`);
    }
  }
  return out;
}

/**
 * Recall top-N lessons relevant to a task or feature key.
 * @param {string} taskOrKey
 * @param {{limit?: number, featureKey?: string}} [opts]
 * @returns {object[]}
 */
export function recallLessons(taskOrKey, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : DEFAULT_RECALL_LIMIT;
  const key = typeof options.featureKey === 'string' && options.featureKey
    ? options.featureKey
    : extractKey(taskOrKey || '');
  const filePath = getFeaturePath(key);
  if (!existsSync(filePath)) return [];
  const lessons = readLessonFile(filePath);
  const taskTokens = tokenize(taskOrKey || '');
  const scored = lessons.map((l) => ({ lesson: l, score: scoreLesson(taskTokens, l) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.lesson);
}

/**
 * Build an archive path with auto numeric suffix on collision (R3).
 * @param {string} dir
 * @param {string} baseKey
 * @returns {string}
 */
function pickArchivePath(dir, baseKey) {
  const stamp = new Date().toISOString().replace(/[:]/g, '');
  const base = path.join(dir, `${baseKey}.${stamp}.archive.jsonl`);
  if (!existsSync(base)) return base;
  let n = 1;
  while (existsSync(path.join(dir, `${baseKey}.${stamp}.archive.${n}.jsonl`))) {
    n += 1;
  }
  return path.join(dir, `${baseKey}.${stamp}.archive.${n}.jsonl`);
}

/**
 * Compact a feature file: archive older entries, retain latest N.
 * Noop when total < threshold.
 * @param {string} featureKey
 * @param {{keepLatest?: number, threshold?: number}} [opts]
 * @returns {{archived: number, kept: number}}
 */
export function compactFeature(featureKey, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const keepLatest = Number.isFinite(options.keepLatest) && options.keepLatest > 0
    ? options.keepLatest
    : DEFAULT_COMPACT_KEEP;
  const threshold = Number.isFinite(options.threshold) && options.threshold > 0
    ? options.threshold
    : DEFAULT_COMPACT_THRESHOLD;
  const filePath = getFeaturePath(featureKey);
  if (!existsSync(filePath)) return { archived: 0, kept: 0 };
  const lessons = readLessonFile(filePath);
  if (lessons.length < threshold) return { archived: 0, kept: lessons.length };
  const cut = Math.max(0, lessons.length - keepLatest);
  const older = lessons.slice(0, cut);
  const kept = lessons.slice(cut);
  const archivePath = pickArchivePath(getMemoryDir(), featureKey);
  const archiveBody = older.map((l) => JSON.stringify(l)).join('\n') + '\n';
  writeFileSync(archivePath, archiveBody, 'utf-8');
  const keptBody = kept.map((l) => JSON.stringify(l)).join('\n') + '\n';
  writeFileSync(filePath, keptBody, 'utf-8');
  return { archived: older.length, kept: kept.length };
}
