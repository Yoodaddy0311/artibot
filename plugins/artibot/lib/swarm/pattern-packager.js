/**
 * Pattern Packager - Converts local patterns to shareable weights
 * and merges global weights back into local patterns.
 *
 * Transforms:
 * - Tool success rates -> normalized weights
 * - Error solutions -> anonymized pattern signatures
 * - Command patterns -> usage frequency weights
 * - Team compositions -> effectiveness scores
 *
 * Zero external dependencies.
 *
 * @module lib/swarm/pattern-packager
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { readJsonFile } from '../core/file.js';
import { ARTIBOT_DIR, round } from '../core/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PATTERNS_DIR = path.join(ARTIBOT_DIR, 'patterns');

/** Pattern types to package */
const PATTERN_TYPES = ['tool', 'error', 'success', 'team'];

/** Default local:global merge ratio */
const DEFAULT_LOCAL_RATIO = 0.3;
const DEFAULT_GLOBAL_RATIO = 0.7;

/** Minimum sample size for a pattern to be packaged */
const MIN_SAMPLE_SIZE = 3;

/** Minimum confidence for a pattern to be packaged */
const MIN_CONFIDENCE = 0.4;

// ---------------------------------------------------------------------------
// Pattern -> Weight Conversion
// ---------------------------------------------------------------------------

/**
 * @typedef {object} PackagedWeights
 * @property {object} weights - Normalized weight vectors by category
 * @property {object} metadata - Package metadata
 * @property {string} checksum - SHA-256 of the weights object
 */

/**
 * Package local patterns into shareable weight vectors.
 *
 * Reads all pattern files from ~/.claude/artibot/patterns/ and converts
 * them into normalized, anonymized weight vectors suitable for upload.
 *
 * @param {object[]} [localPatterns] - Optional pre-loaded patterns. Loads from disk if omitted.
 * @returns {Promise<PackagedWeights>}
 */
export async function packagePatterns(localPatterns) {
  const patterns = localPatterns ?? await loadAllPatterns();

  const weights = {
    tools: {},
    errors: {},
    commands: {},
    teams: {},
  };

  for (const pattern of patterns) {
    if (!pattern.key || (pattern.sampleSize ?? 0) < MIN_SAMPLE_SIZE) continue;
    if ((pattern.confidence ?? 0) < MIN_CONFIDENCE) continue;

    const [type, category] = pattern.key.split('::');

    switch (type) {
      case 'tool':
        weights.tools[category] = packageToolPattern(pattern);
        break;
      case 'error':
        weights.errors[anonymizeKey(category)] = packageErrorPattern(pattern);
        break;
      case 'success':
        weights.commands[category] = packageCommandPattern(pattern);
        break;
      case 'team':
        weights.teams[category] = packageTeamPattern(pattern);
        break;
    }
  }

  const metadata = {
    patternCount: patterns.length,
    packagedCount: countWeightEntries(weights),
    packagedAt: new Date().toISOString(),
    categories: Object.keys(weights).filter((k) => Object.keys(weights[k]).length > 0),
  };

  const checksum = createHash('sha256')
    .update(JSON.stringify(weights))
    .digest('hex');

  return { weights, metadata, checksum };
}

/**
 * Convert a tool pattern into normalized weight vector.
 *
 * @param {object} pattern
 * @returns {object} Normalized weight
 */
function packageToolPattern(pattern) {
  const data = pattern.bestData ?? {};
  return {
    successRate: clamp01(data.successRate ?? pattern.confidence ?? 0),
    avgLatency: normalizeLatency(data.avgMs ?? 0),
    confidence: clamp01(pattern.confidence ?? 0),
    sampleSize: pattern.sampleSize ?? 0,
  };
}

/**
 * Convert an error pattern into an anonymized signature.
 *
 * @param {object} pattern
 * @returns {object} Anonymized error weight
 */
function packageErrorPattern(pattern) {
  const data = pattern.bestData ?? {};
  return {
    frequency: clamp01(1 - (pattern.confidence ?? 0)),
    recoverable: data.recoverable === true ? 1.0 : data.recoverable === false ? 0.0 : 0.5,
    signature: anonymizeKey(data.message?.slice(0, 50) ?? pattern.category ?? ''),
    sampleSize: pattern.sampleSize ?? 0,
  };
}

/**
 * Convert a command/success pattern into usage frequency weight.
 *
 * @param {object} pattern
 * @returns {object} Command weight
 */
