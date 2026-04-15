/**
 * Retention / rotation utilities for unbounded state files.
 *
 * Provides three primitives consumed by maintenance hooks:
 *   - rotateJsonArray: trim a JSON array file to a max age or count
 *   - rotatePatternFiles: delete dated `auto-learn-YYYY-MM-DD.json` files older than N days
 *   - pruneByMaxEntries: keep only the last N entries of a JSON array
 *
 * All operations are atomic (read → in-memory filter → atomic write), use
 * file locks to coexist with concurrent writers, and never throw — they
 * return a structured report so callers can log without try/catch.
 *
 * @module lib/core/rotation
 */

import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteSync, parseJSON } from '../../scripts/utils/index.js';
import { readFileSync } from 'node:fs';
import { withFileLock } from './file-lock.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Trim a JSON array file by age (entries older than `maxAgeDays`) and/or
 * by count (keep only most recent `maxEntries`). The file must contain
 * either a top-level array or an object with an `entries` array.
 *
 * @param {string} filePath - Absolute path to the JSON file.
 * @param {object} options
 * @param {number} [options.maxAgeDays] - Drop entries with `timestamp` older than this.
 * @param {number} [options.maxEntries] - Keep at most this many entries.
 * @param {string} [options.timestampField='timestamp'] - Field name carrying the timestamp.
 * @returns {{ rotated: boolean, before: number, after: number, removed: number, error?: string }}
 */
export function rotateJsonArray(filePath, options = {}) {
  const { maxAgeDays, maxEntries, timestampField = 'timestamp' } = options;

  if (!existsSync(filePath)) {
    return { rotated: false, before: 0, after: 0, removed: 0 };
  }

  try {
    return withFileLock(filePath, () => {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = parseJSON(raw);

      const isArrayShape = Array.isArray(parsed);
      const entries = isArrayShape ? parsed : (Array.isArray(parsed?.entries) ? parsed.entries : null);
      if (entries === null) {
        return { rotated: false, before: 0, after: 0, removed: 0, error: 'unsupported-shape' };
      }

      const before = entries.length;
      let kept = entries;

      if (typeof maxAgeDays === 'number' && maxAgeDays > 0) {
        const cutoffMs = Date.now() - maxAgeDays * MS_PER_DAY;
        kept = kept.filter((e) => {
          const ts = e?.[timestampField];
          if (typeof ts === 'number') return ts >= cutoffMs;
          if (typeof ts === 'string') {
            const n = Date.parse(ts);
            return Number.isFinite(n) ? n >= cutoffMs : true;
          }
          return true;
        });
      }

      if (typeof maxEntries === 'number' && maxEntries > 0 && kept.length > maxEntries) {
        kept = kept.slice(-maxEntries);
      }

      const after = kept.length;
      if (after === before) {
        return { rotated: false, before, after, removed: 0 };
      }

      const next = isArrayShape ? kept : { ...parsed, entries: kept };
      atomicWriteSync(filePath, next);
      return { rotated: true, before, after, removed: before - after };
    });
  } catch (err) {
    return { rotated: false, before: 0, after: 0, removed: 0, error: err?.message ?? String(err) };
  }
}

/**
 * Delete dated pattern files (`auto-learn-YYYY-MM-DD.json`) older than `maxAgeDays`.
 *
 * @param {string} dir - Directory to scan.
 * @param {object} [options]
 * @param {number} [options.maxAgeDays=14]
 * @param {RegExp} [options.namePattern=/^auto-learn-\d{4}-\d{2}-\d{2}\.json$/]
 * @returns {{ scanned: number, deleted: string[], errors: string[] }}
 */
export function rotatePatternFiles(dir, options = {}) {
  const {
    maxAgeDays = 14,
    namePattern = /^auto-learn-\d{4}-\d{2}-\d{2}\.json$/,
  } = options;

  if (!existsSync(dir)) {
    return { scanned: 0, deleted: [], errors: [] };
  }

  const cutoffMs = Date.now() - maxAgeDays * MS_PER_DAY;
  const deleted = [];
  const errors = [];
  let scanned = 0;

  try {
    const files = readdirSync(dir);
    for (const name of files) {
      if (!namePattern.test(name)) continue;
      scanned += 1;
      const full = path.join(dir, name);
      try {
        const stat = statSync(full);
        if (stat.mtimeMs < cutoffMs) {
          unlinkSync(full);
          deleted.push(name);
        }
      } catch (err) {
        errors.push(`${name}: ${err?.message ?? String(err)}`);
      }
    }
  } catch (err) {
    errors.push(`readdir: ${err?.message ?? String(err)}`);
  }

  return { scanned, deleted, errors };
}

/**
 * Convenience wrapper: keep last N entries of an array-shaped JSON file.
 * @param {string} filePath
 * @param {number} maxEntries
 * @returns {ReturnType<typeof rotateJsonArray>}
 */
export function pruneByMaxEntries(filePath, maxEntries) {
  return rotateJsonArray(filePath, { maxEntries });
}
