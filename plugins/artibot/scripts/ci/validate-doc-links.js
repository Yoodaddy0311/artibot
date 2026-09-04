#!/usr/bin/env node
/**
 * CI: Validate documentation internal links and anchors.
 *
 * Scans authored Markdown under **every co-located Artibot plugin** (artibot,
 * artibot-cowork, _shared — see `ci-utils.js#listPluginRoots`), **the repo
 * root's own authored docs** (see {@link ROOT_SCAN_FILES}), and **the tracked
 * docs under the repo-root canon trees** (`.artibot/guides`, `.artibot/adr`,
 * `.artibot/archive`, `reports/SPLIT`, `.artibot/project.md` — see
 * `ci-utils.js#ROOT_SCAN_TREES`, added 2026-09-05), and reports:
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
 * ## Known holes — what this gate still does NOT see
 *
 * A gate's own green becomes the alibi for the next blind spot unless its holes
 * are written down beside it. This list is part of the gate. As of 2026-08-19
 * the following are NOT checked:
 *   - **Non-`.md` link targets.** `[x](./scripts/foo.js)`, image links, and
 *     directory links are never resolved — only `*.md` targets are (see
 *     {@link extractMdLinks}). A dead link to a deleted script passes green.
 *   - **Cross-file anchors.** In `other.md#section` only the *file* half is
 *     verified; the `#section` half is stripped. Only same-file anchors are
 *     matched against headings.
 *   - **External http(s) links.** Never fetched, so link rot is invisible.
 *   - **Reference-style and raw-HTML links.** `[x][ref]` and `<a href="…">`
 *     are not parsed; only inline `[x](target)` is.
 *   - **Repo-root docs excluded by policy** — CHANGELOG.md, RELEASE_NOTES_*.md,
 *     WORK-REPORT-*.md, CLAUDE.local.md (see {@link ROOT_SCAN_FILES}).
 *   - **Untracked files under the root trees** — `.artibot/HANDOFF.md`,
 *     `SESSION-NOTES.md`, `split/`, `missions/`, and the ~3,000 gitignored
 *     `reports/*` files. Excluded on purpose (`ci-utils.js#ROOT_SCAN_TREES`):
 *     they exist on one machine only, so they rot locally and silently.
 *   - **Paths inside backticks** (`docs/PRD/…`, `file:line` citations) — masked
 *     before scanning, so a rotted code→code citation is not this gate's
 *     finding; that is the citation-resolution gate's job.
 *   - **Targets outside the repo root**, which are skipped as out-of-scope
 *     rather than reported (see {@link findBrokenLinks} step 1).
 *   - **Installed trees.** Repo-root scanning requires the dev-repo marker (see
 *     {@link getRepoDocRoot}); under `~/.claude/plugins` only plugin roots are
 *     scanned, so root-doc regressions are caught in CI, not on a user's box.
 *
 * @module scripts/ci/validate-doc-links
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  assertRootScanFloor,
  assertRootTreeScanFloor,
  assertScanFloors,
  gatherRepoRootDocFiles,
  gatherRepoRootTreeDocFiles,
  getPluginsDir,
  listPluginRoots,
} from './ci-utils.js';
import { isMainEntry } from '../hooks/_main-entry.js';

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

// Repo-root scanning (the 2026-08-19 blind spot: the root README's link to the
// deleted RELEASE_NOTES_4.8_KO.md sat broken while this gate reported
// `PASS: 474 documentation file(s) checked, 0 broken references` — true for what
// it scanned, and the root README was not in it). The file list, floor, and
// dev-repo guard live in ci-utils.js so this gate and validate-md-rendering.js
// cannot drift apart on them; re-exported here because that is where callers
// and the firewall tests already look for them.
export { gatherRepoRootDocFiles, gatherRepoRootTreeDocFiles, getRepoDocRoot } from './ci-utils.js';

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
  const { files: pluginFiles, counts } = gatherAllDocFiles();
  const { root: repoRoot, files: rootFiles } = gatherRepoRootDocFiles();

  // Tree enumeration goes through git and refuses to guess when git cannot
  // answer. That refusal is a denominator failure, reported in the same shape
  // as a floor miss, never a quiet "0 tree files, 0 problems".
  let treeFiles;
  try {
    ({ files: treeFiles } = gatherRepoRootTreeDocFiles());
  } catch (err) {
    console.error(`FAIL: scan-denominator: ${err.message}`);
    process.exit(1);
  }

  // Containment root is the widest tree whose docs we scan, never one plugin.
  // A link is only judged when it resolves INSIDE containment (findBrokenLinks
  // step 1 skips the rest as out-of-scope), so a containment narrower than the
  // scan set is fail-open: it silently excuses exactly the links that reach
  // across the boundary. That is the second half of the 2026-08-19 blind spot —
  // adding the root README to the scan set alone would NOT have caught its
  // `./RELEASE_NOTES_4.8_KO.md` link, because the target resolves to the repo
  // root, outside the old `plugins/` containment.
  const containment = repoRoot ?? getPluginsDir();
  const files = [...pluginFiles, ...rootFiles, ...treeFiles];

  const floorFailures = [
    ...assertScanFloors(counts),
    ...assertRootScanFloor(repoRoot, rootFiles.length),
    ...assertRootTreeScanFloor(repoRoot, treeFiles.length),
  ];
  const tally = Object.entries(counts)
    .map(([name, n]) => `${name}=${n}`)
    .concat(
      repoRoot === null
        ? ['<root>=skipped(not-dev-repo)', '<root-trees>=skipped(not-dev-repo)']
        : [`<root>=${rootFiles.length}`, `<root-trees>=${treeFiles.length}`],
    )
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
if (isMainEntry(import.meta.url)) {
  main();
}
