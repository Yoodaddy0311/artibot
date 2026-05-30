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
import { clamp01 } from '../learning/pattern-analyzer.js';
import { ARTIBOT_DIR, round } from '../core/index.js';

// PII fields to strip from provenance when packaging for Swarm sharing
const PROVENANCE_PII_FIELDS = ['user', 'emailHash', 'machineHash'];

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PATTERNS_DIR = path.join(ARTIBOT_DIR, 'patterns');

/** Pattern types to package */
const PATTERN_TYPES = ['tool', 'error', 'success', 'team', 'agent', 'quality'];

/** Fallback directory for patterns stored by memory-manager */
const MEMORY_DIR = path.join(ARTIBOT_DIR, 'memory');

/** Default local:global merge ratio */
const DEFAULT_LOCAL_RATIO = 0.3;
const DEFAULT_GLOBAL_RATIO = 0.7;

/** Minimum sample size for a pattern to be packaged */
const MIN_SAMPLE_SIZE = 3;

/** Minimum confidence for a pattern to be packaged */
const MIN_CONFIDENCE = 0.4;

// ---------------------------------------------------------------------------
// Provenance PII Stripping
// ---------------------------------------------------------------------------

/**
 * Strip PII fields from a provenance object for Swarm sharing.
 * Removes user, emailHash, machineHash; keeps project-level metadata
 * (project, projectName, branch, commitRange, extractedAt, pipelineVersion).
 *
 * @param {object|null} provenance - Full provenance object
 * @returns {object|null} Sanitized provenance or null
 */
export function stripProvenance(provenance) {
  if (!provenance || typeof provenance !== 'object') return null;
  const sanitized = {};
  for (const [key, value] of Object.entries(provenance)) {
    if (!PROVENANCE_PII_FIELDS.includes(key)) {
      sanitized[key] = value;
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

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
    agents: {},
    quality: {},
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
      case 'agent':
        // Agents get their own bucket (was incorrectly routed to weights.tools
        // prior to this change, conflating agent and tool patterns in the swarm).
        weights.agents[category] = packageToolPattern(pattern);
        break;
      case 'quality':
        weights.quality[category] = packageQualityPattern(pattern);
        break;
    }
  }

  // Collect and sanitize provenance from patterns (strip PII for Swarm)
  const rawProvenance = patterns.find((p) => p.provenance)?.provenance ?? null;
  const safeProvenance = stripProvenance(rawProvenance);

  const metadata = {
    patternCount: patterns.length,
    packagedCount: countWeightEntries(weights),
    packagedAt: new Date().toISOString(),
    categories: Object.keys(weights).filter((k) => Object.keys(weights[k]).length > 0),
    provenance: safeProvenance,
  };

  const checksum = createHash('sha256')
    .update(JSON.stringify(weights))
    .digest('hex');

  return { weights, metadata, checksum };
}

/**
 * Convert a tool pattern into a normalized weight vector.
 *
 * @param {object} pattern - Tool pattern to package
 * @returns {object}
 */
function packageToolPattern(pattern) {
  const data = pattern.bestData ?? {};
  const packed = {
    confidence: clamp01(pattern.confidence ?? 0),
    sampleSize: pattern.sampleSize ?? 0,
  };
  // v4.6.4: successRate and avgLatency are only emitted when a real
  // measurement exists. Previously, `?? pattern.confidence ?? 0` and
  // `?? 0` fallbacks fabricated sentinel values that propagated through
  // unpack -> repackage -> mergeEntries and produced the documented
  // `0.66 * 0.3 + 0 * 0.7 = 0.198` drag for tools like
  // `mcp__playwright__evaluate` and `AskUserQuestion`.
  if (data.successRate !== undefined && data.successRate !== null) {
    packed.successRate = clamp01(data.successRate);
  }
  if (data.avgMs !== undefined && data.avgMs !== null) {
    packed.avgLatency = normalizeLatency(data.avgMs);
  }
  // Propagate certainty (sample-size-based signal) if the pattern carries it.
  // Pattern-analyzer adds this field in extractPattern(); older patterns from
  // pre-v4.6.2 disk state may not have it — omit cleanly in that case.
  if (typeof pattern.certainty === 'number') {
    packed.certainty = clamp01(pattern.certainty);
  }
  return packed;
}

