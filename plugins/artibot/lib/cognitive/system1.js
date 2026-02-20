/**
 * System 1: Fast Intuitive Response Module
 *
 * Inspired by Kahneman's dual-process theory. Provides instant responses
 * using cached patterns, memory RAG search, and tool-learner suggestions.
 * Target latency: <100ms for cached hits, <200ms with memory lookup.
 *
 * Integrates with:
 * - memory-manager: RAG-based memory search for relevant past experiences
 * - tool-learner: Optimal tool suggestion from usage history + GRPO scores
 * - Cache: In-memory pattern cache for sub-millisecond hits
 * - Pattern DB: Persistent pattern files in ~/.claude/artibot/patterns/
 *
 * Zero dependencies - uses node:fs, node:path, node:os only.
 * @module lib/cognitive/system1
 */

import path from 'node:path';
import { Cache } from '../core/cache.js';
import { readJsonFile, writeJsonFile, listFiles, ensureDir } from '../core/file.js';
import { getHomeDir } from '../core/platform.js';
import { searchMemory } from '../learning/memory-manager.js';
import { suggestTool, buildContextKey } from '../learning/tool-learner.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directory for persistent pattern files */
const PATTERNS_DIR_NAME = 'patterns';

/** Confidence threshold below which we escalate to System 2 */
const ESCALATION_THRESHOLD = 0.6;

/** Maximum patterns loaded into warm cache */
const MAX_WARM_CACHE_PATTERNS = 200;

/** Cache TTL for pattern lookups (10 minutes) */
const PATTERN_CACHE_TTL = 10 * 60 * 1000;

/** Cache TTL for memory search results (5 minutes) */
const MEMORY_CACHE_TTL = 5 * 60 * 1000;

/** Cache TTL for tool suggestions (5 minutes) */
const TOOL_CACHE_TTL = 5 * 60 * 1000;

/** Maximum tokens from input used for pattern matching */
const MAX_INPUT_TOKENS = 100;

/** Minimum keyword overlap ratio to consider a pattern match */
const MIN_PATTERN_MATCH_SCORE = 0.3;

// ---------------------------------------------------------------------------
// Internal State
// ---------------------------------------------------------------------------

/** In-memory pattern cache for fast lookups */
const _patternCache = new Cache(PATTERN_CACHE_TTL);

/** In-memory cache for memory search results */
const _memoryCache = new Cache(MEMORY_CACHE_TTL);

/** In-memory cache for tool suggestions */
const _toolCache = new Cache(TOOL_CACHE_TTL);

/** Loaded patterns from disk (populated by warmCache) */
let _loadedPatterns = [];

/** Whether warmCache has been called at least once */
let _warmed = false;

// ---------------------------------------------------------------------------
// Path Helpers
// ---------------------------------------------------------------------------

/**
 * Get the patterns directory: ~/.claude/artibot/patterns/
 * @returns {string}
 */
