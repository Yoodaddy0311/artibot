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
import { isMainEntry } from './_main-entry.js';

/**
 * Retired skills that were physically removed from `skills/` in past redesigns.
 * If any of these reappears as a directory it is almost certainly a stale
 * restore / merge artifact (a "phantom") rather than an intentional revival, so
 * we surface it loudly. Keep this list short and append-only.
 *
 * - voyager-curation: removed in the 2026-06 lean redesign together with
 *   `lib/learning/voyager/`; its skill count claims were resynced 114 -> 113.
 *
 * @type {ReadonlyArray<string>}
 */
const RETIRED_SKILLS = Object.freeze(['voyager-curation']);

/**
 * Reverse-validation: detect skill names that should NOT be present on disk.
 *
 * The skill "registry" is a live `skills/*` directory scan, so a classic
 * "registry entry without a directory" phantom can only originate from a
 * retired skill being re-materialised. This guard flags any retired skill whose
 * directory has crept back, preventing silent phantom recurrence.
 *
 * @param {string[]} entries - directory entries under `skills/`.
 * @returns {Array<{ name: string, issues: string[] }>}
 */
function checkPhantoms(entries) {
  const present = new Set(entries);
  const phantoms = [];
  for (const retired of RETIRED_SKILLS) {
    if (present.has(retired)) {
      phantoms.push({
        name: retired,
        issues: ['retired skill reappeared (phantom — should not exist on disk)'],
      });
    }
  }
  return phantoms;
}

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

export async function main() {
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

  // Reverse-validation first: flag retired skills that crept back onto disk.
  for (const phantom of checkPhantoms(entries)) {
    broken.push(phantom);
  }

  for (const entry of entries) {
    // Retired skills are already reported by checkPhantoms above — skip here so a
    // revived-but-malformed retired dir is not double-counted in `broken`.
    if (RETIRED_SKILLS.includes(entry)) continue;

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

// Direct-run guard: importing this module (tests) must not execute the hook.
// main() blocks on stdin, so an import both hangs the importer and fires the
// hook's side effects. Production is unaffected — the dispatcher (or Claude
// Code) spawns this file as argv[1], so the guard passes there.
if (isMainEntry(import.meta.url)) {
  main().catch(createErrorHandler('skill-validation-check', { exit: true }));
}