/**
 * Convert an error pattern into an anonymized weight signature.
 *
 * @param {object} pattern - Error pattern to package
 * @returns {object}
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
 * @param {object} pattern - Command pattern to package
 * @returns {object}
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
 * Convert a CLAUDE.md quality audit pattern into a peer-comparable weight.
 * The pattern is expected to carry `bestData.score` (0..100) and optional
 * `bestData.criterion` / `bestData.projectType` for cross-project alignment.
 *
 * @param {object} pattern - Quality pattern to package
 * @returns {object}
 */
function packageQualityPattern(pattern) {
  const data = pattern.bestData ?? {};
  const rawScore = Number(data.score);
  const score = Number.isFinite(rawScore)
    ? clamp01(Math.max(0, Math.min(100, rawScore)) / 100)
    : 0;
  return {
    score,
    criterion: typeof data.criterion === 'string' ? data.criterion : 'overall',
    projectType: typeof data.projectType === 'string' ? data.projectType : 'unknown',
    confidence: clamp01(pattern.confidence ?? 0),
    sampleSize: pattern.sampleSize ?? 0,
  };
}

/**
 * Convert a team composition pattern into effectiveness weight.
 *
 * @param {object} pattern - Team pattern to package
 * @returns {object}
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
  const ts = new Date().toISOString();

  unpackToolWeights(globalWeights.tools, patterns, ts);
  unpackErrorWeights(globalWeights.errors, patterns, ts);
  unpackCommandWeights(globalWeights.commands, patterns, ts);
  unpackTeamWeights(globalWeights.teams, patterns, ts);
  unpackAgentWeights(globalWeights.agents, patterns, ts);
  unpackQualityWeights(globalWeights.quality, patterns, ts);

  return patterns;
}

/**
 * Unpack quality weight entries into the patterns array.
 *
 * @param {object|undefined} quality - Quality weight map from global weights
 * @param {object[]} patterns - Target patterns array to push into
 * @param {string} extractedAt - ISO timestamp string
 */
function unpackQualityWeights(quality, patterns, extractedAt) {
  if (!quality) return;
  for (const [category, weight] of Object.entries(quality)) {
    patterns.push({
      key: `quality::${category}`,
      type: 'quality',
      category,
      confidence: weight.confidence ?? 0.5,
      sampleSize: weight.sampleSize ?? 0,
      bestData: {
        score: typeof weight.score === 'number' ? Math.round(weight.score * 100) : null,
        criterion: weight.criterion ?? 'overall',
        projectType: weight.projectType ?? 'unknown',
      },
      source: 'swarm-global',
      extractedAt,
    });
  }
}

/**
 * Unpack tool weight entries into the patterns array.
 *
 * @param {object|undefined} tools - Tool weight map from global weights
 * @param {object[]} patterns - Target patterns array to push into
 * @param {string} extractedAt - ISO timestamp string
 */
function unpackToolWeights(tools, patterns, extractedAt) {
  if (!tools) return;
  for (const [category, weight] of Object.entries(tools)) {
    // v4.6.4: bestData fields only included when source weight had real data.
    // `weight.successRate ?? 0` previously fabricated 0 for absent measurements,
    // which then propagated through repackage and dragged merged values down.
    const bestData = {};
    if (weight.successRate !== undefined && weight.successRate !== null) {
      bestData.successRate = weight.successRate;
    }
    if (weight.avgLatency !== undefined && weight.avgLatency !== null) {
      bestData.avgMs = denormalizeLatency(weight.avgLatency);
    }
    const entry = {
      key: `tool::${category}`,
      type: 'tool',
      category,
      confidence: weight.confidence ?? 0.5,
      bestComposite: weight.successRate ?? 0.5,
      sampleSize: weight.sampleSize ?? 0,
      bestData,
      source: 'swarm-global',
      extractedAt,
    };
    if (typeof weight.certainty === 'number') entry.certainty = weight.certainty;
    patterns.push(entry);
  }
}

/**
 * Unpack agent weight entries into the patterns array.
 * Mirror of unpackToolWeights but tags entries with type 'agent' so they
 * route correctly through downstream pattern handling.
 *
 * @param {object|undefined} agents - Agent weight map from global weights
 * @param {object[]} patterns - Target patterns array to push into
 * @param {string} extractedAt - ISO timestamp string
 */
