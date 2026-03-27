/**
 * Skill Injector.
 * Injects auto-learned rules into skill references/ directories as JSON,
 * preventing duplicate injections via a content-addressed injection log.
 *
 * Rules are stored in `skills/<name>/references/auto-learned-rules.json`
 * (inside the auto-commit allowlist) rather than modifying SKILL.md
 * (which is on the auto-commit denylist).
 *
 * Supported injection targets: coding-standards, frontend-patterns, testing-standards
 * (and any other skill directory under the plugin's skills/ directory).
 *
 * @module lib/learning/skill-injector
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { ensureDir, readJsonFile, writeJsonFile } from '../core/file.js';
import { ARTIBOT_DIR } from '../core/config.js';
import { getPluginRoot } from '../core/platform.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INJECTION_LOG_PATH = path.join(ARTIBOT_DIR, 'skill-injection-log.json');

/** Filename for auto-learned rules stored in skill references/ directory */
const AUTO_LEARNED_RULES_FILE = 'auto-learned-rules.json';

/** Sentinel used to locate the legacy project-rules section in SKILL.md */
const SECTION_SENTINEL = '## Project-Specific Rules';

const MAX_INJECTION_LOG = 2000;

// ---------------------------------------------------------------------------
// Injection Log
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} InjectionRecord
 * @property {string} skillName - Target skill directory name
 * @property {string} ruleHash - SHA-like content hash of type+content
 * @property {string} type - Rule type
 * @property {string} content - Rule content text
 * @property {string} injectedAt - ISO timestamp
 */

/**
 * Load the injection log from disk.
 * @returns {Promise<InjectionRecord[]>}
 */
async function loadInjectionLog() {
  const data = await readJsonFile(INJECTION_LOG_PATH);
  return Array.isArray(data) ? data : [];
}

/**
 * Append records to the injection log and persist.
 * @param {InjectionRecord[]} newRecords
 * @returns {Promise<void>}
 */
async function appendInjectionLog(newRecords) {
  if (newRecords.length === 0) return;
  const log = await loadInjectionLog();
  const merged = [...log, ...newRecords];
  const pruned = merged.length > MAX_INJECTION_LOG
    ? merged.slice(merged.length - MAX_INJECTION_LOG)
    : merged;
  await writeJsonFile(INJECTION_LOG_PATH, pruned);
}

/**
 * Build a lightweight content hash string for a rule (no crypto dependency).
 * Uses a simple djb2-style hash over type+content.
 * @param {string} type
 * @param {string} content
 * @returns {string}
 */
function ruleHash(type, content) {
  const str = `${type}::${content.toLowerCase().trim()}`;
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
    h = h >>> 0; // keep 32-bit unsigned
  }
  return h.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Skill Path Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to a skill's SKILL.md file.
 * @param {string} skillName - Skill directory name (e.g. 'coding-standards')
 * @returns {string}
 */
function getSkillMdPath(skillName) {
  return path.join(getPluginRoot(), 'skills', skillName, 'SKILL.md');
}

/**
 * Resolve the absolute path to a skill's auto-learned-rules.json in references dir.
 * This path is within the auto-commit allowlist.
 * @param {string} skillName
 * @returns {string}
 */
function getAutoLearnedRulesPath(skillName) {
  return path.join(getPluginRoot(), 'skills', skillName, 'references', AUTO_LEARNED_RULES_FILE);
}

/**
 * Read existing auto-learned rules from references/ JSON file.
 * @param {string} skillName
 * @returns {Promise<Array<{ type: string, content: string, injectedAt: string }>>}
 */
async function readAutoLearnedRules(skillName) {
  const data = await readJsonFile(getAutoLearnedRulesPath(skillName));
  return Array.isArray(data) ? data : [];
}

/**
 * Write auto-learned rules to references/ JSON file.
 * @param {string} skillName
 * @param {Array<{ type: string, content: string, injectedAt: string }>} rules
 * @returns {Promise<void>}
 */
async function writeAutoLearnedRules(skillName, rules) {
  const refsDir = path.join(getPluginRoot(), 'skills', skillName, 'references');
  await ensureDir(refsDir);
  await writeJsonFile(getAutoLearnedRulesPath(skillName), rules);
}

