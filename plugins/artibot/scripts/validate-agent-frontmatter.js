#!/usr/bin/env node
/**
 * Validate Artibot agent frontmatter (Phase 2 WS-B.1).
 *
 * Reads plugins/artibot/agents/*.md, parses the YAML frontmatter with a
 * minimal line-based parser, validates against AGENT_FRONTMATTER_SCHEMA,
 * and prints a GFM table + summary to stdout.
 *
 * Exits 0 unconditionally (advisory tool, not a gate).
 *
 * @module scripts/validate-agent-frontmatter
 */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { validateFrontmatter } from '../lib/core/agent-frontmatter-schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const AGENTS_DIR = join(__dirname, '..', 'agents');
const FENCE = '---';

/**
 * Parse a flow-array literal like `[a, b, c]` into a string[].
 *
 * @param {string} raw
 * @returns {string[]}
 */
function parseFlowArray(raw) {
  const inner = raw.trim().slice(1, -1);
  if (inner.trim() === '') return [];
  return inner
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter((s) => s.length > 0);
}

/**
 * Count leading spaces on a line (for indentation checks).
 *
 * @param {string} line
 * @returns {number}
 */
function leadingSpaces(line) {
  let n = 0;
  while (n < line.length && line[n] === ' ') n += 1;
  return n;
}

/**
 * Extract the frontmatter line range from a normalized text.
 *
 * @param {string} text
 * @returns {string[] | null}
 */
function extractFrontmatterLines(text) {
  if (!text.startsWith(FENCE)) return null;
  const lines = text.split('\n');
  let closing = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === FENCE) {
      closing = i;
      break;
    }
  }
  if (closing === -1) return null;
  return lines.slice(1, closing);
}

/**
 * Consume a block scalar started with `key: |` and return joined body.
 *
 * @param {string[]} lines
 * @param {number} startIdx - Index of the line AFTER `key: |`.
 * @returns {{ value: string, nextIdx: number }}
 */
function consumeBlockScalar(lines, startIdx) {
  const body = [];
  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      body.push('');
      i += 1;
      continue;
    }
    if (leadingSpaces(line) >= 2) {
      body.push(line.slice(2));
      i += 1;
      continue;
    }
    break;
  }
  return { value: body.join('\n').trim(), nextIdx: i };
}

/**
 * Consume a YAML block list started at `key:` — following `  - item` lines.
 *
 * @param {string[]} lines
 * @param {number} startIdx
 * @returns {{ value: string[], nextIdx: number }}
 */
function consumeBlockList(lines, startIdx) {
  const items = [];
  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i += 1;
      continue;
    }
    const trimmed = line.trim();
    if (leadingSpaces(line) >= 2 && trimmed.startsWith('- ')) {
      items.push(trimmed.slice(2).trim().replace(/^['"]|['"]$/g, ''));
      i += 1;
      continue;
    }
    if (leadingSpaces(line) >= 2 && trimmed === '-') {
      items.push('');
      i += 1;
      continue;
    }
    break;
  }
  return { value: items, nextIdx: i };
}

/**
 * Parse a frontmatter line block into a plain object.
 *
 * @param {string[]} lines
 * @returns {Record<string, unknown>}
 */
function parseFrontmatter(lines) {
  /** @type {Record<string, unknown>} */
  const fm = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#') || leadingSpaces(line) > 0) {
      i += 1;
      continue;
    }
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      i += 1;
      continue;
    }
    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();
    if (rest === '|' || rest === '|-' || rest === '|+') {
      const { value, nextIdx } = consumeBlockScalar(lines, i + 1);
      fm[key] = value;
      i = nextIdx;
      continue;
    }
    if (rest === '') {
      const { value, nextIdx } = consumeBlockList(lines, i + 1);
      fm[key] = value;
      i = nextIdx;
      continue;
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      fm[key] = parseFlowArray(rest);
      i += 1;
      continue;
    }
    fm[key] = rest.replace(/^['"]|['"]$/g, '');
    i += 1;
  }
  return fm;
}

/**
 * Validate a single agent file.
 *
 * @param {string} filePath
 * @returns {Promise<{ file: string, valid: boolean, errors: string[], lifecycle: string }>}
 */
async function validateFile(filePath) {
  const raw = await readFile(filePath, 'utf-8');
  const text = raw.replace(/\r\n/g, '\n');
  const lines = extractFrontmatterLines(text);
  const file = filePath.split(/[\\/]/).pop() || filePath;
  if (!lines) {
    return { file, valid: false, errors: ['missing or malformed frontmatter'], lifecycle: '-' };
  }
  const fm = parseFrontmatter(lines);
  const result = validateFrontmatter(fm);
  const lifecycle = typeof fm.lifecycle === 'string' ? fm.lifecycle : '-';
  return { file, valid: result.valid, errors: result.errors, lifecycle };
}

/**
 * Render validation rows as a GFM table.
 *
 * @param {{file:string, valid:boolean, errors:string[], lifecycle:string}[]} rows
 * @returns {string}
 */
function renderTable(rows) {
  const header = '| Agent | Lifecycle | Valid | Errors |\n| --- | --- | --- | --- |\n';
  const body = rows
    .map((r) => {
      const status = r.valid ? 'yes' : 'no';
      const errs = r.errors.length === 0 ? '-' : r.errors.join('; ');
      return `| ${r.file} | ${r.lifecycle} | ${status} | ${errs} |`;
    })
    .join('\n');
  return `${header}${body}\n`;
}

/**
 * Main entry.
 */
async function main() {
  const entries = await readdir(AGENTS_DIR);
  const mdFiles = entries.filter((f) => f.endsWith('.md')).sort();
  const rows = await Promise.all(
    mdFiles.map((file) => validateFile(join(AGENTS_DIR, file))),
  );
  const total = rows.length;
  const valid = rows.filter((r) => r.valid).length;
  const invalid = total - valid;
  process.stdout.write(renderTable(rows));
  process.stdout.write(`\nTotal: ${total} | Valid: ${valid} | Invalid: ${invalid}\n`);
  process.exit(0);
}

main().catch((err) => {
  process.stdout.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(0);
});
