/**
 * Voyager Skill Auto-Promotion.
 * Records successful task patterns and promotes them to SKILL.md drafts
 * when they reach sufficient confidence and repetition thresholds.
 *
 * Inspired by Voyager's skill library: agents that solve tasks repeatedly
 * crystallize their solutions into reusable skills.
 *
 * Zero runtime deps. ESM only.
 * @module lib/learning/skill-promoter
 */

import { emit } from '../core/event-bus.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MIN_SUCCESS = 3;
const DEFAULT_MIN_CONFIDENCE = 0.8;
const MAX_PATTERNS = 500;

// ---------------------------------------------------------------------------
// Pure helpers — pattern store (immutable updates)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SuccessPattern
 * @property {string} trigger - What activated this pattern (intent/command)
 * @property {string} context - Surrounding context description
 * @property {string[]} tools - Tools used in the solution
 * @property {string} outcome - Outcome description
 */

/**
 * @typedef {object} PatternRecord
 * @property {string} key - Unique pattern key
 * @property {SuccessPattern} pattern
 * @property {number} count
 * @property {number} confidence - 0.0 to 1.0
 * @property {string} firstSeen - ISO timestamp
 * @property {string} lastSeen - ISO timestamp
 */

/**
 * Generate a stable key from a success pattern.
 *
 * @param {SuccessPattern} pattern
 * @returns {string}
 */
function patternKey(pattern) {
  const trigger = (pattern.trigger || '').toLowerCase().trim();
  const toolsSorted = [...(pattern.tools || [])].sort().join(',');
  return `${trigger}::${toolsSorted}`;
}

/**
 * Record a success, returning a new store (immutable).
 *
 * @param {Map<string, PatternRecord>} store
 * @param {SuccessPattern} pattern
 * @param {number} confidence
 * @param {string} timestamp
 * @returns {Map<string, PatternRecord>}
 */
function recordInStore(store, pattern, confidence, timestamp) {
  const key = patternKey(pattern);
  const prev = store.get(key);
  const updated = new Map(store);

  if (prev) {
    updated.set(key, {
      ...prev,
      count: prev.count + 1,
      confidence: weightedConfidence(prev.confidence, prev.count, confidence),
      lastSeen: timestamp,
    });
  } else {
    updated.set(key, {
      key,
      pattern: Object.freeze({ ...pattern }),
      count: 1,
      confidence,
      firstSeen: timestamp,
      lastSeen: timestamp,
    });
  }

  return trimStore(updated, MAX_PATTERNS);
}

/**
 * Weighted running average for confidence.
 *
 * @param {number} prevConf
 * @param {number} prevCount
 * @param {number} newConf
 * @returns {number}
 */
function weightedConfidence(prevConf, prevCount, newConf) {
  const total = prevCount + 1;
  return Math.round(((prevConf * prevCount + newConf) / total) * 1000) / 1000;
}

/**
 * Trim store to maxSize by removing oldest entries.
 *
 * @param {Map<string, PatternRecord>} store
 * @param {number} maxSize
 * @returns {Map<string, PatternRecord>}
 */
function trimStore(store, maxSize) {
  if (store.size <= maxSize) return store;

  const sorted = [...store.entries()].sort(
    (a, b) => new Date(a[1].lastSeen).getTime() - new Date(b[1].lastSeen).getTime(),
  );
  const trimmed = new Map(sorted.slice(sorted.length - maxSize));
  return trimmed;
}

// ---------------------------------------------------------------------------
// Candidate identification
// ---------------------------------------------------------------------------

/**
 * Find patterns that meet promotion thresholds.
 *
 * @param {Map<string, PatternRecord>} store
 * @param {number} minCount
 * @param {number} minConf
 * @param {Set<string>} existingTriggers - Triggers of existing skills
 * @returns {PatternRecord[]}
 */
function findCandidates(store, minCount, minConf, existingTriggers) {
  const candidates = [];
  for (const record of store.values()) {
    if (record.count < minCount) continue;
    if (record.confidence < minConf) continue;
    if (isDuplicate(record, existingTriggers)) continue;
    candidates.push(record);
  }
  return candidates.sort((a, b) => b.count - a.count);
}

/**
 * Check if a pattern's trigger overlaps with existing skills.
 *
 * @param {PatternRecord} record
 * @param {Set<string>} existingTriggers
 * @returns {boolean}
 */
function isDuplicate(record, existingTriggers) {
  const trigger = record.pattern.trigger?.toLowerCase().trim() || '';
  if (!trigger) return false;
  return existingTriggers.has(trigger);
}

// ---------------------------------------------------------------------------
// SKILL.md draft generation
// ---------------------------------------------------------------------------

/**
 * Convert a trigger string to a kebab-case slug.
 *
 * @param {string} trigger
 * @returns {string}
 */
