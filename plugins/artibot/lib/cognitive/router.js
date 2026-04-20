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
// Native Effort Level API Integration (extension point)
// ---------------------------------------------------------------------------
// TODO (#30806): When Claude Code exposes a native model/effort level API,
// integrate it here. The expected shape is:
//   { model: string, effortLevel: 'low'|'medium'|'high', reasoning_budget?: number }
//
// Integration plan:
//   1. Accept native effort via configure() or a new setNativeEffort() function
//   2. Map native effort to System 1/2: low->S1, medium->threshold-based, high->S2
//   3. Use native effort as an override signal (highest priority) or blend with
//      heuristic score via a configurable weight (e.g., nativeWeight: 0.6)
//   4. Expose the native effort in route() return metadata for downstream consumers
//
// The current heuristic classification remains the fallback when native API
// is unavailable, ensuring backward compatibility.
// ---------------------------------------------------------------------------

/** @type {{ model?: string, effortLevel?: string, reasoningBudget?: number } | null} */
let nativeEffortHint = null;

/**
 * Set native effort level hint from Claude Code's plugin API.
 * When set, this hint influences routing decisions alongside heuristic scores.
 * Pass null to clear the hint and revert to pure heuristic routing.
 *
 * TODO (#30806): Wire this to the actual API when available.
 *
 * @param {{ model?: string, effortLevel?: 'low'|'medium'|'high', reasoningBudget?: number } | null} hint
 * @returns {void}
 */
export function setNativeEffortHint(hint) {
  nativeEffortHint = hint;
}

/**
 * Get the current native effort hint (if any).
 * @returns {{ model?: string, effortLevel?: string, reasoningBudget?: number } | null}
 */
export function getNativeEffortHint() {
  return nativeEffortHint;
}

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
 * @param {object} [config] - Configuration options.
 * @param {number} [config.threshold] - Initial routing threshold (0.2-0.7).
 * @param {number} [config.adaptRate] - Threshold adaptation step size (0.001-0.2).
 * @returns {void}
 * @example
 * configure({ threshold: 0.5, adaptRate: 0.03 });
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
  frontend:       ['component', 'ui', 'css', 'react', 'vue', 'responsive', 'accessibility', '컴포넌트', '프론트', 'コンポーネント', 'フロントエンド', '组件', '前端', '界面'],
  backend:        ['api', 'database', 'server', 'endpoint', 'service', 'auth', 'db', '서버', '백엔드', 'データベース', 'サーバー', 'バックエンド', '服务器', '后端', '数据库', '接口'],
  security:       ['security', 'vulnerability', 'threat', 'compliance', 'encrypt', 'xss', 'injection', 'audit', '보안', '취약', '감사', 'セキュリティ', '監査', '脆弱性', '安全', '漏洞', '审计', '加密'],
  infrastructure: ['deploy', 'docker', 'ci/cd', 'monitoring', 'k8s', 'terraform', '배포', 'インフラ', 'デプロイ', '部署', '监控', '容器'],
  testing:        ['test', 'e2e', 'coverage', 'spec', 'jest', 'playwright', '테스트', 'テスト', '単体テスト', '测试', '单元测试', '覆盖率'],
  documentation:  ['document', 'readme', 'docs', 'guide', 'wiki', '문서', 'ドキュメント', '文書', '文档', '说明', '指南'],
  design:         ['architecture', 'design', 'pattern', 'scalability', '설계', '아키텍처', 'アーキテクチャ', '設計', '设计', '架构', '模块'],
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
// Circular Buffer
// ---------------------------------------------------------------------------

/**
 * Create a fixed-capacity circular buffer with O(1) push.
 * Entries are stored in a pre-allocated array; a write pointer wraps around
 * when capacity is reached, overwriting the oldest entry.
 *
 * @param {number} maxSize - Maximum number of entries the buffer can hold.
 * @returns {{
 *   push: (entry: T) => void,
 *   get: (index: number) => T | undefined,
 *   updateAt: (index: number, updater: (entry: T) => T) => void,
 *   filter: (predicate: (entry: T) => boolean) => T[],
 *   toArray: () => T[],
 *   clear: () => void,
 *   size: number,
 * }}
 * @template T
 */
