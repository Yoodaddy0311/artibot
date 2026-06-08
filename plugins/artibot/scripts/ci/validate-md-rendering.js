#!/usr/bin/env node
/**
 * CI: Validate Markdown rendering correctness across the plugin's docs.
 *
 * Catches mechanical rendering bugs that look fine in a diff but render wrong
 * on GitHub / in the Claude Code plugin UI, where every command.md and
 * SKILL.md body is rendered:
 *   - backtick-in-inline-code: an inner backtick inside an inline code span
 *     (`` `a`b` ``) — the span closes early and the rest renders as prose.
 *   - table-pipe-column-mismatch: a GFM table data row whose unescaped pipe
 *     count differs from the header — the table breaks into a ragged grid.
 *
 * Ported from claude-howto/scripts/check_markdown_rendering.py. Zero external
 * dependencies. Each rule is a pure `(content, relPath) -> string[]` function;
 * add a new rule by writing the function and appending `{ name, fn }` to RULES.
 *
 * @module scripts/ci/validate-md-rendering
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { getPluginRoot } from './ci-utils.js';

/** Directories never scanned (vendored / generated / VCS). */
const IGNORE_DIRS = new Set(['node_modules', 'runtime', 'repos', '.git']);

/** Top-level entry points under the plugin root that are scanned for .md. */
const SCAN_DIRS = ['commands', 'skills', 'docs'];

/** Single .md files at the plugin root that are scanned directly. */
const ROOT_FILES = ['CLAUDE.md', 'README.md', 'AGENTS.md'];

const FENCE_RE = /^ {0,3}(?:>\s*)*```/;

/**
 * Replace fenced code blocks with blank lines so line numbers survive.
 *
 * Triple-backtick fences only. Recognises fences inside blockquotes
 * (`> ``` `), matching how GitHub renders them. Lines inside fences become
 * empty so subsequent rules see no code content but still report accurate
 * line numbers.
 *
 * @param {string} content - Raw Markdown.
 * @returns {string} Content with fenced-block lines blanked.
 */
export function maskFencedBlocks(content) {
  const out = [];
  let inFence = false;
  for (const line of String(content).split('\n')) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      out.push('');
      continue;
    }
    out.push(inFence ? '' : line);
  }
  return out.join('\n');
}

/**
 * Remove well-formed inline code spans from a single line.
 *
 * Follows CommonMark inline-code semantics: a run of N backticks opens a
 * span; the span closes at the next matching run of N backticks. Anything
 * left after consumption is a structural mismatch (an unmatched opening run).
 *
 * @param {string} line - One line of Markdown (fences already masked).
 * @returns {string} The line with well-formed code spans removed.
 */
function consumeCodeSpans(line) {
  const out = [];
  const n = line.length;
  let i = 0;
  while (i < n) {
    if (line[i] !== '`') {
      out.push(line[i]);
      i += 1;
      continue;
    }
    const runStart = i;
    while (i < n && line[i] === '`') i += 1;
    const runLen = i - runStart;
    let scan = i;
    let closed = false;
    while (scan < n) {
      if (line[scan] === '`') {
        const closeStart = scan;
        while (scan < n && line[scan] === '`') scan += 1;
        if (scan - closeStart === runLen) {
          i = scan;
          closed = true;
          break;
        }
      } else {
        scan += 1;
      }
    }
    if (!closed) {
      out.push(line.slice(runStart, i));
    }
  }
  return out.join('');
}

/**
 * Remove inline code spans (double- then single-backtick) and HTML comments
 * from a single line, so pipe-counting ignores escaping idioms and comments.
 *
 * @param {string} line - One line of Markdown.
 * @returns {string} The line with inline code and comments stripped.
 */
