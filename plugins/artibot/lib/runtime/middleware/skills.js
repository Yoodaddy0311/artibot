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
 * Match skill index entries against intent keywords and command names.
 *
 * @param {import('../../core/skill-exporter.js').SkillIndexEntry[]} index
 * @param {string[]} keywords - Intent keywords + command names to match
 * @param {number} maxConcurrent - Maximum skills to load
 * @returns {string[]} Matched skill dirNames
 */
function matchSkills(index, keywords, maxConcurrent) {
  const lowerKeywords = keywords.map((k) => k.toLowerCase().replace(/^\//, ''));
  const matches = [];

  for (const entry of index) {
    if (matches.length >= maxConcurrent) break;

    const nameMatch = lowerKeywords.some((kw) =>
      entry.name.toLowerCase().includes(kw) || entry.dirName.toLowerCase().includes(kw),
    );
    const triggerMatch = entry.triggers.some((t) =>
      lowerKeywords.some((kw) => t.includes(kw) || kw.includes(t)),
    );

    if (nameMatch || triggerMatch) {
      matches.push(entry.dirName);
    }
  }

  return matches;
}

/**
 * @param {object} [options]
 * @param {Record<string, string[]>} [options.intentToSkills] - Optional intent->skills map.
 * @param {object} [options.lazyLoading] - Lazy loading configuration.
 * @param {boolean} [options.lazyLoading.enabled=false] - Enable lazy loading mode.
 * @param {number} [options.lazyLoading.maxConcurrent=5] - Max skills to load per request.
 * @param {string} [options.pluginRoot] - Override plugin root path.
 * @returns {(state: object) => Promise<object>}
 */
export function createSkillsMiddleware(options = {}) {
  const { intentToSkills = {} } = options;
  const lazyConfig = options.lazyLoading || {};
  const lazyEnabled = lazyConfig.enabled === true;
  const pluginRoot = options.pluginRoot;

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

    state.context.skills = {
      suggested: deduped,
      source,
      ...(lazyHit && {
        loaded: loaded.map((s) => s.name),
        cacheSize: _skillCache.size,
        indexSize: _indexCache?.length ?? 0,
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
}

