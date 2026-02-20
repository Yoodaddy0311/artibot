/**
 * Swarm Persistence - File-based persistence layer for swarm intelligence data.
 *
 * Provides durable storage for swarm patterns, weights, and metadata
 * at ~/.claude/artibot/swarm-db.json. Includes debounced writes to
 * avoid excessive disk I/O and graceful handling of missing files.
 *
 * Zero external dependencies.
 *
 * @module lib/swarm/swarm-persistence
 */

import path from 'node:path';
import { ensureDir, exists, readJsonFile, writeJsonFile } from '../core/file.js';
import { ARTIBOT_DIR } from '../core/config.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DB_PATH = path.join(ARTIBOT_DIR, 'swarm-db.json');

/** Default debounce delay for saveToDisk (ms) */
const DEFAULT_DEBOUNCE_MS = 2000;

/** Maximum entries per collection to prevent unbounded growth */
const MAX_ENTRIES_PER_COLLECTION = 500;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SwarmDb
 * @property {number} version - Schema version for future migrations
 * @property {object} patterns - Stored pattern data keyed by pattern key
 * @property {object} weights - Cached merged weight vectors
 * @property {object} metadata - Session and sync metadata
 * @property {string} updatedAt - ISO timestamp of last update
 */

/**
 * Create an empty database structure.
 *
 * @returns {SwarmDb}
 */
function createEmptyDb() {
  return {
    version: 1,
    patterns: {},
    weights: {},
    metadata: {
      sessionsCount: 0,
      firstCreated: new Date().toISOString(),
      lastAccessed: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// In-Memory State
// ---------------------------------------------------------------------------

/** @type {SwarmDb | null} */
let _db = null;

/** @type {boolean} */
let _dirty = false;

/** @type {ReturnType<typeof setTimeout> | null} */
let _debounceTimer = null;

/** @type {number} */
let _debounceMs = DEFAULT_DEBOUNCE_MS;

// ---------------------------------------------------------------------------
// Core Persistence API
// ---------------------------------------------------------------------------

/**
 * Load swarm database from disk.
 *
 * Returns the in-memory database after loading. If no file exists on disk
 * (first run), initializes with an empty database structure. Invalid or
 * corrupt files are replaced with a fresh database.
 *
 * @returns {Promise<SwarmDb>} The loaded (or initialized) database
 */
export async function loadFromDisk() {
  const data = await readJsonFile(DB_PATH);

  if (data && typeof data === 'object' && typeof data.version === 'number') {
    _db = {
      version: data.version,
      patterns: data.patterns && typeof data.patterns === 'object' ? data.patterns : {},
      weights: data.weights && typeof data.weights === 'object' ? data.weights : {},
      metadata: data.metadata && typeof data.metadata === 'object'
        ? { ...createEmptyDb().metadata, ...data.metadata }
        : createEmptyDb().metadata,
      updatedAt: data.updatedAt ?? new Date().toISOString(),
    };
  } else {
    _db = createEmptyDb();
  }

  _db.metadata.lastAccessed = new Date().toISOString();
  _dirty = false;

  return _db;
}

/**
 * Save the current in-memory database to disk immediately.
 *
 * Ensures the parent directory exists before writing. Updates the
 * `updatedAt` timestamp on save.
 *
 * @returns {Promise<void>}
 */
export async function saveToDisk() {
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }

  if (!_db) {
    return;
  }

  _db.updatedAt = new Date().toISOString();

  // Prune collections to prevent unbounded growth
  _db.patterns = pruneCollection(_db.patterns);
  _db.weights = pruneCollection(_db.weights);

  await ensureDir(ARTIBOT_DIR);
  await writeJsonFile(DB_PATH, _db);
  _dirty = false;
}

/**
 * Schedule a debounced save to disk.
 *
 * Coalesces multiple rapid updates into a single write. The save
 * triggers after the debounce delay expires with no new calls.
 *
 * @param {number} [delayMs] - Debounce delay in ms (default: 2000)
 * @returns {void}
 */
export function scheduleSave(delayMs) {
  const delay = delayMs ?? _debounceMs;

  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
  }

  _debounceTimer = setTimeout(async () => {
    _debounceTimer = null;
    try {
      await saveToDisk();
    } catch {
      // Best-effort persistence - log but don't throw
    }
  }, delay);
}

/**
 * Clear all persisted data and reset to empty state.
 *
 * Removes the database file from disk and resets in-memory state.
 * Used for testing or when a full reset is needed.
 *
 * @returns {Promise<void>}
 */
export async function clearPersistence() {
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }

  _db = createEmptyDb();
  _dirty = false;

  // Overwrite the file with empty state rather than deleting,
  // so the file always exists after first use
  const fileExists = await exists(DB_PATH);
  if (fileExists) {
    await writeJsonFile(DB_PATH, _db);
  }
}