function unpackAgentWeights(agents, patterns, extractedAt) {
  if (!agents) return;
  for (const [category, weight] of Object.entries(agents)) {
    // v4.6.4: same fabrication-fix as unpackToolWeights — omit bestData fields
    // when source weight lacks them, instead of inserting sentinel zeros.
    const bestData = {};
    if (weight.successRate !== undefined && weight.successRate !== null) {
      bestData.successRate = weight.successRate;
    }
    if (weight.avgLatency !== undefined && weight.avgLatency !== null) {
      bestData.avgMs = denormalizeLatency(weight.avgLatency);
    }
    const entry = {
      key: `agent::${category}`,
      type: 'agent',
      category,
      confidence: weight.confidence ?? 0.5,
      bestComposite: weight.successRate ?? 0.5,
      sampleSize: weight.sampleSize ?? 0,
      bestData,
      source: 'swarm-global',
      extractedAt,
    };
    if (typeof weight.certainty === 'number') entry.certainty = weight.certainty;
    patterns.push(entry);
  }
}

/**
 * Unpack error weight entries into the patterns array.
 *
 * @param {object|undefined} errors - Error weight map from global weights
 * @param {object[]} patterns - Target patterns array to push into
 * @param {string} extractedAt - ISO timestamp string
 */
function unpackErrorWeights(errors, patterns, extractedAt) {
  if (!errors) return;
  for (const [signature, weight] of Object.entries(errors)) {
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
      extractedAt,
    });
  }
}

/**
 * Unpack command weight entries into the patterns array.
 *
 * @param {object|undefined} commands - Command weight map from global weights
 * @param {object[]} patterns - Target patterns array to push into
 * @param {string} extractedAt - ISO timestamp string
 */
function unpackCommandWeights(commands, patterns, extractedAt) {
  if (!commands) return;
  for (const [category, weight] of Object.entries(commands)) {
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
      extractedAt,
    });
  }
}

/**
 * Unpack team weight entries into the patterns array.
 *
 * @param {object|undefined} teams - Team weight map from global weights
 * @param {object[]} patterns - Target patterns array to push into
 * @param {string} extractedAt - ISO timestamp string
 */