/**
 * Check if a skill exists (SKILL.md is present).
 * @param {string} skillName
 * @returns {Promise<boolean>}
 */
async function skillExists(skillName) {
  try {
    await fs.access(getSkillMdPath(skillName));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Skill SKILL.md Manipulation (Immutable Read → Transform → Write)
// ---------------------------------------------------------------------------

/**
 * Read SKILL.md content, returning empty string if missing.
 * @param {string} skillName
 * @returns {Promise<string>}
 */
async function readSkillMd(skillName) {
  try {
    return await fs.readFile(getSkillMdPath(skillName), 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Write updated content back to SKILL.md.
 * @param {string} skillName
 * @param {string} content
 * @returns {Promise<void>}
 */
async function writeSkillMd(skillName, content) {
  const skillDir = path.join(getPluginRoot(), 'skills', skillName);
  await ensureDir(skillDir);
  await fs.writeFile(getSkillMdPath(skillName), content, 'utf-8');
}

/**
 * Format a single rule as a markdown bullet point.
 * @param {{ type: string, content: string }} rule
 * @returns {string}
 */
function formatRuleLine(rule) {
  const typeLabel = {
    preference: '[preference]',
    prohibition: '[prohibition]',
    decision: '[decision]',
    'tool-preference': '[tool]',
  }[rule.type] ?? `[${rule.type}]`;
  return `- ${typeLabel} ${rule.content}`;
}

// ---------------------------------------------------------------------------
// Source of Truth URL Parsing
// ---------------------------------------------------------------------------

/**
 * Parse SKILL.md frontmatter to extract `sources:` field.
 * Returns an array of source URLs that agents can fetch for live documentation.
 * @param {string} content - SKILL.md file content
 * @returns {string[]} Array of source URLs (empty if none)
 */
function parseSourcesFromFrontmatter(content) {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return [];

  const yamlBlock = fmMatch[1];
  const sources = [];

  // Match inline array: sources: ["url1", "url2"]
  const inlineMatch = yamlBlock.match(/^sources\s*:\s*\[([^\]]*)\]/m);
  if (inlineMatch) {
    return inlineMatch[1]
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }

  // Match dash-list:
  //   sources:
  //     - "url1"
  //     - "url2"
  const lines = yamlBlock.split('\n');
  let inSources = false;
  for (const line of lines) {
    if (/^sources\s*:\s*$/.test(line)) {
      inSources = true;
      continue;
    }
    if (inSources) {
      const dashMatch = line.match(/^\s+-\s+["']?([^"'\s]+)["']?/);
      if (dashMatch) {
        sources.push(dashMatch[1]);
      } else if (/^\S/.test(line)) {
        break; // next top-level key
      }
    }
  }

  return sources;
}

/**
 * Build a context hint string for agents, listing source-of-truth URLs.
 * Returns empty string if no sources are defined.
 * @param {string[]} sources - Array of source URLs
 * @returns {string}
 */
function formatSourcesHint(sources) {
  if (!sources || sources.length === 0) return '';
  const urlList = sources.map((url) => `  - ${url}`).join('\n');
  return (
    `\n## Source of Truth\n` +
    `The following URLs provide live, up-to-date documentation for this skill.\n` +
    `Fetch these when you need the latest API specs, SDK changes, or best practices:\n` +
    `${urlList}\n`
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} InjectionResult
 * @property {string} skillName
 * @property {number} injected - Number of new rules written
 * @property {number} skipped - Number of duplicate rules skipped
 * @property {string[]} injectedContents - The rule content strings that were injected
 */

/**
 * Inject extracted rules into a target skill's references/ directory.
 * Rules are stored in `references/auto-learned-rules.json` (within the
 * auto-commit allowlist) rather than modifying SKILL.md (on the denylist).
 * Rules already present in the injection log are silently skipped.
 *
 * @param {Array<{ type: string, content: string, [key: string]: unknown }>} rules
 * @param {string} targetSkill - Skill directory name (e.g. 'coding-standards')
 * @returns {Promise<InjectionResult>}
 */
export async function injectRules(rules, targetSkill) {
  if (!rules || rules.length === 0) {
    return { skillName: targetSkill, injected: 0, skipped: 0, injectedContents: [] };
  }

  await ensureDir(ARTIBOT_DIR);

  const exists = await skillExists(targetSkill);
  if (!exists) {
    return { skillName: targetSkill, injected: 0, skipped: rules.length, injectedContents: [] };
  }

  // Load current log to check for duplicates
  const log = await loadInjectionLog();
  const alreadyInjected = new Set(
    log
      .filter((r) => r.skillName === targetSkill)
      .map((r) => r.ruleHash),
  );

  const now = new Date().toISOString();
  const newEntries = [];
  const newLogRecords = [];
  const injectedContents = [];
  let skipped = 0;

  for (const rule of rules) {
    const hash = ruleHash(rule.type, rule.content);
    if (alreadyInjected.has(hash)) {
      skipped++;
      continue;
    }
    newEntries.push({
      type: rule.type,
      content: rule.content,
      formatted: formatRuleLine(rule),
      injectedAt: now,
    });
    newLogRecords.push({
      skillName: targetSkill,
      ruleHash: hash,
      type: rule.type,
      content: rule.content,
      injectedAt: now,
    });
    injectedContents.push(rule.content);
    alreadyInjected.add(hash);
  }

  if (newEntries.length > 0) {
    // Write to references/auto-learned-rules.json (auto-commit allowlist)
    const existing = await readAutoLearnedRules(targetSkill);
    const merged = [...existing, ...newEntries];
    await writeAutoLearnedRules(targetSkill, merged);
    await appendInjectionLog(newLogRecords);
  }

  return {
    skillName: targetSkill,
    injected: newEntries.length,
    skipped,
    injectedContents,
  };
}

/**
 * Get all injected rules for a given skill (or all skills if omitted).
 *
 * @param {string} [skillName] - Filter by skill; returns all if omitted
 * @returns {Promise<InjectionRecord[]>}
 */
export async function getInjectedRules(skillName) {
  const log = await loadInjectionLog();
  return skillName ? log.filter((r) => r.skillName === skillName) : log;
}

/**
 * Get source-of-truth URLs for a given skill by parsing its SKILL.md frontmatter.
 * Returns an object with the raw URLs and a formatted hint string for agent context.
 *
 * @param {string} skillName - Skill directory name (e.g. 'lang-typescript')
 * @returns {Promise<{ sources: string[], hint: string }>}
 */
export async function getSkillSources(skillName) {
  const exists = await skillExists(skillName);
  if (!exists) return { sources: [], hint: '' };

  const content = await readSkillMd(skillName);
  const sources = parseSourcesFromFrontmatter(content);
  const hint = formatSourcesHint(sources);
  return { sources, hint };
}

/**
 * Clear all injected rules for a given skill.
 * Removes injection log entries and deletes references/auto-learned-rules.json.
 * Also strips legacy project-rules section from SKILL.md if present.
 *
 * @param {string} skillName
 * @returns {Promise<{ cleared: number }>}
 */
export async function clearInjections(skillName) {
  const log = await loadInjectionLog();
  const remaining = log.filter((r) => r.skillName !== skillName);
  const cleared = log.length - remaining.length;

  // Persist trimmed log
  await ensureDir(ARTIBOT_DIR);
  await writeJsonFile(INJECTION_LOG_PATH, remaining);

  // Remove auto-learned rules JSON file
  try {
    await fs.unlink(getAutoLearnedRulesPath(skillName));
  } catch {
    // File may not exist — non-critical
  }

  // Legacy cleanup: strip project-rules section from SKILL.md if present
  if (await skillExists(skillName)) {
    const original = await readSkillMd(skillName);
    if (original.includes(SECTION_SENTINEL)) {
      const idx = original.indexOf(SECTION_SENTINEL);
      const stripped = original.slice(0, idx).trimEnd();
      await writeSkillMd(skillName, stripped + '\n');
    }
  }

  return { cleared };
}
