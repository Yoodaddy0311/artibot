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

// --- Ambiguity type classification and clarifying question generation ---

/**
 * Ambiguity type enum values.
 * @readonly
 */
export const AmbiguityType = Object.freeze({
  VAGUE: 'vague',
  UNKNOWN: 'unknown',
  METAMEDIUM: 'metamedium',
});

/**
 * Signal patterns for each ambiguity type.
 * @type {Record<string, { patterns: RegExp[], keywords: string[] }>}
 */
const AMBIGUITY_SIGNALS = {
  [AmbiguityType.VAGUE]: {
    patterns: [
      /^(?:the|a|an)\s+\S+$/i,
      /(?:do\s+something|somehow|some\s+way)\b/i,
      /(?:maybe|perhaps|possibly|might|could)\s+(?:we|you|i)\b/i,
      /(?:look\s+at|look\s+into|check\s+out)\b/i,
      /^(?:improve|enhance|update|change|modify)\s+(?:the\s+)?(?:app|code|project|system|it)$/i,
    ],
    keywords: [
      'something', 'somehow', 'stuff', 'things', 'whatever',
      'maybe', 'perhaps', 'kind of', 'sort of',
      '뭔가', '좀', '어떻게든', '그거', '이것저것',
    ],
  },
  [AmbiguityType.UNKNOWN]: {
    patterns: [
      /(?:add|create|implement|fix|update)\s+\S+$/i,
      /(?:make\s+it)\s+\w+(?:er)?$/i,
      /(?:should\s+work|work\s+better|be\s+good)\b/i,
    ],
    keywords: [
      'validation', 'error handling', 'faster', 'better', 'properly',
      'the bug', 'the issue', 'the problem', 'that thing',
      '검증', '에러', '더 빠르게', '더 좋게', '제대로', '그 버그',
    ],
  },
  [AmbiguityType.METAMEDIUM]: {
    patterns: [
      /(?:add|implement|build|create|set\s+up)\s+(?:\w+\s+)?(?:authentication|auth|integration|api|system|module|service|layer)\b/i,
      /(?:refactor|redesign|rewrite|overhaul)\s+(?:the\s+)?(?:\w+\s+)?(?:layer|module|system|architecture)\b/i,
      /(?:integrate\s+with|connect\s+to|hook\s+up)\s+\S+/i,
      /(?:update|upgrade|migrate)\s+(?:the\s+)?(?:api|database|framework|dependency|dependencies)\b/i,
    ],
    keywords: [
      'authentication', 'integration', 'api', 'database layer',
      'full stack', 'end to end', 'complete', 'entire',
      '인증', '통합', '전체', '풀스택', '데이터베이스',
    ],
  },
};

/**
 * Classify the ambiguity type of user input text.
 * Returns one or more types ranked by confidence.
 * @param {string} text - User's input text
 * @returns {{ type: string, confidence: number }[]}
 *   Array sorted by confidence descending. Each entry has:
 *   - type: 'vague' | 'unknown' | 'metamedium'
 *   - confidence: 0-100 score
 * @example
 * classifyAmbiguityType('improve the app');
 * // [{ type: 'vague', confidence: 80 }]
 *
 * classifyAmbiguityType('add authentication');
 * // [{ type: 'metamedium', confidence: 70 }, { type: 'unknown', confidence: 40 }]
 */
