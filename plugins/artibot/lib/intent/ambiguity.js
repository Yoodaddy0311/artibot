/**
 * Ambiguity detection and clarification question generation.
 * @module lib/intent/ambiguity
 */

/**
 * Detect ambiguity when multiple intents are found.
 * @param {string[]} intents - Unique intent strings
 * @param {number} [threshold=50] - Ambiguity threshold (0-100).
 *   Lower threshold = more likely to flag ambiguity.
 * @returns {{ ambiguous: boolean, score: number, clarification: string|null }}
 */
export function detectAmbiguity(intents, threshold = 50) {
  if (intents.length <= 1) {
    return { ambiguous: false, score: 0, clarification: null };
  }

  // Group by category (team vs action)
  const categories = new Set(intents.map((i) => i.split(':')[0]));
  const actionTypes = intents.filter((i) => i.startsWith('action:')).map((i) => i.split(':')[1]);

  // Similar intents (e.g., build + implement) are less ambiguous
  const similarPairs = [
    ['build', 'implement'],
    ['review', 'analyze'],
    ['fix', 'refactor'],
    ['document', 'explain'],
    ['plan', 'design'],
  ];

  let similarity = 0;
  for (const [a, b] of similarPairs) {
    if (actionTypes.includes(a) && actionTypes.includes(b)) {
      similarity += 20;
    }
  }

  // Score: higher = more ambiguous
  const baseScore = Math.min(100, intents.length * 25);
  const categoryPenalty = categories.size > 1 ? 20 : 0;
  const score = Math.max(0, baseScore + categoryPenalty - similarity);
  const ambiguous = score >= threshold;

  const clarification = ambiguous ? generateClarification(intents) : null;

  return { ambiguous, score, clarification };
}

/**
 * Generate a clarification question based on detected intents.
 * @param {string[]} intents
 * @returns {string}
 */
function generateClarification(intents) {
  const descriptions = intents.map(intentToLabel).filter(Boolean);

  if (descriptions.length === 0) {
    return 'Could you clarify what you would like to do?';
  }

  if (descriptions.length === 2) {
    return `Did you mean to ${descriptions[0]} or ${descriptions[1]}?`;
  }

  const last = descriptions.pop();
  return `Did you mean to ${descriptions.join(', ')}, or ${last}?`;
}

/**
 * Convert an intent string to a human-readable label.
 */
function intentToLabel(intent) {
  const labels = {
    'team:summon': 'summon a team',
    'action:build': 'build something',
    'action:implement': 'implement a feature',
    'action:review': 'review code',
    'action:test': 'run tests',
    'action:fix': 'fix a bug',
    'action:refactor': 'refactor code',
    'action:deploy': 'deploy',
    'action:document': 'write documentation',
    'action:analyze': 'analyze code',
    'action:explain': 'get an explanation',
    'action:design': 'design a system',
    'action:plan': 'create a plan',
  };
  return labels[intent] ?? null;
}
