/**
 * Skill Evolution Engine.
 * Tracks skill usage, evaluates effectiveness via EWMA trends,
 * classifies lifecycle stage, and learns from user edit diffs.
 *
 * Zero runtime deps. ESM only.
 * @module lib/learning/skill-evolver
 */

import { emit } from '../core/event-bus.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** @enum {string} */
export const CLASSIFICATION = Object.freeze({
  PROVEN: 'proven',
  STABLE: 'stable',
  DECLINING: 'declining',
  DEPRECATED: 'deprecated',
});

/** Default classification thresholds */
export const DEFAULT_THRESHOLDS = Object.freeze({
  provenSuccessRate: 0.9,
  provenMinUsage: 10,
  stableSuccessRate: 0.5,
  decliningTrend: -0.2,
  decliningSuccessRate: 0.5,
  decliningMinUsage: 3,
  deprecatedSuccessRate: 0.3,
  deprecatedMinUsage: 5,
});

const DEFAULT_EWMA_ALPHA = 0.3;

// ---------------------------------------------------------------------------
// Pure helpers — metrics
// ---------------------------------------------------------------------------

/**
 * Compute EWMA trend from a sequence of outcome records.
 *
 * @param {Array<{success: boolean}>} records
 * @param {number} [alpha=0.3]
 * @returns {number} Trend value between -1.0 and 1.0
 */
function computeEwma(records, alpha = DEFAULT_EWMA_ALPHA) {
  let ewma = 0;
  for (const record of records) {
    const value = record.success ? 1 : -1;
    ewma = alpha * value + (1 - alpha) * ewma;
  }
  return Math.round(ewma * 1000) / 1000;
}

/**
 * Compute metrics for a set of outcome records.
 *
 * @param {Array<{invoked: boolean, success: boolean, userEdited: boolean, editDistance: number}>} records
 * @param {number} [alpha=0.3]
 * @returns {{successRate: number, usageCount: number, avgEditDistance: number, trend: number}}
 */
export function computeMetrics(records, alpha = DEFAULT_EWMA_ALPHA) {
  if (!records || records.length === 0) {
    return Object.freeze({ successRate: 0, usageCount: 0, avgEditDistance: 0, trend: 0 });
  }

  const usageCount = records.length;
  const successes = records.filter((r) => r.success).length;
  const successRate = Math.round((successes / usageCount) * 1000) / 1000;

  const totalEdit = records.reduce((sum, r) => sum + (r.editDistance || 0), 0);
  const avgEditDistance = Math.round((totalEdit / usageCount) * 100) / 100;

  const trend = computeEwma(records, alpha);

  return Object.freeze({ successRate, usageCount, avgEditDistance, trend });
}

// ---------------------------------------------------------------------------
// Pure helpers — classification
// ---------------------------------------------------------------------------

/**
 * Classify a skill based on its metrics.
 * Priority: deprecated > declining > proven > stable.
 *
 * @param {{successRate: number, usageCount: number, trend: number}} metrics
 * @param {object} [thresholds]
 * @returns {string}
 */
function classifyMetrics(metrics, thresholds = DEFAULT_THRESHOLDS) {
  const { successRate, usageCount, trend } = metrics;

  if (successRate <= thresholds.deprecatedSuccessRate && usageCount >= thresholds.deprecatedMinUsage) {
    return CLASSIFICATION.DEPRECATED;
  }
  if (trend < thresholds.decliningTrend) {
    return CLASSIFICATION.DECLINING;
  }
  if (successRate < thresholds.decliningSuccessRate && usageCount >= thresholds.decliningMinUsage) {
    return CLASSIFICATION.DECLINING;
  }
  if (successRate >= thresholds.provenSuccessRate && usageCount >= thresholds.provenMinUsage) {
    return CLASSIFICATION.PROVEN;
  }
  return CLASSIFICATION.STABLE;
}

// ---------------------------------------------------------------------------
// Pure helpers — diff analysis
// ---------------------------------------------------------------------------

