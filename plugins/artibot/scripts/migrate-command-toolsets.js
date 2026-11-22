#!/usr/bin/env node
/**
 * Migration script: inject `toolset:` field into the YAML frontmatter of every
 * command file under `plugins/artibot/commands/`, using `toolsets.json` as the
 * source of truth.
 *
 * Pattern adopted from NousResearch/hermes-agent. Part of Phase 1 Quick Wins
 * Sub-Phase 3.
 *
 * Usage:
 *   node plugins/artibot/scripts/migrate-command-toolsets.js [--dry-run]
 *
 * Behavior per command file:
 *   - Has frontmatter w/ `toolset:` -> SKIP
 *   - Has frontmatter w/o `toolset:` -> INSERT before closing `---`
 *   - No frontmatter -> CREATE one
 *
 * @module scripts/migrate-command-toolsets
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteSync } from './utils/index.js';
import { isMainEntry } from './hooks/_main-entry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const COMMANDS_DIR = path.join(PLUGIN_ROOT, 'commands');
const TOOLSETS_JSON = path.join(PLUGIN_ROOT, 'toolsets.json');

/**
 * Build a reverse-index: command slug -> toolset name.
 * @param {object} manifest
 * @returns {Map<string, string>}
 */
function buildIndex(manifest) {
  const index = new Map();
  for (const [name, def] of Object.entries(manifest.toolsets || {})) {
    for (const cmd of def.commands || []) {
      index.set(cmd, name);
    }
  }
  return index;
}

/**
 * Detect file's line-ending style. Defaults to \n.
 * @param {string} text
 * @returns {string}
 */
function detectEOL(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Parse frontmatter block at top of file (line-based split on `---`).
 * @param {string} text
 * @returns {{hasFrontmatter: boolean, hasToolset: boolean, openIdx: number, closeIdx: number, lines: string[]}}
 */
function parseFrontmatter(text) {
  const eol = detectEOL(text);
  const lines = text.split(eol);
  if (lines[0] !== '---') {
    return { hasFrontmatter: false, hasToolset: false, openIdx: -1, closeIdx: -1, lines, eol };
  }
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    return { hasFrontmatter: false, hasToolset: false, openIdx: -1, closeIdx: -1, lines, eol };
  }
  const hasToolset = lines.slice(1, closeIdx).some((l) => /^toolset\s*:/.test(l));
  return { hasFrontmatter: true, hasToolset, openIdx: 0, closeIdx, lines, eol };
}

/**
 * Apply the transformation to a file's content.
 * @param {string} text
 * @param {string} toolset
 * @returns {{action: 'skip'|'insert'|'create', next: string}}
 */
function transform(text, toolset) {
  const fm = parseFrontmatter(text);
  if (fm.hasFrontmatter && fm.hasToolset) {
    return { action: 'skip', next: text };
  }
  if (fm.hasFrontmatter) {
    const { lines, closeIdx, eol } = fm;
    const newLines = [...lines];
    newLines.splice(closeIdx, 0, `toolset: ${toolset}`);
    return { action: 'insert', next: newLines.join(eol) };
  }
  const eol = detectEOL(text);
  const prefix = `---${eol}toolset: ${toolset}${eol}---${eol}`;
  return { action: 'create', next: prefix + text };
}

/**
 * Render a GFM markdown table from rows.
 * @param {Array<{command: string, toolset: string, action: string}>} rows
 * @returns {string}
 */
function renderTable(rows) {
  const header = '| command | toolset | action |';
  const sep = '| --- | --- | --- |';
  const body = rows.map((r) => `| ${r.command} | ${r.toolset} | ${r.action} |`);
  return [header, sep, ...body].join('\n');
}

/**
 * Transform one command file and, unless dry-run, write it.
 * @param {string} filePath
 * @param {string} toolset
 * @param {boolean} dryRun
 * @returns {'insert'|'create'|'skip'|'failed'} what happened to the file on disk
 */
function migrateFile(filePath, toolset, dryRun) {
  const { action, next } = transform(readFileSync(filePath, 'utf-8'), toolset);
  if (dryRun || action === 'skip') return action;
  // atomicWriteSync never throws (2026-11-21 review M4): false means the file still holds
  // the old text, so it is reported as `failed`, never as the insert/create it was meant to be.
  return atomicWriteSync(filePath, next) === true ? action : 'failed';
}

/**
 * Print the migration report: table, totals and misc-bucket fallbacks.
 * @param {{rows: object[], counts: object, miscFallbacks: string[]}} result
 * @param {number} total command files seen
 * @param {boolean} dryRun
 */
function printReport({ rows, counts, miscFallbacks }, total, dryRun) {
  console.log(`\n${dryRun ? '[DRY-RUN] ' : ''}Migration report (${total} commands)\n`);
  console.log(renderTable(rows));
  console.log(
    `\nTotals: insert=${counts.insert}, skip=${counts.skip}, create=${counts.create}, failed=${counts.failed}, misc-fallbacks=${miscFallbacks.length}`,
  );
  if (miscFallbacks.length > 0) {
    console.log(`Misc bucket fallbacks: ${miscFallbacks.join(', ')}`);
  }
}

/**
 * Inject `toolset:` into every command file and print the report.
 * @param {{commandsDir?: string, toolsetsPath?: string, dryRun?: boolean}} [options]
 *   directories default to this plugin's commands/ and toolsets.json.
 * @returns {{ok: boolean, rows: object[], counts: {insert: number, skip: number,
 *   create: number, failed: number}, miscFallbacks: string[]}} ok is false when any write failed
 */
export function migrateCommandToolsets({ commandsDir = COMMANDS_DIR, toolsetsPath = TOOLSETS_JSON, dryRun = false } = {}) {
  const index = buildIndex(JSON.parse(readFileSync(toolsetsPath, 'utf-8')));
  const files = readdirSync(commandsDir).filter((f) => f.endsWith('.md')).sort();
  const rows = [];
  const miscFallbacks = [];
  const counts = { insert: 0, skip: 0, create: 0, failed: 0 };

  for (const file of files) {
    const slug = file.replace(/\.md$/, '');
    let toolset = index.get(slug);
    if (!toolset) {
      toolset = 'misc';
      miscFallbacks.push(slug);
      console.warn(`[warn] no toolset owns "${slug}" -> fallback to misc`);
    }
    const action = migrateFile(path.join(commandsDir, file), toolset, dryRun);
    counts[action]++;
    rows.push({ command: slug, toolset, action });
  }

  const result = { ok: counts.failed === 0, rows, counts, miscFallbacks };
  printReport(result, files.length, dryRun);
  return result;
}

/**
 * Main entrypoint. Exit 1 when any file was not written.
 */
function main() {
  const { ok } = migrateCommandToolsets({ dryRun: process.argv.includes('--dry-run') });
  process.exit(ok ? 0 : 1);
}

// Direct-run guard: importing this module (tests) must not rewrite the real
// commands/ or call process.exit — a non-dry run inserts into every command file
// that lacks `toolset:`. `node scripts/migrate-command-toolsets.js` is unaffected.
if (isMainEntry(import.meta.url)) {
  main();
}
