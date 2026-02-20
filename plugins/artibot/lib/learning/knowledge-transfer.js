/**
 * System 2 -> System 1 Knowledge Transfer Module.
 * Promotes successful deliberate reasoning patterns (System 2) into
 * fast intuitive responses (System 1), and demotes failing patterns back.
 *
 * Promotion criteria: 3+ consecutive successes, confidence > 0.8
 * Demotion criteria: 2 consecutive failures OR error rate > 20%
 *
 * Hot-swap: new patterns are immediately reflected in memory without restart.
 *
 * @module lib/learning/knowledge-transfer
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { readJsonFile, writeJsonFile, ensureDir } from '../core/file.js';
import { ARTIBOT_DIR, round } from '../core/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PATTERNS_DIR = path.join(ARTIBOT_DIR, 'patterns');
const TRANSFER_LOG_PATH = path.join(ARTIBOT_DIR, 'transfer-log.json');
const SYSTEM1_PATH = path.join(ARTIBOT_DIR, 'system1-patterns.json');

/** Minimum consecutive successes to promote to System 1 */
const PROMOTION_THRESHOLD = 3;

/** Minimum confidence to qualify for promotion */
const CONFIDENCE_THRESHOLD = 0.8;

/** Consecutive failures to trigger demotion back to System 2 */
const DEMOTION_FAILURE_THRESHOLD = 2;

/** Error rate above which a pattern gets demoted */
const DEMOTION_ERROR_RATE_THRESHOLD = 0.2;

const MAX_TRANSFER_LOG = 200;

/** Lock file path for hot-swap concurrency control */
const LOCK_PATH = path.join(ARTIBOT_DIR, '.hotswap.lock');

/** Maximum wait time for lock acquisition in ms */
const LOCK_MAX_WAIT_MS = 5000;

/** Stale lock threshold: locks older than this are auto-released */
const LOCK_STALE_AGE_MS = 30 * 1000; // 30 seconds

// ---------------------------------------------------------------------------
// File-Level Lock (for hotSwap concurrency)
// ---------------------------------------------------------------------------

/**
 * Acquire a file-level lock using atomic mkdir.
 * Waits up to maxWait ms for the lock to become available.
 * Auto-releases stale locks older than LOCK_STALE_AGE_MS.
 * @param {number} [maxWait=5000] - Max wait in ms
 * @returns {Promise<void>}
 */
async function acquireLock(maxWait = LOCK_MAX_WAIT_MS) {
  await ensureDir(ARTIBOT_DIR);
  const deadline = Date.now() + maxWait;
  const retryIntervalMs = 50;

  while (Date.now() < deadline) {
    try {
      // atomic mkdir: only one process can succeed at a time
      await fs.mkdir(LOCK_PATH, { recursive: false });
      // Write lock metadata (timestamp) for stale detection
      await fs.writeFile(path.join(LOCK_PATH, 'ts'), String(Date.now()), 'utf-8');
      return; // acquired
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      // Check for stale lock
      try {
        const tsFile = path.join(LOCK_PATH, 'ts');
        const tsRaw = await fs.readFile(tsFile, 'utf-8');
        const lockAge = Date.now() - Number(tsRaw);
        if (lockAge > LOCK_STALE_AGE_MS) {
          // Stale lock: force release
          await releaseLock();
          continue;
        }
      } catch {
        // Lock dir exists but no ts file or unreadable: treat as stale
        await releaseLock().catch(() => {});
        continue;
      }

      // Lock is held by another operation, wait
      await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
    }
  }

  throw new Error(`Failed to acquire hotSwap lock within ${maxWait}ms`);
}

/**
 * Release the file-level lock.
 * @returns {Promise<void>}
 */
async function releaseLock() {
  try {
    await fs.rm(LOCK_PATH, { recursive: true, force: true });
  } catch {
    // Ignore errors during release
  }
}

// ---------------------------------------------------------------------------
// In-Memory Cache (for hot-swap)
// ---------------------------------------------------------------------------

/** @type {Map<string, object> | null} */
let _system1Cache = null;

/**
 * Load System 1 patterns into memory cache.
 * @returns {Promise<Map<string, object>>}
 */
async function loadSystem1Cache() {
  if (_system1Cache) return _system1Cache;

  const data = await readJsonFile(SYSTEM1_PATH);
  const patterns = data?.patterns ?? [];
  _system1Cache = new Map(patterns.map((p) => [p.key, p]));
  return _system1Cache;
}

/**
 * Persist the in-memory System 1 cache to disk.
 * @returns {Promise<void>}
 */
