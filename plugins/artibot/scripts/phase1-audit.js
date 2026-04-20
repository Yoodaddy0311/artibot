#!/usr/bin/env node
/**
 * Phase 1 Quick Wins audit.
 *
 * Reports the current state of three Phase 1 deliverables across the plugin:
 *   1. Skills missing the `## Rationalizations` section
 *   2. Skills with stale or missing `source_hash` frontmatter
 *   3. Commands missing the `toolset:` frontmatter assignment
 *
 * Always exits 0 — advisory output only, never blocks.
 *
 * Usage: node plugins/artibot/scripts/phase1-audit.js
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, '..');
const SKILLS_DIR = path.join(PLUGIN_ROOT, 'skills');
const COMMANDS_DIR = path.join(PLUGIN_ROOT, 'commands');

const RATIONALIZATIONS_HEADER = /^## Rationalizations\s*$/m;

async function listSkillFiles() {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      files.push({ name: e.name, file: path.join(SKILLS_DIR, e.name, 'SKILL.md') });
    }
  }
  return files;
}

async function listCommandFiles() {
  const entries = await readdir(COMMANDS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => ({ name: e.name.replace(/\.md$/, ''), file: path.join(COMMANDS_DIR, e.name) }));
}

async function auditRationalizations(skills) {
  const missing = [];
  for (const { name, file } of skills) {
    try {
      const raw = await readFile(file, 'utf-8');
      if (!RATIONALIZATIONS_HEADER.test(raw)) missing.push(name);
    } catch {
      missing.push(`${name} (unreadable)`);
    }
  }
  return missing;
}

async function auditSourceHash(skills) {
  const { verifyHash } = await import('../lib/core/skill-hash.js');
  const missing = [];
  const stale = [];
  for (const { name, file } of skills) {
    try {
      const result = await verifyHash(file);
      if (!result.stored) {
        missing.push(name);
      } else if (!result.match) {
        stale.push(`${name} (stored=${result.stored} current=${result.current})`);
      }
    } catch {
      missing.push(`${name} (error)`);
    }
  }
  return { missing, stale };
}

async function auditToolsets(commands) {
  const missing = [];
  for (const { name, file } of commands) {
    try {
      const raw = await readFile(file, 'utf-8');
      const text = raw.replace(/\r\n/g, '\n');
      if (!text.startsWith('---')) {
        missing.push(`${name} (no frontmatter)`);
        continue;
      }
      const fmEnd = text.indexOf('\n---', 3);
      const block = fmEnd === -1 ? text : text.slice(0, fmEnd);
      if (!/^toolset:\s*\S+/m.test(block)) missing.push(name);
    } catch {
      missing.push(`${name} (unreadable)`);
    }
  }
  return missing;
}

function out(line) {
  process.stdout.write(line + '\n');
}

function printSection(title, items, total) {
  out('');
  out(`## ${title}`);
  out('');
  out(`**${items.length} of ${total}** items missing.`);
  out('');
  if (items.length === 0) {
    out('All clear.');
    return;
  }
  out('| # | Item |');
  out('|---|------|');
  items.slice(0, 50).forEach((item, i) => out(`| ${i + 1} | ${item} |`));
  if (items.length > 50) out(`| ... | (${items.length - 50} more) |`);
}

async function main() {
  out('# Phase 1 Quick Wins — Audit Report');
  out('');
  out(`Generated: ${new Date().toISOString()}`);

  const skills = await listSkillFiles();
  const commands = await listCommandFiles();

  const missingRationalizations = await auditRationalizations(skills);
  const { missing: missingHash, stale: staleHash } = await auditSourceHash(skills);
  const missingToolset = await auditToolsets(commands);

  printSection('Skills missing `## Rationalizations`', missingRationalizations, skills.length);
  printSection('Skills missing `source_hash` frontmatter', missingHash, skills.length);
  printSection('Skills with stale `source_hash`', staleHash, skills.length);
  printSection('Commands missing `toolset:` frontmatter', missingToolset, commands.length);

  out('');
  out('---');
  out('');
  out(`Summary: ${skills.length} skills, ${commands.length} commands scanned.`);
}

main().catch((err) => {
  process.stderr.write(`[phase1-audit] error: ${err.message}\n`);
  process.exit(0);
});
