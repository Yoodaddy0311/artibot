/**
 * Conversation-to-Memory Rule Extractor.
 * Parses user messages to extract explicit rules, preferences, prohibitions,
 * and decisions expressed in Korean and English.
 *
 * Extracted rules are normalized to a canonical format for storage in the
 * memory-manager and injection into relevant skills.
 *
 * @module lib/learning/rule-extractor
 */

// ---------------------------------------------------------------------------
// Rule Pattern Definitions
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} RulePattern
 * @property {string} type - Rule type: 'preference' | 'prohibition' | 'decision' | 'tool-preference'
 * @property {string} lang - Language hint: 'ko' | 'en' | 'any'
 * @property {RegExp} pattern - Regex to match the rule in a message
 * @property {number} confidence - Base confidence score (0-1)
 * @property {function(string[]): string} extract - Extract the rule content from match groups
 */

/**
 * Canonical rule patterns for Korean and English.
 * Each pattern captures the key phrase expressing a rule.
 */
export const RULE_PATTERNS = [
  // -------------------------------------------------------------------------
  // Korean patterns
  // -------------------------------------------------------------------------

  // 항상 ~해라 / 항상 ~하세요 / 항상 ~할 것 → preference
  {
    type: 'preference',
    lang: 'ko',
    pattern: /항상\s+(.+?)(?:해라|하세요|할\s*것|하도록|해주세요|하기)[.\s]*$/im,
    confidence: 0.9,
    extract: (m) => m[1].trim(),
  },
  // ~를/을 사용해 / ~를 사용하세요 → tool-preference
  {
    type: 'tool-preference',
    lang: 'ko',
    pattern: /(.+?)(?:를|을)\s+사용(?:해|하세요|할\s*것|하도록|해주세요)[.\s]*$/im,
    confidence: 0.85,
    extract: (m) => m[1].trim(),
  },
  // ~ 대신 ~를 사용해 → tool-preference
  {
    type: 'tool-preference',
    lang: 'ko',
    pattern: /(.+?)\s+대신\s+(.+?)(?:를|을)?\s+사용(?:해|하세요|할\s*것)[.\s]*$/im,
    confidence: 0.9,
    extract: (m) => `${m[2].trim()} instead of ${m[1].trim()}`,
  },
  // ~하지 마라 / ~하지 마세요 / ~지 마세요 / ~하면 안 돼 → prohibition
  {
    type: 'prohibition',
    lang: 'ko',
    pattern: /(.+?)(?:(?:하)?지\s*마라|(?:하)?지\s*마세요|하면\s*안\s*돼|(?:하)?지\s*말\s*것|절대\s*하지)[.\s]*$/im,
    confidence: 0.9,
    extract: (m) => m[1].trim(),
  },
  // 절대 ~ → prohibition
  {
    type: 'prohibition',
    lang: 'ko',
    pattern: /절대\s+(.+?)(?:하지\s*마|하면\s*안\s*돼|하지\s*말)[.\s]*$/im,
    confidence: 0.85,
    extract: (m) => m[1].trim(),
  },
  // ~로 결정했다 / ~로 결정됐다 / ~로 정했다 → decision
  {
    type: 'decision',
    lang: 'ko',
    pattern: /(.+?)(?:로|으로|을|를)?\s+(?:결정(?:했다|됐다|했습니다|됐습니다)|정했다|정했습니다|채택(?:했다|했습니다))[.\s]*$/im,
    confidence: 0.85,
    extract: (m) => m[1].trim(),
  },
  // ~를 쓰기로 했다 / ~를 쓰기로 결정 → decision
  {
    type: 'decision',
    lang: 'ko',
    pattern: /(.+?)(?:를|을)\s+쓰기로\s+(?:했다|결정|정했다)[.\s]*$/im,
    confidence: 0.85,
    extract: (m) => m[1].trim(),
  },

  // -------------------------------------------------------------------------
  // English patterns
  // -------------------------------------------------------------------------

  // Always use/do ~ → preference
  {
    type: 'preference',
    lang: 'en',
    pattern: /\balways\s+(?:use\s+)?(.+?)(?:\.|$)/im,
    confidence: 0.9,
    extract: (m) => m[1].trim(),
  },
  // Use ~ → tool-preference (must be imperative, sentence-start or after newline)
  {
    type: 'tool-preference',
    lang: 'en',
    pattern: /^use\s+(.+?)(?:\.|$)/im,
    confidence: 0.75,
    extract: (m) => m[1].trim(),
  },
  // Use ~ instead of ~ → tool-preference
  {
    type: 'tool-preference',
    lang: 'en',
    pattern: /\buse\s+(.+?)\s+instead\s+of\s+(.+?)(?:\.|$)/im,
    confidence: 0.9,
    extract: (m) => `${m[1].trim()} instead of ${m[2].trim()}`,
  },
  // Prefer ~ over ~ → tool-preference
  {
    type: 'tool-preference',
    lang: 'en',
    pattern: /\bprefer\s+(.+?)\s+(?:over|to)\s+(.+?)(?:\.|$)/im,
    confidence: 0.9,
    extract: (m) => `${m[1].trim()} over ${m[2].trim()}`,
  },
  // Never ~ / Don't ~ / Do not ~ → prohibition
  {
    type: 'prohibition',
    lang: 'en',
    pattern: /\b(?:never|don'?t|do\s+not|avoid)\s+(.+?)(?:\.|$)/im,
    confidence: 0.9,
    extract: (m) => m[1].trim(),
  },
  // We decided to ~ / We've decided to ~ → decision
  {
    type: 'decision',
    lang: 'en',
    pattern: /\bwe(?:'ve)?\s+decided\s+(?:to\s+)?(?:use\s+)?(.+?)(?:\.|$)/im,
    confidence: 0.85,
    extract: (m) => m[1].trim(),
  },
  // We will use ~ / We're going to use ~ → decision
  {
    type: 'decision',
    lang: 'en',
    pattern: /\bwe(?:'re)?\s+(?:will|going\s+to)\s+(?:use\s+)?(.+?)(?:\.|$)/im,
    confidence: 0.8,
    extract: (m) => m[1].trim(),
  },
  // The decision is to ~ / Decision: ~ → decision
  {
    type: 'decision',
    lang: 'en',
    pattern: /\b(?:the\s+)?decision\s+(?:is\s+to\s+|:\s*)(.+?)(?:\.|$)/im,
    confidence: 0.85,
    extract: (m) => m[1].trim(),
  },
  // Make sure to ~ / Make sure ~ → preference
  {
    type: 'preference',
    lang: 'en',
    pattern: /\bmake\s+sure\s+(?:to\s+)?(.+?)(?:\.|$)/im,
    confidence: 0.8,
    extract: (m) => m[1].trim(),
  },
  // Remember to ~ / Remember that ~ → preference
  {
    type: 'preference',
    lang: 'en',
    pattern: /\bremember\s+(?:to\s+|that\s+)?(.+?)(?:\.|$)/im,
    confidence: 0.75,
    extract: (m) => m[1].trim(),
  },
];

// ---------------------------------------------------------------------------
// Rule Classification
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ExtractedRule
 * @property {string} type - 'preference' | 'prohibition' | 'decision' | 'tool-preference'
 * @property {string} content - The normalized rule content
 * @property {number} confidence - Confidence score 0-1
 * @property {string} source - Always 'conversation'
 * @property {string} lang - Detected language: 'ko' | 'en' | 'any'
 * @property {string} extractedAt - ISO timestamp
 * @property {string} rawMatch - The original matched text
 */

/**
 * Classify a single piece of text against all known rule patterns.
 * Returns the best-matching rule or null if no pattern matches.
 *
 * @param {string} text - A single sentence or clause to classify
 * @returns {ExtractedRule | null}
 */
export function classifyRule(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed.length < 3) return null;

  let best = null;

  for (const ruleDef of RULE_PATTERNS) {
    const match = ruleDef.pattern.exec(trimmed);
    if (!match) continue;

    const content = ruleDef.extract(match);
    if (!content || content.length < 2) continue;

    const candidate = {
      type: ruleDef.type,
      content,
      confidence: ruleDef.confidence,
      source: 'conversation',
      lang: ruleDef.lang,
      extractedAt: new Date().toISOString(),
      rawMatch: match[0].trim(),
    };

    // Keep highest-confidence match
    if (!best || candidate.confidence > best.confidence) {
      best = candidate;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Sentence Splitter
// ---------------------------------------------------------------------------

/**
 * Split a message into individual sentences/clauses for per-sentence matching.
 * Handles Korean sentence endings (다, 요, 죠) and standard English punctuation.
 *
 * @param {string} message
 * @returns {string[]}
 */
function splitSentences(message) {
  // Split on sentence-ending punctuation or Korean sentence endings
  // Also split on newlines (each line may carry a distinct rule)
  return message
    .split(/(?<=[.!?\n])|(?<=다[.\s])|(?<=요[.\s])|(?<=죠[.\s])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract all rules from a user message.
 * Splits the message into sentences/clauses and classifies each one.
 * Deduplicates rules with identical content (keeps highest confidence).
 *
 * @param {string} message - Raw user message text
 * @returns {ExtractedRule[]} Array of extracted rules (may be empty)
 */
export function extractRules(message) {
  if (!message || typeof message !== 'string') return [];

  const sentences = splitSentences(message);
  const seen = new Map(); // content -> ExtractedRule

  for (const sentence of sentences) {
    const rule = classifyRule(sentence);
    if (!rule) continue;

    const key = `${rule.type}::${rule.content.toLowerCase()}`;
    const existing = seen.get(key);
    if (!existing || rule.confidence > existing.confidence) {
      seen.set(key, rule);
    }
  }

  return [...seen.values()].sort((a, b) => b.confidence - a.confidence);
}
