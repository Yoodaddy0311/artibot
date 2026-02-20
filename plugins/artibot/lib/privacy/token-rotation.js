/**
 * Token Rotation Mechanism.
 * Generates scoped, cryptographically random tokens with configurable
 * rotation periods and in-memory storage with optional persistence.
 *
 * Zero runtime dependencies. ESM only.
 * @module lib/privacy/token-rotation
 */

import { randomBytes, randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default rotation period in milliseconds (24 hours) */
const DEFAULT_ROTATION_MS = 24 * 60 * 60 * 1000;

/** Minimum rotation period (1 minute) */
const MIN_ROTATION_MS = 60 * 1000;

/** Maximum tokens stored to prevent memory leaks */
const MAX_TOKENS = 10_000;

/** Token prefix for identification */
const TOKEN_PREFIX = 'abt_';

// ---------------------------------------------------------------------------
// Types (JSDoc only)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} TokenEntry
 * @property {string} id - Unique token identifier
 * @property {string} token - The cryptographic token value
 * @property {string} purpose - Scoped purpose of this token
 * @property {number} createdAt - Unix timestamp of creation
 * @property {number} expiresAt - Unix timestamp of expiration
 * @property {boolean} revoked - Whether the token has been manually revoked
 */

/**
 * @typedef {object} TokenStoreConfig
 * @property {number} [rotationPeriodMs=86400000] - Token rotation period in ms
 * @property {number} [maxTokens=10000] - Maximum stored tokens
 * @property {((data: object) => void)|null} [onPersist] - Optional persistence callback
 * @property {(() => object|null)|null} [onRestore] - Optional restore callback
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {Map<string, TokenEntry>} */
let tokenStore = new Map();

/** @type {number} Current rotation period */
let rotationPeriodMs = DEFAULT_ROTATION_MS;

/** @type {number} Current max tokens limit */
let maxTokens = MAX_TOKENS;

/** @type {((data: object) => void)|null} */
let persistCallback = null;

/** @type {(() => object|null)|null} */
let restoreCallback = null;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configure the token rotation system.
 *
 * @param {TokenStoreConfig} [config] - Configuration options
 * @returns {void}
 * @example
 * configure({ rotationPeriodMs: 12 * 60 * 60 * 1000 }); // 12 hours
 */
export function configure(config = {}) {
  if (typeof config.rotationPeriodMs === 'number') {
    rotationPeriodMs = Math.max(MIN_ROTATION_MS, config.rotationPeriodMs);
  }
  if (typeof config.maxTokens === 'number') {
    maxTokens = Math.max(1, config.maxTokens);
  }
  if (config.onPersist !== undefined) {
    persistCallback = typeof config.onPersist === 'function' ? config.onPersist : null;
  }
  if (config.onRestore !== undefined) {
    restoreCallback = typeof config.onRestore === 'function' ? config.onRestore : null;
  }
}

// ---------------------------------------------------------------------------
// Core Functions
// ---------------------------------------------------------------------------

/**
 * Generate a new scoped token.
 *
 * @param {string} purpose - Purpose/scope of the token (e.g. 'api-access', 'session', 'webhook')
 * @param {object} [options]
 * @param {number} [options.expiresInMs] - Custom expiration time in ms (overrides rotation period)
 * @returns {{ id: string, token: string, purpose: string, expiresAt: number }}
 * @example
 * const { id, token } = generateToken('api-access');
 * // { id: 'abt_...', token: 'abt_...', purpose: 'api-access', expiresAt: 1708086400000 }
 */
export function generateToken(purpose, options = {}) {
  if (!purpose || typeof purpose !== 'string') {
    throw new Error('Token purpose is required and must be a string');
  }

  enforceMaxTokens();

  const id = TOKEN_PREFIX + randomUUID();
  const token = TOKEN_PREFIX + randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresInMs = options.expiresInMs ?? rotationPeriodMs;
  const expiresAt = now + expiresInMs;

  const entry = {
    id,
    token,
    purpose,
    createdAt: now,
    expiresAt,
    revoked: false,
  };

  tokenStore.set(id, entry);
  triggerPersist();

  return { id, token, purpose, expiresAt };
}

/**
 * Rotate an existing token: invalidate the old one and create a new one
 * with the same purpose.
 *
 * @param {string} tokenId - The ID of the token to rotate
 * @returns {{ oldId: string, newId: string, newToken: string, purpose: string, expiresAt: number }|null}
 *   Rotation result, or null if the token ID was not found
 * @example
 * const result = rotateToken('abt_abc-123');
 * // { oldId: 'abt_abc-123', newId: 'abt_def-456', newToken: 'abt_...', purpose: 'api-access', expiresAt: ... }
 */
export function rotateToken(tokenId) {
  const existing = tokenStore.get(tokenId);
  if (!existing) return null;

  // Revoke the old token
  const updated = { ...existing, revoked: true };
  tokenStore.set(tokenId, updated);

  // Generate new token with same purpose
  const newEntry = generateToken(existing.purpose);

  triggerPersist();

  return {
    oldId: tokenId,
    newId: newEntry.id,
    newToken: newEntry.token,
    purpose: existing.purpose,
    expiresAt: newEntry.expiresAt,
  };
}

/**
 * Check whether a token is currently valid.
 * A token is valid if it exists, has not been revoked, and has not expired.
 *
 * @param {string} token - The token value to validate
 * @returns {{ valid: boolean, reason?: string }}
 * @example
 * const { valid, reason } = isTokenValid('abt_...');
 * // { valid: true } or { valid: false, reason: 'expired' }
 */
export function isTokenValid(token) {
  if (!token || typeof token !== 'string') {
    return { valid: false, reason: 'invalid_input' };
  }

  const entry = findByToken(token);

  if (!entry) {
    return { valid: false, reason: 'not_found' };
  }

  if (entry.revoked) {
    return { valid: false, reason: 'revoked' };
  }

  if (Date.now() > entry.expiresAt) {
    return { valid: false, reason: 'expired' };
  }

  return { valid: true };
}

/**
 * Revoke a token by its ID, making it immediately invalid.
 *
 * @param {string} tokenId - Token ID to revoke
 * @returns {{ revoked: boolean, id: string }}
 * @example
 * revokeToken('abt_abc-123');
 * // { revoked: true, id: 'abt_abc-123' }
 */
export function revokeToken(tokenId) {
  const entry = tokenStore.get(tokenId);
  if (!entry) {
    return { revoked: false, id: tokenId };
  }

  const updated = { ...entry, revoked: true };
  tokenStore.set(tokenId, updated);
  triggerPersist();

  return { revoked: true, id: tokenId };
}

/**
 * Get token metadata by ID (does not expose the token value).
 *
 * @param {string} tokenId - Token ID
 * @returns {{ id: string, purpose: string, createdAt: number, expiresAt: number, revoked: boolean, expired: boolean }|null}
 * @example
 * const info = getTokenInfo('abt_abc-123');
 * // { id: '...', purpose: 'api-access', createdAt: ..., expiresAt: ..., revoked: false, expired: false }
 */
export function getTokenInfo(tokenId) {
  const entry = tokenStore.get(tokenId);
  if (!entry) return null;

  return {
    id: entry.id,
    purpose: entry.purpose,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    revoked: entry.revoked,
    expired: Date.now() > entry.expiresAt,
  };
}

/**
 * List all tokens for a given purpose.
 * Returns metadata only (no token values).
 *
 * @param {string} [purpose] - Filter by purpose (optional, lists all if omitted)
 * @returns {Array<{ id: string, purpose: string, createdAt: number, expiresAt: number, revoked: boolean, expired: boolean }>}
 * @example
 * const tokens = listTokens('api-access');
 */
export function listTokens(purpose) {
  const now = Date.now();
  const results = [];

  for (const entry of tokenStore.values()) {
    if (purpose && entry.purpose !== purpose) continue;

    results.push({
      id: entry.id,
      purpose: entry.purpose,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      revoked: entry.revoked,
      expired: now > entry.expiresAt,
    });
  }

  return results;
}

/**
 * Remove expired and revoked tokens from the store.
 *
 * @returns {{ removed: number, remaining: number }}
 * @example
 * const { removed, remaining } = cleanup();
 * // { removed: 5, remaining: 12 }
 */
export function cleanup() {
  const now = Date.now();
  let removed = 0;

  for (const [id, entry] of tokenStore) {
    if (entry.revoked || now > entry.expiresAt) {
      tokenStore.delete(id);
      removed++;
    }
  }

  if (removed > 0) triggerPersist();

  return { removed, remaining: tokenStore.size };
}

/**
 * Get token store statistics.
 *
 * @returns {{ total: number, active: number, expired: number, revoked: number, byPurpose: Record<string, number> }}
 * @example
 * const stats = getTokenStats();
 * // { total: 10, active: 7, expired: 2, revoked: 1, byPurpose: { 'api-access': 5, 'session': 5 } }
 */
export function getTokenStats() {
  const now = Date.now();
  let active = 0;
  let expired = 0;
  let revoked = 0;
  const byPurpose = {};

  for (const entry of tokenStore.values()) {
    byPurpose[entry.purpose] = (byPurpose[entry.purpose] ?? 0) + 1;

    if (entry.revoked) {
      revoked++;
    } else if (now > entry.expiresAt) {
      expired++;
    } else {
      active++;
    }
  }

  return {
    total: tokenStore.size,
    active,
    expired,
    revoked,
    byPurpose,
  };
}

/**
 * Restore tokens from persistence.
 * Calls the configured onRestore callback to load tokens.
 *
 * @returns {{ restored: number }}
 * @example
 * configure({ onRestore: () => savedData });
 * const { restored } = restoreFromPersistence();
 */
export function restoreFromPersistence() {
  if (typeof restoreCallback !== 'function') {
    return { restored: 0 };
  }

  const data = restoreCallback();
  if (!data || !Array.isArray(data.tokens)) {
    return { restored: 0 };
  }

  let restored = 0;
  for (const entry of data.tokens) {
    if (entry.id && entry.token && entry.purpose) {
      tokenStore.set(entry.id, {
        id: entry.id,
        token: entry.token,
        purpose: entry.purpose,
        createdAt: entry.createdAt ?? Date.now(),
        expiresAt: entry.expiresAt ?? Date.now() + rotationPeriodMs,
        revoked: entry.revoked ?? false,
      });
      restored++;
    }
  }

  return { restored };
}

/**
 * Reset all token state to defaults.
 * Intended for testing or session teardown.
 *
 * @returns {void}
 */
export function resetTokenStore() {
  tokenStore = new Map();
  rotationPeriodMs = DEFAULT_ROTATION_MS;
  maxTokens = MAX_TOKENS;
  persistCallback = null;
  restoreCallback = null;
}

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

export {
  DEFAULT_ROTATION_MS,
  MIN_ROTATION_MS,
  MAX_TOKENS,
  TOKEN_PREFIX,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Find a token entry by its token value.
 * @param {string} token
 * @returns {TokenEntry|undefined}
 */
function findByToken(token) {
  for (const entry of tokenStore.values()) {
    if (entry.token === token) {
      return entry;
    }
  }
  return undefined;
}

/**
 * Enforce the maximum token limit by removing oldest expired/revoked tokens first.
 */
function enforceMaxTokens() {
  if (tokenStore.size < maxTokens) return;

  // First pass: remove expired and revoked
  const now = Date.now();
  for (const [id, entry] of tokenStore) {
    if (entry.revoked || now > entry.expiresAt) {
      tokenStore.delete(id);
    }
  }

  // Second pass: if still over limit, remove oldest
  if (tokenStore.size >= maxTokens) {
    const entries = [...tokenStore.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    const toRemove = entries.slice(0, entries.length - maxTokens + 1);
    for (const [id] of toRemove) {
      tokenStore.delete(id);
    }
  }
}

/**
 * Trigger the persistence callback if configured.
 */
function triggerPersist() {
  if (typeof persistCallback !== 'function') return;

  const tokens = [...tokenStore.values()].map((entry) => ({
    ...entry,
  }));

  persistCallback({ tokens, savedAt: Date.now() });
}
