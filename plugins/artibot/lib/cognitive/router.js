/**
 * System 1/2 Cognitive Router.
 * Routes user input to fast-intuitive (System 1) or deep-reasoning (System 2)
 * processing based on multi-factor complexity classification.
 *
 * Inspired by Kahneman's dual-process theory:
 *   - System 1: Fast, automatic, intuitive (< 100ms target)
 *   - System 2: Slow, deliberate, analytical (quality-first, no time limit)
 *
 * @module lib/cognitive/router
 */

import { round as _coreRound } from '../core/index.js';

// Router uses 2 decimal precision for display values
const round = (n) => _coreRound(n, 2);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default threshold dividing System 1 / System 2 */
const DEFAULT_THRESHOLD = 0.4;

/** Bounds for adaptive threshold adjustment */
const THRESHOLD_MIN = 0.2;
const THRESHOLD_MAX = 0.7;

/** How much a single feedback event shifts the threshold (configurable via configure()) */
let adaptStep = 0.05;

/** Maximum routing history entries kept for statistics */
const MAX_HISTORY = 500;

/** Consecutive System 1 successes before threshold nudges up */
const SUCCESS_STREAK_TRIGGER = 5;

/**
 * Complexity signal weights (sum = 1.0).
 * @type {Readonly<Record<string, number>>}
 */
