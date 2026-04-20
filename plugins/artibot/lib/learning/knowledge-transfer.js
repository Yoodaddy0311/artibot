/**
 * System 2 -> System 1 Knowledge Transfer Module.
 * Promotes successful deliberate reasoning patterns (System 2) into
 * fast intuitive responses (System 1).
 *
 * Promotion criteria: 3+ consecutive successes, confidence > 0.8
 *
 * Demotion and hot-swap logic is in knowledge-demotion.js.
 *
 * @module lib/learning/knowledge-transfer
 */

import path from 'node:path';
import { ensureDir, readJsonFile, writeJsonFile } from '../core/file.js';
import { ARTIBOT_DIR, round } from '../core/index.js';

// ---------------------------------------------------------------------------
// Constants (shared with knowledge-demotion.js)
// ---------------------------------------------------------------------------

const PATTERNS_DIR = path.join(ARTIBOT_DIR, 'patterns');
const TRANSFER_LOG_PATH = path.join(ARTIBOT_DIR, 'transfer-log.json');
const SYSTEM1_PATH = path.join(ARTIBOT_DIR, 'system1-patterns.json');

/** Minimum consecutive successes to promote to System 1 */
export const PROMOTION_THRESHOLD = 3;

/** Minimum confidence to qualify for promotion */
export const CONFIDENCE_THRESHOLD = 0.8;

/** Consecutive failures to trigger demotion back to System 2 */
export const DEMOTION_FAILURE_THRESHOLD = 2;

/** Error rate above which a pattern gets demoted */
export const DEMOTION_ERROR_RATE_THRESHOLD = 0.2;

const MAX_TRANSFER_LOG = 200;

// ---------------------------------------------------------------------------
// In-Memory Cache (shared with knowledge-demotion.js)
// ---------------------------------------------------------------------------

/** @type {Map<string, object> | null} */
let _system1Cache = null;

/**
 * Load System 1 patterns into memory cache.
 * @returns {Promise<Map<string, object>>}
 */
export async function loadSystem1Cache() {
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
export async function persistSystem1Cache() {
  if (!_system1Cache) return;

  await ensureDir(ARTIBOT_DIR);
  await writeJsonFile(SYSTEM1_PATH, {
    patterns: [..._system1Cache.values()],
    updatedAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Persistence Helpers (shared with knowledge-demotion.js)
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
export async function appendTransferLog(entry) {
  const log = await loadTransferLog();
  const updated = [...log, entry];
  const pruned = updated.length > MAX_TRANSFER_LOG
    ? updated.slice(updated.length - MAX_TRANSFER_LOG)
    : updated;
  await writeJsonFile(TRANSFER_LOG_PATH, pruned);
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
 * @param {object} [options] - Optional config overrides
 * @param {number} [options.promotionThreshold] - Override PROMOTION_THRESHOLD
 * @param {number} [options.confidenceThreshold] - Override CONFIDENCE_THRESHOLD
 * @returns {Promise<{
 *   promoted: boolean,
 *   reason: string,
 *   pattern: object | null
 * }>}
 */
// eslint-disable-next-line complexity
export async function promoteToSystem1(pattern, options = {}) {
  if (!pattern?.key) {
    return { promoted: false, reason: 'Pattern missing key', pattern: null };
  }

  const successes = pattern.consecutiveSuccesses ?? 0;
  const confidence = pattern.confidence ?? 0;
  const promoThresh = options.promotionThreshold ?? PROMOTION_THRESHOLD;
  const confThresh = options.confidenceThreshold ?? CONFIDENCE_THRESHOLD;

  // Check promotion criteria
  if (successes < promoThresh) {
    return {
      promoted: false,
      reason: `Insufficient successes: ${successes}/${promoThresh}`,
      pattern: null,
    };
  }

  if (confidence < confThresh) {
    return {
      promoted: false,
      reason: `Confidence too low: ${round(confidence)}/${confThresh}`,
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

/**
 * Bootstrap promotion with relaxed criteria for initial pattern seeding.
 * Uses lower thresholds (confidence >= 0.3, no consecutive success requirement)
 * to ensure newly extracted patterns from historical data get promoted
 * to System 1 and can start accumulating real usage feedback.
 *
 * @param {object} pattern - Pattern to promote
 * @param {string} pattern.key - Unique pattern key
 * @param {number} pattern.confidence - Pattern confidence score
 * @param {string} [pattern.insight] - Human-readable insight
 * @param {object} [pattern.bestData] - Best-performing data snapshot
 * @returns {Promise<{ promoted: boolean, reason: string, pattern: object | null }>}
 */
export async function bootstrapPromote(pattern) {
  if (!pattern?.key) {
    return { promoted: false, reason: 'Pattern missing key', pattern: null };
  }

  const confidence = pattern.confidence ?? 0;

  // Relaxed criteria for bootstrap: confidence >= 0.3, no success streak required
  if (confidence < 0.3) {
    return {
      promoted: false,
      reason: `Bootstrap confidence too low: ${round(confidence)}/0.3`,
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
    lastSuccessStreak: pattern.consecutiveSuccesses ?? 0,
    usageCount: existing?.usageCount ?? 0,
    failureCount: existing?.failureCount ?? 0,
    consecutiveFailures: 0,
    source: 'bootstrap',
    status: 'active',
  };

  cache.set(pattern.key, system1Pattern);
  await persistSystem1Cache();

  await appendTransferLog({
    action: 'promote',
    patternKey: pattern.key,
    confidence,
    source: 'bootstrap',
    timestamp: new Date().toISOString(),
  });

  return { promoted: true, reason: 'Bootstrap promotion (relaxed criteria)', pattern: system1Pattern };
}

// ---------------------------------------------------------------------------
// Promotion Candidates
// ---------------------------------------------------------------------------

/**
 * Scan all learned patterns and return those eligible for System 1 promotion.
 * Checks consecutiveSuccesses >= 3 and confidence > 0.8.
 *
 * @param {object} [options] - Optional config overrides
 * @param {number} [options.promotionThreshold] - Override PROMOTION_THRESHOLD
 * @param {number} [options.confidenceThreshold] - Override CONFIDENCE_THRESHOLD
 * @returns {Promise<{
 *   candidates: object[],
 *   alreadyPromoted: string[],
 *   belowThreshold: object[]
 * }>}
 */
export async function getPromotionCandidates(options = {}) {
  const patternTypes = ['tool', 'error', 'success', 'team', 'general'];
  const candidates = [];
  const belowThreshold = [];
  const cache = await loadSystem1Cache();
  const alreadyPromoted = [...cache.keys()];

  const promoThresh = options.promotionThreshold ?? PROMOTION_THRESHOLD;
  const confThresh = options.confidenceThreshold ?? CONFIDENCE_THRESHOLD;

  for (const type of patternTypes) {
    const filePath = path.join(PATTERNS_DIR, `${type}-patterns.json`);
    const data = await readJsonFile(filePath);
    const patterns = data?.patterns ?? [];

    for (const pattern of patterns) {
      // Skip already promoted
      if (cache.has(pattern.key)) continue;

      const successes = pattern.consecutiveSuccesses ?? 0;
      const confidence = pattern.confidence ?? 0;

      if (successes >= promoThresh && confidence >= confThresh) {
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
          needsSuccesses: Math.max(0, promoThresh - successes),
          needsConfidence: Math.max(0, round(confThresh - confidence)),
        });
      }
    }
  }

  // Sort candidates by confidence descending
  candidates.sort((a, b) => b.confidence - a.confidence);

  return { candidates, alreadyPromoted, belowThreshold };
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
