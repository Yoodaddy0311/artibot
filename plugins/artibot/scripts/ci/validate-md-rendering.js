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
 * Scope: every co-located plugin root (`ci-utils.js#listPluginRoots`) plus the
 * repo root's own authored docs (`ci-utils.js#ROOT_SCAN_FILES`) plus the
 * tracked docs under the repo-root canon trees (`ci-utils.js#ROOT_SCAN_TREES`:
 * `.artibot/guides`, `.artibot/adr`, `.artibot/archive`, `reports/SPLIT`,
 * `.artibot/project.md`). The root was added 2026-08-19, closing the gap where
 * `validate-doc-links.js` already scanned root docs and this gate did not —
 * root README/CONTRIBUTING tables could render ragged with both gates green.
 * The trees were added 2026-09-05; the design canon entered with 15 real
 * violations fixed first (12 ragged rows in `ARTIBOT-5.0-DESIGN.md` 부록 0-2,
 * 3 unclosed code spans) rather than baselined, because a baseline on a file
 * still being edited goes stale on the next edit and bites the next author.
 *
 * ## Known holes — what this gate still does NOT see
 *
 * Two rules is not "rendering is correct"; it is two mechanical bugs ruled out.
 * Write the rest down, or the gate's own green becomes the next alibi:
 *   - **Every rendering bug outside the two RULES** — unclosed emphasis, broken
 *     nested lists, bad reference links, raw HTML, heading-level jumps, mixed
 *     tabs/spaces in fences. None are checked.
 *   - **Whether the table is CORRECT**, only whether its pipe counts line up. A
 *     table with the right shape and wrong numbers passes.
 *   - **Baselined violations** in {@link KNOWN_RENDER_VIOLATIONS} — real bugs
 *     held at an exact count, not fixed.
 *   - **Files outside SCAN_DIRS/ROOT_FILES/ROOT_SCAN_FILES/ROOT_SCAN_TREES** —
 *     notably `agents/*.md`, `CHANGELOG.md`, `RELEASE.md`, and the root's
 *     `RELEASE_NOTES_*.md` / `WORK-REPORT-*.md`.
 *   - **Untracked files under the root trees** — `.artibot/HANDOFF.md`,
 *     `SESSION-NOTES.md`, `split/`, `missions/`, gitignored `reports/*`. Only
 *     git-tracked files are enumerated (`ci-utils.js#gatherRepoRootTreeDocFiles`)
 *     so local and CI see the same set; local-only docs rot locally.
 *   - **Installed trees.** Root scanning requires the dev-repo marker
 *     (`ci-utils.js#getRepoDocRoot`), so root regressions are caught in CI, not
 *     on a user's box.
 *   - **The actual renderer.** These are regexes, not GitHub's GFM parser; they
 *     approximate it and can disagree at the edges.
 *
 * @module scripts/ci/validate-md-rendering
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

/** Directories never scanned (vendored / generated / VCS). */
const IGNORE_DIRS = new Set(['node_modules', 'runtime', 'repos', '.git', '_reports', 'coverage']);

/**
 * Top-level entry points under each plugin root that are scanned for .md.
 * Kept in lockstep with `validate-doc-links.js#SCAN_DIRS` — see the note there
 * on why `rubrics` is listed.
 */
const SCAN_DIRS = ['commands', 'skills', 'docs', 'rubrics'];

/**
 * Single .md files at each plugin root that are scanned directly. CHANGELOG.md
 * and RELEASE.md are excluded; see `validate-doc-links.js#SCAN_FILES`.
 */
const ROOT_FILES = ['CLAUDE.md', 'README.md', 'AGENTS.md'];

/**
 * Pre-existing violations that predate this gate's expansion to every plugin
 * root, keyed `<plugin>/<path-within-plugin>::<rule>` → exact occurrence count.
 *
 * ── Why a keyed exact count and not a total ─────────────────────────────────
 * A single "baseline: 2" number absorbs a brand-new violation the moment an old
 * one is fixed. Keying by file *and* rule *and* count makes each entry a precise
 * claim, so a third broken row in an already-listed file still fails.
 *
 * ── Why this ratchet cannot loosen itself ───────────────────────────────────
 * The comparison is `!==`, not `>`. Fixing a listed violation turns the gate RED
 * with "stale entry — delete this line", so the baseline can only ever be
 * removed by hand, never widened by drift. There is no code path that rewrites
 * this map, and no environment condition that skips the comparison: a missing
 * or unreadable tree fails the denominator floor first
 * (`ci-utils.js#assertScanFloors`) rather than reporting a tightened baseline.
 * That is the failure mode `check-unused-ratchet` had when it printed
 * "Baseline tightened 59 → 0. PASS." with `node_modules` absent.
 *
 * ── Entries (measured 2026-08-16) ───────────────────────────────────────────
 * Both are genuine GFM table bugs in artibot-cowork: a data row carries fewer
 * columns than its header, so the table renders ragged. They are left unfixed
 * here only because cowork documentation content is owned elsewhere; the fix in
 * each case is to add the missing cell (or escape a literal `|` as `\|`).
 *
 * Line numbers are intentionally omitted — they rot within a single editing
 * session, and this map must survive concurrent edits to the same files.
 *
 * @type {Record<string, number>}
 */
