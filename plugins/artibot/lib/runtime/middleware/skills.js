/**
 * Runtime skills middleware.
 * Provides lightweight skill recommendations from detected commands/intents.
 * Supports lazy loading mode: loads skill index first, then matches
 * triggers against router intent to load only needed skills.
 *
 * @module lib/runtime/middleware/skills
 */

import { emit } from '../../core/event-bus.js';
import { loadSkillIndex, loadSkillsByNames } from '../../core/skill-exporter.js';

/** @type {import('../../core/skill-exporter.js').SkillIndexEntry[] | null} */
let _indexCache = null;

/** @type {Map<string, object>} */
const _skillCache = new Map();

/**
 * Keyword → dirName[] lookup index for O(m) matching.
 * Built once per index load; invalidated on _resetSkillCaches().
 * @type {Map<string, Set<string>> | null}
 */
let _keywordIndex = null;

/**
 * Build a keyword → skill dirName index from the skill index entries.
 * Each entry's name, dirName, and triggers are tokenised and stored.
 * Index is built once and reused across requests.
 *
 * @param {import('../../core/skill-exporter.js').SkillIndexEntry[]} index
 * @returns {Map<string, Set<string>>}
 */
function buildKeywordIndex(index) {
  /** @type {Map<string, Set<string>>} */
  const kwIndex = new Map();

  const addToken = (token, dirName) => {
    const existing = kwIndex.get(token);
    if (existing) {
      existing.add(dirName);
    } else {
      kwIndex.set(token, new Set([dirName]));
    }
  };

  for (const entry of index) {
    const nameLower = entry.name.toLowerCase();
    const dirLower = entry.dirName.toLowerCase();

    // Index full name and dirName for substring matching
    addToken(nameLower, entry.dirName);
    addToken(dirLower, entry.dirName);

    // Index individual triggers
    for (const trigger of entry.triggers) {
      const tLower = trigger.toLowerCase();
      addToken(tLower, entry.dirName);
    }
  }

  return kwIndex;
}

/**
 * Substring fallback scan for partial matches.
 * Extracted to reduce nesting depth in matchSkills.
 *
 * @param {string[]} lowerKeywords
 * @param {number} maxConcurrent
 * @param {Set<string>} matchSet - mutated in place
 */
function _substringFallback(lowerKeywords, maxConcurrent, matchSet) {
  for (const kw of lowerKeywords) {
    if (matchSet.size >= maxConcurrent) return;

    for (const [token, dirNames] of _keywordIndex) {
      if (matchSet.size >= maxConcurrent) return;
      if (!(token.includes(kw) || kw.includes(token))) continue;

      for (const dirName of dirNames) {
        if (matchSet.size >= maxConcurrent) return;
        matchSet.add(dirName);
      }
    }
  }
}

/**
 * Match skill index entries against intent keywords using the keyword index.
 * Complexity: O(m * k) where m = input keywords, k = avg index hits per keyword.
 * Falls back to substring scan for partial matches not covered by exact lookup.
 *
 * @param {import('../../core/skill-exporter.js').SkillIndexEntry[]} index
 * @param {string[]} keywords - Intent keywords + command names to match
 * @param {number} maxConcurrent - Maximum skills to load
 * @returns {string[]} Matched skill dirNames
 */
