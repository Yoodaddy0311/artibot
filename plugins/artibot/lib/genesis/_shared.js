/**
 * Genesis shared low-level filesystem helpers — pure, non-destructive,
 * Korean-path safe, atomic. Net-new for the `/genesis` MVP renderers
 * (tree-gen / flow-gen / dataset-gen).
 *
 * Design note (option A, locked): nonCollidingPath / slugify / resolveNow
 * mirror the *module-private* helpers in `lib/planning/artifacts.js`.
 * artifacts.js does not export them, so they are re-defined here inside the
 * genesis namespace rather than modify the stable file. This is the only
 * sanctioned re-definition (low-level fs primitives only) — higher-level
 * artifact writers (writePRD etc.) are reused, never re-implemented.
 *
 * `atomicWriteText` is NOT re-defined: it is the canonical
 * `lib/core/file.js#atomicWriteText`, re-exported. The "artifacts.js does not
 * export it" reason above never applied to it — core exports it publicly, and
 * genesis (L2) importing core (L1) is the allowed direction. The local copy
 * that used to live here renamed once with no retry, so a transient Windows
 * destination lock (EPERM/EBUSY/EACCES) failed a blueprint write the core
 * writer rides out (M8, 2026-11-21).
 *
 * Rules:
 *   - Pure & non-destructive: never overwrite an existing file. On collision a
 *     `-NN` suffix is appended so prior output survives.
 *   - `now` is injectable for deterministic tests: a `() => Date` function or a
 *     `Date`. Defaults to `() => new Date()`.
 *   - Korean-path safe: `path.join` only (no manual separators / URL coercion).
 *   - Atomic writes: temp sibling + rename so readers never see a partial file.
 *   - No network. No external services. Local filesystem only (DATA POLICY).
 *
 * @module lib/genesis/_shared
 */

import path from 'node:path';
import fs from 'node:fs/promises';

export { atomicWriteText } from '../core/file.js';

/** @typedef {() => Date} NowFn */

const DEFAULT_NOW = () => new Date();

/**
 * Resolve a `now` argument into a Date, tolerating both function and Date.
 * @param {NowFn|Date} [now]
 * @returns {Date}
 */
export function resolveNow(now) {
  if (typeof now === 'function') return now();
  if (now instanceof Date) return now;
  return DEFAULT_NOW();
}

/**
 * Format a Date as `YYYY-MM-DD HH:MM` for human-readable headers.
 * @param {Date} d
 * @returns {string}
 */
export function humanStamp(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Slugify a title into a filesystem-safe, lowercase token. Keeps unicode
 * letters/numbers (so Korean titles stay meaningful), collapses everything
 * else to single hyphens.
 * @param {string} title
 * @returns {string}
 */
export function slugify(title) {
  const base = String(title || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'untitled';
}

/**
 * Check whether a path exists, tolerating any access error as "absent".
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return a non-colliding absolute path. Tries `<dir>/<base><ext>` first, then
 * `<base>-2`, `<base>-3`, ... so existing files are never overwritten.
 * @param {string} dir
 * @param {string} base - Filename without extension.
 * @param {string} ext - Extension including leading dot (e.g. `.md`).
 * @returns {Promise<string>}
 */
export async function nonCollidingPath(dir, base, ext) {
  const first = path.join(dir, `${base}${ext}`);
  if (!(await exists(first))) return first;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = path.join(dir, `${base}-${i}${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
  // Astronomically unlikely fallback.
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

/**
 * Escape pipe + newline so arbitrary text is safe inside a GFM table cell.
 * @param {string} value
 * @returns {string}
 */
export function cell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}
