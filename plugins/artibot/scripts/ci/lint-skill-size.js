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
 * Exit codes:
 *   0 — every SKILL.md is within the ceiling
 *   1 — at least one SKILL.md exceeds it
 *
 * Zero dependencies. Node 20+ built-ins only.
 *
 * @module scripts/ci/lint-skill-size
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function main() {
  const sizes = collectSkillSizes();
  const offenders = sizes.filter((s) => s.lines > MAX_SKILL_LINES);
  const largest = sizes.slice().sort((a, b) => b.lines - a.lines)[0];

  console.log(`Artibot SKILL.md size gate (ceiling: ${MAX_SKILL_LINES} lines)`);
  console.log(`  scanned ${sizes.length} skills, largest: ${largest ? `${largest.name} (${largest.lines})` : 'n/a'}`);

  if (offenders.length === 0) {
    console.log('All SKILL.md files are within the line ceiling.');
    process.exit(0);
  }

  console.log(`SKILL.md size violations (${offenders.length}):`);
  for (const o of offenders.sort((a, b) => b.lines - a.lines)) {
    console.log(`  ✗ ${o.name}: ${o.lines} lines (> ${MAX_SKILL_LINES})`);
  }
  console.log('');
  console.log('Fix: split the body into reference files loaded on-demand, keeping');
  console.log('the SKILL.md body within the progressive-disclosure ceiling.');
  process.exit(1);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
