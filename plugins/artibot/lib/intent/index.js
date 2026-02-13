/**
 * Intent detection engine entry point.
 * @module lib/intent
 */

import { matchKeywords, uniqueIntents } from './language.js';
import { getRecommendations, getBestRecommendation } from './trigger.js';
import { detectAmbiguity } from './ambiguity.js';

/**
 * Detect user intent from text input.
 * @param {string} text - User's prompt text
 * @param {object} [options]
 * @param {string[]} [options.languages] - Languages to scan
 * @param {number} [options.ambiguityThreshold] - Ambiguity threshold (0-100)
 * @returns {{
 *   intents: string[],
 *   matches: { intent: string, keyword: string, lang: string }[],
 *   recommendations: { intent: string, type: string, description: string, agents: string[], commands: string[] }[],
 *   best: { intent: string, type: string, description: string, agents: string[], commands: string[] }|null,
 *   ambiguity: { ambiguous: boolean, score: number, clarification: string|null }
 * }}
 */
export function detectIntent(text, options = {}) {
  const { languages, ambiguityThreshold = 50 } = options;

  const matches = matchKeywords(text, languages);
  const intents = uniqueIntents(matches);
  const recommendations = getRecommendations(intents);
  const best = getBestRecommendation(intents);
  const ambiguity = detectAmbiguity(intents, ambiguityThreshold);

  return { intents, matches, recommendations, best, ambiguity };
}

export { matchKeywords, uniqueIntents } from './language.js';
export { getRecommendations, getBestRecommendation } from './trigger.js';
export { detectAmbiguity } from './ambiguity.js';
