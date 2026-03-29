/**
 * Collective Intelligence Hub — community-wide pattern sharing with privacy.
 * Extends the existing swarm system to enable opt-in anonymous pattern sharing
 * across the global Artibot user community.
 *
 * All sharing is: opt-in, anonymized (PII scrubbed), local-first.
 * DATA POLICY: No external DB access, no third-party data transmission.
 * All data stays within Artibot's own plugin/server infrastructure.
 *
 * @module lib/swarm/collective-hub
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum success rate for a pattern to be shareable */
const MIN_SHARE_SUCCESS_RATE = 0.6;

/** Minimum usage count before a pattern qualifies for sharing */
const MIN_USAGE_COUNT = 5;

/** Maximum patterns per contribution batch */
const MAX_BATCH_SIZE = 50;

/** Ranking decay factor — recent patterns rank higher */
const RECENCY_WEIGHT = 0.3;

/** Success rate weight in ranking */
const SUCCESS_WEIGHT = 0.5;

/** Popularity weight in ranking */
const POPULARITY_WEIGHT = 0.2;

// ---------------------------------------------------------------------------
// Pattern Types
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SharedPattern
 * @property {string} id - Anonymized pattern ID (SHA-256 hash)
 * @property {string} type - Pattern category (tool, error, team, workflow)
 * @property {string} signature - Anonymized pattern signature
 * @property {number} successRate - Success rate (0.0 - 1.0)
 * @property {number} usageCount - How many times used across community
 * @property {number} contributorCount - Unique contributors
 * @property {number} score - Computed ranking score
 * @property {string} lastUpdated - ISO timestamp
 * @property {object} [metadata] - Additional anonymized metadata
 */

/**
 * @typedef {object} ContributionBatch
 * @property {string} batchId - Unique batch identifier
 * @property {SharedPattern[]} patterns - Patterns to share
 * @property {string} instanceHash - Anonymized instance ID
 * @property {string} timestamp - ISO timestamp
 * @property {boolean} optIn - Must always be true
 */

/**
 * @typedef {object} HubConfig
 * @property {boolean} optIn - Whether sharing is enabled
 * @property {string[]} shareTypes - Pattern types allowed to share
 * @property {number} minSuccessRate - Minimum success rate to share
 * @property {number} minUsageCount - Minimum usage count to share
 */

// ---------------------------------------------------------------------------
// Anonymization
// ---------------------------------------------------------------------------

/**
 * Generate an anonymized pattern ID from raw data.
 * Uses SHA-256 to ensure no reversible PII.
 *
 * @param {string} rawData - Raw pattern data to hash
 * @returns {string} Hex SHA-256 hash
 */
export function anonymizeId(rawData) {
  return createHash('sha256').update(String(rawData)).digest('hex');
}

/**
 * Generate an anonymized instance identifier.
 * Hashes machine-specific info so the hub can deduplicate without identifying users.
 *
 * @param {object} deps
 * @param {string} [deps.hostname]
 * @param {string} [deps.username]
 * @returns {string}
 */
export function createInstanceHash(deps = {}) {
  const raw = `${deps.hostname || 'unknown'}:${deps.username || 'unknown'}:artibot`;
  return anonymizeId(raw);
}

// ---------------------------------------------------------------------------
// Pattern Qualification
// ---------------------------------------------------------------------------

/**
 * Check if a local pattern qualifies for community sharing.
 *
 * @param {object} pattern - Local pattern data
 * @param {number} pattern.successRate
 * @param {number} pattern.usageCount
 * @param {HubConfig} config
 * @returns {{ qualified: boolean, reasons: string[] }}
 */
