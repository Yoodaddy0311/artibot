/**
 * Self-registering agent registry.
 *
 * Scans `plugins/artibot/agents/*.md`, parses frontmatter, and builds an
 * in-memory Map keyed by agent name. The registry is cached and invalidated
 * when any agent file's mtime advances.
 *
 * Phase 2 WS-B.2 — depends on WS-B.1 frontmatter schema.
 *
 * Zero runtime deps. Korean-path safe (no pathToFileURL).
 *
 * @module lib/core/agent-registry
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { LIFECYCLE_VALUES } from './agent-frontmatter-schema.js';
import { getPluginRoot } from './platform.js';

const FENCE = '---';
const DESCRIPTION_MAX = 280;

/**
 * @typedef {object} AgentEntry
 * @property {string} name
 * @property {string} description
 * @property {string[]} capabilities
 * @property {string|null} lifecycle
 * @property {string|undefined} model
 * @property {string[]|undefined} tools
 * @property {string} path
 * @property {number} mtimeMs
 */

/** @type {{ map: Map<string, AgentEntry>, maxMtimeMs: number, dir: string } | null} */
let cache = null;

function agentsDir() {
  return path.join(getPluginRoot(), 'agents');
}

/**
 * Count leading spaces on a line.
 *
 * @param {string} line
 * @returns {number}
 */
function leadingSpaces(line) {
  let n = 0;
  while (n < line.length && line[n] === ' ') n += 1;
  return n;
}

/**
 * Parse a YAML flow-array literal (e.g., `[a, b, "c"]`) into a string[].
 *
 * @param {string} raw
 * @returns {string[]}
 */
function parseFlowArray(raw) {
  const inner = raw.trim().slice(1, -1);
  if (inner.trim() === '') return [];
  return inner
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter((s) => s.length > 0);
}

/**
 * Extract frontmatter lines between `---` fences (LF-normalized text).
 *
 * @param {string} text
 * @returns {string[] | null}
 */
function extractFrontmatterLines(text) {
  if (!text.startsWith(FENCE)) return null;
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === FENCE) return lines.slice(1, i);
  }
  return null;
}

/**
 * Consume a block scalar body started by `key: |`.
 *
 * @param {string[]} lines
 * @param {number} startIdx
 * @returns {{ value: string, nextIdx: number }}
 */
function consumeBlockScalar(lines, startIdx) {
  const body = [];
  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      body.push('');
      i += 1;
      continue;
    }
    if (leadingSpaces(line) >= 2) {
      body.push(line.slice(2));
      i += 1;
      continue;
    }
    break;
  }
  return { value: body.join('\n').trim(), nextIdx: i };
}

/**
 * Consume a YAML block list (indented `- item` lines) following `key:`.
 *
 * @param {string[]} lines
 * @param {number} startIdx
 * @returns {{ value: string[], nextIdx: number }}
 */
function consumeBlockList(lines, startIdx) {
  const items = [];
  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i += 1;
      continue;
    }
    const trimmed = line.trim();
    if (leadingSpaces(line) >= 2 && trimmed.startsWith('- ')) {
      items.push(trimmed.slice(2).trim().replace(/^['"]|['"]$/g, ''));
      i += 1;
      continue;
    }
    break;
  }
  return { value: items, nextIdx: i };
}

/**
 * Parse a frontmatter line block into a plain object.
 *
 * Supports scalar `key: value`, flow arrays `[a,b]`, block scalars `|`,
 * and block lists (`- item`).
 *
 * @param {string[]} lines
 * @returns {Record<string, unknown>}
 */
function parseFrontmatter(lines) {
  /** @type {Record<string, unknown>} */
  const fm = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#') || leadingSpaces(line) > 0) {
      i += 1;
      continue;
    }
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      i += 1;
      continue;
    }
    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();
    if (rest === '|' || rest === '|-' || rest === '|+') {
      const { value, nextIdx } = consumeBlockScalar(lines, i + 1);
      fm[key] = value;
      i = nextIdx;
      continue;
    }
    if (rest === '') {
      const { value, nextIdx } = consumeBlockList(lines, i + 1);
      fm[key] = value;
      i = nextIdx;
      continue;
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      fm[key] = parseFlowArray(rest);
      i += 1;
      continue;
    }
    fm[key] = rest.replace(/^['"]|['"]$/g, '');
    i += 1;
  }
  return fm;
}

/**
 * Normalize a description: first line only, trimmed, truncated.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeDescription(raw) {
  if (typeof raw !== 'string') return '';
  const firstLine = raw.split('\n').find((l) => l.trim() !== '') || '';
  const trimmed = firstLine.trim();
  if (trimmed.length <= DESCRIPTION_MAX) return trimmed;
  return `${trimmed.slice(0, DESCRIPTION_MAX - 1)}…`;
}

/**
 * Build a single AgentEntry from a parsed frontmatter object. Returns null
 * if the required `name` field is missing (can't key a map without it).
 *
 * @param {Record<string, unknown>} fm
 * @param {string} filePath
 * @param {number} mtimeMs
 * @returns {AgentEntry | null}
 */
