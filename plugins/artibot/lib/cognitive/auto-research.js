/**
 * AutoResearch Pipeline.
 * Automatically researches low-confidence System 2 queries across
 * multiple sources (web, codebase, memory) in parallel.
 *
 * Inspired by oh-my-claudecode's AutoResearch pipeline.
 * Integrates with the System 1/2 cognitive router.
 *
 * @module lib/cognitive/auto-research
 */

import { round as _coreRound } from '../core/index.js';

const round = (n) => _coreRound(n, 2);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONFIDENCE_THRESHOLD = 0.3;
const DEFAULT_MAX_RESULTS = 10;
const MAX_KEYWORDS = 10;
const CONTENT_MAX_LENGTH = 500;
const TOP_ITEMS_LIMIT = 5;

/** @type {ReadonlySet<string>} */
const STOP_WORDS = Object.freeze(new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to',
  'for', 'of', 'and', 'or', 'but', 'not', 'with', 'by', 'from', 'as',
  'it', 'this', 'that', 'be', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'can', 'could', 'should', 'may', 'might',
  '이', '가', '은', '는', '을', '를', '에', '에서', '로', '으로',
  '와', '과', '도', '만', '의', '한', '된', '하는', '있는',
]));

const CODE_INDICATORS = Object.freeze(new Set([
  'function', 'class', 'import', 'export', 'const', 'let', 'var',
  'def', 'async', 'await', 'return', 'module', 'require',
  'interface', 'type', 'enum', 'struct',
  '함수', '클래스', '모듈',
]));

const WEB_INDICATORS = Object.freeze(new Set([
  'tutorial', 'documentation', 'docs', 'api', 'library',
  'framework', 'package', 'npm', 'install', 'latest', 'version',
  'official', 'reference', 'guide',
  '사용법', '설치', '라이브러리', '프레임워크',
]));

const MEMORY_INDICATORS = Object.freeze(new Set([
  'before', 'previous', 'earlier', 'remember', 'again',
  '이전', '기억', '지난번', '아까', '다시',
]));

const HOW_TO_PATTERN = /\bhow\s+to\b/i;
const FILE_PATH_PATTERN = /[/\\][\w.-]+\.\w{1,10}\b/;

// ---------------------------------------------------------------------------
// Pure Functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Extract keywords from a query string.
 * @param {string} query
 * @returns {string[]}
 */
export function extractKeywords(query) {
  if (!query || typeof query !== 'string') return [];
  const lower = query.toLowerCase();
  const tokens = lower
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
  return [...new Set(tokens)].slice(0, MAX_KEYWORDS);
}

/**
 * Select research sources based on keywords and query.
 * @param {string[]} keywords
 * @param {string} query
 * @returns {Set<'web'|'codebase'|'memory'>}
 */
export function selectSources(keywords, query) {
  const sources = new Set();
  const kwSet = new Set(keywords);

  for (const kw of kwSet) {
    if (CODE_INDICATORS.has(kw)) sources.add('codebase');
    if (WEB_INDICATORS.has(kw)) sources.add('web');
    if (MEMORY_INDICATORS.has(kw)) sources.add('memory');
  }

  if (HOW_TO_PATTERN.test(query)) sources.add('web');
  if (FILE_PATH_PATTERN.test(query)) sources.add('codebase');

  if (sources.size === 0) {
    sources.add('codebase');
    sources.add('memory');
  }
  return sources;
}

/**
 * Deduplicate items by content fingerprint (first 100 chars).
 * @param {Array<{ source: string, content: string }>} items
 * @returns {Array<{ source: string, content: string }>}
 */
export function deduplicateItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const fp = (item.content || '').slice(0, 100).trim().toLowerCase();
    if (fp && !seen.has(fp)) {
      seen.add(fp);
      result.push(item);
    }
  }
  return result;
}

/**
 * Score relevance of a single item against keywords.
 * @param {string} content
 * @param {string[]} keywords
 * @returns {number} 0~1
 */
export function scoreRelevance(content, keywords) {
  if (!content || !keywords.length) return 0;
  const lower = content.toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) hits++;
  }
  return round(Math.min(hits / keywords.length, 1));
}

/**
 * Calculate overall quality score.
 * @param {{ total: number, deduplicated: number, sources: string[] }} stats
 * @returns {number} 0~1
 */
export function scoreQuality(stats) {
  const sourceDiversity = stats.sources.length / 3;
  const volumeScore = Math.min(stats.total / 10, 1);
  const dedupeRatio = stats.total > 0
    ? 1 - (stats.deduplicated / stats.total)
    : 0;
  return round(
    (sourceDiversity * 0.4) + (volumeScore * 0.3) + (dedupeRatio * 0.3),
  );
}

// ---------------------------------------------------------------------------
// Normalizers (convert source-specific results to unified shape)
// ---------------------------------------------------------------------------

