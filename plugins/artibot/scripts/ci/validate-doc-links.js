#!/usr/bin/env node
/**
 * CI: Validate documentation internal links and anchors.
 *
 * Scans authored Markdown under **every co-located Artibot plugin** (artibot,
 * artibot-cowork, _shared — see `ci-utils.js#listPluginRoots`) and reports:
 *   1. Broken relative `[..](path.md)` links (target file does not exist).
 *   2. Broken in-page `[..](#anchor)` references (no matching heading).
 *   3. Unbalanced (odd) code fences (likely an unclosed ``` block).
 *
 * External (http/https) links, image links, and non-.md targets are ignored.
 * Code fences and inline code spans are masked before scanning so that example
 * links inside documentation snippets do not produce false positives.
 *
 * Ported from claude-howto's check_cross_references.py (Python → Node ESM).
 * Zero external dependencies (node:fs / node:path / node:url only).
 *
 * @module scripts/ci/validate-doc-links
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { assertScanFloors, getPluginsDir, listPluginRoots } from './ci-utils.js';

/** Directories never scanned (vendored, generated, or VCS internals). */
const IGNORE_DIRS = new Set([
  'node_modules',
  'runtime',
  'repos',
  '.git',
  '_reports',
  'coverage',
  '.vitest',
]);

/**
 * Top-level scan roots under each plugin root, relative to it. Only authored
 * documentation lives here; everything else is excluded by IGNORE_DIRS or by
 * not being listed.
 *
 * `rubrics` exists only in `_shared`; listing it here is inert for plugins that
 * lack the directory and avoids leaving `_shared`'s three authored rubric docs
 * as a known hole.
 */
const SCAN_DIRS = ['commands', 'skills', 'docs', 'rubrics'];

/**
 * Individual top-level Markdown files to scan (not inside SCAN_DIRS), relative
 * to each plugin root.
 *
 * Deliberately excludes CHANGELOG.md / RELEASE.md: they are append-only release
 * history, and `plugins/artibot/CHANGELOG.md` currently carries 14 rendering
 * violations (measured 2026-08-16) that are out of scope for this gate's job.
 */
const SCAN_FILES = ['CLAUDE.md', 'README.md', 'AGENTS.md'];

/**
 * Mask fenced code blocks and inline code spans by replacing their inner
 * characters with spaces (line count and structure preserved so reported line
 * numbers, if ever added, stay accurate). This prevents example links inside
 * code from being treated as real cross-references.
 *
 * @param {string} content - Raw Markdown content.
 * @returns {string} Content with code regions blanked out.
 */
export function maskCodeFences(content) {
  const text = String(content).replace(/\r\n/g, '\n');
  // Blank fenced blocks (``` or ~~~) including their delimiters, preserving newlines.
  let masked = text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, (block) =>
    block.replace(/[^\n]/g, ' ')
  );
  // Blank inline code spans (`...`), preserving span length.
  masked = masked.replace(/`[^`\n]+`/g, (span) => ' '.repeat(span.length));
  return masked;
}

/**
 * Extract relative `.md` link targets from (already masked) content. External
 * http(s) links, image links, and non-.md targets are excluded. Any trailing
 * `#anchor` fragment is stripped from the returned target.
 *
 * @param {string} content - Markdown content (should be code-masked first).
 * @returns {string[]} Array of relative .md path targets (anchors stripped).
 */
export function extractMdLinks(content) {
  const text = String(content);
  const targets = [];
  // [label](target.md[#anchor][ "title"]) where target is not http(s) and not an image.
  const re = /(!?)\[[^\]]*\]\(([^)\s]+?\.md)(#[^)\s]*)?(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const isImage = m[1] === '!';
    const target = m[2];
    if (isImage) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) continue; // skip protocol URLs
    targets.push(target);
  }
  return targets;
}

/**
 * Extract in-page anchor references (`[label](#anchor)`) from (masked) content.
 * Cross-file anchors (`file.md#x`) are not in-page and are excluded.
 *
 * @param {string} content - Markdown content (should be code-masked first).
 * @returns {string[]} Array of anchor slugs (without the leading `#`).
 */
export function extractAnchorRefs(content) {
  const text = String(content);
  const anchors = [];
  const re = /(!?)\[[^\]]*\]\(#([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1] === '!') continue;
    anchors.push(m[2]);
  }
  return anchors;
}

/**
 * Convert a heading's text to a GitHub-style anchor slug (near-approximation):
 * lowercase, strip non-alphanumeric/space/hyphen characters, spaces → hyphens,
 * trailing hyphens trimmed. Unicode word characters are preserved.
 *
 * @param {string} heading - Heading text (without leading `#` markers).
 * @returns {string} Anchor slug.
 */
export function headingToAnchor(heading) {
  return String(heading)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '') // drop punctuation/emoji, keep letters/numbers
    .replace(/ /g, '-') // each space → one hyphen (GitHub does NOT collapse runs)
    .replace(/-+$/g, ''); // trim trailing hyphens
}

/**
 * Extract ATX heading texts (levels 1–6) from raw content. Code masking is NOT
 * required here because a `#` inside a fenced block rarely forms a valid anchor
 * target collision; however callers may pass masked content for strictness.
 *
 * @param {string} content - Markdown content.
 * @returns {string[]} Heading text lines (without leading hash markers).
 */
export function extractHeadings(content) {
  const text = String(content).replace(/\r\n/g, '\n');
  const headings = [];
  const re = /^#{1,6}\s+(.+?)\s*#*\s*$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    headings.push(m[1].trim());
  }
  return headings;
}