function getPatternsDir() {
  return path.join(getHomeDir(), '.claude', 'artibot', PATTERNS_DIR_NAME);
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

/**
 * Tokenize input text into normalized lowercase tokens.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .split(/[\s,./\\:;|_\-@#()[\]{}"'`!?=<>+*&^%$~]+/)
    .filter((t) => t.length >= 2 && t.length <= 60)
    .slice(0, MAX_INPUT_TOKENS);
}

/**
 * Build a cache key from input and optional context fields.
 * @param {string} input
 * @param {object} [context]
 * @returns {string}
 */
function buildCacheKey(input, context) {
  const parts = [input.slice(0, 200)];
  if (context?.command) parts.push(context.command);
  if (context?.domain) parts.push(context.domain);
  return parts.join('::');
}

// ---------------------------------------------------------------------------
// Pattern Matching
// ---------------------------------------------------------------------------

/**
 * @typedef {object} PatternRecord
 * @property {string} id - Unique pattern identifier
 * @property {string[]} keywords - Trigger keywords
 * @property {string} intent - Detected intent category
 * @property {object} response - Cached response template
 * @property {string} [domain] - Domain classification
 * @property {string} [command] - Associated command
 * @property {number} confidence - Base confidence score (0-1)
 * @property {number} useCount - Times this pattern was matched
 * @property {number} successRate - Historical success rate (0-1)
 * @property {number} lastUsed - Unix timestamp of last use
 * @property {string} [source] - Where this pattern originated
 */

/**
 * Score a pattern against tokenized input.
 * Uses keyword overlap ratio + bonus for domain/command match.
 *
 * @param {PatternRecord} pattern
 * @param {string[]} inputTokens
 * @param {object} [context]
 * @returns {{ score: number, matchedKeywords: string[] }}
 */
function scorePattern(pattern, inputTokens, context) {
  if (!pattern.keywords || pattern.keywords.length === 0) {
    return { score: 0, matchedKeywords: [] };
  }

  const inputSet = new Set(inputTokens);
  const matchedKeywords = pattern.keywords.filter((kw) => inputSet.has(kw));
  const overlapRatio = matchedKeywords.length / pattern.keywords.length;

  // Base score from keyword overlap
  let score = overlapRatio;

  // Domain match bonus (+0.1)
  if (context?.domain && pattern.domain === context.domain) {
    score += 0.1;
  }

  // Command match bonus (+0.1)
  if (context?.command && pattern.command === context.command) {
    score += 0.1;
  }

  // Success rate weighting
  if (pattern.useCount > 0) {
    score *= 0.7 + 0.3 * pattern.successRate;
  }

  // Recency bonus: patterns used recently get a small boost
  if (pattern.lastUsed) {
    const ageMs = Date.now() - pattern.lastUsed;
    const dayMs = 24 * 60 * 60 * 1000;
    if (ageMs < dayMs) score += 0.05;
    else if (ageMs < 7 * dayMs) score += 0.02;
  }

  return { score: Math.min(1, score), matchedKeywords };
}

/**
 * Match input against loaded patterns and return the best match.
 *
 * @param {string} input - Raw user input
 * @param {object} [context] - Optional context (domain, command, etc.)
 * @returns {{ pattern: PatternRecord|null, score: number, metadata: object }}
 */
export function patternMatch(input, context) {
  const start = performance.now();
  const tokens = tokenize(input);

  if (tokens.length === 0) {
    return {
      pattern: null,
      score: 0,
      metadata: { tokens: 0, patternsChecked: 0, latencyMs: performance.now() - start },
    };
  }

  let bestPattern = null;
  let bestScore = 0;
  let bestMatched = [];

  for (const pattern of _loadedPatterns) {
    const { score, matchedKeywords } = scorePattern(pattern, tokens, context);
    if (score > bestScore) {
      bestScore = score;
      bestPattern = pattern;
      bestMatched = matchedKeywords;
    }
  }

  const latencyMs = Math.round((performance.now() - start) * 100) / 100;

  return {
    pattern: bestScore >= MIN_PATTERN_MATCH_SCORE ? bestPattern : null,
    score: Math.round(bestScore * 1000) / 1000,
    metadata: {
      tokens: tokens.length,
      patternsChecked: _loadedPatterns.length,
      matchedKeywords: bestMatched,
      latencyMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Fast Response (Core API)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} FastResponse
 * @property {object|null} response - The response payload
 * @property {number} confidence - Confidence score (0-1)
 * @property {string} source - Where the response came from: 'cache' | 'pattern' | 'memory' | 'tool' | 'none'
 * @property {number} latencyMs - Total response time in milliseconds
 * @property {object} [toolSuggestion] - Suggested tool if available
 * @property {object} [memoryHits] - Relevant memory entries
 * @property {boolean} [escalate] - Whether to escalate to System 2
 * @property {string} [escalateReason] - Reason for escalation
 */

/**
 * Produce a fast, intuitive response by searching cached patterns,
 * memory, and tool history. Target: <100ms for cache hits.
 *
 * @param {string} input - User input or task description
 * @param {object} [context] - Session context
 * @param {string} [context.command] - Current command
 * @param {string} [context.domain] - Domain classification
 * @param {string} [context.project] - Project name
 * @param {string} [context.cwd] - Current working directory
 * @returns {Promise<FastResponse>}
 */
export async function fastResponse(input, context = {}) {
  const start = performance.now();

  if (!input || typeof input !== 'string' || input.trim().length === 0) {
    return {
      response: null,
      confidence: 0,
      source: 'none',
      latencyMs: 0,
      escalate: true,
      escalateReason: 'empty_input',
    };
  }

  // Ensure patterns are loaded
  if (!_warmed) {
    await warmCache();
  }

  const cacheKey = buildCacheKey(input, context);

  // 1. Check in-memory response cache (sub-ms)
  const cached = _patternCache.get(cacheKey);
  if (cached) {
    return {
      ...cached,
      source: 'cache',
      latencyMs: Math.round((performance.now() - start) * 100) / 100,
    };
  }

  // 2. Pattern matching against loaded patterns (sync, fast)
  const match = patternMatch(input, context);
  let bestResponse = null;
  let bestConfidence = 0;
  let bestSource = 'none';

  if (match.pattern && match.score >= MIN_PATTERN_MATCH_SCORE) {
    bestResponse = match.pattern.response;
    bestConfidence = match.score * match.pattern.confidence;
    bestSource = 'pattern';
  }

  // 3. Parallel: memory search + tool suggestion (async, <100ms each)
  const [memoryHits, toolSuggestion] = await Promise.all([
    _searchMemoryCached(input, context),
    _suggestToolCached(input, context),
  ]);

  // 4. If memory has high-relevance hits, boost confidence or use as response
  if (memoryHits.length > 0 && memoryHits[0].score > 0.5) {
    if (bestConfidence < memoryHits[0].score) {
      bestResponse = {
        type: 'memory_recall',
        entries: memoryHits.slice(0, 3).map((h) => h.entry.data),
        topScore: memoryHits[0].score,
      };
      bestConfidence = memoryHits[0].score;
      bestSource = 'memory';
    } else {
      // Boost pattern confidence with memory corroboration
      bestConfidence = Math.min(1, bestConfidence + 0.1);
    }
  }

  // 5. If tool suggestion available, attach it
  const toolResult = toolSuggestion.length > 0 ? toolSuggestion[0] : null;
  if (toolResult && bestSource === 'none') {
    bestResponse = {
      type: 'tool_recommendation',
      tool: toolResult.tool,
      score: toolResult.weightedScore,
      confidence: toolResult.confidence,
    };
    bestConfidence = toolResult.weightedScore * 0.8;
    bestSource = 'tool';
  }

  // 6. Determine if escalation is needed
  const shouldEscalate = bestConfidence < ESCALATION_THRESHOLD;
  const latencyMs = Math.round((performance.now() - start) * 100) / 100;

  const result = {
    response: bestResponse,
    confidence: Math.round(bestConfidence * 1000) / 1000,
    source: bestSource,
    latencyMs,
    ...(toolResult && { toolSuggestion: toolResult }),
    ...(memoryHits.length > 0 && { memoryHits: memoryHits.slice(0, 5) }),
    ...(shouldEscalate && { escalate: true }),
    ...(shouldEscalate && { escalateReason: _getEscalationReason(bestConfidence, bestSource) }),
  };

  // Cache the result for subsequent identical queries
  if (!shouldEscalate) {
    _patternCache.set(cacheKey, result);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

/**
 * Explicitly escalate an input to System 2 for deep reasoning.
 *
 * @param {string} input - The input that needs deeper processing
 * @param {string} reason - Why System 1 cannot handle this
 * @returns {{ escalated: true, input: string, reason: string, timestamp: number }}
 */
export function escalateToSystem2(input, reason) {
  return {
    escalated: true,
    input,
    reason,
    timestamp: Date.now(),
  };
}

/**
 * Determine escalation reason based on confidence and source.
 * @param {number} confidence
 * @param {string} source
 * @returns {string}
 */
function _getEscalationReason(confidence, source) {
  if (confidence === 0) return 'no_matching_pattern';
  if (confidence < 0.3) return 'very_low_confidence';
  if (source === 'none') return 'no_data_source';
  return 'below_threshold';
}

// ---------------------------------------------------------------------------
// Cache Warming
// ---------------------------------------------------------------------------

/**
 * Pre-load frequently used patterns from disk into memory.
 * Called automatically on first fastResponse(), or can be called
 * explicitly at startup for better first-query latency.
 *
 * @returns {Promise<{ loaded: number, dir: string }>}
 */
export async function warmCache() {
  const dir = getPatternsDir();
  await ensureDir(dir);

  const files = await listFiles(dir, '.json');
  const patterns = [];

  for (const file of files.slice(0, MAX_WARM_CACHE_PATTERNS)) {
    const data = await readJsonFile(file);
    if (data && data.id && data.keywords) {
      patterns.push(data);
    } else if (data && Array.isArray(data.patterns)) {
      // Support pattern collection files
      for (const p of data.patterns) {
        if (p.id && p.keywords) patterns.push(p);
      }
    }
  }

  // Sort by useCount descending so most popular patterns are checked first
  patterns.sort((a, b) => (b.useCount || 0) - (a.useCount || 0));

  _loadedPatterns = patterns.slice(0, MAX_WARM_CACHE_PATTERNS);
  _warmed = true;

  return { loaded: _loadedPatterns.length, dir };
}

// ---------------------------------------------------------------------------
// Pattern Persistence
// ---------------------------------------------------------------------------

/**
 * Save a new pattern or update an existing one in the pattern DB.
 *
 * @param {PatternRecord} pattern - Pattern to save
 * @returns {Promise<void>}
 */
export async function savePattern(pattern) {
  if (!pattern.id || !pattern.keywords) {
    throw new Error('Pattern must have id and keywords');
  }

  const dir = getPatternsDir();
  await ensureDir(dir);

  const filePath = path.join(dir, `${pattern.id}.json`);
  const saved = {
    ...pattern,
    useCount: pattern.useCount || 0,
    successRate: pattern.successRate || 1.0,
    lastUsed: pattern.lastUsed || Date.now(),
    confidence: pattern.confidence || 0.5,
  };

  await writeJsonFile(filePath, saved);

  // Update in-memory cache
  const idx = _loadedPatterns.findIndex((p) => p.id === pattern.id);
  if (idx >= 0) {
    _loadedPatterns[idx] = saved;
  } else if (_loadedPatterns.length < MAX_WARM_CACHE_PATTERNS) {
    _loadedPatterns.push(saved);
  }
}

/**
 * Record that a pattern was used and whether it succeeded.
 * Updates useCount, successRate, and lastUsed.
 *
 * @param {string} patternId - Pattern ID
 * @param {boolean} success - Whether the response was helpful
 * @returns {Promise<void>}
 */
export async function recordPatternOutcome(patternId, success) {
  const idx = _loadedPatterns.findIndex((p) => p.id === patternId);
  if (idx < 0) return;

  const pattern = _loadedPatterns[idx];
  const newCount = (pattern.useCount || 0) + 1;
  const oldRate = pattern.successRate || 1.0;
  const oldCount = pattern.useCount || 0;

  // Incremental average update
  const newRate = oldCount > 0
    ? (oldRate * oldCount + (success ? 1 : 0)) / newCount
    : success ? 1.0 : 0.0;

  const updated = {
    ...pattern,
    useCount: newCount,
    successRate: Math.round(newRate * 1000) / 1000,
    lastUsed: Date.now(),
  };

  _loadedPatterns[idx] = updated;
  await savePattern(updated);
}

// ---------------------------------------------------------------------------
// Cached Lookups (Internal)
// ---------------------------------------------------------------------------

/**
 * Search memory with caching to avoid repeated disk I/O.
 * @param {string} input
 * @param {object} context
 * @returns {Promise<Array<{entry: object, score: number}>>}
 */
async function _searchMemoryCached(input, context) {
  const cacheKey = `mem::${input.slice(0, 100)}`;
  const cached = _memoryCache.get(cacheKey);
  if (cached) return cached;

  try {
    const query = [input, context.command, context.domain, context.project]
      .filter(Boolean)
      .join(' ');
    const results = await searchMemory(query, { limit: 5, threshold: 0.2 });
    _memoryCache.set(cacheKey, results);
    return results;
  } catch {
    return [];
  }
}

/**
 * Get tool suggestions with caching.
 * @param {string} input
 * @param {object} context
 * @returns {Promise<Array>}
 */
async function _suggestToolCached(input, context) {
  const tokens = tokenize(input);
  const operation = _detectOperation(tokens);
  const target = _detectTarget(tokens, context);
  const contextKey = buildContextKey(operation, target);

  const cacheKey = `tool::${contextKey}`;
  const cached = _toolCache.get(cacheKey);
  if (cached) return cached;

  try {
    const results = await suggestTool(contextKey, { limit: 3, minScore: 0.3 });
    _toolCache.set(cacheKey, results);
    return results;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Intent Detection Helpers
// ---------------------------------------------------------------------------

/** Operation keywords grouped by category */
const OPERATION_MAP = {
  search: ['search', 'find', 'grep', 'look', 'locate', 'where'],
  edit: ['edit', 'modify', 'change', 'update', 'replace', 'rename'],
  create: ['create', 'new', 'add', 'generate', 'build', 'make', 'write'],
  delete: ['delete', 'remove', 'drop', 'clean', 'purge'],
  analyze: ['analyze', 'review', 'check', 'inspect', 'audit', 'examine'],
  test: ['test', 'verify', 'validate', 'assert', 'expect'],
  debug: ['debug', 'fix', 'troubleshoot', 'resolve', 'diagnose'],
  deploy: ['deploy', 'release', 'publish', 'ship'],
  document: ['document', 'describe', 'explain', 'comment'],
  refactor: ['refactor', 'restructure', 'reorganize', 'simplify', 'optimize'],
};

/** Target keywords grouped by category */
const TARGET_MAP = {
  typescript: ['typescript', 'ts', 'tsx', 'types', 'interface'],
  javascript: ['javascript', 'js', 'jsx', 'node', 'npm'],
  react: ['react', 'component', 'hook', 'jsx', 'tsx', 'props', 'state'],
  css: ['css', 'style', 'scss', 'sass', 'tailwind', 'responsive'],
  api: ['api', 'endpoint', 'route', 'rest', 'graphql', 'request'],
  database: ['database', 'db', 'sql', 'query', 'schema', 'migration'],
  config: ['config', 'configuration', 'env', 'settings', 'environment'],
  tests: ['test', 'spec', 'jest', 'vitest', 'playwright', 'e2e'],
  docs: ['docs', 'documentation', 'readme', 'guide', 'wiki'],
  security: ['security', 'auth', 'authentication', 'authorization', 'token'],
};

/**
 * Detect the primary operation from tokens.
 * @param {string[]} tokens
 * @returns {string}
 */
function _detectOperation(tokens) {
  const tokenSet = new Set(tokens);
  for (const [op, keywords] of Object.entries(OPERATION_MAP)) {
    if (keywords.some((kw) => tokenSet.has(kw))) return op;
  }
  return 'general';
}

/**
 * Detect the primary target from tokens and context.
 * @param {string[]} tokens
 * @param {object} [context]
 * @returns {string}
 */
function _detectTarget(tokens, context) {
  if (context?.domain) return context.domain;

  const tokenSet = new Set(tokens);
  for (const [target, keywords] of Object.entries(TARGET_MAP)) {
    if (keywords.some((kw) => tokenSet.has(kw))) return target;
  }
  return 'code';
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Get System 1 diagnostic information.
 * @returns {{ warmed: boolean, patternsLoaded: number, patternCacheSize: number, memoryCacheSize: number, toolCacheSize: number }}
 */
export function getDiagnostics() {
  return {
    warmed: _warmed,
    patternsLoaded: _loadedPatterns.length,
    patternCacheSize: _patternCache.size,
    memoryCacheSize: _memoryCache.size,
    toolCacheSize: _toolCache.size,
  };
}

/**
 * Clear all in-memory caches. Useful for testing.
 */
export function clearAllCaches() {
  _patternCache.clear();
  _memoryCache.clear();
  _toolCache.clear();
  _loadedPatterns = [];
  _warmed = false;
}