const WEIGHTS = Object.freeze({
  steps:        0.25,
  domains:      0.20,
  uncertainty:  0.20,
  risk:         0.20,
  novelty:      0.15,
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configure router parameters from external config (artibot.config.json).
 * Call before routing to sync with plugin configuration.
 *
 * @param {object} [config]
 * @param {number} [config.threshold] - Initial routing threshold (0.2-0.7)
 * @param {number} [config.adaptRate] - Threshold adaptation step size
 */
export function configure(config = {}) {
  if (typeof config.threshold === 'number') {
    threshold = Math.max(THRESHOLD_MIN, Math.min(THRESHOLD_MAX, config.threshold));
  }
  if (typeof config.adaptRate === 'number') {
    adaptStep = Math.max(0.001, Math.min(0.2, config.adaptRate));
  }
}

/**
 * Keyword patterns for domain detection (multi-language).
 * Maps domain names to arrays of lowercase keyword triggers.
 */
const DOMAIN_KEYWORDS = Object.freeze({
  frontend:       ['component', 'ui', 'css', 'react', 'vue', 'responsive', 'accessibility', '컴포넌트', '프론트'],
  backend:        ['api', 'database', 'server', 'endpoint', 'service', 'auth', 'db', '서버', '백엔드', 'データベース'],
  security:       ['security', 'vulnerability', 'threat', 'compliance', 'encrypt', 'xss', 'injection', 'audit', '보안', '취약', '감사', 'セキュリティ', '監査'],
  infrastructure: ['deploy', 'docker', 'ci/cd', 'monitoring', 'k8s', 'terraform', '배포', 'インフラ'],
  testing:        ['test', 'e2e', 'coverage', 'spec', 'jest', 'playwright', '테스트', 'テスト'],
  documentation:  ['document', 'readme', 'docs', 'guide', 'wiki', '문서', 'ドキュメント'],
  design:         ['architecture', 'design', 'pattern', 'scalability', '설계', '아키텍처', 'アーキテクチャ'],
});

/**
 * Keywords indicating high uncertainty / ambiguity.
 */
const UNCERTAINTY_KEYWORDS = [
  'maybe', 'possibly', 'unclear', 'not sure', 'might',
  'could be', 'investigate', 'explore', 'figure out',
  '아마', '불확실', '모르', '조사', '탐색',
  'もしかして', '調べ', '不明',
];

/**
 * Keywords indicating high risk / critical operations.
 */
const RISK_KEYWORDS = [
  'production', 'critical', 'security', 'migration', 'breaking',
  'delete', 'drop', 'remove all', 'force push', 'rollback',
  'audit', 'deploy',
  '운영', '프로덕션', '마이그레이션', '삭제', '중요', '감사', '배포',
  '本番', 'マイグレーション', '削除', 'デプロイ', '監査',
];

/**
 * Step-count indicator patterns.
 * Each entry is [regex, estimated step count].
 * @type {[RegExp, number][]}
 */
const STEP_PATTERNS = [
  [/\b(?:then|after that|next|afterwards|그리고|다음에|그런 다음|それから|次に)\b/gi, 1],
  [/\b(?:step \d|phase \d|단계|フェーズ)\b/gi, 1],
  [/\b(?:first|second|third|fourth|fifth|1\.|2\.|3\.|4\.|5\.)/gi, 1],
  [/\b(?:and also|additionally|furthermore|또한|さらに)\b/gi, 1],
];

// ---------------------------------------------------------------------------
// State (module-scoped, session-lifetime)
// ---------------------------------------------------------------------------

/** @type {number} Current adaptive threshold */
let threshold = DEFAULT_THRESHOLD;

/** @type {{ timestamp: number, input: string, score: number, system: 1|2, confidence: number, durationMs: number, success?: boolean }[]} */
let history = [];

/** @type {number} Consecutive System 1 successes */
let s1SuccessStreak = 0;

// ---------------------------------------------------------------------------
// Complexity Classification
// ---------------------------------------------------------------------------

/**
 * Classify the complexity of an input string.
 *
 * @param {string} input - Raw user input text
 * @param {object} [context] - Optional context from prior routing
 * @param {string[]} [context.recentDomains] - Domains touched recently
 * @param {number} [context.sessionDepth] - How deep into a session (0-based)
 * @param {Record<string, number>} [context.domainSuccessRates] - Per-domain System 1 success rates
 * @returns {{ score: number, system: 1|2, confidence: number, factors: Record<string, number>, threshold: number }}
 */
export function classifyComplexity(input, context = {}) {
  const lower = input.toLowerCase();
  const factors = {
    steps:       estimateSteps(lower),
    domains:     estimateDomains(lower),
    uncertainty: estimateUncertainty(lower),
    risk:        estimateRisk(lower),
    novelty:     estimateNovelty(lower, context),
  };

  const score = Object.entries(WEIGHTS).reduce(
    (sum, [key, weight]) => sum + (factors[key] ?? 0) * weight,
    0,
  );

  const clampedScore = Math.max(0, Math.min(1, score));
  const system = clampedScore < threshold ? 1 : 2;

  // Confidence: higher when score is far from threshold
  const distance = Math.abs(clampedScore - threshold);
  const confidence = Math.min(1, 0.5 + distance * 2);

  return {
    score: round(clampedScore),
    system,
    confidence: round(confidence),
    factors: Object.fromEntries(
      Object.entries(factors).map(([k, v]) => [k, round(v)]),
    ),
    threshold: round(threshold),
  };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Route an input to System 1 or System 2 and record the decision.
 *
 * @param {string} input - Raw user input
 * @param {object} [context] - Routing context (forwarded to classifyComplexity)
 * @returns {{ system: 1|2, classification: ReturnType<typeof classifyComplexity>, metadata: { routedAt: number, historySize: number } }}
 */
export function route(input, context = {}) {
  const start = Date.now();
  const classification = classifyComplexity(input, context);
  const durationMs = Date.now() - start;

  const entry = {
    timestamp: Date.now(),
    input: input.slice(0, 200),
    score: classification.score,
    system: classification.system,
    confidence: classification.confidence,
    durationMs,
  };

  history.push(entry);
  if (history.length > MAX_HISTORY) {
    history = history.slice(-MAX_HISTORY);
  }

  return {
    system: classification.system,
    classification,
    metadata: {
      routedAt: entry.timestamp,
      historySize: history.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Adaptive Threshold
// ---------------------------------------------------------------------------

/**
 * Adjust the routing threshold based on outcome feedback.
 *
 * When System 1 fails (bad outcome), the threshold is lowered so more
 * inputs are routed to System 2. When System 1 succeeds consistently
 * (streak >= SUCCESS_STREAK_TRIGGER), the threshold is raised so more
 * inputs stay in System 1.
 *
 * @param {{ system: 1|2, success: boolean }} feedback
 * @returns {{ previousThreshold: number, newThreshold: number, direction: 'lowered'|'raised'|'unchanged', streak: number }}
 */
export function adaptThreshold(feedback) {
  const prev = threshold;
  let direction = 'unchanged';

  if (feedback.system === 1) {
    if (!feedback.success) {
      // System 1 failure: lower threshold (route more to System 2)
      threshold = Math.max(THRESHOLD_MIN, threshold - adaptStep);
      s1SuccessStreak = 0;
      direction = 'lowered';
    } else {
      s1SuccessStreak++;
      if (s1SuccessStreak >= SUCCESS_STREAK_TRIGGER) {
        // Consecutive successes: raise threshold (trust System 1 more)
        threshold = Math.min(THRESHOLD_MAX, threshold + adaptStep);
        s1SuccessStreak = 0;
        direction = 'raised';
      }
    }
  }

  // Mark the most recent matching history entry
  const recent = findRecentEntry(feedback.system);
  if (recent) {
    recent.success = feedback.success;
  }

  return {
    previousThreshold: round(prev),
    newThreshold: round(threshold),
    direction,
    streak: s1SuccessStreak,
  };
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Retrieve routing statistics for observability and learning.
 *
 * @returns {{
 *   totalRouted: number,
 *   system1Count: number,
 *   system2Count: number,
 *   system1Ratio: number,
 *   avgScore: number,
 *   avgConfidence: number,
 *   avgDurationMs: number,
 *   currentThreshold: number,
 *   successRate: { system1: number, system2: number },
 *   recentTrend: 'stable'|'shifting_to_s2'|'shifting_to_s1',
 * }}
 */
export function getRoutingStats() {
  const total = history.length;
  if (total === 0) {
    return {
      totalRouted: 0,
      system1Count: 0,
      system2Count: 0,
      system1Ratio: 0,
      avgScore: 0,
      avgConfidence: 0,
      avgDurationMs: 0,
      currentThreshold: round(threshold),
      successRate: { system1: 0, system2: 0 },
      recentTrend: 'stable',
    };
  }

  const s1 = history.filter((h) => h.system === 1);
  const s2 = history.filter((h) => h.system === 2);

  const avgScore = history.reduce((s, h) => s + h.score, 0) / total;
  const avgConf = history.reduce((s, h) => s + h.confidence, 0) / total;
  const avgDur = history.reduce((s, h) => s + h.durationMs, 0) / total;

  const s1WithFeedback = s1.filter((h) => h.success !== undefined);
  const s2WithFeedback = s2.filter((h) => h.success !== undefined);

  const s1SuccessRate = s1WithFeedback.length > 0
    ? s1WithFeedback.filter((h) => h.success).length / s1WithFeedback.length
    : 0;
  const s2SuccessRate = s2WithFeedback.length > 0
    ? s2WithFeedback.filter((h) => h.success).length / s2WithFeedback.length
    : 0;

  // Trend detection: compare last 20% to first 80%
  const recentTrend = detectTrend(history);

  return {
    totalRouted: total,
    system1Count: s1.length,
    system2Count: s2.length,
    system1Ratio: round(s1.length / total),
    avgScore: round(avgScore),
    avgConfidence: round(avgConf),
    avgDurationMs: round(avgDur),
    currentThreshold: round(threshold),
    successRate: {
      system1: round(s1SuccessRate),
      system2: round(s2SuccessRate),
    },
    recentTrend,
  };
}

// ---------------------------------------------------------------------------
// Reset (for testing / session boundaries)
// ---------------------------------------------------------------------------

/**
 * Reset all router state to defaults.
 * Intended for testing or session teardown.
 */
export function resetRouter() {
  threshold = DEFAULT_THRESHOLD;
  history = [];
  s1SuccessStreak = 0;
}

/**
 * Get the current adaptive threshold value.
 * @returns {number}
 */
export function getThreshold() {
  return round(threshold);
}

// ---------------------------------------------------------------------------
// Internal: Factor Estimators
// ---------------------------------------------------------------------------

/**
 * Estimate number of steps in the input (0.0 - 1.0).
 * @param {string} lower - Lowercased input
 * @returns {number}
 */
function estimateSteps(lower) {
  let stepCount = 1; // at least one step

  for (const [pattern] of STEP_PATTERNS) {
    const matches = lower.match(pattern);
    if (matches) {
      stepCount += matches.length;
    }
  }

  // Comma-separated verb phrases signal multiple tasks
  const commaSegments = lower.split(/,\s*/).filter((s) => s.trim().length > 3);
  if (commaSegments.length > 1) {
    stepCount += commaSegments.length - 1;
  }

  // "and" / "with" conjunctions connecting distinct actions
  const conjunctions = lower.match(/(?:\b(?:and\s+(?:also\s+)?(?:then\s+)?|with\s+)\b|하고\s*|해서\s*|그리고\s*|까지|と\s*|して)/gi);
  if (conjunctions) {
    stepCount += conjunctions.length;
  }

  // Sentence count as fallback signal
  const sentences = lower.split(/[.!?;]\s+/).filter((s) => s.trim().length > 3);
  if (sentences.length > 2) {
    stepCount += Math.floor(sentences.length / 2);
  }

  // Input length as a soft signal (long inputs tend to be multi-step)
  if (lower.length > 150) stepCount += 1;
  if (lower.length > 300) stepCount += 1;

  // Normalize: 1 step = 0.0, 2 steps = 0.2, 4+ steps = 0.6+
  return Math.min(1, (stepCount - 1) * 0.2);
}

/**
 * Estimate number of distinct domains mentioned (0.0 - 1.0).
 * @param {string} lower - Lowercased input
 * @returns {number}
 */
function estimateDomains(lower) {
  let domainCount = 0;

  for (const keywords of Object.values(DOMAIN_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      domainCount++;
    }
  }

  // Normalize: 0 = 0.0, 1 = 0.2, 2 = 0.5, 3 = 0.75, 4+ = 0.9+
  if (domainCount === 0) return 0;
  if (domainCount === 1) return 0.2;
  return Math.min(1, 0.25 + domainCount * 0.25);
}

/**
 * Estimate uncertainty level in the input (0.0 - 1.0).
 * @param {string} lower - Lowercased input
 * @returns {number}
 */
function estimateUncertainty(lower) {
  let matchCount = 0;

  for (const kw of UNCERTAINTY_KEYWORDS) {
    if (lower.includes(kw)) {
      matchCount++;
    }
  }

  // Question marks also signal uncertainty
  const questionMarks = (lower.match(/\?/g) || []).length;
  matchCount += Math.min(2, questionMarks);

  return Math.min(1, matchCount * 0.25);
}

/**
 * Estimate risk level of the requested operation (0.0 - 1.0).
 * @param {string} lower - Lowercased input
 * @returns {number}
 */
function estimateRisk(lower) {
  let riskSignals = 0;

  for (const kw of RISK_KEYWORDS) {
    if (lower.includes(kw)) {
      riskSignals++;
    }
  }

  return Math.min(1, riskSignals * 0.3);
}

/**
 * Estimate novelty based on how different this input is from recent context (0.0 - 1.0).
 * @param {string} lower - Lowercased input
 * @param {object} context - Routing context
 * @returns {number}
 */
function estimateNovelty(lower, context) {
  let novelty = 0;

  // If no session context, moderate novelty
  if (!context.sessionDepth && context.sessionDepth !== 0) {
    return 0.3;
  }

  // First request in a session is somewhat novel
  if (context.sessionDepth === 0) {
    novelty += 0.4;
  }

  // Domain not seen recently
  if (context.recentDomains && context.recentDomains.length > 0) {
    const currentDomains = Object.entries(DOMAIN_KEYWORDS)
      .filter(([, keywords]) => keywords.some((kw) => lower.includes(kw)))
      .map(([domain]) => domain);

    const newDomains = currentDomains.filter(
      (d) => !context.recentDomains.includes(d),
    );
    if (newDomains.length > 0) {
      novelty += 0.3;
    }
  }

  // Low historical success rate in this domain → treat as more novel/risky
  if (context.domainSuccessRates) {
    const currentDomains = Object.entries(DOMAIN_KEYWORDS)
      .filter(([, keywords]) => keywords.some((kw) => lower.includes(kw)))
      .map(([domain]) => domain);

    for (const domain of currentDomains) {
      const rate = context.domainSuccessRates[domain];
      if (rate !== undefined && rate < 0.5) {
        novelty += 0.2;
      }
    }
  }

  return Math.min(1, novelty);
}

// ---------------------------------------------------------------------------
// Internal: Helpers
// ---------------------------------------------------------------------------

/**
 * Find the most recent history entry for a given system.
 * @param {1|2} system
 * @returns {object|undefined}
 */
function findRecentEntry(system) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].system === system && history[i].success === undefined) {
      return history[i];
    }
  }
  return undefined;
}

/**
 * Detect whether routing is trending towards System 1 or System 2.
 * @param {{ system: 1|2 }[]} entries
 * @returns {'stable'|'shifting_to_s2'|'shifting_to_s1'}
 */
function detectTrend(entries) {
  if (entries.length < 10) return 'stable';

  const splitPoint = Math.floor(entries.length * 0.8);
  const earlier = entries.slice(0, splitPoint);
  const recent = entries.slice(splitPoint);

  const earlyS1Ratio = earlier.filter((e) => e.system === 1).length / earlier.length;
  const recentS1Ratio = recent.filter((e) => e.system === 1).length / recent.length;

  const diff = recentS1Ratio - earlyS1Ratio;
  if (diff > 0.15) return 'shifting_to_s1';
  if (diff < -0.15) return 'shifting_to_s2';
  return 'stable';
}