function stripInlineCode(line) {
  return line
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/``[^`]+``/g, '')
    .replace(/`[^`\n]+`/g, '');
}

/**
 * Flag inline code spans that contain a literal backtick.
 *
 * Bug pattern: `` `!`command`` `` — a single-backtick span with an inner
 * backtick. Detection: consume well-formed code spans left-to-right per line;
 * any leftover backtick is an unmatched opener that renders wrong. The fix is
 * the `` `text` `` idiom (double-backticks + space padding). Skips fences.
 *
 * @param {string} content - Raw Markdown.
 * @param {string} relPath - Display path for error messages.
 * @returns {string[]} One message per offending line.
 */
export function ruleBacktickInInlineCode(content, relPath) {
  const masked = maskFencedBlocks(content);
  const errors = [];
  const lines = masked.split('\n');
  for (let idx = 0; idx < lines.length; idx += 1) {
    if (consumeCodeSpans(lines[idx]).includes('`')) {
      errors.push(
        `${relPath}:${idx + 1}: backtick-in-inline-code — ` +
          'use `` `text` `` (double-backtick + space) to display a literal backtick',
      );
    }
  }
  return errors;
}

/**
 * Count unescaped, non-code pipes in a GFM table line.
 *
 * Inline code spans are stripped first (their pipes are cell content, not
 * separators). An escaped `\|` is not a column boundary.
 *
 * @param {string} line - A trimmed table line.
 * @returns {number} Number of column-separating pipes.
 */
function pipeCount(line) {
  const scannable = stripInlineCode(line.trim());
  const matches = scannable.match(/(?<!\\)\|/g);
  return matches ? matches.length : 0;
}

const SEPARATOR_RE = /^\s*\|[\s\-:|]+\|\s*$/;

/**
 * Flag GFM table rows whose pipe count differs from the header row.
 *
 * A table is a header line (`|...|...|`) immediately followed by a separator
 * row (`|---|---|`). Every body row until a blank/non-table line must have the
 * same pipe count as the header. A bare `|` in a cell inflates the count and
 * breaks rendering; the fix is `\|`. Pipes inside inline code are ignored.
 * Skips fences.
 *
 * @param {string} content - Raw Markdown.
 * @param {string} relPath - Display path for error messages.
 * @returns {string[]} One message per offending data row.
 */
export function ruleTablePipeMismatch(content, relPath) {
  const masked = maskFencedBlocks(content);
  const errors = [];
  const lines = masked.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const next = i + 1 < lines.length ? lines[i + 1] : null;
    if (
      line.startsWith('|') &&
      line.endsWith('|') &&
      next !== null &&
      SEPARATOR_RE.test(next)
    ) {
      const headerPipes = pipeCount(line);
      let j = i + 2;
      while (j < lines.length) {
        const row = lines[j].trim();
        if (!(row.startsWith('|') && row.endsWith('|'))) break;
        if (pipeCount(row) !== headerPipes) {
          errors.push(
            `${relPath}:${j + 1}: table-pipe-column-mismatch — ` +
              'row column count differs from header; escape a literal `|` as `\\|`',
          );
        }
        j += 1;
      }
      i = j;
    } else {
      i += 1;
    }
  }
  return errors;
}

/**
 * Rule registry. Add a rule by appending `{ name, fn }`.
 * @type {{ name: string, fn: (content: string, relPath: string) => string[] }[]}
 */
export const RULES = [
  { name: 'backtick-in-inline-code', fn: ruleBacktickInInlineCode },
  { name: 'table-pipe-column-mismatch', fn: ruleTablePipeMismatch },
];

/**
 * Recursively collect `.md` files under a directory, skipping IGNORE_DIRS.
 *
 * @param {string} dir - Absolute directory path.
 * @param {string} root - Plugin root, for relative display paths.
 * @returns {string[]} Absolute paths of matching .md files.
 */
function collectMarkdown(dir, root) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue;
    const abs = path.join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      found.push(...collectMarkdown(abs, root));
    } else if (entry.endsWith('.md')) {
      found.push(abs);
    }
  }
  return found;
}

/**
 * Resolve the full list of .md files to validate under the plugin root.
 *
 * @param {string} root - Plugin root.
 * @returns {string[]} Absolute .md paths.
 */
function listTargets(root) {
  const targets = [];
  for (const sub of SCAN_DIRS) {
    targets.push(...collectMarkdown(path.join(root, sub), root));
  }
  for (const f of ROOT_FILES) {
    const abs = path.join(root, f);
    if (existsSync(abs)) targets.push(abs);
  }
  return targets;
}

function main() {
  const root = getPluginRoot();
  const files = listTargets(root);
  const errors = [];

  for (const abs of files) {
    const relPath = path.relative(root, abs).split(path.sep).join('/');
    const content = readFileSync(abs, 'utf-8');
    for (const rule of RULES) {
      errors.push(...rule.fn(content, relPath));
    }
  }

  if (errors.length > 0) {
    for (const e of errors) console.error(`FAIL: ${e}`);
    console.error(
      `\n${errors.length} markdown rendering error(s) found in ${files.length} file(s).`,
    );
    process.exit(1);
  }

  console.log(
    `Markdown rendering clean (${files.length} files, ${RULES.length} rules).`,
  );
}

// Run only when invoked directly (CLI), not when imported by tests.
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath.endsWith('validate-md-rendering.js')) {
  main();
}
