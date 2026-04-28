#!/usr/bin/env node
/**
 * SessionStart hook — Lightweight skill validation check.
 * Scans skill directories for missing SKILL.md files or invalid frontmatter.
 * Reports issues at session start so the user is aware of broken skills.
 * Runs once per session (hooks.json: once: true).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';

/**
 * Check if a skill directory has a valid SKILL.md with required frontmatter.
 *
 * @param {string} skillDir
 * @returns {{ name: string, issues: string[] }}
 */
function checkSkill(skillDir) {
  const name = path.basename(skillDir);
  const issues = [];
  const skillMd = path.join(skillDir, 'SKILL.md');

  try {
    const content = readFileSync(skillMd, 'utf-8');

    // Check frontmatter exists
    if (!content.startsWith('---')) {
      issues.push('missing frontmatter');
      return { name, issues };
    }

    const endIdx = content.indexOf('---', 3);
    if (endIdx === -1) {
      issues.push('unclosed frontmatter');
      return { name, issues };
    }

    const frontmatter = content.slice(3, endIdx);

    // Check required fields
    for (const field of ['name', 'description', 'context', 'triggers']) {
      if (!frontmatter.includes(`${field}:`)) {
        issues.push(`missing field: ${field}`);
      }
    }

    // Warning (non-blocking): check for whenNotToUse field
    if (!frontmatter.includes('whenNotToUse:')) {
      console.warn(`[skill-validation] Missing whenNotToUse: ${skillMd}`);
    }
  } catch {
    issues.push('SKILL.md not found or unreadable');
  }

  return { name, issues };
}

async function main() {
  const raw = await readStdin();
  parseJSON(raw);

  // Find skills directory
  const hookFile = fileURLToPath(import.meta.url);
  const pluginRoot = path.resolve(path.dirname(hookFile), '..', '..');
  const skillsDir = path.join(pluginRoot, 'skills');

  let entries;
  try {
    entries = readdirSync(skillsDir);
  } catch {
    // Skills directory doesn't exist — not an error, just skip
    return;
  }

  const broken = [];
  for (const entry of entries) {
    const fullPath = path.join(skillsDir, entry);
    try {
      if (!statSync(fullPath).isDirectory()) continue;
    } catch {
      continue;
    }

    const result = checkSkill(fullPath);
    if (result.issues.length > 0) {
      broken.push(result);
    }
  }

  if (broken.length === 0) return;

  const lines = [`[skill-check] ${broken.length} skill(s) with issues:`];
  for (const skill of broken.slice(0, 5)) {
    lines.push(`  - ${skill.name}: ${skill.issues.join(', ')}`);
  }
  if (broken.length > 5) {
    lines.push(`  ... and ${broken.length - 5} more. Run: npm run skill:check`);
  }

  writeStdout({ message: lines.join('\n') });
}

main().catch(createErrorHandler('skill-validation-check', { exit: true }));
