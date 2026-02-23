/**
 * Skill Injector.
 * Injects user-extracted rules into skill SKILL.md files as a
 * project-specific rules section, preventing duplicate injections
 * via a content-addressed injection log.
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

/** Header appended to SKILL.md when project rules section is first created */
const PROJECT_RULES_HEADER = '\n## Project-Specific Rules\n\n' +
  '> Auto-injected from conversation history. Do not edit manually.\n';

/** Sentinel comment used to locate the project-rules section in SKILL.md */
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

/**
 * Inject new rule lines into existing SKILL.md text.
 * If the project-rules section doesn't exist, creates it at the end.
 * Returns the updated content string (immutable transformation).
 *
 * @param {string} originalContent - Current SKILL.md text
 * @param {string[]} newLines - Formatted rule lines to add
 * @returns {string}
 */
function injectIntoContent(originalContent, newLines) {
  if (newLines.length === 0) return originalContent;

  const addendum = newLines.join('\n');

  if (originalContent.includes(SECTION_SENTINEL)) {
    // Append after the sentinel (at end of existing section)
    const idx = originalContent.indexOf(SECTION_SENTINEL);
    // Find the end of the section header line
    const endOfHeader = originalContent.indexOf('\n', idx) + 1;
    const before = originalContent.slice(0, endOfHeader);
    const after = originalContent.slice(endOfHeader);
    return `${before}${addendum}\n${after}`;
  }

  // No section yet: append header + rules at the end
  const base = originalContent.trimEnd();
  return `${base}\n${PROJECT_RULES_HEADER}${addendum}\n`;
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
 * Inject extracted rules into a target skill's SKILL.md.
 * Rules already present in the injection log are silently skipped.
 * Returns an updated skill context object for downstream use.
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
  const newLines = [];
  const newLogRecords = [];
  const injectedContents = [];
  let skipped = 0;

  for (const rule of rules) {
    const hash = ruleHash(rule.type, rule.content);
    if (alreadyInjected.has(hash)) {
      skipped++;
      continue;
    }
    newLines.push(formatRuleLine(rule));
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

  if (newLines.length > 0) {
    const original = await readSkillMd(targetSkill);
    const updated = injectIntoContent(original, newLines);
    await writeSkillMd(targetSkill, updated);
    await appendInjectionLog(newLogRecords);
  }

  return {
    skillName: targetSkill,
    injected: newLines.length,
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
 * Clear all injected rules for a given skill.
 * Removes injection log entries and strips the project-rules section from SKILL.md.
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

  // Strip project-rules section from SKILL.md if it exists
  if (await skillExists(skillName)) {
    const original = await readSkillMd(skillName);
    if (original.includes(SECTION_SENTINEL)) {
      const idx = original.indexOf(SECTION_SENTINEL);
      // Also strip the preceding blank line(s)
      const stripped = original.slice(0, idx).trimEnd();
      await writeSkillMd(skillName, stripped + '\n');
    }
  }

  return { cleared };
}
