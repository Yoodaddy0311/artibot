/**
 * Autopilot profile renderer.
 * Loads markdown templates with frontmatter + sidecar `.config.yaml`,
 * substitutes `{{key}}` placeholders, and caps output by line count.
 *
 * Zero external deps — uses regex + node:fs only.
 *
 * @module lib/autopilot/profile-renderer
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the profiles directory in a way that survives Korean / spaced paths.
 * Prefers `import.meta.dirname` (Node >=20.11), falls back to URL conversion.
 * @returns {string}
 */
function getProfilesDir() {
  const dir = import.meta.dirname || path.dirname(fileURLToPath(import.meta.url));
  return path.join(dir, 'profiles');
}

/**
 * Parse a minimal YAML config file.
 * Only `name`, `include`, `maxLines`, `minLines` keys are extracted.
 * @param {string} text
 * @returns {{ name?: string, include?: string[], maxLines?: number, minLines?: number }}
 */
export function parseSimpleYaml(text) {
  const out = {};
  if (typeof text !== 'string') return out;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^(\w+)\s*:\s*(.+?)\s*$/.exec(trimmed);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (key === 'include') {
      const arr = /^\[(.*)\]$/.exec(rawValue);
      if (arr) {
        out.include = arr[1]
          .split(',')
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean);
      }
    } else if (key === 'maxLines' || key === 'minLines') {
      const n = Number(rawValue);
      if (Number.isFinite(n)) out[key] = n;
    } else if (key === 'name') {
      out.name = rawValue.replace(/^['"]|['"]$/g, '');
    }
  }
  return out;
}

/**
 * Split markdown into frontmatter meta + heading-keyed sections.
 * @param {string} markdown
 * @returns {{ meta: object, sections: Map<string, string[]> }}
 */
export function parseSections(markdown) {
  if (typeof markdown !== 'string') return { meta: {}, sections: new Map() };
  let body = markdown;
  let meta = {};
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (fmMatch) {
    meta = parseSimpleYaml(fmMatch[1]);
    body = markdown.slice(fmMatch[0].length);
  }
  const sections = new Map();
  const lines = body.split(/\r?\n/);
  let current = '__preamble__';
  sections.set(current, []);
  for (const line of lines) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      current = h[1];
      sections.set(current, []);
      continue;
    }
    sections.get(current).push(line);
  }
  return { meta, sections };
}

const profileCache = new Map();

/**
 * Clear the in-process loadProfile cache. Useful for tests or when profile
 * files are edited at runtime.
 */
export function clearProfileCache() {
  profileCache.clear();
}

/**
 * Load a profile template + config by name. Cached per-process for the
 * lifetime of the module — invalidate via clearProfileCache().
 * @param {string} name
 * @returns {{ template: string, config: object }}
 */
export function loadProfile(name) {
  if (!name || typeof name !== 'string' || !/^\w+$/.test(name)) {
    throw new TypeError(`invalid profile name: ${name}`);
  }
  if (profileCache.has(name)) return profileCache.get(name);
  const dir = getProfilesDir();
  const tmplPath = path.join(dir, `${name}.md`);
  const cfgPath = path.join(dir, `${name}.config.yaml`);
  if (!existsSync(tmplPath)) {
    throw new Error(`profile template not found: ${tmplPath}`);
  }
  const template = readFileSync(tmplPath, 'utf-8');
  const config = existsSync(cfgPath)
    ? parseSimpleYaml(readFileSync(cfgPath, 'utf-8'))
    : {};
  const entry = { template, config };
  profileCache.set(name, entry);
  return entry;
}

/**
 * Replace every `{{key}}` placeholder using values from `data`.
 * Throws when any key is absent from `data` (undefined or null).
 * @param {string} template
 * @param {object} data
 * @returns {string}
 */
export function mustacheRender(template, data) {
  if (typeof template !== 'string') {
    throw new TypeError('template must be a string');
  }
  const ctx = data && typeof data === 'object' ? data : {};
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in ctx) || ctx[key] === undefined || ctx[key] === null) {
      throw new Error(`unfilled placeholder: ${key}`);
    }
    const v = ctx[key];
    return typeof v === 'string' ? v : String(v);
  });
}

/**
 * Throw if any `{{key}}` remains in the rendered text.
 * @param {string} rendered
 * @returns {void}
 */
export function assertNoUnfilled(rendered) {
  if (typeof rendered !== 'string') {
    throw new TypeError('rendered must be a string');
  }
  const m = /\{\{(\w+)\}\}/.exec(rendered);
  if (m) {
    throw new Error(`unfilled placeholder remaining: ${m[1]}`);
  }
}

/**
 * Hard-truncate text to at most `maxLines` lines.
 * @param {string} text
 * @param {number} maxLines
 * @returns {string}
 */
export function capLines(text, maxLines) {
  if (typeof text !== 'string') return '';
  if (!Number.isFinite(maxLines) || maxLines <= 0) return text;
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n');
}

/**
 * Render a profile end-to-end: load → mustache → assert → cap.
 * @param {string} name
 * @param {object} data
 * @returns {string}
 */
export function renderProfile(name, data) {
  const { template, config } = loadProfile(name);
  const rendered = mustacheRender(template, data);
  assertNoUnfilled(rendered);
  const max = Number.isFinite(config.maxLines) ? config.maxLines : 0;
  return max > 0 ? capLines(rendered, max) : rendered;
}