function unpackTeamWeights(teams, patterns, extractedAt) {
  if (!teams) return;
  for (const [pattern, weight] of Object.entries(teams)) {
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
      extractedAt,
    });
  }
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
  for (const category of ['tools', 'errors', 'commands', 'teams', 'agents', 'quality']) {
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
 * @param {object} localEntry - Local weight entry
 * @param {object} globalEntry - Global weight entry
 * @param {number} localRatio - Weight ratio for local values
 * @param {number} globalRatio - Weight ratio for global values
 * @returns {object}
 */
function mergeEntries(localEntry, globalEntry, localRatio, globalRatio) {
  // v4.6.4: defense-in-depth — when one side has sampleSize=0 it has no real
  // measurements to contribute, so the other side should win wholesale instead
  // of dragging values toward 0 via weighted averaging. This guards against
  // legacy uploads with fabricated 0 fields (root cause of the 0.198 drag).
  const localSamples = typeof localEntry.sampleSize === 'number' ? localEntry.sampleSize : 0;
  const globalSamples = typeof globalEntry.sampleSize === 'number' ? globalEntry.sampleSize : 0;
  if (localSamples === 0 && globalSamples > 0) return { ...globalEntry };
  if (globalSamples === 0 && localSamples > 0) return { ...localEntry };

  const merged = {};
  const allKeys = new Set([...Object.keys(localEntry), ...Object.keys(globalEntry)]);

  for (const key of allKeys) {
    const localVal = localEntry[key];
    const globalVal = globalEntry[key];

    if (key === 'sampleSize' && typeof localVal === 'number' && typeof globalVal === 'number') {
      // Sum sample sizes
      merged[key] = localVal + globalVal;
    } else if (typeof localVal === 'number' && typeof globalVal === 'number') {
      // Weighted average for numeric values
      merged[key] = round(localVal * localRatio + globalVal * globalRatio);
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
 * Load all patterns from disk storage.
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
      continue;
    }
    // Fallback: error patterns may live in memory/ (written by memory-manager).
    // The fallback file can be either the analyzed `{ patterns: [...] }` shape
    // or the memory-tracker `{ entries: [...] }` shape. Accept both — the entries
    // shape is adapted into packageable patterns, otherwise the swarm errors
    // bucket stays empty despite real captured data.
    if (type === 'error') {
      const fallbackPath = path.join(MEMORY_DIR, 'error-patterns.json');
      const memData = await readJsonFile(fallbackPath);
      if (memData?.patterns && Array.isArray(memData.patterns)) {
        allPatterns.push(...memData.patterns);
      } else if (Array.isArray(memData?.entries)) {
        allPatterns.push(...adaptErrorEntries(memData.entries));
      }
    }
  }

  return allPatterns;
}

/**
 * Adapt memory-tracker error entries into packageable error patterns.
 *
 * The memory store records one raw entry per observed error
 * (`{ id, type, data: { message, ... } }`). The packager expects analyzed
 * patterns keyed `error::<signature>` with `sampleSize`/`confidence`. This
 * groups entries by their anonymized message signature (the same truncation
 * `packageErrorPattern` applies) and emits one pattern per signature, with
 * `sampleSize` = occurrence count. Signatures below MIN_SAMPLE_SIZE are still
 * emitted here and filtered downstream by the shared packaging threshold, so
 * the filter policy lives in exactly one place.
 *
 * @param {object[]} entries - Memory-tracker error entries
 * @returns {object[]} Error patterns in the analyzed shape
 */
function adaptErrorEntries(entries) {
  const bySignature = new Map();

  for (const entry of entries) {
    const message = entry?.data?.message;
    if (typeof message !== 'string' || message.length === 0) continue;

    const signature = message.slice(0, 50);
    const existing = bySignature.get(signature);
    if (existing) {
      existing.sampleSize += 1;
    } else {
      bySignature.set(signature, {
        sampleSize: 1,
        recoverable: entry?.data?.recoverable ?? null,
        message: signature,
      });
    }
  }

  const patterns = [];
  for (const [signature, agg] of bySignature) {
    patterns.push({
      key: `error::${signature}`,
      type: 'error',
      category: signature,
      // More recurrences ⇒ higher confidence the signature is real, capped at
      // 0.9 to leave headroom and stay clear of the "fabricated 1.0" smell.
      confidence: clamp01(Math.min(0.9, 0.4 + agg.sampleSize / 50)),
      sampleSize: agg.sampleSize,
      bestData: { message: agg.message, recoverable: agg.recoverable },
    });
  }

  return patterns;
}

// ---------------------------------------------------------------------------
// Normalization Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize latency (ms) to 0-1 scale.
 * 0ms -> 1.0 (fast), 10000ms -> ~0.0 (slow)
 *
 * @param {number} ms - Latency in milliseconds
 * @returns {number}
 */
function normalizeLatency(ms) {
  return clamp01(1.0 / (1 + ms / 5000));
}

/**
 * Denormalize latency from 0-1 back to milliseconds.
 *
 * @param {number} normalized - Normalized value 0-1
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
 * @param {number} ms - Duration in milliseconds
 * @returns {number}
 */
function normalizeDuration(ms) {
  return clamp01(1.0 / (1 + ms / 60000));
}

/**
 * Denormalize duration from 0-1 back to milliseconds.
 *
 * @param {number} normalized - Normalized value 0-1
 * @returns {number}
 */
function denormalizeDuration(normalized) {
  if (normalized <= 0) return Infinity;
  return Math.round(60000 * (1 / normalized - 1));
}

/**
 * Normalize file count to 0-1 scale.
 *
 * @param {number} count - File count
 * @returns {number}
 */
function normalizeFileCount(count) {
  return clamp01(1.0 / (1 + count / 20));
}

/**
 * Denormalize file count from 0-1 back to integer.
 *
 * @param {number} normalized - Normalized value 0-1
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
 * @param {object} weights - Weight object with categories
 * @returns {number}
 */
function countWeightEntries(weights) {
  return Object.values(weights).reduce(
    (sum, cat) => sum + Object.keys(cat).length,
    0,
  );
}
