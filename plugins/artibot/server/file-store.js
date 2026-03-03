/**
 * File-based persistence for Federated Swarm server.
 *
 * Provides JSON file storage so data survives Cloud Run cold starts.
 * Falls back gracefully to in-memory when the data directory is unavailable.
 *
 * Uses atomic writes (write-to-temp then rename) to prevent corruption.
 *
 * @module server/file-store
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Data directory — configurable via DATA_DIR env var */
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');

/** Debounce delay for saves (ms) */
const SAVE_DEBOUNCE_MS = 2000;

/** Pending save timers keyed by filename */
const pendingTimers = new Map();

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Ensure the data directory exists.
 *
 * @returns {boolean} true if directory is writable, false otherwise
 */
export function initDataDir() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

/**
 * Read a JSON file from the data directory.
 *
 * @param {string} filename - File name (not path) e.g. 'weights.json'
 * @returns {object|null} Parsed data or null if missing/corrupt
 */
export function readData(filename) {
  try {
    const filePath = path.join(DATA_DIR, filename);
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Write data to a JSON file atomically (write temp → rename).
 *
 * @param {string} filename - File name
 * @param {object} data - Data to serialize
 * @returns {boolean} true on success, false on failure
 */
export function writeData(filename, data) {
  try {
    const filePath = path.join(DATA_DIR, filename);
    const tmpPath = `${filePath}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmpPath, filePath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Debounced Save
// ---------------------------------------------------------------------------

/**
 * Schedule a debounced write. Coalesces rapid writes into a single disk I/O.
 *
 * @param {string} filename - Target file
 * @param {() => object} dataFn - Function that returns the data to save
 */
export function scheduleSave(filename, dataFn) {
  if (pendingTimers.has(filename)) {
    clearTimeout(pendingTimers.get(filename));
  }

  const timer = setTimeout(() => {
    pendingTimers.delete(filename);
    const data = dataFn();
    if (data !== null && data !== undefined) {
      writeData(filename, data);
    }
  }, SAVE_DEBOUNCE_MS);

  // Don't block process exit
  if (timer.unref) timer.unref();

  pendingTimers.set(filename, timer);
}

/**
 * Flush all pending saves immediately (for graceful shutdown).
 *
 * @param {Map<string, () => object>} dataProviders - Map of filename → data function
 * @returns {number} Number of files flushed
 */
export function flushAll(dataProviders) {
  let flushed = 0;
  for (const [filename, timer] of pendingTimers) {
    clearTimeout(timer);
    pendingTimers.delete(filename);
    const dataFn = dataProviders.get(filename);
    if (dataFn) {
      const data = dataFn();
      if (data !== null && data !== undefined && writeData(filename, data)) {
        flushed++;
      }
    }
  }
  return flushed;
}

// ---------------------------------------------------------------------------
// Snapshot Helpers
// ---------------------------------------------------------------------------

/**
 * Serialize a Map to a plain object for JSON storage.
 *
 * @param {Map<string, *>} map
 * @returns {object}
 */
export function mapToObject(map) {
  const obj = {};
  for (const [key, value] of map) {
    obj[key] = value;
  }
  return obj;
}

/**
 * Restore a Map from a plain object.
 *
 * @param {object} obj
 * @returns {Map<string, *>}
 */
export function objectToMap(obj) {
  const map = new Map();
  if (obj && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      map.set(key, value);
    }
  }
  return map;
}