function packageCommandPattern(pattern) {
  const data = pattern.bestData ?? {};
  return {
    effectiveness: clamp01(pattern.confidence ?? 0),
    avgDuration: normalizeDuration(data.duration ?? 0),
    filesModified: normalizeFileCount(data.filesModified ?? 0),
    testsPass: data.testsPass === true ? 1.0 : data.testsPass === false ? 0.0 : 0.5,
    sampleSize: pattern.sampleSize ?? 0,
  };
}

/**
 * Convert a team composition pattern into effectiveness score.
 *
 * @param {object} pattern
 * @returns {object} Team weight
 */
function packageTeamPattern(pattern) {
  const data = pattern.bestData ?? {};
  return {
    effectiveness: clamp01(pattern.confidence ?? 0),
    optimalSize: data.size ?? 0,
    avgDuration: normalizeDuration(data.duration ?? 0),
    sampleSize: pattern.sampleSize ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Weight -> Pattern Conversion
// ---------------------------------------------------------------------------

/**
 * Unpack global weights into local pattern format.
 *
 * Converts downloaded global weight vectors back into the local
 * pattern structure used by lifelong-learner and knowledge-transfer.
 *
 * @param {object} globalWeights - Weight object from server
 * @returns {object[]} Array of pattern objects in local format
 */
export function unpackWeights(globalWeights) {
  if (!globalWeights || typeof globalWeights !== 'object') return [];

  const patterns = [];

  // Unpack tool weights
  if (globalWeights.tools) {
    for (const [category, weight] of Object.entries(globalWeights.tools)) {
      patterns.push({
        key: `tool::${category}`,
        type: 'tool',
        category,
        confidence: weight.confidence ?? 0.5,
        bestComposite: weight.successRate ?? 0.5,
        sampleSize: weight.sampleSize ?? 0,
        bestData: {
          successRate: weight.successRate ?? 0,
          avgMs: denormalizeLatency(weight.avgLatency ?? 0.5),
        },
        source: 'swarm-global',
        extractedAt: new Date().toISOString(),
      });
    }
  }

  // Unpack error weights
  if (globalWeights.errors) {
    for (const [signature, weight] of Object.entries(globalWeights.errors)) {
      patterns.push({
        key: `error::${signature}`,
        type: 'error',
        category: signature,
        confidence: clamp01(1 - (weight.frequency ?? 0.5)),
        sampleSize: weight.sampleSize ?? 0,
        bestData: {
          recoverable: weight.recoverable >= 0.5,
          message: null, // Anonymized, no original message
        },
        source: 'swarm-global',
        extractedAt: new Date().toISOString(),
      });
    }
  }

  // Unpack command weights
  if (globalWeights.commands) {
    for (const [category, weight] of Object.entries(globalWeights.commands)) {
      patterns.push({
        key: `success::${category}`,
        type: 'success',
        category,
        confidence: weight.effectiveness ?? 0.5,
        sampleSize: weight.sampleSize ?? 0,
        bestData: {
          duration: denormalizeDuration(weight.avgDuration ?? 0.5),
          filesModified: denormalizeFileCount(weight.filesModified ?? 0.5),
          testsPass: weight.testsPass >= 0.5,
        },
        source: 'swarm-global',
        extractedAt: new Date().toISOString(),
      });
    }
  }

  // Unpack team weights
  if (globalWeights.teams) {
    for (const [pattern, weight] of Object.entries(globalWeights.teams)) {
      patterns.push({
        key: `team::${pattern}`,
        type: 'team',
        category: pattern,
        confidence: weight.effectiveness ?? 0.5,
        sampleSize: weight.sampleSize ?? 0,
        bestData: {
          size: weight.optimalSize ?? 0,
          duration: denormalizeDuration(weight.avgDuration ?? 0.5),
          pattern,
        },
        source: 'swarm-global',
        extractedAt: new Date().toISOString(),
      });
    }
  }

  return patterns;
}

// ---------------------------------------------------------------------------
// Weight Merging
// ---------------------------------------------------------------------------

/**
 * Merge local and global weights using weighted averaging.
 *
 * Default ratio: local 30%, global 70%.
 * Handles key-level conflicts by blending numeric values.
 *
 * @param {object} local - Local weight object
 * @param {object} global_ - Global weight object
 * @param {number[]} [ratio] - [localRatio, globalRatio], must sum to 1.0
 * @returns {object} Merged weight object
 */
export function mergeWeights(local, global_, ratio) {
  const localRatio = ratio?.[0] ?? DEFAULT_LOCAL_RATIO;
  const globalRatio = ratio?.[1] ?? DEFAULT_GLOBAL_RATIO;

  if (!local && !global_) return {};
  if (!local) return global_;
  if (!global_) return local;

  const merged = {};

  // Merge each weight category
  for (const category of ['tools', 'errors', 'commands', 'teams']) {
    const localCat = local[category] ?? {};
    const globalCat = global_[category] ?? {};
    const allKeys = new Set([...Object.keys(localCat), ...Object.keys(globalCat)]);

    merged[category] = {};

    for (const key of allKeys) {
      const localEntry = localCat[key];
      const globalEntry = globalCat[key];

      if (localEntry && globalEntry) {
        // Both exist: weighted average of numeric fields
        merged[category][key] = mergeEntries(localEntry, globalEntry, localRatio, globalRatio);
      } else if (localEntry) {
        // Local only: keep with local weight
        merged[category][key] = { ...localEntry };
      } else {
        // Global only: keep with global weight
        merged[category][key] = { ...globalEntry };
      }
    }
  }

  return merged;
}

/**
 * Merge two weight entries by blending numeric values.
 *
 * @param {object} localEntry
 * @param {object} globalEntry
 * @param {number} localRatio
 * @param {number} globalRatio
 * @returns {object}
 */
function mergeEntries(localEntry, globalEntry, localRatio, globalRatio) {
  const merged = {};
  const allKeys = new Set([...Object.keys(localEntry), ...Object.keys(globalEntry)]);

  for (const key of allKeys) {
    const localVal = localEntry[key];
    const globalVal = globalEntry[key];

    if (typeof localVal === 'number' && typeof globalVal === 'number') {
      // Weighted average for numeric values
      merged[key] = round(localVal * localRatio + globalVal * globalRatio);
    } else if (key === 'sampleSize' && typeof localVal === 'number' && typeof globalVal === 'number') {
      // Sum sample sizes
      merged[key] = localVal + globalVal;
    } else if (localVal !== undefined) {
      merged[key] = localVal;
    } else {
      merged[key] = globalVal;
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Pattern Loading
// ---------------------------------------------------------------------------

/**
 * Load all patterns from disk.
 *
 * @returns {Promise<object[]>}
 */
async function loadAllPatterns() {
  const allPatterns = [];

  for (const type of PATTERN_TYPES) {
    const filePath = path.join(PATTERNS_DIR, `${type}-patterns.json`);
    const data = await readJsonFile(filePath);
    if (data?.patterns && Array.isArray(data.patterns)) {
      allPatterns.push(...data.patterns);
    }
  }

  return allPatterns;
}

// ---------------------------------------------------------------------------
// Normalization Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize latency (ms) to 0-1 scale.
 * 0ms -> 1.0 (fast), 10000ms -> ~0.0 (slow)
 *
 * @param {number} ms
 * @returns {number}
 */
function normalizeLatency(ms) {
  return clamp01(1.0 / (1 + ms / 5000));
}

/**
 * Denormalize latency from 0-1 back to ms.
 *
 * @param {number} normalized
 * @returns {number}
 */
function denormalizeLatency(normalized) {
  if (normalized <= 0) return Infinity;
  return Math.round(5000 * (1 / normalized - 1));
}

/**
 * Normalize duration (ms) to 0-1 scale.
 * 0ms -> 1.0 (fast), 120000ms -> ~0.0 (slow)
 *
 * @param {number} ms
 * @returns {number}
 */
function normalizeDuration(ms) {
  return clamp01(1.0 / (1 + ms / 60000));
}

/**
 * Denormalize duration from 0-1 back to ms.
 *
 * @param {number} normalized
 * @returns {number}
 */
function denormalizeDuration(normalized) {
  if (normalized <= 0) return Infinity;
  return Math.round(60000 * (1 / normalized - 1));
}

/**
 * Normalize file count to 0-1 scale.
 *
 * @param {number} count
 * @returns {number}
 */
function normalizeFileCount(count) {
  return clamp01(1.0 / (1 + count / 20));
}

/**
 * Denormalize file count from 0-1 back to integer.
 *
 * @param {number} normalized
 * @returns {number}
 */
function denormalizeFileCount(normalized) {
  if (normalized <= 0) return Infinity;
  return Math.round(20 * (1 / normalized - 1));
}

/**
 * Anonymize a key by hashing it.
 * Strips any PII or identifying information.
 *
 * @param {string} key
 * @returns {string} First 12 characters of SHA-256 hash
 */
function anonymizeKey(key) {
  if (!key || typeof key !== 'string') return 'unknown';
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Count total entries across all weight categories.
 *
 * @param {object} weights
 * @returns {number}
 */
function countWeightEntries(weights) {
  return Object.values(weights).reduce(
    (sum, cat) => sum + Object.keys(cat).length,
    0,
  );
}

/**
 * Clamp a value between 0 and 1.
 *
 * @param {number} value
 * @returns {number}
 */
function clamp01(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