/**
 * Find common edit patterns from before/after diff pairs.
 * Groups diffs by simplified transformation signature.
 *
 * @param {Array<{before: string, after: string}>} diffs
 * @returns {Array<{pattern: string, frequency: number}>}
 */
export function findCommonEdits(diffs) {
  if (!diffs || diffs.length === 0) return [];

  const editMap = new Map();

  for (const diff of diffs) {
    const sig = describeEdit(diff.before, diff.after);
    if (!sig) continue;
    editMap.set(sig, (editMap.get(sig) || 0) + 1);
  }

  return [...editMap.entries()]
    .map(([pattern, frequency]) => ({ pattern, frequency }))
    .sort((a, b) => b.frequency - a.frequency);
}

/**
 * Describe the transformation between before and after text.
 *
 * @param {string} before
 * @param {string} after
 * @returns {string|null}
 */
function describeEdit(before, after) {
  if (!before || !after) return null;
  if (before === after) return null;

  const bLines = before.split('\n');
  const aLines = after.split('\n');

  if (aLines.length > bLines.length) return 'lines-added';
  if (aLines.length < bLines.length) return 'lines-removed';

  const changedLines = bLines.filter((line, i) => line !== aLines[i]).length;
  if (changedLines === 0) return null;

  if (changedLines <= 2) return 'minor-text-change';
  if (changedLines <= 5) return 'moderate-rewrite';
  return 'major-rewrite';
}

/**
 * Generate a refactor suggestion for a skill based on its metrics.
 *
 * @param {string} skillName
 * @param {{successRate: number, usageCount: number, avgEditDistance: number, trend: number}} metrics
 * @returns {string}
 */
