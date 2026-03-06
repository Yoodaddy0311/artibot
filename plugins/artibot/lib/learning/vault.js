/**
 * Self-Knowledge Vault (Phase 1).
 * Stores categorized self-knowledge entries with file-based persistence
 * and time-decay for stale entries.
 *
 * Categories:
 *   - identity: who the agent is, its role, personality traits
 *   - domain: domain expertise, technical knowledge areas
 *   - methodology: preferred approaches, workflows, patterns
 *   - preference: user/agent preferences, style choices
 *   - constraint: rules, limitations, things to avoid
 *
 * Zero dependencies beyond node built-ins. ESM only.
 * @module lib/learning/vault
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { ARTIBOT_DIR, round } from '../core/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Valid knowledge categories */
export const CATEGORIES = Object.freeze([
  'identity',
  'domain',
  'methodology',
  'preference',
  'constraint',
]);

/** Decay threshold in milliseconds (90 days) */
const DECAY_MS = 90 * 24 * 60 * 60 * 1000;

/** Maximum entries per category before oldest are pruned */
const MAX_ENTRIES_PER_CATEGORY = 200;

/** Vault storage file path */
const VAULT_PATH = path.join(ARTIBOT_DIR, 'vault.json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} VaultEntry
 * @property {string} id - Unique entry identifier
 * @property {string} category - One of CATEGORIES
 * @property {string} content - Knowledge content text
 * @property {string} source - Where this knowledge came from
 * @property {number} createdAt - Unix timestamp
 * @property {number} lastAccessed - Unix timestamp of last access
 * @property {string[]} [tags] - Optional searchable tags
 */

/**
 * @typedef {Object} VaultData
 * @property {number} version - Schema version
 * @property {Record<string, VaultEntry[]>} categories - Entries by category
 * @property {number} lastUpdated - Unix timestamp
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {VaultData|null} */
let _vault = null;

/** Whether in-memory vault has unsaved changes */
let _dirty = false;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Load vault from disk. Creates empty vault if file doesn't exist.
 * @returns {Promise<VaultData>}
 */
export async function loadVault() {
  if (_vault) return _vault;

  try {
    const raw = await fs.readFile(VAULT_PATH, 'utf-8');
    _vault = JSON.parse(raw);
    if (!_vault.version || _vault.version < 1) {
      _vault = createEmptyVault();
    }
  } catch {
    _vault = createEmptyVault();
  }

  return _vault;
}

/**
 * Persist vault to disk.
 * @returns {Promise<void>}
 */
export async function saveVault() {
  if (!_vault) return;

  _vault.lastUpdated = Date.now();
  await fs.mkdir(path.dirname(VAULT_PATH), { recursive: true });
  const content = JSON.stringify(_vault, null, 2) + '\n';
  await fs.writeFile(VAULT_PATH, content, 'utf-8');
  _dirty = false;
}

/**
 * Create an empty vault structure.
 * @returns {VaultData}
 */
export function createEmptyVault() {
  /** @type {Record<string, VaultEntry[]>} */
  const categories = {};
  for (const cat of CATEGORIES) {
    categories[cat] = [];
  }
  return { version: 1, categories, lastUpdated: Date.now() };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Add an entry to the vault under a specific category.
 *
 * @param {string} category - One of CATEGORIES
 * @param {string} content - Knowledge content text
 * @param {string} [source='unknown'] - Where this knowledge came from
 * @param {object} [options]
 * @param {string[]} [options.tags] - Optional searchable tags
 * @returns {Promise<{ added: boolean, id: string, category: string }>}
 * @throws {Error} If category is invalid
 */
export async function addEntry(category, content, source = 'unknown', options = {}) {
  if (!CATEGORIES.includes(category)) {
    throw new Error(`Invalid category: ${category}. Must be one of: ${CATEGORIES.join(', ')}`);
  }

  const vault = await loadVault();
  const now = Date.now();

  const entry = {
    id: `v-${now}-${Math.random().toString(36).slice(2, 8)}`,
    category,
    content: String(content),
    source: String(source),
    createdAt: now,
    lastAccessed: now,
    ...(options.tags ? { tags: options.tags } : {}),
  };

  // Immutable append
  vault.categories[category] = [...vault.categories[category], entry];

  // Prune if over limit (keep newest)
  if (vault.categories[category].length > MAX_ENTRIES_PER_CATEGORY) {
    vault.categories[category] = vault.categories[category].slice(-MAX_ENTRIES_PER_CATEGORY);
  }

  _dirty = true;
  await saveVault();

  return { added: true, id: entry.id, category };
}

/**
 * Get entries from a specific category.
 *
 * @param {string} category - One of CATEGORIES
 * @param {number} [limit] - Max entries to return (default: all)
 * @returns {Promise<VaultEntry[]>}
 * @throws {Error} If category is invalid
 */
export async function getEntries(category, limit) {
  if (!CATEGORIES.includes(category)) {
    throw new Error(`Invalid category: ${category}. Must be one of: ${CATEGORIES.join(', ')}`);
  }

  const vault = await loadVault();
  const entries = vault.categories[category] || [];

  // Update lastAccessed on returned entries
  const now = Date.now();
  vault.categories[category] = entries.map((e) => ({ ...e, lastAccessed: now }));
  _dirty = true;

  if (limit && limit > 0) {
    return entries.slice(-limit);
  }
  return [...entries];
}

/**
 * Search all categories for entries matching a keyword query.
 *
 * @param {string} query - Search query (case-insensitive keyword matching)
 * @returns {Promise<VaultEntry[]>}
 */
export async function search(query) {
  if (!query || typeof query !== 'string') return [];

  const vault = await loadVault();
  const lower = query.toLowerCase();
  const keywords = lower.split(/\s+/).filter((k) => k.length > 0);

  if (keywords.length === 0) return [];

  const results = [];
  const now = Date.now();

  for (const cat of CATEGORIES) {
    const entries = vault.categories[cat] || [];
    for (const entry of entries) {
      const text = (entry.content + ' ' + entry.source + ' ' + (entry.tags || []).join(' ')).toLowerCase();
      const matches = keywords.filter((kw) => text.includes(kw));
      if (matches.length > 0) {
        results.push({ ...entry, _matchCount: matches.length });
      }
    }
  }

  // Sort by match count (descending), then by recency
  results.sort((a, b) => {
    if (b._matchCount !== a._matchCount) return b._matchCount - a._matchCount;
    return b.createdAt - a.createdAt;
  });

  // Update lastAccessed on matched entries
  for (const r of results) {
    updateLastAccessed(vault, r.id, now);
  }
  _dirty = true;

  // Remove internal _matchCount before returning
  return results.map(({ _matchCount, ...entry }) => entry);
}

/**
 * Remove entries that haven't been accessed in 90 days.
 *
 * @returns {Promise<{ removed: number, remaining: number }>}
 */
export async function decay() {
  const vault = await loadVault();
  const cutoff = Date.now() - DECAY_MS;
  let removed = 0;
  let remaining = 0;

  for (const cat of CATEGORIES) {
    const before = vault.categories[cat].length;
    vault.categories[cat] = vault.categories[cat].filter((e) => e.lastAccessed >= cutoff);
    const after = vault.categories[cat].length;
    removed += before - after;
    remaining += after;
  }

  if (removed > 0) {
    _dirty = true;
    await saveVault();
  }

  return { removed, remaining };
}

/**
 * Get vault statistics.
 *
 * @returns {Promise<{
 *   totalEntries: number,
 *   byCategory: Record<string, number>,
 *   oldestEntry: number|null,
 *   newestEntry: number|null,
 *   isDirty: boolean,
 * }>}
 */
export async function getVaultStats() {
  const vault = await loadVault();
  const byCategory = {};
  let total = 0;
  let oldest = null;
  let newest = null;

  for (const cat of CATEGORIES) {
    const entries = vault.categories[cat] || [];
    byCategory[cat] = entries.length;
    total += entries.length;
    for (const e of entries) {
      if (oldest === null || e.createdAt < oldest) oldest = e.createdAt;
      if (newest === null || e.createdAt > newest) newest = e.createdAt;
    }
  }

  return { totalEntries: total, byCategory, oldestEntry: oldest, newestEntry: newest, isDirty: _dirty };
}

/**
 * Reset vault state. For testing or session teardown.
 * @returns {void}
 */
export function resetVault() {
  _vault = null;
  _dirty = false;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Update lastAccessed for an entry by id across all categories.
 * @param {VaultData} vault
 * @param {string} id
 * @param {number} timestamp
 */
function updateLastAccessed(vault, id, timestamp) {
  for (const cat of CATEGORIES) {
    vault.categories[cat] = vault.categories[cat].map((e) =>
      e.id === id ? { ...e, lastAccessed: timestamp } : e
    );
  }
}

// ---------------------------------------------------------------------------
// Exported constants (for testing)
// ---------------------------------------------------------------------------

export { DECAY_MS, MAX_ENTRIES_PER_CATEGORY, VAULT_PATH };