function normalizeResults(source, results, maxResults) {
  if (!Array.isArray(results)) return [];
  return results.slice(0, maxResults).map((r) => ({
    source,
    content: String(r.content ?? r.text ?? r.snippet ?? r).slice(0, CONTENT_MAX_LENGTH),
  }));
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an AutoResearch pipeline instance.
 * @param {object} [options]
 * @param {Function} [options.searchFn]
 * @param {Function} [options.grepFn]
 * @param {Function} [options.memoryRecallFn]
 * @param {number}   [options.confidenceThreshold]
 * @param {number}   [options.maxResults]
 * @returns {Readonly<AutoResearch>}
 */
export function createAutoResearch(options = {}) {
  const {
    searchFn = null,
    grepFn = null,
    memoryRecallFn = null,
    confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD,
    maxResults = DEFAULT_MAX_RESULTS,
  } = options;

  /**
   * Determine whether research is needed.
   * @param {object} routingResult - from router.route()
   * @returns {boolean}
   */
  function shouldResearch(routingResult) {
    if (!routingResult) return false;
    const confidence = routingResult.confidence ?? routingResult.score ?? 1;
    return confidence < confidenceThreshold;
  }

  /**
   * Determine scope: keywords and sources.
   * @param {string} query
   * @returns {{ keywords: string[], sources: Set<string>, query: string }}
   */
  function scope(query) {
    const keywords = extractKeywords(query);
    const sources = selectSources(keywords, query || '');
    return Object.freeze({ keywords, sources, query: query || '' });
  }

  /**
   * Gather results from selected sources in parallel.
   * @param {{ keywords: string[], sources: Set<string>, query: string }} scopeResult
   * @returns {Promise<object>}
   */
  async function gather(scopeResult) {
    const start = Date.now();
    const { keywords, sources, query } = scopeResult;
    const searchQuery = keywords.join(' ') || query;

    const tasks = [];
    const taskSources = [];

    if (sources.has('web') && searchFn) {
      taskSources.push('web');
      tasks.push(searchFn(searchQuery));
    }
    if (sources.has('codebase') && grepFn) {
      taskSources.push('codebase');
      tasks.push(grepFn(searchQuery));
    }
    if (sources.has('memory') && memoryRecallFn) {
      taskSources.push('memory');
      tasks.push(memoryRecallFn(searchQuery));
    }

    const settled = await Promise.allSettled(tasks);

    const web = [];
    const codebase = [];
    const memory = [];
    const errors = [];
    const buckets = { web, codebase, memory };

    for (let i = 0; i < settled.length; i++) {
      const src = taskSources[i];
      if (settled[i].status === 'fulfilled') {
        buckets[src].push(
          ...normalizeResults(src, settled[i].value, maxResults),
        );
      } else {
        errors.push({ source: src, reason: String(settled[i].reason) });
      }
    }

    return Object.freeze({
      web, codebase, memory, errors, elapsed: Date.now() - start,
    });
  }

  /**
   * Synthesize gathered results: deduplicate, rank, score.
   * @param {object} gatherResult
   * @param {string[]} [keywords]
   * @returns {object}
   */
  function synthesize(gatherResult, keywords = []) {
    const allItems = [
      ...gatherResult.web,
      ...gatherResult.codebase,
      ...gatherResult.memory,
    ];
    const deduped = deduplicateItems(allItems);
    const scored = deduped
      .map((item) => ({
        ...item,
        relevance: scoreRelevance(item.content, keywords),
      }))
      .sort((a, b) => b.relevance - a.relevance);

    const activeSources = new Set(scored.map((i) => i.source));
    const stats = Object.freeze({
      total: allItems.length,
      deduplicated: allItems.length - deduped.length,
      sources: [...activeSources],
    });
    const quality = scoreQuality(stats);

    return Object.freeze({ items: scored, quality, stats });
  }

  /**
   * Persist synthesis result to session memory.
   * @param {object} synthesisResult
   * @param {object} sessionMemory - Map-like with set()
   * @returns {{ key: string, stored: boolean }}
   */
  function persist(synthesisResult, sessionMemory) {
    const key = `research:${Date.now()}`;
    if (!sessionMemory || typeof sessionMemory.set !== 'function') {
      return Object.freeze({ key, stored: false });
    }
    const topItems = synthesisResult.items.slice(0, TOP_ITEMS_LIMIT).map(
      (item) => ({ source: item.source, content: item.content, relevance: item.relevance }),
    );
    sessionMemory.set(key, Object.freeze({
      quality: synthesisResult.quality,
      itemCount: synthesisResult.items.length,
      topItems,
      timestamp: new Date().toISOString(),
    }));
    return Object.freeze({ key, stored: true });
  }

  /**
   * Run the full pipeline: scope -> gather -> synthesize -> persist.
   * @param {string} query
   * @param {object} routingResult
   * @param {object} [sessionMemory]
   * @returns {Promise<object>}
   */
  async function run(query, routingResult, sessionMemory = null) {
    if (!shouldResearch(routingResult)) {
      return Object.freeze({ skipped: true });
    }
    const scopeResult = scope(query);
    const gatherResult = await gather(scopeResult);
    const synthesisResult = synthesize(gatherResult, scopeResult.keywords);
    const persistResult = persist(synthesisResult, sessionMemory);

    return Object.freeze({
      skipped: false,
      scope: scopeResult,
      gather: gatherResult,
      synthesis: synthesisResult,
      persist: persistResult,
    });
  }

  return Object.freeze({
    shouldResearch,
    scope,
    gather,
    synthesize,
    persist,
    run,
  });
}