function buildEntry(fm, filePath, mtimeMs) {
  const name = typeof fm.name === 'string' ? fm.name.trim() : '';
  if (!name) return null;
  const capabilities = Array.isArray(fm.capabilities)
    ? fm.capabilities.filter((c) => typeof c === 'string' && c.trim() !== '')
    : [];
  if (capabilities.length === 0) {
    process.stderr.write(
      `[agent-registry] warning: agent '${name}' has no capabilities\n`,
    );
  }
  /** @type {string|null} */
  let lifecycle = null;
  if (typeof fm.lifecycle === 'string' && LIFECYCLE_VALUES.includes(fm.lifecycle)) {
    lifecycle = fm.lifecycle === 'null' ? null : fm.lifecycle;
  }
  const model = typeof fm.model === 'string' ? fm.model : undefined;
  const tools = Array.isArray(fm.tools)
    ? /** @type {string[]} */ (fm.tools.filter((t) => typeof t === 'string'))
    : undefined;
  return {
    name,
    description: normalizeDescription(fm.description),
    capabilities,
    lifecycle,
    model,
    tools,
    path: filePath,
    mtimeMs,
  };
}

/**
 * Parse a single agent file and return its AgentEntry, or null on failure.
 *
 * @param {string} filePath
 * @param {number} mtimeMs
 * @returns {Promise<AgentEntry|null>}
 */
async function loadEntry(filePath, mtimeMs) {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const text = raw.replace(/\r\n/g, '\n');
    const lines = extractFrontmatterLines(text);
    if (!lines) return null;
    const fm = parseFrontmatter(lines);
    return buildEntry(fm, filePath, mtimeMs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[agent-registry] failed to parse ${filePath}: ${msg}\n`);
    return null;
  }
}

/**
 * Stat every `.md` file in the agents dir. Returns sorted entries with mtimes.
 *
 * @returns {Promise<{ files: { path: string, mtimeMs: number }[], maxMtimeMs: number }>}
 */
async function statAgentFiles() {
  const dir = agentsDir();
  // Exclude documentation files (INDEX.md, README.md) — they live in agents/
  // for discoverability but are not agent definitions.
  const names = (await readdir(dir))
    .filter((n) => n.endsWith('.md') && n !== 'INDEX.md' && n !== 'README.md')
    .sort();
  const files = [];
  let maxMtimeMs = 0;
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const st = await stat(full);
      files.push({ path: full, mtimeMs: st.mtimeMs });
      if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
    } catch {
      // skip unreadable files
    }
  }
  return { files, maxMtimeMs };
}

/**
 * Load (and memoize) the agent registry. Scans the agents directory,
 * parses frontmatter, and returns a Map keyed by agent name. The cache
 * is invalidated whenever the max mtime across agent files advances.
 *
 * @returns {Promise<Map<string, AgentEntry>>}
 */
export async function loadAgentRegistry() {
  const dir = agentsDir();
  const { files, maxMtimeMs } = await statAgentFiles();
  if (cache && cache.dir === dir && cache.maxMtimeMs === maxMtimeMs) {
    return cache.map;
  }
  /** @type {Map<string, AgentEntry>} */
  const map = new Map();
  for (const { path: filePath, mtimeMs } of files) {
    const entry = await loadEntry(filePath, mtimeMs);
    if (entry) map.set(entry.name, entry);
  }
  cache = { map, maxMtimeMs, dir };
  return map;
}

/**
 * Get a single agent entry by name.
 *
 * @param {string} name
 * @returns {Promise<AgentEntry | null>}
 */
export async function getAgent(name) {
  const map = await loadAgentRegistry();
  return map.get(name) || null;
}

/**
 * List all registered agent names.
 *
 * @returns {Promise<string[]>}
 */
export async function listAgents() {
  const map = await loadAgentRegistry();
  return [...map.keys()];
}

/**
 * Filter agents by a predicate function.
 *
 * @param {(entry: AgentEntry) => boolean} predicate
 * @returns {Promise<AgentEntry[]>}
 */
export async function filterAgents(predicate) {
  const map = await loadAgentRegistry();
  return [...map.values()].filter(predicate);
}

/**
 * Convenience: get all agents for a given lifecycle phase. Pass the string
 * `'null'` to retrieve cross-phase agents (lifecycle === null).
 *
 * @param {string} lifecycle - One of LIFECYCLE_VALUES.
 * @returns {Promise<AgentEntry[]>}
 */
export async function getAgentsForLifecycle(lifecycle) {
  const target = lifecycle === 'null' ? null : lifecycle;
  return filterAgents((a) => a.lifecycle === target);
}

/**
 * Reset the in-memory cache. Test helper only.
 */
export function _resetAgentCache() {
  cache = null;
}
