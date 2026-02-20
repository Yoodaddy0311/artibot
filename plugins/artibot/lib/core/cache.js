/**
 * TTL-based in-memory cache with optional LRU eviction and file-mtime invalidation.
 * @module lib/core/cache
 */

import { statSync } from 'node:fs';

/**
 * TTL-based in-memory cache for storing temporary values with automatic expiration.
 * Supports optional LRU eviction via `maxSize` and file-mtime-based invalidation.
 *
 * @example
 * const cache = new Cache(60000); // 60s TTL
 * cache.set('key', { data: 'value' });
 * const val = cache.get('key'); // { data: 'value' }
 * // After 60 seconds, cache.get('key') returns undefined
 *
 * // LRU eviction
 * const lru = new Cache(60000, { maxSize: 100 });
 * // Oldest entries are evicted when cache exceeds 100 entries
 */
export class Cache {
  /**
   * Create a new Cache instance.
   *
   * @param {number} [defaultTTL=30000] - Default time-to-live in milliseconds for cached entries.
   * @param {object} [options] - Additional cache options.
   * @param {number} [options.maxSize=0] - Maximum number of entries. 0 means unlimited (no LRU eviction).
   */
  constructor(defaultTTL = 30000, options = {}) {
    this._store = new Map();
    this._defaultTTL = defaultTTL;
    this._maxSize = options.maxSize || 0;
  }

  /**
   * Set a value in the cache with an optional TTL override.
   * If maxSize is set and the cache is at capacity, evicts the least-recently-used entry.
   *
   * @param {string} key - Cache key.
   * @param {*} value - Value to store.
   * @param {number} [ttl] - TTL in milliseconds; defaults to the constructor value.
   * @returns {Cache} The cache instance (for chaining).
   * @example
   * cache.set('user:123', userData);
   * cache.set('temp', value, 5000); // expires in 5 seconds
   */
  set(key, value, ttl) {
    // If key already exists, delete first so re-insert moves it to the end (most recent)
    if (this._store.has(key)) {
      this._store.delete(key);
    }

    // LRU eviction: remove the oldest entry (first in Map iteration order)
    if (this._maxSize > 0 && this._store.size >= this._maxSize) {
      const oldest = this._store.keys().next().value;
      this._store.delete(oldest);
    }

    const expiresAt = Date.now() + (ttl ?? this._defaultTTL);
    this._store.set(key, { value, expiresAt });
    return this;
  }

  /**
   * Set a value with file-mtime-based invalidation.
   * The cached value is only returned by get() if the file has not been modified
   * since it was cached.
   *
   * @param {string} key - Cache key.
   * @param {*} value - Value to store.
   * @param {string} filePath - Absolute path to the file whose mtime is tracked.
   * @param {number} [ttl] - TTL in milliseconds; defaults to the constructor value.
   * @returns {Cache} The cache instance (for chaining).
   */
  setWithMtime(key, value, filePath, ttl) {
    if (this._store.has(key)) {
      this._store.delete(key);
    }

    if (this._maxSize > 0 && this._store.size >= this._maxSize) {
      const oldest = this._store.keys().next().value;
      this._store.delete(oldest);
    }

    let mtime = null;
    try {
      mtime = statSync(filePath).mtimeMs;
    } catch {
      // File unreadable — cache without mtime tracking
    }

    const expiresAt = Date.now() + (ttl ?? this._defaultTTL);
    this._store.set(key, { value, expiresAt, filePath, mtime });
    return this;
  }

  /**
   * Get a cached value by key. Returns `undefined` if the key is missing, expired,
   * or if the associated file has been modified since caching.
   * Expired or invalidated entries are automatically removed on access.
   * Accessing a valid entry promotes it as most-recently-used for LRU.
   *
   * @param {string} key - Cache key to retrieve.
   * @returns {*} The cached value, or `undefined` if not found or expired.
   * @example
   * const value = cache.get('user:123');
   * if (value !== undefined) {
   *   // use cached value
   * }
   */
  get(key) {
    const entry = this._store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this._store.delete(key);
      return undefined;
    }

    // File-mtime invalidation check
    if (entry.filePath && entry.mtime !== null) {
      try {
        const currentMtime = statSync(entry.filePath).mtimeMs;
        if (currentMtime !== entry.mtime) {
          this._store.delete(key);
          return undefined;
        }
      } catch {
        // File gone or unreadable — invalidate
        this._store.delete(key);
        return undefined;
      }
    }

    // LRU promotion: move to end of Map iteration order
    if (this._maxSize > 0) {
      this._store.delete(key);
      this._store.set(key, entry);
    }

    return entry.value;
  }

  /**
   * Check if a key exists in the cache and is not expired.
   *
   * @param {string} key - Cache key to check.
   * @returns {boolean} `true` if the key exists and has not expired.
   * @example
   * if (cache.has('user:123')) {
   *   // key is cached and valid
   * }
   */
  has(key) {
    return this.get(key) !== undefined;
  }

  /**
   * Delete a specific key from the cache.
   *
   * @param {string} key - Cache key to delete.
   * @returns {boolean} `true` if the key was found and deleted.
   * @example
   * cache.delete('user:123');
   */
  delete(key) {
    return this._store.delete(key);
  }

  /**
   * Clear all entries from the cache.
   *
   * @returns {void}
   * @example
   * cache.clear(); // remove everything
   */
  clear() {
    this._store.clear();
  }

  /**
   * Remove all expired entries from the cache.
   * Useful for periodic cleanup to free memory.
   *
   * @returns {void}
   * @example
   * cache.prune(); // remove only expired entries
   */
  prune() {
    const now = Date.now();
    for (const [key, entry] of this._store) {
      if (now > entry.expiresAt) this._store.delete(key);
    }
  }

  /**
   * Current number of stored entries (including potentially expired ones).
   * Use `prune()` first for an accurate count of valid entries.
   *
   * @type {number}
   * @example
   * const count = cache.size; // e.g. 42
   */
  get size() {
    return this._store.size;
  }

  /**
   * Maximum cache size. 0 means unlimited.
   *
   * @type {number}
   */
  get maxSize() {
    return this._maxSize;
  }
}

/**
 * Shared default cache instance with 30-second TTL.
 * Use this for common caching needs across the plugin.
 *
 * @type {Cache}
 * @example
 * import { defaultCache } from './cache.js';
 * defaultCache.set('config', parsedConfig);
 * const cached = defaultCache.get('config');
 */
export const defaultCache = new Cache();