// ---------------------------------------------------------------------------
// Data Access API
// ---------------------------------------------------------------------------

/**
 * Get a pattern by key from the in-memory database.
 *
 * @param {string} key - Pattern key (e.g., "tool::Read")
 * @returns {object | null} The pattern data, or null if not found
 */
export function getPattern(key) {
  if (!_db || !key) return null;
  return _db.patterns[key] ?? null;
}

/**
 * Store or update a pattern in the in-memory database.
 *
 * Marks the database as dirty and schedules a debounced save.
 *
 * @param {string} key - Pattern key
 * @param {object} data - Pattern data to store
 * @returns {void}
 */
export function setPattern(key, data) {
  if (!_db) {
    _db = createEmptyDb();
  }

  _db.patterns[key] = {
    ...data,
    storedAt: new Date().toISOString(),
  };
  _dirty = true;
  scheduleSave();
}

/**
 * Remove a pattern from the in-memory database.
 *
 * @param {string} key - Pattern key to remove
 * @returns {boolean} True if the key existed and was removed
 */
export function removePattern(key) {
  if (!_db || !_db.patterns[key]) return false;

  delete _db.patterns[key];
  _dirty = true;
  scheduleSave();
  return true;
}

/**
 * Get all patterns from the in-memory database.
 *
 * @returns {object} Shallow copy of the patterns object
 */
export function getAllPatterns() {
  if (!_db) return {};
  return { ..._db.patterns };
}

/**
 * Store merged weights in the database.
 *
 * @param {object} weights - Merged weight vectors
 * @returns {void}
 */
export function setWeights(weights) {
  if (!_db) {
    _db = createEmptyDb();
  }

  _db.weights = weights && typeof weights === 'object' ? { ...weights } : {};
  _dirty = true;
  scheduleSave();
}

/**
 * Get cached merged weights from the database.
 *
 * @returns {object} Shallow copy of the weights object
 */
export function getWeights() {
  if (!_db) return {};
  return { ..._db.weights };
}

/**
 * Update metadata fields in the database.
 *
 * Merges provided fields into the existing metadata object.
 *
 * @param {object} fields - Metadata fields to update
 * @returns {void}
 */
export function updateMetadata(fields) {
  if (!_db) {
    _db = createEmptyDb();
  }

  _db.metadata = { ..._db.metadata, ...fields };
  _dirty = true;
  scheduleSave();
}

/**
 * Get current metadata from the database.
 *
 * @returns {object} Shallow copy of the metadata object
 */
export function getMetadata() {
  if (!_db) return {};
  return { ..._db.metadata };
}

// ---------------------------------------------------------------------------
// State Inspection
// ---------------------------------------------------------------------------

/**
 * Check if the in-memory database has unsaved changes.
 *
 * @returns {boolean}
 */
export function isDirty() {
  return _dirty;
}

/**
 * Check if the database has been loaded from disk.
 *
 * @returns {boolean}
 */
export function isLoaded() {
  return _db !== null;
}

/**
 * Get the database file path.
 *
 * @returns {string}
 */
export function getDbPath() {
  return DB_PATH;
}

/**
 * Configure the debounce delay for scheduled saves.
 *
 * @param {number} ms - Debounce delay in milliseconds
 * @returns {void}
 */
export function setDebounceDelay(ms) {
  if (typeof ms === 'number' && ms >= 0) {
    _debounceMs = ms;
  }
}

/**
 * Reset internal state for testing.
 * Clears in-memory data and pending timers without touching disk.
 *
 * @returns {void}
 */
export function _resetForTesting() {
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  _db = null;
  _dirty = false;
  _debounceMs = DEFAULT_DEBOUNCE_MS;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Prune a collection object to stay within size limits.
 * Keeps the most recently stored entries.
 *
 * @param {object} collection - Object to prune
 * @returns {object} Pruned object
 */
function pruneCollection(collection) {
  if (!collection || typeof collection !== 'object') return {};

  const keys = Object.keys(collection);
  if (keys.length <= MAX_ENTRIES_PER_COLLECTION) return collection;

  // Sort by storedAt (newest first), fall back to key order
  const sorted = keys.sort((a, b) => {
    const aTime = collection[a]?.storedAt ?? '';
    const bTime = collection[b]?.storedAt ?? '';
    return bTime.localeCompare(aTime);
  });

  const pruned = {};
  for (let i = 0; i < MAX_ENTRIES_PER_COLLECTION; i++) {
    pruned[sorted[i]] = collection[sorted[i]];
  }
  return pruned;
}
