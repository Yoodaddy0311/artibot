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
 * Main entrypoint.
 */
function main() {
  const dryRun = process.argv.includes('--dry-run');
  const manifest = JSON.parse(readFileSync(TOOLSETS_JSON, 'utf-8'));
  const index = buildIndex(manifest);

  const files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md'));
  const rows = [];
  const miscFallbacks = [];
  const counts = { insert: 0, skip: 0, create: 0 };

  for (const file of files.sort()) {
    const slug = file.replace(/\.md$/, '');
    let toolset = index.get(slug);
    if (!toolset) {
      toolset = 'misc';
      miscFallbacks.push(slug);
      console.warn(`[warn] no toolset owns "${slug}" -> fallback to misc`);
    }
    const filePath = path.join(COMMANDS_DIR, file);
    const text = readFileSync(filePath, 'utf-8');
    const { action, next } = transform(text, toolset);
    counts[action]++;
    rows.push({ command: slug, toolset, action });
    if (!dryRun && action !== 'skip') {
      atomicWriteSync(filePath, next);
    }
  }

  console.log(`\n${dryRun ? '[DRY-RUN] ' : ''}Migration report (${files.length} commands)\n`);
  console.log(renderTable(rows));
  console.log(
    `\nTotals: insert=${counts.insert}, skip=${counts.skip}, create=${counts.create}, misc-fallbacks=${miscFallbacks.length}`,
  );
  if (miscFallbacks.length > 0) {
    console.log(`Misc bucket fallbacks: ${miscFallbacks.join(', ')}`);
  }
  process.exit(0);
}

main();
