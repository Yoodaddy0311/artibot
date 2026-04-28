/**
 * Skills bridge — exposes the Artibot skill inventory to MCP tools.
 *
 * The bridge is a pure factory: it accepts a skillRegistry dependency (or
 * constructs a default filesystem-backed one scoped to `plugins/artibot/skills/`)
 * and returns read-only helpers that the MCP tool layer can wrap into
 * handlers.
 *
 * Design contract:
 *   - Zero runtime deps.
 *   - Korean-path safe (no pathToFileURL).
 *   - All helpers are async and never throw on transient I/O; they return
 *     `{ok: true, value}` / `{ok: false, error}` shapes so the MCP layer
 *     can surface structured errors.
 *   - No external network; only reads the local `skills/` dir.
 *   - No mutation of any file or cache — strictly read-only.
 *
 * Public API:
 *   createSkillsBridge({skillRegistry?, skillsDir?}) →
 *     { listSkills, getSkill, searchSkills }
 *
 * @module lib/mcp/bridge/skills-bridge
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { getPluginRoot } from '../../core/platform.js';
import { parseFrontmatter } from '../../core/skill-exporter.js';

const DEFAULT_SKILLS_BASENAME = 'skills';
const MAX_DESCRIPTION_LEN = 280;
const MAX_FRONTMATTER_TAGS = 20;

/**
 * Normalize a description field to a short single-line string.
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeDescription(raw) {
  if (typeof raw !== 'string') return '';
  const firstLine = raw.split('\n').find((l) => l.trim() !== '') || '';
  const trimmed = firstLine.trim();
  if (trimmed.length <= MAX_DESCRIPTION_LEN) return trimmed;
  return `${trimmed.slice(0, MAX_DESCRIPTION_LEN - 1)}\u2026`;
}

/**
 * Coerce a frontmatter tag / keyword array into a bounded string[].
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeStringList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v) => typeof v === 'string' && v.trim() !== '')
    .map((v) => v.trim())
    .slice(0, MAX_FRONTMATTER_TAGS);
}

/**
 * Read a single SKILL.md and produce an inventory entry.
 * Returns null when the file is missing / unreadable / has no frontmatter
 * name.
 *
 * @param {string} skillsRoot
 * @param {string} skillName
 * @returns {Promise<null | {
 *   name: string,
 *   description: string,
 *   tags: string[],
 *   path: string,
 *   size: number,
 *   mtimeMs: number
 * }>}
 */
async function readSkillEntry(skillsRoot, skillName) {
  const filePath = path.join(skillsRoot, skillName, 'SKILL.md');
  let raw;
  let statInfo;
  try {
    [raw, statInfo] = await Promise.all([
      readFile(filePath, 'utf-8'),
      stat(filePath),
    ]);
  } catch {
    return null;
  }
  const { frontmatter } = parseFrontmatter(raw);
  const name = typeof frontmatter?.name === 'string' && frontmatter.name.trim() !== ''
    ? frontmatter.name.trim()
    : skillName;
  const tags = [
    ...normalizeStringList(frontmatter?.tags),
    ...normalizeStringList(frontmatter?.keywords),
  ];
  return {
    name,
    description: normalizeDescription(frontmatter?.description),
    tags,
    path: filePath,
    size: raw.length,
    mtimeMs: statInfo.mtimeMs,
  };
}

/**
 * Default filesystem-backed skill registry. Scans `{pluginRoot}/skills/`
 * on each call — the upstream skill-hash-cache is the source of truth for
 * hash-based freshness, but the bridge does not need hashes to satisfy
 * MCP reads, so we stay dep-free by walking the directory directly.
 *
 * @param {string} skillsRoot
 * @returns {{
 *   list: () => Promise<Array<object>>,
 *   read: (name: string) => Promise<{ entry: object, body: string } | null>,
 * }}
 */
