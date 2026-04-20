/**
 * Skill hash cache builder and persister.
 *
 * Scans all `plugins/artibot/skills/{name}/SKILL.md` files, computes their
 * body hashes, and persists the result to `.claude-cache/skill-hashes.json`
 * (relative to plugin root) for fast freshness checks during agent runs.
 *
 * Phase 1 Quick Win — adopted from makabakaxy/mcp2cli benchmark.
 *
 * All functions are designed to never throw on transient I/O failures so
 * they can be safely invoked from the SessionStart hook.
 *
 * @module lib/core/skill-hash-cache
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteSync } from '../../scripts/utils/index.js';
import { getPluginRoot } from './platform.js';
import { computeHash, extractSkillBody } from './skill-hash.js';

const CACHE_VERSION = 1;
const CACHE_FILENAME = path.join('.claude-cache', 'skill-hashes.json');
const DEFAULT_REFRESH_MS = 24 * 60 * 60 * 1000; // 24 hours

function skillsDir() {
  return path.join(getPluginRoot(), 'skills');
}

function cachePath() {
  return path.join(getPluginRoot(), CACHE_FILENAME);
}

/**
 * Scan the skills directory and compute hashes for every SKILL.md file found.
 * Skips entries that are not directories or that lack a SKILL.md.
 *
 * @returns {Promise<{ version: number, generatedAt: string, skills: Record<string, { hash: string, path: string, size: number }> }>}
 */
export async function buildSkillHashCache() {
  const root = skillsDir();
  const entries = await readdir(root, { withFileTypes: true });
  const skills = {};
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillName = entry.name;
    const skillFile = path.join(root, skillName, 'SKILL.md');
    try {
      const raw = await readFile(skillFile, 'utf-8');
      const body = extractSkillBody(raw);
      skills[skillName] = {
        hash: computeHash(body),
        path: path.relative(getPluginRoot(), skillFile),
        size: raw.length,
      };
    } catch {
      // Skip skills that lack SKILL.md or are unreadable.
    }
  }
  return {
    version: CACHE_VERSION,
    generatedAt: new Date().toISOString(),
    skills,
  };
}

/**
 * Persist the cache to `.claude-cache/skill-hashes.json` atomically.
 * Never throws — returns false on failure.
 *
 * @param {object} data - Cache data from buildSkillHashCache.
 * @returns {boolean} True on success, false on failure.
 */
export function persistSkillHashCache(data) {
  try {
    atomicWriteSync(cachePath(), data);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the cache from disk. Returns null on missing/corrupt file.
 *
 * @returns {Promise<object|null>}
 */
export async function loadSkillHashCache() {
  try {
    const raw = await readFile(cachePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.skills) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Determine whether the on-disk cache should be rebuilt.
 * Rebuild if missing, older than `maxAgeMs`, or if `ARTIBOT_REFRESH_HASHES=1`.
 *
 * @param {number} [maxAgeMs] - Cache lifetime in ms (default 24h).
 * @returns {Promise<boolean>}
 */
export async function shouldRebuildCache(maxAgeMs = DEFAULT_REFRESH_MS) {
  if (process.env.ARTIBOT_REFRESH_HASHES === '1') return true;
  try {
    const stats = await stat(cachePath());
    return Date.now() - stats.mtimeMs > maxAgeMs;
  } catch {
    return true; // missing → rebuild
  }
}

/**
 * Convenience helper for hooks: refresh the cache if stale and return the
 * latest data. Never throws — logs to stderr on failure.
 *
 * @param {number} [maxAgeMs]
 * @returns {Promise<object|null>}
 */
export async function refreshIfStale(maxAgeMs = DEFAULT_REFRESH_MS) {
  try {
    if (await shouldRebuildCache(maxAgeMs)) {
      const data = await buildSkillHashCache();
      persistSkillHashCache(data);
      return data;
    }
    return await loadSkillHashCache();
  } catch (err) {
    process.stderr.write(`[skill-hash-cache] refresh failed: ${err.message}\n`);
    return null;
  }
}
