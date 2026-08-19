/**
 * Shared utilities for CI validation scripts.
 * @module scripts/ci/ci-utils
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { getPluginRoot } from '../../lib/core/platform.js';

// Canonical getPluginRoot from lib/core/platform.js (single source of truth)
export { getPluginRoot } from '../../lib/core/platform.js';

/**
 * Directory holding every co-located Artibot plugin.
 *
 * In the dev repo this is `<repo>/plugins`; in an installed tree it is
 * `~/.claude/plugins`. Both cases resolve as the parent of the artibot plugin
 * root, so no separate repo-root detection is needed.
 *
 * @returns {string} Absolute path to the plugins directory.
 */
export function getPluginsDir() {
  return path.dirname(getPluginRoot());
}

/**
 * Names under `getPluginsDir()` that belong to this project and therefore fall
 * under our documentation gates.
 *
 * Why a name rule rather than "every sibling directory": in an installed tree
 * the siblings include third-party plugins from other marketplaces. Scanning
 * those would turn *their* broken links into *our* CI failures. Why a name rule
 * rather than a hardcoded list: a future `plugins/artibot-<x>/` is picked up
 * automatically, so adding a plugin cannot silently create a new blind spot —
 * which is exactly the defect this predicate exists to close.
 *
 * `_shared` has no `.claude-plugin/plugin.json`, so plugin-manifest detection
 * would skip it; it is named explicitly.
 *
 * @param {string} name - Directory name directly under the plugins directory.
 * @returns {boolean} True if the directory is part of this project.
 */
export function isProjectPluginDir(name) {
  return name === 'artibot' || name.startsWith('artibot-') || name === '_shared';
}

/**
 * Enumerate the project's plugin roots, sorted for deterministic output.
 *
 * @returns {string[]} Absolute paths of project plugin roots.
 */
export function listPluginRoots() {
  const base = getPluginsDir();
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((name) => isProjectPluginDir(name))
    .map((name) => path.join(base, name))
    .filter((abs) => statSync(abs).isDirectory())
    .sort();
}

/**
 * Minimum number of Markdown files each plugin root must contribute.
 *
 * This is the denominator assertion. Without it, "0 problems found" and "0
 * files examined" are the same output, and the gate becomes the evidence for
 * the next blind spot. Values are round numbers below the measured counts
 * (2026-08-16: artibot 349, artibot-cowork 144, _shared 4) with slack for
 * ordinary churn; `_shared` is pinned exactly because all four of its files are
 * long-lived and deleting one should be a deliberate act.
 *
 * A root that is present but missing from this map is NOT exempt — see
 * {@link assertScanFloors}, which fails on unknown roots rather than skipping
 * them.
 *
 * @type {Record<string, number>}
 */
export const MIN_DOC_FILES = {
  artibot: 300,
  'artibot-cowork': 100,
  _shared: 4,
};

/**
 * Verify every scanned root met its floor, and that no root is unaccounted for.
 *
 * @param {Record<string, number>} counts - Root directory name → files scanned.
 * @returns {string[]} Human-readable failures (empty when all floors are met).
 */
export function assertScanFloors(counts) {
  const failures = [];
  for (const [name, floor] of Object.entries(MIN_DOC_FILES)) {
    if (!(name in counts)) {
      failures.push(`expected plugin root '${name}' was not scanned at all`);
    } else if (counts[name] < floor) {
      failures.push(`'${name}' scanned ${counts[name]} file(s), below floor ${floor}`);
    }
  }
  for (const name of Object.keys(counts)) {
    if (!(name in MIN_DOC_FILES)) {
      failures.push(
        `plugin root '${name}' has no entry in MIN_DOC_FILES — add one so its ` +
          'denominator is asserted too (a new root must not coast on an unchecked zero)',
      );
    }
  }
  return failures;
}

/**
 * Authored Markdown at the **repo root** — the parent of the plugins directory.
 * These sit outside every plugin root, so neither documentation scanner saw
 * them until 2026-08-19 (doc-links) / 2026-08-19 (md-rendering).
 *
 * Shared rather than copied per scanner: `SCAN_DIRS`/`ROOT_FILES` are duplicated
 * in each scanner with a lockstep test holding them together, but the dev-repo
 * GUARD below must never diverge — two copies of a safety check is how one gets
 * fixed and the other does not.
 *
 * Excluded on purpose, mirroring each scanner's CHANGELOG rule:
 *   - `CHANGELOG.md` — append-only release history.
 *   - `RELEASE_NOTES_*.md`, `WORK-REPORT-*.md` — frozen dated artifacts; their
 *     content describes the repo as it was, not as it is.
 *   - `CLAUDE.local.md` — gitignored personal config, absent in CI.
 */