function createCircularBuffer(maxSize) {
  const buf = new Array(maxSize);
  let head = 0;   // next write position
  let count = 0;  // current number of entries

  return {
    /** Add an entry in O(1). Overwrites oldest when full. */
    push(entry) {
      buf[head] = entry;
      head = (head + 1) % maxSize;
      if (count < maxSize) count++;
    },

    /** Random access by logical index (0 = oldest). */
    get(index) {
      if (index < 0 || index >= count) return undefined;
      const start = count < maxSize ? 0 : head;
      return buf[(start + index) % maxSize];
    },

    /** Update a single entry at logical index without copying. */
    updateAt(index, updater) {
      if (index < 0 || index >= count) return;
      const start = count < maxSize ? 0 : head;
      const physical = (start + index) % maxSize;
      buf[physical] = updater(buf[physical]);
    },

    /** Return entries matching predicate (oldest first). */
    filter(predicate) {
      const result = [];
      const start = count < maxSize ? 0 : head;
      for (let i = 0; i < count; i++) {
        const entry = buf[(start + i) % maxSize];
        if (predicate(entry)) result.push(entry);
      }
      return result;
    },

    /** Return all entries in insertion order (oldest first). */
    toArray() {
      if (count === 0) return [];
      const start = count < maxSize ? 0 : head;
      const result = new Array(count);
      for (let i = 0; i < count; i++) {
        result[i] = buf[(start + i) % maxSize];
      }
      return result;
    },

    /** Reset to empty state. */
    clear() {
      head = 0;
      count = 0;
    },

    /** Current number of entries. */
    get size() {
      return count;
    },
  };
}

// ---------------------------------------------------------------------------
// State (module-scoped, session-lifetime)
// ---------------------------------------------------------------------------

/** @type {number} Current adaptive threshold */
let threshold = DEFAULT_THRESHOLD;

/** @type {ReturnType<typeof createCircularBuffer>} */
const history = createCircularBuffer(MAX_HISTORY);

/** @type {number} Consecutive System 1 successes */
let s1SuccessStreak = 0;

// ---------------------------------------------------------------------------
// Complexity Classification
// ---------------------------------------------------------------------------

/**
 * Classify the complexity of an input string.
 *
 * @param {string} input - Raw user input text.
 * @param {object} [context] - Optional context from prior routing.
 * @param {string[]} [context.recentDomains] - Domains touched recently.
 * @param {number} [context.sessionDepth] - How deep into a session (0-based).
 * @param {Record<string, number>} [context.domainSuccessRates] - Per-domain System 1 success rates.
 * @returns {{ score: number, system: 1|2, confidence: number, factors: Record<string, number>, threshold: number }}
 *   Classification result with complexity score, target system, confidence, factor breakdown, and current threshold.
 * @example
 * const result = classifyComplexity('implement login feature with OAuth');
 * // { score: 0.45, system: 2, confidence: 0.6, factors: { steps: 0.2, domains: 0.4, ... }, threshold: 0.4 }
 *
 * if (result.system === 1) {
 *   // fast path: sub-agent delegation
 * } else {
 *   // deep path: agent team creation
 * }
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
  let system = clampedScore < threshold ? 1 : 2;

  // TODO (#30806): When native effort API is available, blend or override here.
  // Current behavior: native hint overrides heuristic system assignment.
  let nativeOverride = false;
  if (nativeEffortHint && nativeEffortHint.effortLevel) {
    const level = nativeEffortHint.effortLevel;
    if (level === 'low') { system = 1; nativeOverride = true; }
    else if (level === 'high') { system = 2; nativeOverride = true; }
    // 'medium' defers to heuristic threshold
  }

  // Confidence: higher when score is far from threshold
  const distance = Math.abs(clampedScore - threshold);
  const confidence = Math.min(1, 0.5 + distance * 2);

  return {
    score: round(clampedScore),
    system,
    confidence: round(nativeOverride ? Math.max(confidence, 0.8) : confidence),
    factors: Object.fromEntries(
      Object.entries(factors).map(([k, v]) => [k, round(v)]),
    ),
    threshold: round(threshold),
    nativeEffort: nativeEffortHint ? nativeEffortHint.effortLevel : null,
  };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Route an input to System 1 or System 2 and record the decision.
 *
 * @param {string} input - Raw user input.
 * @param {object} [context] - Routing context (forwarded to classifyComplexity).
 * @returns {{ system: 1|2, classification: ReturnType<typeof classifyComplexity>, metadata: { routedAt: number, historySize: number } }}
 *   Routing result with system assignment, full classification details, and metadata.
 * @example
 * const result = route('analyze security vulnerabilities in auth module');
 * console.log(result.system);          // 2 (deep analysis)
 * console.log(result.classification);  // { score, confidence, factors, ... }
 * console.log(result.metadata);        // { routedAt: 1708000000000, historySize: 42 }
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

  return {
    system: classification.system,
    classification,
    metadata: {
      routedAt: entry.timestamp,
      historySize: history.size,
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
 * @param {{ system: 1|2, success: boolean }} feedback - Outcome feedback for a previous routing decision.
 * @returns {{ previousThreshold: number, newThreshold: number, direction: 'lowered'|'raised'|'unchanged', streak: number }}
 *   Object describing threshold change, including previous/new values and current success streak.
 * @example
 * // Report that System 1 produced a bad result
 * const result = adaptThreshold({ system: 1, success: false });
 * // { previousThreshold: 0.4, newThreshold: 0.35, direction: 'lowered', streak: 0 }
 *
 * // Report System 1 success
 * adaptThreshold({ system: 1, success: true });
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

  // Mark the most recent matching history entry (immutable entry replacement)
  const recentIdx = findRecentEntryIndex(feedback.system);
  if (recentIdx >= 0) {
    history.updateAt(recentIdx, (h) => ({ ...h, success: feedback.success }));
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
 * @example
 * const stats = getRoutingStats();
 * // stats.totalRouted === 42
 * // stats.system1Ratio === 0.65
 * // stats.successRate.system1 === 0.9
 * // stats.recentTrend === 'stable'
 */