function matchSkills(index, keywords, maxConcurrent) {
  if (!_keywordIndex) {
    _keywordIndex = buildKeywordIndex(index);
  }

  const lowerKeywords = keywords.map((k) => k.toLowerCase().replace(/^\//, ''));
  /** @type {Set<string>} */
  const matchSet = new Set();

  // Phase 1: Exact lookup — keyword matches an indexed token
  for (const kw of lowerKeywords) {
    if (matchSet.size >= maxConcurrent) break;

    const exact = _keywordIndex.get(kw);
    if (exact) {
      for (const dirName of exact) {
        if (matchSet.size >= maxConcurrent) break;
        matchSet.add(dirName);
      }
    }
  }

  // Phase 2: Substring fallback — covers kw.includes(trigger) and name.includes(kw)
  if (matchSet.size < maxConcurrent) {
    _substringFallback(lowerKeywords, maxConcurrent, matchSet);
  }

  return [...matchSet];
}

/**
 * Match extension-registered skills against intent keywords.
 * Extracted to reduce nesting depth in the main middleware function.
 *
 * @param {object} registry - Extension registry instance
 * @param {object} intentInfo - Intent context from router
 * @param {string|undefined} bestCommand - Best matched command
 * @param {string[]} deduped - Mutable suggested skills array (matched items are appended)
 * @returns {string[]} Names of matched extension skills
 */
function matchExtensionSkills(registry, intentInfo, bestCommand, deduped) {
  const { skills: extSkills } = registry.listExtensions();
  if (extSkills.length === 0) return [];

  const keywords = [
    ...(intentInfo.intents || []),
    ...(intentInfo.commands || []),
    intentInfo.best,
    bestCommand,
  ].filter(Boolean).map((k) => k.toLowerCase().replace(/^\//, ''));

  const matched = [];
  for (const ext of extSkills) {
    const extName = ext.name.toLowerCase();
    const extTriggers = Array.isArray(ext.config.triggers) ? ext.config.triggers : [];
    const nameHit = keywords.some((kw) => extName.includes(kw) || kw.includes(extName));
    const triggerHit = extTriggers.some((t) =>
      keywords.some((kw) => t.toLowerCase().includes(kw) || kw.includes(t.toLowerCase())),
    );
    if (nameHit || triggerHit) {
      matched.push(ext.name);
      if (!deduped.includes(ext.name)) {
        deduped.push(ext.name);
      }
    }
  }
  return matched;
}

/**
 * @param {object} [options]
 * @param {Record<string, string[]>} [options.intentToSkills] - Optional intent->skills map.
 * @param {object} [options.lazyLoading] - Lazy loading configuration.
 * @param {boolean} [options.lazyLoading.enabled=false] - Enable lazy loading mode.
 * @param {number} [options.lazyLoading.maxConcurrent=5] - Max skills to load per request.
 * @param {string} [options.pluginRoot] - Override plugin root path.
 * @param {object} [options.extensionRegistry] - Extension registry for dynamic skill lookup.
 * @returns {(state: object) => Promise<object>}
 */
export function createSkillsMiddleware(options = {}) {
  const { intentToSkills = {} } = options;
  const lazyConfig = options.lazyLoading || {};
  const lazyEnabled = lazyConfig.enabled === true;
  const pluginRoot = options.pluginRoot;
  const extensionRegistry = options.extensionRegistry || null;


  return async function skillsMiddleware(state) {
    // Bridge: prefer creation-time options, fall back to runtime config
    const runtimeLazy = state.config?.skills?.lazyLoading || {};
    const effectiveLazyEnabled = lazyEnabled || runtimeLazy.enabled === true;
    const effectiveMaxConcurrent = lazyConfig.maxConcurrent ?? runtimeLazy.maxConcurrent ?? 5;
    const effectivePluginRoot = pluginRoot ?? runtimeLazy.pluginRoot;

    const intentInfo = state.context.intent || {};
    const bestCommand = intentInfo.commands?.[0];
    const bestIntent = intentInfo.best;
    const suggested = [];

    if (bestCommand) {
      const fromCommand = bestCommand.replace(/^\//, 'cmd-');
      suggested.push(fromCommand);
    }

    if (bestIntent && Array.isArray(intentToSkills[bestIntent])) {
      suggested.push(...intentToSkills[bestIntent]);
    }

    const deduped = [...new Set(suggested)];
    let loaded = [];
    let source = 'intent-derived';
    let lazyHit = false;

    if (effectiveLazyEnabled) {
      try {
        if (!_indexCache) {
          _indexCache = await loadSkillIndex(effectivePluginRoot);
        }

        const keywords = [
          ...(intentInfo.intents || []),
          ...(intentInfo.commands || []),
          bestIntent,
        ].filter(Boolean);

        const matched = matchSkills(_indexCache, keywords, effectiveMaxConcurrent);

        const uncached = matched.filter((n) => !_skillCache.has(n));
        if (uncached.length > 0) {
          const freshSkills = await loadSkillsByNames(uncached, effectivePluginRoot);
          for (const skill of freshSkills) {
            _skillCache.set(skill.dirName, skill);
          }
        }

        loaded = matched.map((n) => _skillCache.get(n)).filter(Boolean);
        source = 'lazy-loaded';
        lazyHit = true;
      } catch {
        source = 'intent-derived';
        lazyHit = false;
      }
    }

    // Merge extension-registered skills into suggestions
    const extensionMatched = extensionRegistry
      ? matchExtensionSkills(extensionRegistry, intentInfo, bestCommand, deduped)
      : [];

    state.context.skills = {
      suggested: deduped,
      source,
      ...(lazyHit && {
        loaded: loaded.map((s) => s.name),
        cacheSize: _skillCache.size,
        indexSize: _indexCache?.length ?? 0,
      }),
      ...(extensionMatched.length > 0 && {
        extensionSkills: extensionMatched,
      }),
    };

    state.messageParts.push(`skills=${deduped.length}`);

    if (lazyHit && loaded.length > 0) {
      emit('feature:source-fetched', { detail: `${loaded.length} skills loaded` });
    }

    return state;
  };
}

/**
 * Reset internal caches for testing.
 * @returns {void}
 */
export function _resetSkillCaches() {
  _indexCache = null;
  _skillCache.clear();
  _keywordIndex = null;
}

/**
 * Expose keyword index for testing/inspection.
 * Returns null if index has not been built yet.
 * @returns {Map<string, Set<string>> | null}
 */
export function _getKeywordIndex() {
  return _keywordIndex;
}

// Re-export for unit testing
export { buildKeywordIndex as _buildKeywordIndex };

