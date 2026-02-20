/**
 * TTL-based in-memory cache.
 * @module lib/core/cache
 */

/**
 * TTL-based in-memory cache for storing temporary values with automatic expiration.
 *
 * @example
 * const cache = new Cache(60000); // 60s TTL
 * cache.set('key', { data: 'value' });
 * const val = cache.get('key'); // { data: 'value' }
 * // After 60 seconds, cache.get('key') returns undefined
 */
export class Cache {
  /**
   * Create a new Cache instance.
   *
   * @param {number} [defaultTTL=30000] - Default time-to-live in milliseconds for cached entries.
   */
  constructor(defaultTTL = 30000) {
    this._store = new Map();
    this._defaultTTL = defaultTTL;
  }

  /**
   * Set a value in the cache with an optional TTL override.
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
    const expiresAt = Date.now() + (ttl ?? this._defaultTTL);
    this._store.set(key, { value, expiresAt });
    return this;
  }

  /**
   * Get a cached value by key. Returns `undefined` if the key is missing or expired.
   * Expired entries are automatically removed on access.
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
   * console.log(`Cache has ${cache.size} entries`);
   */
  get size() {
    return this._store.size;
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