export function classifyAmbiguityType(text) {
  const lower = text.toLowerCase();
  const results = [];

  for (const [type, signals] of Object.entries(AMBIGUITY_SIGNALS)) {
    let score = 0;

    // Pattern matches (weighted higher)
    for (const pattern of signals.patterns) {
      if (pattern.test(text)) {
        score += 30;
      }
    }

    // Keyword matches
    for (const kw of signals.keywords) {
      if (lower.includes(kw.toLowerCase())) {
        score += 15;
      }
    }

    // Short input bonus for vague (< 5 words likely vague)
    if (type === AmbiguityType.VAGUE) {
      const wordCount = text.trim().split(/\s+/).length;
      if (wordCount <= 4) score += 20;
    }

    // Long input with scope keywords bonus for metamedium
    if (type === AmbiguityType.METAMEDIUM) {
      const wordCount = text.trim().split(/\s+/).length;
      if (wordCount >= 3 && score > 0) score += 10;
    }

    if (score > 0) {
      results.push({ type, confidence: Math.min(100, score) });
    }
  }

  // Sort by confidence descending
  results.sort((a, b) => b.confidence - a.confidence);

  // If nothing matched, default to vague with low confidence
  if (results.length === 0) {
    results.push({ type: AmbiguityType.VAGUE, confidence: 20 });
  }

  return results;
}

/**
 * Question templates for each ambiguity type.
 * @type {Record<string, { intro: string, format: string, questions: string[] }>}
 */
const QUESTION_TEMPLATES = {
  [AmbiguityType.VAGUE]: {
    intro: 'Your request could mean several things. Which is closest?',
    format: 'mcq',
    questions: [
      'What specific outcome do you want? (A) {hyp_a} (B) {hyp_b} (C) Something else',
      'What action should be taken? (A) Create new (B) Modify existing (C) Fix broken (D) Remove/clean up',
      'What is the primary goal? (A) Add functionality (B) Improve quality (C) Fix a problem (D) Learn/understand',
    ],
  },
  [AmbiguityType.UNKNOWN]: {
    intro: 'I need a few details to proceed:',
    format: 'targeted',
    questions: [
      'Which file, module, or component is this about?',
      'What is the specific problem or desired behavior?',
      'Are there constraints? (performance target, compatibility, deadline)',
      'What does "done" look like? How will we verify success?',
      'Are there related files or tests to consider?',
    ],
  },
  [AmbiguityType.METAMEDIUM]: {
    intro: 'This could range from minimal to comprehensive. Which scope fits?',
    format: 'tier',
    questions: [
      'Scope tier: (A) Minimal - bare essentials only (B) Standard - typical implementation (C) Comprehensive - full-featured with edge cases',
      'Should this include tests? (A) No tests needed (B) Unit tests (C) Unit + integration tests',
      'Breaking changes acceptable? (A) Must be backward compatible (B) Breaking changes OK (C) Full rewrite acceptable',
    ],
  },
};

/**
 * Generate clarifying questions for a given input text and ambiguity type.
 * Questions are hypothesis-based MCQ format to minimize user effort.
 * @param {string} text - User's original input text
 * @param {string} [type] - Ambiguity type override. If omitted, auto-classified.
 * @param {object} [options]
 * @param {number} [options.maxQuestions=5] - Maximum questions to return (1-8)
 * @returns {{
 *   type: string,
 *   confidence: number,
 *   intro: string,
 *   questions: string[],
 *   format: string,
 *   original: string
 * }}
 * @example
 * generateClarifyingQuestions('improve the app');
 * // {
 * //   type: 'vague',
 * //   confidence: 80,
 * //   intro: 'Your request could mean several things...',
 * //   questions: ['What specific outcome...', 'What action...'],
 * //   format: 'mcq',
 * //   original: 'improve the app'
 * // }
 */
export function generateClarifyingQuestions(text, type, options = {}) {
  const maxQuestions = Math.max(1, Math.min(8, options.maxQuestions ?? 5));

  // Auto-classify if type not provided
  const classifications = classifyAmbiguityType(text);
  const resolvedType = type ?? classifications[0].type;
  const confidence = classifications.find((c) => c.type === resolvedType)?.confidence
    ?? classifications[0].confidence;

  const template = QUESTION_TEMPLATES[resolvedType] ?? QUESTION_TEMPLATES[AmbiguityType.VAGUE];

  // Select questions up to maxQuestions
  const questions = template.questions.slice(0, maxQuestions);

  return {
    type: resolvedType,
    confidence,
    intro: template.intro,
    questions,
    format: template.format,
    original: text,
  };
}
