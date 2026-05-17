/**
 * Goal Contract template loader (v4.10.0 Track G).
 *
 * Reads pre-made YAML contracts from `lib/autopilot/contract-templates/` so
 * callers can scaffold a Goal Contract without writing YAML by hand.
 *
 * Reuses `parseSimpleYaml` from profile-renderer for the array (`include`)
 * and numeric fields, then layers a thin string-field parser on top for
 * Goal-Contract-specific keys (`objective`, `stoppingCondition`,
 * `validationCommand`, `forbiddenChanges`, `maxIterations`).
 *
 * Zero deps — only node:fs.
 *
 * Public surface:
 *   - loadTemplate(name)
 *   - listTemplates()
 *   - getTemplatesDir()
 *   - clearTemplateCache()
 *
 * @module lib/autopilot/template-loader
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSimpleYaml } from './profile-renderer.js';

/** Fields that may appear as comma-separated arrays inside `[...]`. */
const ARRAY_FIELDS = new Set(['forbiddenChanges', 'include']);

/** Fields parsed as integers. */
const INTEGER_FIELDS = new Set(['maxIterations', 'maxLines', 'minLines']);

/** Fields parsed as plain strings (no quote-stripping if already bare). */
const STRING_FIELDS = new Set([
  'name', 'objective', 'stoppingCondition', 'validationCommand', 'description',
]);

/**
 * Resolve the contract-templates dir; survives Korean / spaced paths via
 * import.meta.dirname (Node >=20.11) with a URL fallback.
 *
 * @returns {string}
 */
export function getTemplatesDir() {
  const dir = import.meta.dirname || path.dirname(fileURLToPath(import.meta.url));
  return path.join(dir, 'contract-templates');
}

/**
 * Strip a leading `#` comment from a line; preserves the body otherwise.
 *
 * @param {string} line
 * @returns {string}
 */
function stripComment(line) {
  const idx = line.indexOf(' #');
  return idx === -1 ? line : line.slice(0, idx);
}

/**
 * Parse a single `key: value` line into a typed entry. Returns null when the
 * line is blank, a comment, or malformed.
 *
 * Numeric & array semantics piggy-back on parseSimpleYaml — we run it over
 * the single-line snippet so array bracket-stripping stays in one place.
 *
 * @param {string} line
 * @returns {{ key: string, value: unknown }|null}
 */
function parseLine(line) {
  const trimmed = stripComment(line).trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const match = /^(\w+)\s*:\s*(.*)$/.exec(trimmed);
  if (!match) return null;
  const [, key, raw] = match;
  if (raw === '') return { key, value: '' };
  if (ARRAY_FIELDS.has(key) && /^\[.*\]$/.test(raw)) {
    const parsed = parseSimpleYaml(`include: ${raw}`);
    return { key, value: Array.isArray(parsed.include) ? parsed.include : [] };
  }
  if (INTEGER_FIELDS.has(key)) {
    const n = Number(raw);
    return { key, value: Number.isFinite(n) ? n : null };
  }
  if (STRING_FIELDS.has(key)) {
    return { key, value: raw.replace(/^['"]|['"]$/g, '') };
  }
  // Unknown key: passthrough as trimmed string for forward-compat.
  return { key, value: raw.replace(/^['"]|['"]$/g, '') };
}

/**
 * Parse a Goal Contract YAML body into a plain object. Comments and blank
 * lines are ignored. Unknown keys are preserved as strings.
 *
 * @param {string} text
 * @returns {object}
 */
function parseTemplate(text) {
  if (typeof text !== 'string') return {};
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const entry = parseLine(line);
    if (entry !== null) out[entry.key] = entry.value;
  }
  return out;
}

const templateCache = new Map();

/**
 * Clear the per-process template cache. Tests / hot-reload only.
 */
export function clearTemplateCache() {
  templateCache.clear();
}

/**
 * Validate a template name against the same character class accepted by the
 * profile loader. Keeps callers from traversing out of the templates dir.
 *
 * @param {string} name
 * @returns {boolean}
 */
function isValidName(name) {
  return typeof name === 'string' && /^[\w-]+$/.test(name);
}

/**
 * Load a contract template by bare name (no extension). Throws on invalid
 * name or missing file. Cached per-process; call `clearTemplateCache` to
 * force re-read.
 *
 * @param {string} name
 * @returns {object} parsed contract template
 */
export function loadTemplate(name) {
  if (!isValidName(name)) {
    throw new TypeError(`invalid template name: ${name}`);
  }
  if (templateCache.has(name)) return templateCache.get(name);
  const file = path.join(getTemplatesDir(), `${name}.yaml`);
  if (!existsSync(file)) {
    throw new Error(`template not found: ${file}`);
  }
  const raw = readFileSync(file, 'utf-8');
  const parsed = parseTemplate(raw);
  templateCache.set(name, parsed);
  return parsed;
}

/**
 * List available template names (without `.yaml` extension), sorted
 * alphabetically. Missing directory returns an empty array.
 *
 * @returns {string[]}
 */
export function listTemplates() {
  const dir = getTemplatesDir();
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((n) => n.endsWith('.yaml'))
    .map((n) => n.slice(0, -5))
    .sort();
}
