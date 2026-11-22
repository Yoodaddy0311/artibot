#!/usr/bin/env node
/**
 * Inject `source_hash` into the YAML frontmatter of every SKILL.md.
 *
 * Idempotent — running twice produces zero diff. Hashes are computed against
 * the body content (frontmatter excluded), so adding/updating `source_hash`
 * itself never invalidates the hash.
 *
 * Phase 1 Quick Win — adopted from makabakaxy/mcp2cli benchmark.
 *
 * Usage:
 *   node plugins/artibot/scripts/inject-source-hash.js [--dry-run]
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteSync } from './utils/index.js';
import { isMainEntry } from './hooks/_main-entry.js';
import { computeHash, extractSkillBody } from '../lib/core/skill-hash.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, '..');
const SKILLS_DIR = path.join(PLUGIN_ROOT, 'skills');
const FENCE = '---';

function out(line) {
  process.stdout.write(line + '\n');
}

/**
 * Insert or update a `source_hash:` line within an existing frontmatter block.
 * Returns the new full file text.
 */
function applyHash(text, hash) {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith(FENCE)) {
    // No frontmatter — create one.
    return `---\nsource_hash: ${hash}\n---\n${normalized}`;
  }
  const lines = normalized.split('\n');
  let closingIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === FENCE) {
      closingIdx = i;
      break;
    }
  }
  if (closingIdx === -1) {
    // Malformed — prepend instead of corrupting further.
    return `---\nsource_hash: ${hash}\n---\n${normalized}`;
  }
  let updated = false;
  for (let i = 1; i < closingIdx; i++) {
    if (/^source_hash:/.test(lines[i])) {
      lines[i] = `source_hash: ${hash}`;
      updated = true;
      break;
    }
  }
  if (!updated) {
    lines.splice(closingIdx, 0, `source_hash: ${hash}`);
  }
  return lines.join('\n');
}

async function processSkill(name, file, dryRun) {
  const raw = await readFile(file, 'utf-8');
  const body = extractSkillBody(raw);
  const hash = computeHash(body);
  const next = applyHash(raw, hash);
  if (next === raw.replace(/\r\n/g, '\n')) {
    return { name, action: 'skip', hash };
  }
  // atomicWriteSync never throws (2026-11-21 review M4): false means the file still holds
  // the old text. Throwing lands it in the caller's error row instead of the update row.
  if (!dryRun && atomicWriteSync(file, next) !== true) {
    const err = new Error(`not written (cause on stderr, [artibot:atomicWrite]): ${file}`);
    throw Object.assign(err, { notWritten: true });
  }
  return { name, action: 'update', hash };
}

/**
 * Hash every `<skillsDir>/<name>/SKILL.md` and print the per-action table.
 *
 * @param {{skillsDir?: string, dryRun?: boolean}} [options] skillsDir defaults to this
 *   plugin's skills/; dryRun counts would-be updates without writing.
 * @returns {Promise<{update: number, skip: number, error: number, notWritten: number,
 *   errors: string[]}>} notWritten counts the error rows that are failed writes (the rest
 *   are read errors)
 */
export async function injectSourceHashes({ skillsDir = SKILLS_DIR, dryRun = false } = {}) {
  out(`# inject-source-hash ${dryRun ? '(dry-run)' : ''}`);
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const results = { update: 0, skip: 0, error: 0 };
  let notWritten = 0;
  const errors = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(skillsDir, entry.name, 'SKILL.md');
    try {
      const r = await processSkill(entry.name, file, dryRun);
      results[r.action]++;
    } catch (err) {
      results.error++;
      if (err.notWritten === true) notWritten++;
      errors.push(`${entry.name}: ${err.message}`);
    }
  }
  out('');
  out('| Action | Count |');
  out('|--------|-------|');
  out(`| update | ${results.update} |`);
  out(`| skip   | ${results.skip} |`);
  out(`| error  | ${results.error} |`);
  if (errors.length) {
    out('');
    out('Errors:');
    errors.forEach((e) => out(`- ${e}`));
  }
  return { ...results, notWritten, errors };
}

/**
 * CLI body. Exit code 1 when at least one SKILL.md was not written (the rule
 * migrate-command-toolsets follows); a read error alone stays 0, this script's
 * long-standing convention.
 *
 * @param {{argv?: string[], skillsDir?: string}} [options]
 * @returns {Promise<number>} the process exit code
 */
export async function main({ argv = process.argv.slice(2), skillsDir } = {}) {
  const { notWritten } = await injectSourceHashes({ skillsDir, dryRun: argv.includes('--dry-run') });
  return notWritten > 0 ? 1 : 0;
}

// Direct-run guard: importing this module (tests) must not walk and rewrite the
// real skills/. `node scripts/inject-source-hash.js` is unaffected.
if (isMainEntry(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    process.stderr.write(`[inject-source-hash] error: ${err.message}\n`);
    process.exit(1);
  });
}