/**
 * Determine whether the content has an odd (unbalanced) number of line-start
 * code fences, which indicates a likely unclosed code block.
 *
 * @param {string} content - Markdown content.
 * @returns {boolean} True if the fence count is odd.
 */
export function hasUnbalancedFences(content) {
  const text = String(content).replace(/\r\n/g, '\n');
  const matches = text.match(/^(```|~~~)/gm);
  const count = matches ? matches.length : 0;
  return count % 2 !== 0;
}

/**
 * Find all broken links/anchors/fence issues for a single file's content.
 *
 * @param {string} content - Raw file content.
 * @param {string} fileAbsPath - Absolute path of the file (for resolving relatives).
 * @param {string} repoRoot - Absolute root; links resolving outside are skipped.
 * @returns {Array<{type:'link'|'anchor'|'fence', target:string, message:string}>}
 *   List of broken-reference descriptors (empty if clean).
 */
export function findBrokenLinks(content, fileAbsPath, repoRoot) {
  const raw = String(content);
  const scannable = maskCodeFences(raw);
  const broken = [];
  const fileDir = path.dirname(fileAbsPath);
  const root = path.resolve(repoRoot);

  // 1. Relative .md links must resolve to an existing file within the repo root.
  for (const target of extractMdLinks(scannable)) {
    const resolved = path.resolve(fileDir, target);
    // Skip links that escape the repo root (out of scan scope).
    if (resolved !== root && !resolved.startsWith(root + path.sep)) continue;
    if (!existsSync(resolved)) {
      broken.push({
        type: 'link',
        target,
        message: `broken link → '${target}' (resolved: ${resolved})`,
      });
    }
  }

  // 2. In-page anchors must match a heading in the same file.
  const anchors = extractAnchorRefs(scannable);
  if (anchors.length > 0) {
    const validAnchors = new Set(extractHeadings(raw).map((h) => headingToAnchor(h)));
    for (const anchor of anchors) {
      if (!validAnchors.has(anchor)) {
        broken.push({
          type: 'anchor',
          target: anchor,
          message: `broken anchor → '#${anchor}'`,
        });
      }
    }
  }

  // 3. Unbalanced code fences.
  if (hasUnbalancedFences(raw)) {
    broken.push({
      type: 'fence',
      target: '',
      message: 'unmatched code fences (odd number of ``` / ~~~ openers)',
    });
  }

  return broken;
}

/**
 * Recursively collect Markdown file paths under a directory, honoring IGNORE_DIRS.
 *
 * @param {string} dir - Absolute directory to walk.
 * @returns {string[]} Absolute paths of .md files found.
 */
function collectMarkdown(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (IGNORE_DIRS.has(entry)) continue;
      out.push(...collectMarkdown(full));
    } else if (entry.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Gather every authored Markdown file under one plugin root in scope.
 *
 * @param {string} root - Plugin root absolute path.
 * @returns {string[]} Absolute .md file paths.
 */
export function gatherDocFiles(root) {
  const files = [];
  for (const dir of SCAN_DIRS) {
    files.push(...collectMarkdown(path.join(root, dir)));
  }
  for (const f of SCAN_FILES) {
    const full = path.join(root, f);
    if (existsSync(full)) files.push(full);
  }
  return files;
}

/**
 * Gather documentation files across every project plugin root.
 *
 * @returns {{ files: string[], counts: Record<string, number> }} Absolute paths
 *   plus a per-root file tally (the denominator asserted by `assertScanFloors`).
 */
export function gatherAllDocFiles() {
  const files = [];
  /** @type {Record<string, number>} */
  const counts = {};
  for (const root of listPluginRoots()) {
    const found = gatherDocFiles(root);
    counts[path.basename(root)] = found.length;
    files.push(...found);
  }
  return { files, counts };
}

/**
 * CLI entry point: scan every plugin tree and exit non-zero on broken
 * references or on a scan denominator that fell below its floor.
 */
function main() {
  // Containment root is the shared plugins directory, not one plugin: that way a
  // cross-plugin link (`../artibot-cowork/README.md`) is validated instead of
  // being silently treated as "outside scope".
  const containment = getPluginsDir();
  const { files, counts } = gatherAllDocFiles();

  const floorFailures = assertScanFloors(counts);
  const tally = Object.entries(counts)
    .map(([name, n]) => `${name}=${n}`)
    .join(' ');

  if (floorFailures.length > 0) {
    for (const f of floorFailures) console.error(`FAIL: scan-denominator: ${f}`);
    console.error(`\nScanned ${files.length} file(s) [${tally}] — denominator assertion failed.`);
    process.exit(1);
  }

  let errorCount = 0;
  let fileWithErrors = 0;

  for (const file of files) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch (err) {
      console.error(`FAIL: ${path.relative(containment, file)}: cannot read → ${err.message}`);
      errorCount++;
      fileWithErrors++;
      continue;
    }
    const broken = findBrokenLinks(content, file, containment);
    if (broken.length > 0) {
      fileWithErrors++;
      const rel = path.relative(containment, file).split(path.sep).join('/');
      for (const b of broken) {
        console.error(`FAIL: ${rel}: ${b.message}`);
        errorCount++;
      }
    }
  }

  if (errorCount > 0) {
    console.error(
      `\n${errorCount} broken reference(s) across ${fileWithErrors} file(s) (of ${files.length} scanned) [${tally}].`
    );
    process.exit(1);
  }

  console.log(
    `PASS: ${files.length} documentation file(s) checked [${tally}], 0 broken references.`
  );
  process.exit(0);
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('validate-doc-links.js')) {
  main();
}