function createDefaultRegistry(skillsRoot) {
  async function list() {
    let names;
    try {
      names = (await readdir(skillsRoot, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      return [];
    }
    const entries = [];
    for (const name of names) {
      const entry = await readSkillEntry(skillsRoot, name);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  async function read(skillName) {
    if (typeof skillName !== 'string' || skillName.trim() === '') return null;
    if (skillName.includes('..') || skillName.includes('/') || skillName.includes('\\')) {
      return null; // reject traversal attempts
    }
    const entry = await readSkillEntry(skillsRoot, skillName);
    if (!entry) return null;
    let body;
    try {
      body = await readFile(entry.path, 'utf-8');
    } catch {
      return null;
    }
    return { entry, body };
  }

  return { list, read };
}

/**
 * Simple case-insensitive keyword match against name, description, tags.
 * @param {{name: string, description: string, tags: string[]}} entry
 * @param {string[]} tokens
 * @returns {number} match count (0 = no match)
 */
function scoreEntry(entry, tokens) {
  if (tokens.length === 0) return 0;
  const haystack = [
    entry.name,
    entry.description,
    ...(entry.tags || []),
  ].join(' ').toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (haystack.includes(t)) score += 1;
  }
  return score;
}

/**
 * Tokenize a search query into a normalized list of keywords.
 * @param {unknown} query
 * @returns {string[]}
 */
function tokenize(query) {
  if (typeof query !== 'string') return [];
  return query
    .toLowerCase()
    .split(/[\s,./\\:;|_\-@#]+/)
    .filter((t) => t.length >= 2);
}

/**
 * Create a skills bridge.
 *
 * @param {object} [deps]
 * @param {object} [deps.skillRegistry] - custom registry, see `createDefaultRegistry`
 * @param {string} [deps.skillsDir]     - override the default `{pluginRoot}/skills`
 * @returns {{
 *   listSkills: () => Promise<{ok: boolean, value?: Array<object>, error?: string}>,
 *   getSkill:   (name: string) => Promise<{ok: boolean, value?: object, error?: string}>,
 *   searchSkills: (args: {query: string, limit?: number}) => Promise<{ok: boolean, value?: Array<object>, error?: string}>,
 * }}
 */
export function createSkillsBridge(deps = {}) {
  const skillsDir = typeof deps.skillsDir === 'string' && deps.skillsDir.trim() !== ''
    ? deps.skillsDir
    : path.join(getPluginRoot(), DEFAULT_SKILLS_BASENAME);
  const registry = deps.skillRegistry || createDefaultRegistry(skillsDir);

  async function listSkills() {
    try {
      const entries = await registry.list();
      const value = entries.map((e) => ({
        name: e.name,
        description: e.description,
        tags: e.tags || [],
        path: e.path,
        size: e.size,
      }));
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function getSkill(name) {
    if (typeof name !== 'string' || name.trim() === '') {
      return { ok: false, error: 'skill name required' };
    }
    try {
      const result = await registry.read(name);
      if (!result) {
        return { ok: false, error: `skill not found: ${name}` };
      }
      return {
        ok: true,
        value: {
          name: result.entry.name,
          description: result.entry.description,
          tags: result.entry.tags || [],
          path: result.entry.path,
          size: result.entry.size,
          body: result.body,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function searchSkills(args = {}) {
    const { query, limit } = args || {};
    const tokens = tokenize(query);
    if (tokens.length === 0) {
      return { ok: false, error: 'query must contain at least one 2+ char token' };
    }
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 10;
    try {
      const entries = await registry.list();
      const scored = entries
        .map((e) => ({ entry: e, score: scoreEntry(e, tokens) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, cap)
        .map((r) => ({
          name: r.entry.name,
          description: r.entry.description,
          tags: r.entry.tags || [],
          score: r.score,
          path: r.entry.path,
        }));
      return { ok: true, value: scored };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  return Object.freeze({ listSkills, getSkill, searchSkills });
}