export function qualifyPattern(pattern, config) {
  const reasons = [];
  const minSuccess = config.minSuccessRate ?? MIN_SHARE_SUCCESS_RATE;
  const minUsage = config.minUsageCount ?? MIN_USAGE_COUNT;

  if (!config.optIn) {
    return { qualified: false, reasons: ['Sharing is not opted in'] };
  }

  if (pattern.successRate < minSuccess) {
    reasons.push(`Success rate ${pattern.successRate} below threshold ${minSuccess}`);
  }

  if (pattern.usageCount < minUsage) {
    reasons.push(`Usage count ${pattern.usageCount} below threshold ${minUsage}`);
  }

  return { qualified: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Ranking Engine
// ---------------------------------------------------------------------------

/**
 * Compute a ranking score for a shared pattern.
 *
 * Score = (successRate * SUCCESS_WEIGHT) +
 *         (normalizedPopularity * POPULARITY_WEIGHT) +
 *         (recencyScore * RECENCY_WEIGHT)
 *
 * @param {SharedPattern} pattern
 * @param {object} context
 * @param {number} context.maxUsage - Max usage count in the dataset (for normalization)
 * @param {string} [context.now] - Current ISO timestamp
 * @returns {number} Score between 0.0 and 1.0
 */
export function computeRankingScore(pattern, context) {
  const successScore = pattern.successRate * SUCCESS_WEIGHT;

  const maxUsage = context.maxUsage || 1;
  const popularityScore = (pattern.usageCount / maxUsage) * POPULARITY_WEIGHT;

  const now = context.now ? new Date(context.now).getTime() : Date.now();
  const updated = new Date(pattern.lastUpdated).getTime();
  const ageMs = Math.max(0, now - updated);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const recencyScore = Math.max(0, 1 - ageDays / 90) * RECENCY_WEIGHT;

  return Math.round((successScore + popularityScore + recencyScore) * 1000) / 1000;
}

/**
 * Rank patterns and return the top N.
 *
 * @param {SharedPattern[]} patterns
 * @param {number} [topN=10]
 * @param {object} [context]
 * @returns {SharedPattern[]}
 */
export function rankPatterns(patterns, topN = 10, context = {}) {
  if (!patterns || patterns.length === 0) return [];

  const maxUsage = Math.max(...patterns.map((p) => p.usageCount), 1);
  const ctx = { ...context, maxUsage };

  const scored = patterns.map((p) => ({
    ...p,
    score: computeRankingScore(p, ctx),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}

// ---------------------------------------------------------------------------
// Contribution Builder
// ---------------------------------------------------------------------------

/**
 * Build a contribution batch from local patterns.
 * Filters by qualification, anonymizes, and caps at MAX_BATCH_SIZE.
 *
 * @param {object[]} localPatterns - Raw local patterns
 * @param {HubConfig} config
 * @param {object} [deps]
 * @param {string} [deps.hostname]
 * @param {string} [deps.username]
 * @returns {ContributionBatch | null} Null if nothing qualifies or opt-in is off
 */
export function buildContribution(localPatterns, config, deps = {}) {
  if (!config.optIn) return null;
  if (!Array.isArray(localPatterns) || localPatterns.length === 0) return null;

  const qualified = [];

  for (const raw of localPatterns) {
    const check = qualifyPattern(raw, config);
    if (!check.qualified) continue;

    qualified.push({
      id: anonymizeId(`${raw.type}:${raw.signature || raw.name || ''}`),
      type: raw.type || 'unknown',
      signature: anonymizeId(raw.signature || raw.name || ''),
      successRate: raw.successRate,
      usageCount: raw.usageCount,
      contributorCount: 1,
      score: 0,
      lastUpdated: new Date().toISOString(),
      metadata: raw.metadata ? stripPiiFromMetadata(raw.metadata) : undefined,
    });
  }

  if (qualified.length === 0) return null;

  const batch = qualified.slice(0, MAX_BATCH_SIZE);

  return {
    batchId: anonymizeId(`batch:${Date.now()}`),
    patterns: batch,
    instanceHash: createInstanceHash(deps),
    timestamp: new Date().toISOString(),
    optIn: true,
  };
}

// ---------------------------------------------------------------------------
// Privacy Helpers
// ---------------------------------------------------------------------------

/** PII-sensitive metadata keys to strip */
const PII_KEYS = new Set([
  'user', 'username', 'email', 'emailHash', 'machineHash',
  'hostname', 'ip', 'path', 'cwd', 'home',
]);

/**
 * Strip PII-sensitive keys from metadata.
 *
 * @param {object} metadata
 * @returns {object} Sanitized metadata
 */
function stripPiiFromMetadata(metadata) {
  const sanitized = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!PII_KEYS.has(key)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

// ---------------------------------------------------------------------------
// Weekly Recommendations (Top-N)
// ---------------------------------------------------------------------------

/**
 * Generate "Top N patterns this week" recommendation.
 *
 * @param {SharedPattern[]} communityPatterns - All patterns from the community hub
 * @param {number} [topN=10]
 * @param {object} [context]
 * @returns {{ title: string, patterns: SharedPattern[], generatedAt: string }}
 */
export function generateWeeklyTop(communityPatterns, topN = 10, context = {}) {
  const ranked = rankPatterns(communityPatterns, topN, context);
  return {
    title: `Top ${topN} Patterns This Week`,
    patterns: ranked,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  MIN_SHARE_SUCCESS_RATE as _MIN_SHARE_SUCCESS_RATE,
  MIN_USAGE_COUNT as _MIN_USAGE_COUNT,
  MAX_BATCH_SIZE as _MAX_BATCH_SIZE,
  PII_KEYS as _PII_KEYS,
  stripPiiFromMetadata as _stripPiiFromMetadata,
};
