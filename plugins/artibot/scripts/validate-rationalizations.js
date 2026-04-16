#!/usr/bin/env node
/**
 * Rationalizations Section Validator
 *
 * Warn-only validator that scans every `plugins/artibot/skills/{skill}/SKILL.md`
 * file and reports which skills are missing the `## Rationalizations` section.
 *
 * The Rationalizations section is a GFM table of "Excuse" / "Rebuttal" pairs
 * adopted from addyosmani/agent-skills. It helps agents catch and resist
 * common shortcuts when executing a skill.
 *
 * Exit code is always 0 — this script never blocks CI or hooks. It only
 * surfaces a Markdown report so coverage can be improved incrementally.
 *
 * Usage:
 *   node plugins/artibot/scripts/validate-rationalizations.js
 *
 * Zero dependencies. Node >=18 required (ESM, top-level await).
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.resolve(HERE, '..', 'skills');
const SECTION_REGEX = /^## Rationalizations\s*$/m;

/**
 * Enumerate every `{skill}/SKILL.md` file under the skills directory.
 * Uses only `fs/promises` — no glob dependency.
 *
 * @param {string} root - Absolute path to the skills directory.
 * @returns {Promise<string[]>} Sorted absolute paths to SKILL.md files.
 */
async function findSkillFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name, 'SKILL.md');
    try {
      const info = await stat(candidate);
      if (info.isFile()) results.push(candidate);
    } catch {
      // No SKILL.md in this directory — skip silently.
    }
  }
  return results.sort();
}

/**
 * Check whether the given SKILL.md file contains a Rationalizations section.
 *
 * @param {string} filePath - Absolute path to SKILL.md.
 * @returns {Promise<boolean>} True if the section header is present.
 */
async function hasRationalizations(filePath) {
  const content = await readFile(filePath, 'utf8');
  return SECTION_REGEX.test(content);
}

/**
 * Derive the skill name (parent directory) from a SKILL.md path.
 *
 * @param {string} filePath - Absolute path to SKILL.md.
 * @returns {string} Skill directory name.
 */
function skillNameOf(filePath) {
  return path.basename(path.dirname(filePath));
}

/**
 * Format the missing-skills report as a GFM table.
 *
 * @param {string[]} missing - Skill directory names lacking the section.
 * @param {number} total - Total skill count scanned.
 * @returns {string} Markdown report body.
 */
function formatReport(missing, total) {
  const header = `# Rationalizations Coverage Report\n\n`;
  const summary =
    `- Total skills scanned: ${total}\n` +
    `- Skills with \`## Rationalizations\`: ${total - missing.length}\n` +
    `- Skills missing the section: ${missing.length}\n\n`;

  if (missing.length === 0) {
    return `${header}${summary}All skills contain a Rationalizations section.\n`;
  }

  const tableHeader = `| # | Skill | Status |\n|---|-------|--------|\n`;
  const rows = missing
    .map((name, idx) => `| ${idx + 1} | \`${name}\` | missing |`)
    .join('\n');
  return `${header}${summary}## Skills Missing \`## Rationalizations\`\n\n${tableHeader}${rows}\n`;
}

/**
 * Entry point. Always exits 0 (warn-only).
 */
async function main() {
  const files = await findSkillFiles(SKILLS_DIR);
  const missing = [];
  for (const file of files) {
    const present = await hasRationalizations(file);
    if (!present) missing.push(skillNameOf(file));
  }
  const report = formatReport(missing, files.length);
  process.stdout.write(report);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[validate-rationalizations] ${err.message}\n`);
  process.exit(0);
});