function toSlug(trigger) {
  return trigger
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'auto-skill';
}

/**
 * Generate a SKILL.md draft from a promotion candidate.
 *
 * @param {PatternRecord} candidate
 * @returns {{ content: string, suggestedPath: string, slug: string }}
 */
function generateDraft(candidate) {
  const { pattern, count, confidence } = candidate;
  const slug = toSlug(pattern.trigger);
  const triggers = [pattern.trigger, ...(pattern.tools || [])];
  const triggerList = triggers.map((t) => `  - "${t}"`).join('\n');

  const content = [
    '---',
    'context: fork',
    `name: ${slug}`,
    'description: |',
    `  Auto-promoted skill from ${count}x successful pattern (confidence ${confidence}).`,
    `  Auto-activates when: ${pattern.trigger}.`,
    `  Triggers: ${triggers.join(', ')}`,
    'platforms: [claude-code]',
    'level: 1',
    'triggers:',
    triggerList,
    '---',
    '',
    `# ${pattern.trigger}`,
    '',
    '## When This Skill Applies',
    '',
    `- ${pattern.context || 'Auto-detected pattern from repeated successful outcomes'}`,
    `- Confidence: ${confidence} (from ${count} successful executions)`,
    '',
    '## Core Guidance',
    '',
    '### Recommended Tools',
    '',
    (pattern.tools || []).map((t) => `- \`${t}\``).join('\n') || '- (none recorded)',
    '',
    '### Expected Outcome',
    '',
    pattern.outcome || 'Successfully resolved task matching this pattern.',
    '',
    '## Quick Reference',
    '',
    '| Item | Value |',
    '|------|-------|',
    `| Trigger | ${pattern.trigger} |`,
    `| Tools | ${(pattern.tools || []).join(', ') || 'N/A'} |`,
    `| Success Count | ${count} |`,
    `| Confidence | ${confidence} |`,
    `| First Seen | ${candidate.firstSeen} |`,
    `| Last Seen | ${candidate.lastSeen} |`,
    '',
  ].join('\n');

  return {
    content,
    suggestedPath: `skills/${slug}/SKILL.md`,
    slug,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a skill promoter instance.
 *
 * @param {object} [config]
 * @param {number} [config.minSuccessCount=3]
 * @param {number} [config.minConfidence=0.8]
 * @param {Set<string>} [config.existingTriggers] - Known skill triggers for dedup
 * @param {() => number} [config.now]
 * @returns {{
 *   recordSuccess: (pattern: SuccessPattern, confidence?: number) => void,
 *   identifyPromotionCandidates: () => PatternRecord[],
 *   generateSkillDraft: (candidate: PatternRecord) => { content: string, suggestedPath: string, slug: string },
 *   promoteToSkill: (candidate: PatternRecord) => { content: string, suggestedPath: string, slug: string },
 *   getPromotionStats: () => { totalPatterns: number, candidates: number, promoted: number },
 *   getStore: () => Map<string, PatternRecord>,
 * }}
 */
export function createSkillPromoter(config = {}) {
  const minSuccessCount = config.minSuccessCount ?? DEFAULT_MIN_SUCCESS;
  const minConfidence = config.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const existingTriggers = config.existingTriggers ?? new Set();
  const now = config.now ?? Date.now;

  let store = new Map();
  let promotedCount = 0;

  return {
    recordSuccess(pattern, confidence = 1.0) {
      const ts = new Date(now()).toISOString();
      store = recordInStore(store, pattern, confidence, ts);
    },

    identifyPromotionCandidates() {
      return findCandidates(store, minSuccessCount, minConfidence, existingTriggers);
    },

    generateSkillDraft(candidate) {
      return generateDraft(candidate);
    },

    promoteToSkill(candidate) {
      const draft = generateDraft(candidate);
      promotedCount += 1;
      emit('skill:promoted', {
        detail: `${candidate.pattern.trigger} (${candidate.count}x, conf ${candidate.confidence})`,
        candidate: { key: candidate.key, trigger: candidate.pattern.trigger },
        draft: { suggestedPath: draft.suggestedPath, slug: draft.slug },
      });
      return draft;
    },

    getPromotionStats() {
      const candidates = findCandidates(store, minSuccessCount, minConfidence, existingTriggers);
      return {
        totalPatterns: store.size,
        candidates: candidates.length,
        promoted: promotedCount,
      };
    },

    getStore() {
      return new Map(store);
    },
  };
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  patternKey as _patternKey,
  recordInStore as _recordInStore,
  weightedConfidence as _weightedConfidence,
  findCandidates as _findCandidates,
  isDuplicate as _isDuplicate,
  generateDraft as _generateDraft,
  toSlug as _toSlug,
  trimStore as _trimStore,
};
