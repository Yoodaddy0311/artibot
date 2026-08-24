#!/usr/bin/env node
/**
 * lint-skill-size.js — Fail if any SKILL.md exceeds the progressive-disclosure
 * line ceiling.
 *
 * Claude Code Agent Skills load the full SKILL.md body into context when the
 * skill matches a task. Oversized bodies defeat progressive disclosure (the
 * whole point is name+description at ~100 tokens, body on-demand, reference
 * files bash-loaded). The platform guidance is to keep bodies small and split
 * overflow into reference files. This ratchet enforces a hard 500-line ceiling
 * so the 114-skill (and growing) surface cannot silently bloat.
 *
 * Scope: EVERY project plugin root, not just `plugins/artibot/`. Until
 * 2026-08-16 this scanned one hardcoded root, so cowork's 46 skills were never
 * measured and the gate still printed a PASS — see
 * `scripts/ci/skill-scan-roots.js` for the denominator machinery that makes
 * "0 violations" distinguishable from "0 files examined".
 *
 * Exit codes:
 *   0 — every SKILL.md is within the ceiling
 *   1 — at least one SKILL.md exceeds it, or a denominator floor was missed
 *
 * Zero dependencies. Node 20+ built-ins only.
 *
 * @module scripts/ci/lint-skill-size
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertEntityFloors, countByRoot, listAllSkillFiles } from './skill-scan-roots.js';
import { isMainEntry } from '../hooks/_main-entry.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(scriptDir, '..', '..');
export const MAX_SKILL_LINES = 500;

/**
 * Collect every skills/<name>/SKILL.md and its line count.
 * @param {string} [pluginRoot]
 * @returns {{ name: string, file: string, lines: number }[]}
 */
export function collectSkillSizes(pluginRoot = PLUGIN_ROOT) {
  const skillsDir = path.join(pluginRoot, 'skills');
  let entries;
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return [];
  }
  const sizes = [];
  for (const name of entries) {
    const file = path.join(skillsDir, name, 'SKILL.md');
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue; // no SKILL.md in this dir
    }
    if (!stat.isFile()) continue;
    const lines = readFileSync(file, 'utf-8').split('\n').length;
    sizes.push({ name, file, lines });
  }
  return sizes;
}

/**
 * @param {string} [pluginRoot]
 * @param {number} [max]
 * @returns {{ name: string, file: string, lines: number }[]} offenders over `max`
 */
export function findOversizedSkills(pluginRoot = PLUGIN_ROOT, max = MAX_SKILL_LINES) {
  return collectSkillSizes(pluginRoot).filter((s) => s.lines > max);
}

/**
 * Collect SKILL.md line counts across every project plugin root.
 *
 * @returns {{ key: string, rootName: string, file: string, lines: number }[]}
 *   `key` is the root-qualified name (`artibot-cowork/social-media`).
 */
export function collectAllSkillSizes() {
  return listAllSkillFiles().map(({ key, rootName, file }) => ({
    key,
    rootName,
    file,
    lines: readFileSync(file, 'utf-8').split('\n').length,
  }));
}

function main() {
  const sizes = collectAllSkillSizes();
  const offenders = sizes.filter((s) => s.lines > MAX_SKILL_LINES);
  const largest = sizes.slice().sort((a, b) => b.lines - a.lines)[0];
  const perRoot = countByRoot(sizes);
  const floorFailures = assertEntityFloors('skills', perRoot);

  console.log(`Artibot SKILL.md size gate (ceiling: ${MAX_SKILL_LINES} lines)`);
  console.log(
    `  scanned ${sizes.length} skills across ${Object.keys(perRoot).length} root(s): ` +
      Object.entries(perRoot)
        .map(([r, n]) => `${r}=${n}`)
        .join(' '),
  );
  console.log(`  largest: ${largest ? `${largest.key} (${largest.lines})` : 'n/a'}`);

  // Denominator first: a floor miss means the numbers above are not evidence of
  // anything, so report it before (and independently of) the violation list.
  if (floorFailures.length > 0) {
    console.error(`\nFAIL: skill scan denominator (${floorFailures.length}):`);
    for (const f of floorFailures) console.error(`  - ${f}`);
  }

  if (offenders.length > 0) {
    console.error(`\nSKILL.md size violations (${offenders.length}):`);
    for (const o of offenders.sort((a, b) => b.lines - a.lines)) {
      console.error(`  ✗ ${o.key}: ${o.lines} lines (> ${MAX_SKILL_LINES})`);
    }
    console.error('');
    console.error('Fix: split the body into reference files loaded on-demand, keeping');
    console.error('the SKILL.md body within the progressive-disclosure ceiling.');
  }

  if (floorFailures.length > 0 || offenders.length > 0) process.exit(1);

  console.log('All SKILL.md files are within the line ceiling.');
  process.exit(0);
}

const invokedDirectly = isMainEntry(import.meta.url);
if (invokedDirectly) main();