export const ROOT_SCAN_FILES = [
  'README.md',
  'CONTRIBUTING.md',
  'INSTALL.md',
  'CLAUDE.md',
  'AGENTS.md',
];

/**
 * Minimum repo-root docs that must be scanned once the root is in scope.
 *
 * Kept separate from {@link MIN_DOC_FILES} because that map is keyed by plugin
 * root and {@link assertScanFloors} fails on any key it does not know — adding
 * a `<root>` entry there would make every plugin-only scanner fail.
 *
 * Pinned exactly at the measured count (4 of the 5 listed files exist;
 * `AGENTS.md` has never existed at the repo root) for the same reason
 * `MIN_DOC_FILES._shared` is pinned: all four are long-lived, and repo history
 * shows **zero** deletions of any of them (`git log --diff-filter=D`, checked
 * 2026-08-19), so losing one should fail loudly rather than pass with slack.
 */
export const MIN_ROOT_DOC_FILES = 4;

/**
 * File that marks a directory as the Artibot **dev repo** rather than an
 * installed plugin tree.
 *
 * This matters because `getPluginsDir()`'s parent is `<repo>` in the dev repo
 * but `~/.claude` in an installed tree. Without this check the scanners would
 * walk a user's personal `~/.claude/README.md` and `CLAUDE.md` and report their
 * problems as Artibot CI failures.
 */
const DEV_REPO_MARKER = path.join('.claude-plugin', 'marketplace.json');

/**
 * Resolve the repo root whose top-level docs are in scope, or `null` when not
 * running against the dev repo (installed tree → plugin roots only).
 *
 * @returns {string|null} Absolute repo root, or null if unavailable.
 */
export function getRepoDocRoot() {
  const candidate = path.resolve(getPluginsDir(), '..');
  return existsSync(path.join(candidate, DEV_REPO_MARKER)) ? candidate : null;
}

/**
 * Gather the repo root's authored top-level Markdown files.
 *
 * @returns {{ root: string|null, files: string[] }} The repo root in scope (or
 *   null outside the dev repo) and the absolute paths of its scanned docs.
 */
export function gatherRepoRootDocFiles() {
  const root = getRepoDocRoot();
  if (root === null) return { root: null, files: [] };
  const files = ROOT_SCAN_FILES.map((f) => path.join(root, f)).filter((abs) => existsSync(abs));
  return { root, files };
}

/**
 * Check the repo-root denominator, mirroring {@link assertScanFloors}'s job for
 * plugin roots. Returns no failure outside the dev repo, where the root is
 * deliberately out of scope.
 *
 * @param {string|null} root - Repo root in scope, or null.
 * @param {number} count - Files actually scanned at that root.
 * @returns {string[]} Human-readable failures (empty when the floor is met).
 */
export function assertRootScanFloor(root, count) {
  if (root === null) return [];
  if (count < MIN_ROOT_DOC_FILES) {
    return [`repo root scanned ${count} file(s), below floor ${MIN_ROOT_DOC_FILES}`];
  }
  return [];
}

/**
 * Extract YAML frontmatter fields from a Markdown file's content.
 * Supports simple key:value pairs (no nested objects).
 * @param {string} content - Raw file content
 * @returns {object|null} Parsed key-value pairs, or null if no frontmatter found
 */
export function extractFrontmatter(content) {
  // Normalize CRLF -> LF so the regex below works uniformly on Windows files.
  // Without this, lines like "name: foo\r" fail the `^(\w[\w-]*):\s*(.+)$` match
  // because `.` in JS regex does not match `\r`, causing every field to parse
  // as null except the very last line (which has no trailing `\r` before `---`).
  const normalized = String(content).replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  // Simple YAML key:value parser (no nested objects).
  // Block scalars (`key: |`) and list values are stored as raw scalar values
  // (truthy), which is sufficient for CI validators that only check presence.
  const fields = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (kv) fields[kv[1].trim()] = kv[2].trim();
  }
  return fields;
}