export function generateRefactorSuggestion(skillName, metrics) {
  if (metrics.successRate <= 0.3) {
    return `Skill "${skillName}" has very low success (${metrics.successRate}). Consider rewriting or removing.`;
  }
  if (metrics.avgEditDistance > 50) {
    return `Skill "${skillName}" outputs require heavy editing (avg ${metrics.avgEditDistance}). Review output templates.`;
  }
  if (metrics.trend < -0.2) {
    return `Skill "${skillName}" is trending downward (${metrics.trend}). Investigate recent failures.`;
  }
  return `Skill "${skillName}" is performing adequately. No immediate action needed.`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a skill evolver instance.
 *
 * @param {object} [options]
 * @param {string} [options.storagePath]
 * @param {number} [options.ewmaAlpha=0.3]
 * @param {object} [options.thresholds]
 * @param {() => number} [options.now]
 * @returns {{
 *   track: (skillName: string, outcome: object) => void,
 *   evaluate: (skillName: string) => object,
 *   classify: (metrics: object) => string,
 *   evolve: (skillName: string, diffs: Array) => Array,
 *   getReport: () => object,
 *   runBatch: (allSkillNames: string[]) => Map,
 *   getRecords: () => Map,
 * }}
 */
export function createSkillEvolver(options = {}) {
  const alpha = options.ewmaAlpha ?? DEFAULT_EWMA_ALPHA;
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const now = options.now ?? Date.now;

  /** @type {Map<string, Array>} skillName -> outcome records */
  let records = new Map();

  /** @type {Array} accumulated learned rules */
  let learnedRules = [];

  return {
    /**
     * Record a skill usage outcome.
     *
     * @param {string} skillName
     * @param {{invoked: boolean, success: boolean, userEdited: boolean, editDistance: number}} outcome
     */
    track(skillName, outcome) {
      if (typeof skillName !== 'string' || skillName.length === 0) {
        throw new Error('Skill name must be a non-empty string');
      }
      if (!outcome || typeof outcome !== 'object') {
        throw new Error('Outcome must be an object');
      }

      const entry = Object.freeze({
        timestamp: new Date(now()).toISOString(),
        invoked: Boolean(outcome.invoked),
        success: Boolean(outcome.success),
        userEdited: Boolean(outcome.userEdited),
        editDistance: Number(outcome.editDistance) || 0,
      });

      const prev = records.get(skillName) || [];
      const updated = new Map(records);
      updated.set(skillName, [...prev, entry]);
      records = updated;
    },

    /**
     * Evaluate a skill's metrics.
     *
     * @param {string} skillName
     * @returns {{successRate: number, usageCount: number, avgEditDistance: number, trend: number}}
     */
    evaluate(skillName) {
      const skillRecords = records.get(skillName);
      if (!skillRecords || skillRecords.length === 0) {
        return Object.freeze({ successRate: 0, usageCount: 0, avgEditDistance: 0, trend: 0 });
      }
      return computeMetrics(skillRecords, alpha);
    },

    /**
     * Classify a skill based on metrics.
     *
     * @param {{successRate: number, usageCount: number, trend: number}} metrics
     * @returns {string}
     */
    classify(metrics) {
      return classifyMetrics(metrics, thresholds);
    },

    /**
     * Learn from user edit diffs and generate rules.
     *
     * @param {string} skillName
     * @param {Array<{before: string, after: string}>} diffs
     * @returns {Array<{skillName: string, pattern: string, frequency: number, suggestion: string}>}
     */
    evolve(skillName, diffs) {
      if (typeof skillName !== 'string' || skillName.length === 0) {
        throw new Error('Skill name must be a non-empty string');
      }
      if (!Array.isArray(diffs)) {
        throw new Error('Diffs must be an array');
      }

      const commonEdits = findCommonEdits(diffs);
      const rules = commonEdits
        .filter((edit) => edit.frequency >= 2)
        .map((edit) => Object.freeze({
          skillName,
          pattern: edit.pattern,
          frequency: edit.frequency,
          suggestion: `Consider updating "${skillName}" to avoid "${edit.pattern}" edits`,
        }));

      if (rules.length > 0) {
        learnedRules = [...learnedRules, ...rules];
        emit('skill:evolved', { skillName, rulesCount: rules.length });
      }

      return rules;
    },

    /**
     * Generate a full evolution report.
     *
     * @returns {{totalSkills: number, proven: string[], stable: string[], declining: string[], deprecated: string[], topByUsage: Array, generatedAt: string}}
     */
    getReport() {
      const proven = [];
      const stable = [];
      const declining = [];
      const deprecated = [];
      const usageCounts = [];

      for (const [name, skillRecords] of records) {
        const metrics = computeMetrics(skillRecords, alpha);
        const cls = classifyMetrics(metrics, thresholds);

        if (cls === CLASSIFICATION.PROVEN) proven.push(name);
        else if (cls === CLASSIFICATION.DECLINING) declining.push(name);
        else if (cls === CLASSIFICATION.DEPRECATED) deprecated.push(name);
        else stable.push(name);

        usageCounts.push({ name, count: metrics.usageCount });
      }

      const topByUsage = usageCounts
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      return Object.freeze({
        totalSkills: records.size,
        proven,
        stable,
        declining,
        deprecated,
        topByUsage,
        generatedAt: new Date(now()).toISOString(),
      });
    },

    /**
     * Batch evaluate all provided skill names.
     *
     * @param {string[]} allSkillNames
     * @returns {Map<string, {metrics: object, classification: string}>}
     */
    runBatch(allSkillNames) {
      if (!Array.isArray(allSkillNames)) {
        throw new Error('allSkillNames must be an array');
      }

      const results = new Map();
      for (const name of allSkillNames) {
        const skillRecords = records.get(name) || [];
        const metrics = computeMetrics(skillRecords, alpha);
        const classification = classifyMetrics(metrics, thresholds);

        if (classification === CLASSIFICATION.DEPRECATED) {
          emit('skill:deprecated', { skillName: name, metrics });
        }

        results.set(name, Object.freeze({ metrics, classification }));
      }
      return results;
    },

    /**
     * Get a copy of the internal records (for persistence/testing).
     *
     * @returns {Map<string, Array>}
     */
    getRecords() {
      return new Map(records);
    },
  };
}
