/**
 * Rules resolver — wires agent frontmatter `rules:` refs to canonical CSV rules.
 *
 * Phase 2 WS-D.3: given an agent name, read its .md frontmatter, extract the
 * `rules:` flow array (entries like `"domain:rule_id"`), and return the
 * matching Rule objects from the CSV store at `plugins/artibot/rules/csv/`.
 *
 * Zero runtime deps. Korean-path safe (no pathToFileURL). Loads all rules
 * once per process and caches them alongside a per-agent resolution cache.
 * Unresolved refs are warned to stderr but never throw.
 *
 * @module lib/core/rules-resolver
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadAllRules } from './rules-csv-loader.js';
import { getPluginRoot } from './platform.js';

/** @typedef {import('./rules-csv-loader.js').Rule} Rule */

const FENCE = '---';

/** @type {Rule[] | null} */
let rulesCache = null;
/** @type {Map<string, Rule> | null} */
let ruleIndex = null;

/**
 * Absolute path to the canonical rules CSV directory.
 * @returns {string}
 */
function rulesDir() {
  return path.join(getPluginRoot(), 'rules', 'csv');
}

/**
 * Absolute path to an agent's .md file.
 * @param {string} agentName
 * @returns {string}
 */
function agentPath(agentName) {
  return path.join(getPluginRoot(), 'agents', `${agentName}.md`);
}

/**
 * Build a `domain:rule_id` -> Rule lookup map from an array of rules.
 * @param {Rule[]} rules
 * @returns {Map<string, Rule>}
 */
function buildIndex(rules) {
  const index = new Map();
  for (const rule of rules) {
    index.set(`${rule.domain}:${rule.rule_id}`, rule);
  }
  return index;
}

/**
 * Load all rules from the canonical CSV dir (cached).
 * @returns {Promise<Rule[]>}
 */
export async function getAllRules() {
  if (rulesCache) return rulesCache;
  const rules = await loadAllRules(rulesDir());
  rulesCache = rules;
  ruleIndex = buildIndex(rules);
  return rules;
}

/**
 * Ensure the rule index is primed and return it.
 * @returns {Promise<Map<string, Rule>>}
 */
async function getIndex() {
  if (!ruleIndex) await getAllRules();
  // getAllRules sets ruleIndex; the non-null assertion is safe here.
  return /** @type {Map<string, Rule>} */ (ruleIndex);
}

/**
 * Resolve a single `"domain:rule_id"` reference to a Rule, or null if not found.
 * Malformed refs (missing colon, empty parts) log to stderr and return null.
 *
 * @param {string} ref
 * @returns {Promise<Rule | null>}
 */
export async function resolveRuleByRef(ref) {
  if (typeof ref !== 'string' || !ref.includes(':')) {
    process.stderr.write(`[rules-resolver] malformed rule ref: ${JSON.stringify(ref)}\n`);
    return null;
  }
  const colonIdx = ref.indexOf(':');
  const domain = ref.slice(0, colonIdx).trim();
  const ruleId = ref.slice(colonIdx + 1).trim();
  if (!domain || !ruleId) {
    process.stderr.write(`[rules-resolver] malformed rule ref: ${JSON.stringify(ref)}\n`);
    return null;
  }
  const index = await getIndex();
  const rule = index.get(`${domain}:${ruleId}`);
  if (!rule) {
    process.stderr.write(`[rules-resolver] unresolved rule ref: ${domain}:${ruleId}\n`);
    return null;
  }
  return rule;
}

/**
 * Extract frontmatter lines between `---` fences from LF-normalized text.
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
 * Parse the `rules:` entry out of frontmatter lines.
 * Only handles the flow-array form: `rules: [a:b, c:d]`.
 * Returns an empty array when the field is missing or malformed.
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
function parseRulesField(lines) {
  for (const line of lines) {
    const match = line.match(/^rules\s*:\s*(.*)$/);
    if (!match) continue;
    const rest = match[1].trim();
    if (!rest.startsWith('[') || !rest.endsWith(']')) return [];
    const inner = rest.slice(1, -1).trim();
    if (inner === '') return [];
    return inner
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter((s) => s.length > 0);
  }
  return [];
}

/**
 * Read an agent's .md file and return its `rules:` refs (flow array form).
 * Missing files or missing frontmatter yield an empty array.
 *
 * @param {string} agentName
 * @returns {Promise<string[]>}
 */
async function readAgentRuleRefs(agentName) {
  let raw;
  try {
    raw = await readFile(agentPath(agentName), 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[rules-resolver] failed to read agent '${agentName}': ${msg}\n`);
    return [];
  }
  const text = raw.replace(/\r\n/g, '\n');
  const lines = extractFrontmatterLines(text);
  if (!lines) return [];
  return parseRulesField(lines);
}

/**
 * Resolve every `rules:` ref declared in an agent's frontmatter.
 * Deduplicated by `domain:rule_id`, preserved in original reference order.
 * Unresolved refs are warned to stderr and skipped (never thrown).
 *
 * @param {string} agentName
 * @returns {Promise<Rule[]>}
 */
export async function resolveRules(agentName) {
  const refs = await readAgentRuleRefs(agentName);
  if (refs.length === 0) return [];
  const index = await getIndex();
  const seen = new Set();
  /** @type {Rule[]} */
  const resolved = [];
  for (const ref of refs) {
    if (!ref.includes(':')) {
      process.stderr.write(`[rules-resolver] malformed rule ref: ${JSON.stringify(ref)}\n`);
      continue;
    }
    const colonIdx = ref.indexOf(':');
    const domain = ref.slice(0, colonIdx).trim();
    const ruleId = ref.slice(colonIdx + 1).trim();
    const key = `${domain}:${ruleId}`;
    if (!domain || !ruleId) {
      process.stderr.write(`[rules-resolver] malformed rule ref: ${JSON.stringify(ref)}\n`);
      continue;
    }
    if (seen.has(key)) continue;
    const rule = index.get(key);
    if (!rule) {
      process.stderr.write(`[rules-resolver] unresolved rule ref: ${key}\n`);
      continue;
    }
    seen.add(key);
    resolved.push(rule);
  }
  return resolved;
}

/**
 * Reset the in-memory caches. Test-only helper.
 * @returns {void}
 */
export function _resetResolverCache() {
  rulesCache = null;
  ruleIndex = null;
}
