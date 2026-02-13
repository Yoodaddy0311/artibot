/**
 * TTL-based in-memory cache.
 * @module lib/core/cache
 */

export class Cache {
  /** @param {number} defaultTTL - Default TTL in milliseconds */
  constructor(defaultTTL = 30000) {
    this._store = new Map();
    this._defaultTTL = defaultTTL;
  }

  /**
   * Set a value with optional TTL override.
   * @param {string} key
   * @param {*} value
   * @param {number} [ttl] - TTL in ms, defaults to constructor value
   */
  set(key, value, ttl) {
    const expiresAt = Date.now() + (ttl ?? this._defaultTTL);
    this._store.set(key, { value, expiresAt });
    return this;
  }

  /**
   * Get a value. Returns undefined if missing or expired.
   * @param {string} key
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
   * Check if key exists and is not expired.
   * @param {string} key
   */
  has(key) {
    return this.get(key) !== undefined;
  }

  /**
   * Delete a specific key.
   * @param {string} key
   */
  delete(key) {
    return this._store.delete(key);
  }

  /** Clear all entries. */
  clear() {
    this._store.clear();
  }

  /** Remove all expired entries. */
  prune() {
    const now = Date.now();
    for (const [key, entry] of this._store) {
      if (now > entry.expiresAt) this._store.delete(key);
    }
  }

  /** Current number of stored entries (including expired). */
  get size() {
    return this._store.size;
  }
}

/** Shared default cache instance */
export const defaultCache = new Cache();
