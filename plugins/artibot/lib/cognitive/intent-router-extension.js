/**
 * Intent Router Extension (v4.11.0 Track I).
 *
 * Non-invasive bridge between the existing System 1/2 router (router.js) and
 * the new autopilot-intent detector. Does NOT modify router.js — returns a
 * new classification object with the `autopilotIntents` field appended.
 *
 * Pure functions: no I/O, no module state, no side effects.
 *
 * Flow:
 *   const baseCls = classifyComplexity(prompt)
 *   const ext = extendClassification(baseCls, prompt)
 *   const triggers = shouldAutoTrigger(ext.autopilotIntents)
 *
 * @module lib/cognitive/intent-router-extension
 */

import { detectAllIntents } from './autopilot-intent.js';

/** Default confidence gate above which auto-trigger fires. */
export const DEFAULT_TRIGGER_THRESHOLD = 0.7;

/** Recognised feature names corresponding to intent keys. */
export const AUTOPILOT_FEATURES = Object.freeze([
  'queue',
  'schedule',
  'dryRun',
  'template',
  'rollback',
]);

/**
 * Append the autopilot intent map to an existing router classification.
 * Pure: produces a NEW object (immutable pattern).
 *
 * @param {object} baseClassification - Output of router.classifyComplexity().
 * @param {string} prompt - Raw user prompt.
 * @returns {object} `{ ...baseClassification, autopilotIntents }`.
 */
export function extendClassification(baseClassification, prompt) {
  const base = baseClassification && typeof baseClassification === 'object'
    ? baseClassification
    : {};
  const autopilotIntents = detectAllIntents(typeof prompt === 'string' ? prompt : '');
  return { ...base, autopilotIntents };
}

/**
 * Decide which autopilot features should auto-trigger based on confidence.
 *
 * @param {ReturnType<typeof detectAllIntents>} intents - Output of detectAllIntents().
 * @param {{ threshold?: number, only?: string[] }} [opts]
 *   - threshold: minimum confidence (default 0.7).
 *   - only: optional allow-list of feature names to consider.
 * @returns {string[]} Feature names meeting the threshold (sorted by confidence desc).
 */
export function shouldAutoTrigger(intents, opts = {}) {
  if (!intents || typeof intents !== 'object') return [];
  const threshold = typeof opts.threshold === 'number'
    ? Math.max(0, Math.min(1, opts.threshold))
    : DEFAULT_TRIGGER_THRESHOLD;
  const allow = Array.isArray(opts.only) && opts.only.length > 0
    ? new Set(opts.only)
    : null;

  const scored = [];
  for (const name of AUTOPILOT_FEATURES) {
    if (allow && !allow.has(name)) continue;
    const slot = intents[name];
    if (!slot || !slot.found) continue;
    if (typeof slot.confidence !== 'number') continue;
    if (slot.confidence < threshold) continue;
    scored.push([name, slot.confidence]);
  }

  scored.sort((a, b) => b[1] - a[1]);
  return scored.map(([name]) => name);
}

/**
 * Return the highest-confidence triggered feature, or null when none met
 * the threshold. Useful for callers that only act on a single dominant intent.
 *
 * @param {ReturnType<typeof detectAllIntents>} intents
 * @param {{ threshold?: number }} [opts]
 * @returns {string|null}
 */
export function dominantIntent(intents, opts = {}) {
  const triggered = shouldAutoTrigger(intents, opts);
  return triggered.length > 0 ? triggered[0] : null;
}