async function persistSystem1Cache() {
  if (!_system1Cache) return;

  await ensureDir(ARTIBOT_DIR);
  await writeJsonFile(SYSTEM1_PATH, {
    patterns: [..._system1Cache.values()],
    updatedAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Promotion: System 2 -> System 1
// ---------------------------------------------------------------------------

/**
 * Promote a pattern from System 2 (deliberate reasoning) to System 1 (fast intuition).
 * A pattern qualifies when it has 3+ consecutive successes and confidence > 0.8.
 *
 * @param {object} pattern - Pattern to promote
 * @param {string} pattern.key - Unique pattern key (e.g. "tool::Read")
 * @param {number} pattern.confidence - Pattern confidence score
 * @param {number} [pattern.consecutiveSuccesses] - Number of consecutive successes
 * @param {string} [pattern.insight] - Human-readable insight
 * @param {object} [pattern.bestData] - Best-performing data snapshot
 * @returns {Promise<{
 *   promoted: boolean,
 *   reason: string,
 *   pattern: object | null
 * }>}
 */
export async function promoteToSystem1(pattern) {
  if (!pattern?.key) {
    return { promoted: false, reason: 'Pattern missing key', pattern: null };
  }

  const successes = pattern.consecutiveSuccesses ?? 0;
  const confidence = pattern.confidence ?? 0;

  // Check promotion criteria
  if (successes < PROMOTION_THRESHOLD) {
    return {
      promoted: false,
      reason: `Insufficient successes: ${successes}/${PROMOTION_THRESHOLD}`,
      pattern: null,
    };
  }

  if (confidence < CONFIDENCE_THRESHOLD) {
    return {
      promoted: false,
      reason: `Confidence too low: ${round(confidence)}/${CONFIDENCE_THRESHOLD}`,
      pattern: null,
    };
  }

  const cache = await loadSystem1Cache();
  const existing = cache.get(pattern.key);

  const system1Pattern = {
    key: pattern.key,
    type: pattern.type ?? pattern.key.split('::')[0] ?? 'general',
    category: pattern.category ?? pattern.key.split('::')[1] ?? 'unknown',
    confidence,
    insight: pattern.insight ?? null,
    bestData: pattern.bestData ?? null,
    promotedAt: new Date().toISOString(),
    promotionCount: (existing?.promotionCount ?? 0) + 1,
    lastSuccessStreak: successes,
    usageCount: existing?.usageCount ?? 0,
    failureCount: existing?.failureCount ?? 0,
    consecutiveFailures: 0,
    source: 'system2',
    status: 'active',
  };

  // Hot-swap: update in-memory cache immediately
  cache.set(pattern.key, system1Pattern);
  await persistSystem1Cache();

  // Log the transfer
  await appendTransferLog({
    action: 'promote',
    patternKey: pattern.key,
    confidence,
    consecutiveSuccesses: successes,
    timestamp: new Date().toISOString(),
  });

  return { promoted: true, reason: 'Meets all promotion criteria', pattern: system1Pattern };
}

// ---------------------------------------------------------------------------
// Demotion: System 1 -> System 2
// ---------------------------------------------------------------------------

/**
 * Demote a pattern from System 1 back to System 2.
 * Triggers when a pattern has 2 consecutive failures or error rate > 20%.
 *
 * @param {object} pattern - Pattern to demote
 * @param {string} pattern.key - Unique pattern key
 * @param {string} [pattern.reason] - Reason for demotion
 * @returns {Promise<{
 *   demoted: boolean,
 *   reason: string,
 *   pattern: object | null
 * }>}
 */
export async function demoteFromSystem1(pattern) {
  if (!pattern?.key) {
    return { demoted: false, reason: 'Pattern missing key', pattern: null };
  }

  const cache = await loadSystem1Cache();
  const existing = cache.get(pattern.key);

  if (!existing) {
    return { demoted: false, reason: 'Pattern not found in System 1', pattern: null };
  }

  // Remove from System 1 cache (hot-swap)
  cache.delete(pattern.key);
  await persistSystem1Cache();

  // Log the transfer
  await appendTransferLog({
    action: 'demote',
    patternKey: pattern.key,
    reason: pattern.reason ?? 'Manual demotion',
    previousConfidence: existing.confidence,
    failureCount: existing.failureCount,
    timestamp: new Date().toISOString(),
  });

  return {
    demoted: true,
    reason: pattern.reason ?? 'Demoted from System 1',
    pattern: { ...existing, status: 'demoted', demotedAt: new Date().toISOString() },
  };
}

/**
 * Record a usage result for a System 1 pattern and auto-demote if needed.
 * Call this after every time a System 1 pattern is used.
 *
 * @param {string} patternKey - Pattern key
 * @param {boolean} success - Whether the usage was successful
 * @returns {Promise<{
 *   updated: boolean,
 *   autoDemoted: boolean,
 *   reason: string | null
 * }>}
 */
export async function recordSystem1Usage(patternKey, success) {
  const cache = await loadSystem1Cache();
  const pattern = cache.get(patternKey);

  if (!pattern) {
    return { updated: false, autoDemoted: false, reason: 'Pattern not in System 1' };
  }

  const updated = {
    ...pattern,
    usageCount: (pattern.usageCount ?? 0) + 1,
  };

  if (success) {
    updated.consecutiveFailures = 0;
    updated.lastSuccessAt = new Date().toISOString();
  } else {
    updated.failureCount = (pattern.failureCount ?? 0) + 1;
    updated.consecutiveFailures = (pattern.consecutiveFailures ?? 0) + 1;
  }

  // Check auto-demotion criteria
  const errorRate = updated.usageCount > 0
    ? updated.failureCount / updated.usageCount
    : 0;

  const shouldDemote =
    updated.consecutiveFailures >= DEMOTION_FAILURE_THRESHOLD ||
    (updated.usageCount >= 5 && errorRate > DEMOTION_ERROR_RATE_THRESHOLD);

  if (shouldDemote) {
    const reason = updated.consecutiveFailures >= DEMOTION_FAILURE_THRESHOLD
      ? `${updated.consecutiveFailures} consecutive failures`
      : `Error rate ${round(errorRate * 100)}% exceeds ${DEMOTION_ERROR_RATE_THRESHOLD * 100}% threshold`;

    await demoteFromSystem1({ key: patternKey, reason });
    return { updated: true, autoDemoted: true, reason };
  }

  // Update in cache (hot-swap)
  cache.set(patternKey, updated);
  await persistSystem1Cache();

  return { updated: true, autoDemoted: false, reason: null };
}

// ---------------------------------------------------------------------------
// Promotion Candidates
// ---------------------------------------------------------------------------

/**
 * Scan all learned patterns and return those eligible for System 1 promotion.
 * Checks consecutiveSuccesses >= 3 and confidence > 0.8.
 *
 * @returns {Promise<{
 *   candidates: object[],
 *   alreadyPromoted: string[],
 *   belowThreshold: object[]
 * }>}
 */
export async function getPromotionCandidates() {
  const patternTypes = ['tool', 'error', 'success', 'team', 'general'];
  const candidates = [];
  const belowThreshold = [];
  const cache = await loadSystem1Cache();
  const alreadyPromoted = [...cache.keys()];

  for (const type of patternTypes) {
    const filePath = path.join(PATTERNS_DIR, `${type}-patterns.json`);
    const data = await readJsonFile(filePath);
    const patterns = data?.patterns ?? [];

    for (const pattern of patterns) {
      // Skip already promoted
      if (cache.has(pattern.key)) continue;

      const successes = pattern.consecutiveSuccesses ?? 0;
      const confidence = pattern.confidence ?? 0;

      if (successes >= PROMOTION_THRESHOLD && confidence >= CONFIDENCE_THRESHOLD) {
        candidates.push({
          key: pattern.key,
          type: pattern.type,
          category: pattern.category,
          confidence,
          consecutiveSuccesses: successes,
          insight: pattern.insight,
          bestData: pattern.bestData,
          sampleSize: pattern.sampleSize ?? 0,
        });
      } else {
        belowThreshold.push({
          key: pattern.key,
          confidence,
          consecutiveSuccesses: successes,
          needsSuccesses: Math.max(0, PROMOTION_THRESHOLD - successes),
          needsConfidence: Math.max(0, round(CONFIDENCE_THRESHOLD - confidence)),
        });
      }
    }
  }

  // Sort candidates by confidence descending
  candidates.sort((a, b) => b.confidence - a.confidence);

  return { candidates, alreadyPromoted, belowThreshold };
}

// ---------------------------------------------------------------------------
// Hot Swap
// ---------------------------------------------------------------------------

/**
 * Hot-swap: immediately reflect new or updated patterns in memory.
 * Promotes all eligible candidates and demotes all failing patterns
 * in a single atomic operation without requiring restart.
 * Uses file-level locking to prevent concurrent execution.
 *
 * @returns {Promise<{
 *   promoted: string[],
 *   demoted: string[],
 *   unchanged: number,
 *   timestamp: string
 * }>}
 */
export async function hotSwap() {
  await acquireLock();

  try {
    return await _hotSwapImpl();
  } finally {
    await releaseLock();
  }
}

/**
 * Internal hot-swap implementation (runs within lock).
 * @returns {Promise<object>}
 */
async function _hotSwapImpl() {
  const cache = await loadSystem1Cache();
  const promotedKeys = [];
  const demotedKeys = [];

  // 1. Auto-demote failing patterns
  for (const [key, pattern] of cache) {
    const errorRate = pattern.usageCount > 0
      ? (pattern.failureCount ?? 0) / pattern.usageCount
      : 0;

    const shouldDemote =
      (pattern.consecutiveFailures ?? 0) >= DEMOTION_FAILURE_THRESHOLD ||
      (pattern.usageCount >= 5 && errorRate > DEMOTION_ERROR_RATE_THRESHOLD);

    if (shouldDemote) {
      const reason = (pattern.consecutiveFailures ?? 0) >= DEMOTION_FAILURE_THRESHOLD
        ? `${pattern.consecutiveFailures} consecutive failures`
        : `Error rate ${round(errorRate * 100)}% too high`;

      cache.delete(key);
      demotedKeys.push(key);

      await appendTransferLog({
        action: 'demote',
        patternKey: key,
        reason,
        source: 'hot-swap',
        timestamp: new Date().toISOString(),
      });
    }
  }

  // 2. Auto-promote eligible patterns
  const { candidates } = await getPromotionCandidates();
  for (const candidate of candidates) {
    const result = await promoteToSystem1(candidate);
    if (result.promoted) {
      promotedKeys.push(candidate.key);
    }
  }

  const timestamp = new Date().toISOString();

  // Log the hot-swap event
  if (promotedKeys.length > 0 || demotedKeys.length > 0) {
    await appendTransferLog({
      action: 'hot-swap',
      promoted: promotedKeys,
      demoted: demotedKeys,
      timestamp,
    });
  }

  return {
    promoted: promotedKeys,
    demoted: demotedKeys,
    unchanged: cache.size,
    timestamp,
  };
}

// ---------------------------------------------------------------------------
// Query API
// ---------------------------------------------------------------------------

/**
 * Get all active System 1 patterns.
 * @returns {Promise<object[]>}
 */
export async function getSystem1Patterns() {
  const cache = await loadSystem1Cache();
  return [...cache.values()].filter((p) => p.status === 'active');
}

/**
 * Check if a specific pattern is in System 1.
 * @param {string} patternKey
 * @returns {Promise<object | null>}
 */
export async function getSystem1Pattern(patternKey) {
  const cache = await loadSystem1Cache();
  return cache.get(patternKey) ?? null;
}

/**
 * Get transfer history (promotions and demotions).
 * @param {object} [options]
 * @param {number} [options.limit=50] - Max entries to return
 * @param {string} [options.action] - Filter by action type ('promote' | 'demote' | 'hot-swap')
 * @returns {Promise<object[]>}
 */
export async function getTransferHistory(options = {}) {
  const { limit = 50, action } = options;
  const log = await loadTransferLog();
  const filtered = action ? log.filter((e) => e.action === action) : log;
  return filtered.slice(-limit);
}

/**
 * Get knowledge transfer statistics.
 * @returns {Promise<{
 *   system1Count: number,
 *   totalPromotions: number,
 *   totalDemotions: number,
 *   avgConfidence: number,
 *   avgUsageCount: number,
 *   hotSwapCount: number
 * }>}
 */
export async function getTransferStats() {
  const cache = await loadSystem1Cache();
  const log = await loadTransferLog();

  const patterns = [...cache.values()];
  const promotions = log.filter((e) => e.action === 'promote').length;
  const demotions = log.filter((e) => e.action === 'demote').length;
  const hotSwaps = log.filter((e) => e.action === 'hot-swap').length;

  const avgConfidence = patterns.length > 0
    ? round(patterns.reduce((s, p) => s + (p.confidence ?? 0), 0) / patterns.length)
    : 0;

  const avgUsageCount = patterns.length > 0
    ? round(patterns.reduce((s, p) => s + (p.usageCount ?? 0), 0) / patterns.length)
    : 0;

  return {
    system1Count: patterns.length,
    totalPromotions: promotions,
    totalDemotions: demotions,
    avgConfidence,
    avgUsageCount,
    hotSwapCount: hotSwaps,
  };
}

// ---------------------------------------------------------------------------
// Persistence Helpers
// ---------------------------------------------------------------------------

/**
 * Load transfer log from disk.
 * @returns {Promise<object[]>}
 */
async function loadTransferLog() {
  const data = await readJsonFile(TRANSFER_LOG_PATH);
  return Array.isArray(data) ? data : [];
}

/**
 * Append an entry to the transfer log.
 * @param {object} entry
 * @returns {Promise<void>}
 */
async function appendTransferLog(entry) {
  const log = await loadTransferLog();
  const updated = [...log, entry];
  const pruned = updated.length > MAX_TRANSFER_LOG
    ? updated.slice(updated.length - MAX_TRANSFER_LOG)
    : updated;
  await writeJsonFile(TRANSFER_LOG_PATH, pruned);
}

// ---------------------------------------------------------------------------
// Cache Management
// ---------------------------------------------------------------------------

/**
 * Clear the in-memory System 1 cache.
 * Forces a reload from disk on next access.
 * @returns {void}
 */
export function clearCache() {
  _system1Cache = null;
}

