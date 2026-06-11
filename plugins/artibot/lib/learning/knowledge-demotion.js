/**
 * System 1 -> System 2 Knowledge Demotion Module.
 * Handles demotion of failing patterns back to deliberate reasoning,
 * usage recording with auto-demotion, and hot-swap orchestration.
 *
 * Demotion criteria: 2 consecutive failures OR error rate > 20%
 * Hot-swap: atomic promote/demote cycle with file-level locking.
 *
 * @module lib/learning/knowledge-demotion
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { ensureDir } from '../core/file.js';
import { ARTIBOT_DIR, round } from '../core/index.js';
import {
  appendTransferLog,
  CONFIDENCE_THRESHOLD,
  DEMOTION_ERROR_RATE_THRESHOLD,
  DEMOTION_FAILURE_THRESHOLD,
  getPromotionCandidates,
  loadSystem1Cache,
  persistSystem1Cache,
  PROMOTION_THRESHOLD,
} from './knowledge-transfer.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
          // Stale lock: force release, then retry mkdir on next iteration
          await releaseLock();
          continue;
        }
      } catch (readErr) {
        // Lock dir exists but no ts file or unreadable: treat as stale
        if (readErr.code === 'ENOENT' || readErr.code === 'EACCES' || readErr.code === 'EISDIR') {
          await releaseLock().catch(() => {});
        }
        // For unexpected errors, still continue to retry
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
// Hot Swap Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the error rate for a pattern.
 * @param {object} pattern - System 1 pattern
 * @returns {number}
 */
function _computePatternErrorRate(pattern) {
  return pattern.usageCount > 0
    ? (pattern.failureCount ?? 0) / pattern.usageCount
    : 0;
}

/**
 * Determine whether a pattern should be demoted.
 * @param {object} pattern - System 1 pattern
 * @param {number} errorRate - Pre-computed error rate
 * @returns {boolean}
 */
function _shouldDemotePattern(pattern, errorRate) {
  return (
    (pattern.consecutiveFailures ?? 0) >= DEMOTION_FAILURE_THRESHOLD ||
    (pattern.usageCount >= 5 && errorRate > DEMOTION_ERROR_RATE_THRESHOLD)
  );
}

/**
 * Build the demotion reason string.
 * @param {object} pattern - System 1 pattern
 * @param {number} errorRate - Pre-computed error rate
 * @returns {string}
 */
function _buildDemotionReason(pattern, errorRate) {
  return (pattern.consecutiveFailures ?? 0) >= DEMOTION_FAILURE_THRESHOLD
    ? `${pattern.consecutiveFailures} consecutive failures`
    : `Error rate ${round(errorRate * 100)}% too high`;
}

/**
 * Build a System 1 pattern object from a promotion candidate.
 * @param {object} candidate - Promotion candidate
 * @param {object|undefined} existing - Existing cache entry (if any)
 * @param {number} confidence - Candidate confidence
 * @param {number} successes - Candidate consecutive successes
 * @returns {object}
 */
function _buildSystem1Pattern(candidate, existing, confidence, successes) {
  return {
    key: candidate.key,
    type: candidate.type ?? candidate.key.split('::')[0] ?? 'general',
    category: candidate.category ?? candidate.key.split('::')[1] ?? 'unknown',
    confidence,
    insight: candidate.insight ?? null,
    bestData: candidate.bestData ?? null,
    promotedAt: new Date().toISOString(),
    promotionCount: (existing?.promotionCount ?? 0) + 1,
    lastSuccessStreak: successes,
    usageCount: existing?.usageCount ?? 0,
    failureCount: existing?.failureCount ?? 0,
    consecutiveFailures: 0,
    source: 'system2',
    status: 'active',
  };
}

/**
 * Process demotion of failing patterns from the cache.
 * @param {Map<string, object>} cache - System 1 cache
 * @returns {Promise<string[]>} Demoted keys
 */
async function _processDemotions(cache) {
  const demotedKeys = [];

  for (const [key, pattern] of cache) {
    const errorRate = _computePatternErrorRate(pattern);
    if (!_shouldDemotePattern(pattern, errorRate)) continue;

    const reason = _buildDemotionReason(pattern, errorRate);
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

  return demotedKeys;
}

/**
 * Process promotion of eligible candidates into the cache.
 * @param {Map<string, object>} cache - System 1 cache
 * @returns {Promise<string[]>} Promoted keys
 */
async function _processPromotions(cache) {
  const { candidates } = await getPromotionCandidates();
  const promotedKeys = [];
  const promotionLogEntries = [];

  for (const candidate of candidates) {
    const successes = candidate.consecutiveSuccesses ?? 0;
    const confidence = candidate.confidence ?? 0;

    if (successes < PROMOTION_THRESHOLD || confidence < CONFIDENCE_THRESHOLD) continue;

    const existing = cache.get(candidate.key);
    const system1Pattern = _buildSystem1Pattern(candidate, existing, confidence, successes);

    cache.set(candidate.key, system1Pattern);
    promotedKeys.push(candidate.key);
    promotionLogEntries.push({
      action: 'promote',
      patternKey: candidate.key,
      confidence,
      consecutiveSuccesses: successes,
      timestamp: new Date().toISOString(),
    });
  }

  // Cache persistence is handled once by the caller (_hotSwapImpl) after both
  // demotion and promotion phases run, so a demote-only run is not lost. Here
  // we only emit the promotion transfer-log entries.
  if (promotedKeys.length > 0) {
    for (const logEntry of promotionLogEntries) {
      await appendTransferLog(logEntry);
    }
  }

  return promotedKeys;
}

/**
 * Internal hot-swap implementation (runs within lock).
 * @returns {Promise<object>}
 */
async function _hotSwapImpl() {
  const cache = await loadSystem1Cache();

  const demotedKeys = await _processDemotions(cache);
  const promotedKeys = await _processPromotions(cache);

  const timestamp = new Date().toISOString();

  // Persist the cache whenever anything changed — demotions OR promotions.
  // Previously only promotions triggered persistence, so a demote-only run
  // mutated the in-memory cache but never reached disk (data loss). Flushing
  // once here, after both phases, keeps the on-disk snapshot consistent.
  if (promotedKeys.length > 0 || demotedKeys.length > 0) {
    await persistSystem1Cache();
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
// Hot Swap (Public API)
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