export function getRoutingStats() {
  const total = history.size;
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

  // Single-pass accumulation over circular buffer
  const all = history.toArray();
  let s1Count = 0, s2Count = 0;
  let sumScore = 0, sumConf = 0, sumDur = 0;
  let s1WithFb = 0, s1Success = 0, s2WithFb = 0, s2Success = 0;

  for (const h of all) {
    sumScore += h.score;
    sumConf += h.confidence;
    sumDur += h.durationMs;
    if (h.system === 1) {
      s1Count++;
      if (h.success !== undefined) { s1WithFb++; if (h.success) s1Success++; }
    } else {
      s2Count++;
      if (h.success !== undefined) { s2WithFb++; if (h.success) s2Success++; }
    }
  }

  const s1SuccessRate = s1WithFb > 0 ? s1Success / s1WithFb : 0;
  const s2SuccessRate = s2WithFb > 0 ? s2Success / s2WithFb : 0;

  // Trend detection: compare last 20% to first 80%
  const recentTrend = detectTrend(all);

  return {
    totalRouted: total,
    system1Count: s1Count,
    system2Count: s2Count,
    system1Ratio: round(s1Count / total),
    avgScore: round(sumScore / total),
    avgConfidence: round(sumConf / total),
    avgDurationMs: round(sumDur / total),
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
 *
 * @returns {void}
 * @example
 * resetRouter(); // threshold back to 0.4, history cleared
 */
export function resetRouter() {
  threshold = DEFAULT_THRESHOLD;
  history.clear();
  s1SuccessStreak = 0;
  nativeEffortHint = null;
}

/**
 * Get the current adaptive threshold value.
 *
 * @returns {number} Current threshold (between 0.2 and 0.7).
 * @example
 * const t = getThreshold(); // 0.4 (default)
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
 * Find the index of the most recent history entry for a given system.
 * @param {1|2} system
 * @returns {number} Index or -1 if not found
 */
function findRecentEntryIndex(system) {
  for (let i = history.size - 1; i >= 0; i--) {
    const entry = history.get(i);
    if (entry.system === system && entry.success === undefined) {
      return i;
    }
  }
  return -1;
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

// ---------------------------------------------------------------------------
// Effort Level Policy (Claude Opus 4.7 effort parameter)
// ---------------------------------------------------------------------------
// Official guide: https://platform.claude.com/docs/ko/build-with-claude/effort
// 'xhigh' is the 4.7-introduced level recommended for agentic coding.
// Messages API caller reads EFFORT_POLICY to auto-inject `effort` per command.

/** @type {Readonly<Record<string, 'xhigh'|'high'|'medium'|'low'>>} */
export const EFFORT_POLICY = Object.freeze({
  // xhigh — agentic coding (4.7 official recommendation)
  implement: 'xhigh', team: 'xhigh', tdd: 'xhigh',
  'build-fix': 'xhigh', cleanup: 'xhigh',
  // high — focused reasoning
  'code-review': 'high', 'adversarial-review': 'high',
  plan: 'high', troubleshoot: 'high', analyze: 'high', design: 'high',
  // medium — balanced
  daily: 'medium', load: 'medium', index: 'medium',
  explain: 'medium', document: 'medium',
  // low — cost-saving
  permissions: 'low', update: 'low', quickstart: 'low',
});

/**
 * Resolve effort level for a slash command name.
 * @param {string} commandName - e.g. 'implement', 'code-review' (leading '/' optional)
 * @returns {'xhigh'|'high'|'medium'|'low'} Defaults to 'medium' for unknown commands.
 */
export function getEffortForCommand(commandName) {
  const key = String(commandName || '').replace(/^\//, '').trim();
  return EFFORT_POLICY[key] ?? 'medium';
}