export const KNOWN_RENDER_VIOLATIONS = {
  'artibot-cowork/skills/long-form-writing/SKILL.md::table-pipe-column-mismatch': 1,
  'artibot-cowork/skills/marketing-strategy/references/positioning-template.md::table-pipe-column-mismatch': 1,
};

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
 * Resolve the full list of .md files to validate under one plugin root.
 *
 * @param {string} root - Plugin root.
 * @returns {string[]} Absolute .md paths.
 */
export function listTargets(root) {
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

/**
 * Run every rule across every project plugin root.
 *
 * @returns {{
 *   counts: Record<string, number>,
 *   total: number,
 *   findings: Array<{ key: string, message: string }>,
 * }} Per-root file tallies plus one finding per violation, each carrying the
 *   `<plugin>/<path>::<rule>` key used by the ratchet.
 */
export function scanAllPlugins() {
  const pluginsDir = getPluginsDir();
  /** @type {Record<string, number>} */
  const counts = {};
  /** @type {Array<{ key: string, message: string }>} */
  const findings = [];
  let total = 0;

  for (const root of listPluginRoots()) {
    const files = listTargets(root);
    counts[path.basename(root)] = files.length;
    total += files.length;
    for (const abs of files) {
      // Display path is plugin-qualified so messages from two plugins that share
      // a relative path (e.g. both `README.md`) stay distinguishable.
      const relPath = path.relative(pluginsDir, abs).split(path.sep).join('/');
      const content = readFileSync(abs, 'utf-8');
      for (const rule of RULES) {
        for (const message of rule.fn(content, relPath)) {
          findings.push({ key: `${relPath}::${rule.name}`, message });
        }
      }
    }
  }
  return { counts, total, findings };
}

/**
 * Run every rule across the repo root's own authored docs.
 *
 * Deliberately NOT folded into {@link scanAllPlugins}: that function's `counts`
 * is asserted key-for-key against `validate-doc-links.js#gatherAllDocFiles`'s
 * counts by the lockstep firewall test, and both are keyed by PLUGIN root. A
 * `<root>` key there would break the lockstep and, via
 * `ci-utils.js#assertScanFloors`, fail every plugin-only scanner.
 *
 * Ratchet keys are prefixed `<root>/` so a root `README.md` can never collide
 * with a plugin's `artibot/README.md`.
 *
 * @returns {{ root: string|null, count: number, findings: Array<{ key: string, message: string }> }}
 *   The repo root in scope (null outside the dev repo), how many files were
 *   read there, and one finding per violation.
 */
export function scanRepoRoot() {
  const { root, files } = gatherRepoRootDocFiles();
  /** @type {Array<{ key: string, message: string }>} */
  const findings = [];
  if (root === null) return { root, count: 0, findings };

  for (const abs of files) {
    const relPath = `<root>/${path.relative(root, abs).split(path.sep).join('/')}`;
    const content = readFileSync(abs, 'utf-8');
    for (const rule of RULES) {
      for (const message of rule.fn(content, relPath)) {
        findings.push({ key: `${relPath}::${rule.name}`, message });
      }
    }
  }
  return { root, count: files.length, findings };
}

/**
 * Run every rule across the tracked docs under the repo-root canon trees
 * (`ci-utils.js#ROOT_SCAN_TREES` + `ROOT_SCAN_TREE_FILES`).
 *
 * Kept beside {@link scanRepoRoot} rather than inside it for the same reason
 * that one is not inside {@link scanAllPlugins}: the two denominators are
 * asserted separately (`<root>` against `MIN_ROOT_DOC_FILES`, `<root-trees>`
 * against `MIN_ROOT_TREE_DOC_FILES`), and a single merged count would let one
 * side shrink while the other grew.
 *
 * Ratchet keys use the same `<root>/` prefix as {@link scanRepoRoot}, so a key
 * reads `<root>/.artibot/adr/ADR-001.md::table-pipe-column-mismatch`.
 *
 * @returns {{ root: string|null, count: number, findings: Array<{ key: string, message: string }> }}
 * @throws {Error} When the root is in scope and git cannot enumerate it — the
 *   caller reports this as a denominator failure.
 */
export function scanRepoRootTrees() {
  const { root, files } = gatherRepoRootTreeDocFiles();
  /** @type {Array<{ key: string, message: string }>} */
  const findings = [];
  if (root === null) return { root, count: 0, findings };

  for (const abs of files) {
    const relPath = `<root>/${path.relative(root, abs).split(path.sep).join('/')}`;
    const content = readFileSync(abs, 'utf-8');
    for (const rule of RULES) {
      for (const message of rule.fn(content, relPath)) {
        findings.push({ key: `${relPath}::${rule.name}`, message });
      }
    }
  }
  return { root, count: files.length, findings };
}

/**
 * Compare findings against {@link KNOWN_RENDER_VIOLATIONS}.
 *
 * @param {Array<{ key: string, message: string }>} findings - Raw violations.
 * @param {Record<string, number>} [baseline] - Allowlist (injectable for tests).
 * @returns {{ unexpected: string[], stale: string[] }} `unexpected` holds
 *   messages for violations above baseline; `stale` holds baseline entries whose
 *   observed count no longer matches (including entries now fully fixed).
 */
export function applyRatchet(findings, baseline = KNOWN_RENDER_VIOLATIONS) {
  /** @type {Record<string, {count: number, messages: string[]}>} */
  const observed = {};
  for (const f of findings) {
    observed[f.key] ??= { count: 0, messages: [] };
    observed[f.key].count += 1;
    observed[f.key].messages.push(f.message);
  }

  const unexpected = [];
  const stale = [];

  for (const [key, seen] of Object.entries(observed)) {
    const allowed = baseline[key] ?? 0;
    if (seen.count > allowed) {
      // Report only the surplus so a listed file's known bug stays quiet while
      // a newly added one in the same file still surfaces.
      unexpected.push(...seen.messages.slice(allowed));
    }
  }

  for (const [key, allowed] of Object.entries(baseline)) {
    const seen = observed[key]?.count ?? 0;
    if (seen !== allowed) {
      stale.push(
        `${key}: baseline claims ${allowed} violation(s) but ${seen} observed — ` +
          (seen < allowed
            ? 'fixed or moved; tighten KNOWN_RENDER_VIOLATIONS by editing/removing this entry'
            : 'unreachable (surplus already reported above)'),
      );
    }
  }

  return { unexpected, stale };
}

function main() {
  const { counts, total: pluginTotal, findings: pluginFindings } = scanAllPlugins();
  const { root: repoRoot, count: rootCount, findings: rootFindings } = scanRepoRoot();

  // Tree enumeration goes through git and refuses to guess when git cannot
  // answer; that refusal is a denominator failure, never a quiet zero.
  let treeCount;
  let treeFindings;
  try {
    ({ count: treeCount, findings: treeFindings } = scanRepoRootTrees());
  } catch (err) {
    console.error(`FAIL: scan-denominator: ${err.message}`);
    process.exit(1);
  }

  const total = pluginTotal + rootCount + treeCount;
  const findings = [...pluginFindings, ...rootFindings, ...treeFindings];
  const tally = Object.entries(counts)
    .map(([name, n]) => `${name}=${n}`)
    .concat(
      repoRoot === null
        ? ['<root>=skipped(not-dev-repo)', '<root-trees>=skipped(not-dev-repo)']
        : [`<root>=${rootCount}`, `<root-trees>=${treeCount}`],
    )
    .join(' ');

  // Denominator first: a shrunken or missing tree must not be able to present
  // itself as a clean run, nor as a "tightened" baseline.
  const floorFailures = [
    ...assertScanFloors(counts),
    ...assertRootScanFloor(repoRoot, rootCount),
    ...assertRootTreeScanFloor(repoRoot, treeCount),
  ];
  if (floorFailures.length > 0) {
    for (const f of floorFailures) console.error(`FAIL: scan-denominator: ${f}`);
    console.error(`\nScanned ${total} file(s) [${tally}] — denominator assertion failed.`);
    process.exit(1);
  }

  const { unexpected, stale } = applyRatchet(findings);

  if (unexpected.length > 0 || stale.length > 0) {
    for (const e of unexpected) console.error(`FAIL: ${e}`);
    for (const s of stale) console.error(`FAIL: stale-baseline: ${s}`);
    console.error(
      `\n${unexpected.length} new + ${stale.length} stale-baseline markdown rendering ` +
        `error(s) in ${total} file(s) [${tally}].`,
    );
    process.exit(1);
  }

  const known = Object.values(KNOWN_RENDER_VIOLATIONS).reduce((a, b) => a + b, 0);
  console.log(
    `Markdown rendering clean (${total} files [${tally}], ${RULES.length} rules, ` +
      `${known} baselined violation(s) unchanged).`,
  );
}

// Run only when invoked directly (CLI), not when imported by tests.
if (isMainEntry(import.meta.url)) {
  main();
}
