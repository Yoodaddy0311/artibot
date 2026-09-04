/**
 * Shared utilities for CI validation scripts.
 * @module scripts/ci/ci-utils
 */

import { execFileSync } from 'node:child_process';
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

/** @type {Map<string, Set<string>|null>} */
const trackedNameCache = new Map();

/**
 * Environment for the git spawns below, with the repository-override
 * variables removed so discovery starts from `cwd` and nowhere else.
 *
 * git runs its hooks with an absolute `GIT_DIR` exported and — in a linked
 * worktree — no `GIT_WORK_TREE`. Under exactly that pair, `git ls-files` run
 * from a *subdirectory* takes the subdirectory itself as the top of the work
 * tree and prints the whole index relative to it. Measured 2026-09-05 in the
 * worktree `split-artibot-ci-scope` (retro split-9d6dc2 #56):
 *
 *   cwd=plugins, env clean            → 1822 paths, heads {_shared, artibot, artibot-cowork}
 *   cwd=plugins, GIT_DIR only         → 1975 paths, heads {.artibot, .github, ARTIBOT.md, …}
 *   cwd=plugins, GIT_DIR + WORK_TREE  → 1822 paths, correct again
 *
 * With the wrong listing the first-segment parser in {@link gitTrackedNames}
 * sees `plugins` and no plugin root, and the structure / doc-links / md-render
 * gates all fail with "expected plugin root … contributed no … at all". This
 * never reproduced from a plain shell or in CI because neither exports
 * `GIT_DIR`; it fired only from `git push` in a linked worktree.
 *
 * Dropping both variables is the fix rather than re-relativising the output:
 * every question this module asks is "what does git track *here*", and the
 * only way to make `cwd` mean `cwd` is to leave discovery to it. Other `GIT_*`
 * variables (`GIT_INDEX_FILE`, `GIT_TRACE`, author identity) are kept — they
 * do not move the work tree.
 *
 * @returns {NodeJS.ProcessEnv} A copy of `process.env` without the overrides.
 */
function gitDiscoveryEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

/**
 * Run `git ls-files -z` in `cwd`, optionally narrowed to `pathspecs`, and
 * return the tracked paths relative to `cwd`. Throws when git is absent or
 * `cwd` is not inside a work tree — callers decide whether that is a null
 * (name rule stands alone) or a hard failure (fail-closed enumeration).
 *
 * @param {string} cwd - Directory the paths are reported relative to.
 * @param {string[]} [pathspecs] - Narrowing pathspecs, relative to `cwd`.
 * @returns {string[]} Tracked paths, POSIX-separated, relative to `cwd`.
 */
function runGitLsFiles(cwd, pathspecs = []) {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], {
    cwd,
    encoding: 'utf-8',
    env: gitDiscoveryEnv(),
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out.split('\0').filter((entry) => entry.length > 0);
}

/**
 * Top-level directory names under `base` that git actually tracks.
 *
 * `readdirSync` answers "what is on disk", which is a different question from
 * "what is part of this project". The two diverge whenever a directory appears
 * that git never accepted: a nested worktree copy, a junction, a stale checkout
 * left by a killed run. Measured 2026-08-26 in this repo, seven such copies sat
 * under `plugins/artibot/runtime/autopilot/worktrees/` while `git worktree
 * list` reported only the main tree.
 *
 * One `git ls-files` per directory, memoized — every gate calls
 * {@link listPluginRoots}, and re-spawning per call is how a cheap check turns
 * into the 158-spawn problem.
 *
 * @param {string} base - Directory to enumerate tracked children of.
 * @returns {Set<string>|null} Tracked top-level names, or `null` when `base` is
 *   not inside a git work tree (an installed plugin tree, a tarball).
 */
function gitTrackedNames(base) {
  if (trackedNameCache.has(base)) return trackedNameCache.get(base);
  /** @type {Set<string>|null} */
  let result;
  try {
    const names = new Set();
    for (const entry of runGitLsFiles(base)) {
      const [head] = entry.split('/');
      if (head) names.add(head);
    }
    result = names;
  } catch {
    result = null;
  }
  trackedNameCache.set(base, result);
  return result;
}

/**
 * Reset the tracked-name memo. Test helper, not public contract.
 *
 * @returns {void}
 */
export function _resetTrackedNameCache() {
  trackedNameCache.clear();
}

/**
 * Enumerate the project's plugin roots, sorted for deterministic output.
 *
 * Anchored to git rather than to the filesystem. {@link isProjectPluginDir} is
 * a *name* rule, so anything named `artibot-<x>` on disk was previously adopted
 * as a plugin root — including a junction or a nested repo copy, which then
 * contributed a second set of every skill and doc to whichever gate asked.
 * The two observed failures, both reproduced in
 * `tests/firewall/gate-scan-anchoring.test.js`:
 *
 *   1. a live link named `artibot-*` was enumerated as a real root, and
 *   2. a dangling one threw ENOENT out of the unguarded `statSync` below,
 *      taking down the whole gate rather than failing it.
 *
 * Outside a work tree there is nothing to anchor to, so the name rule stands
 * alone (see {@link gitTrackedNames}). That is a widening, not a fail-open: the
 * per-root floors in {@link assertScanFloors} still have to be met, and an
 * extra root trips the "no entry in MIN_DOC_FILES" branch rather than passing
 * quietly.
 *
 * @param {object} [options]
 * @param {Set<string>|null} [options.trackedNames] - Override the tracked-name
 *   set instead of consulting git. Injected by tests so a fixture needs no
 *   `git init`; the same shape the resolver returns.
 * @returns {string[]} Absolute paths of project plugin roots.
 */
export function listPluginRoots(options = {}) {
  const base = getPluginsDir();
  if (!existsSync(base)) return [];
  const tracked = options.trackedNames !== undefined
    ? options.trackedNames
    : gitTrackedNames(base);
  return readdirSync(base)
    .filter((name) => isProjectPluginDir(name))
    .filter((name) => tracked === null || tracked.has(name))
    .map((name) => path.join(base, name))
    .filter((abs) => {
      // A dangling link survives readdirSync and throws here. Dropping it is
      // right either way: it resolves to nothing, so it holds no files to scan.
      //
      // Only those two codes. Swallowing every error would turn a root that is
      // merely unreadable (EACCES, ELOOP) into one that was never there, and a
      // root absent from the enumeration is absent from `counts` — so a *new*
      // root, one MIN_DOC_FILES has no entry for yet, would clear both loops of
      // assertScanFloors and pass in silence. Before this guard existed such a
      // root crashed the gate, which is worse output but louder. Rethrowing
      // keeps the loud half for everything that is not a dead link.
      try {
        return statSync(abs).isDirectory();
      } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
        throw err;
      }
    })
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
 * Repo-root **subtrees** scanned in addition to {@link ROOT_SCAN_FILES}. These
 * hold the design canon (`.artibot/guides`), the ADRs (`.artibot/adr` — single
 * home since B2), archived diagnostics, and `/split` run reports. Until
 * 2026-09-05 neither documentation scanner saw any of them, so a rotted ADR
 * link or a ragged table in the design canon could never go red
 * (`ARTIBOT-5.0-DESIGN.md` 후속 1).
 *
 * An **allowlist of subtrees**, not `.artibot/**`: `.artibot/` also holds
 * untracked local artifacts (`HANDOFF.md`, `SESSION-NOTES.md`, `split/`,
 * `missions/`, `runtime/`), and `reports/*` is gitignored except `SPLIT/`
 * (`.gitignore` re-includes it). A disk walk over either would make local and
 * CI results diverge; a negative list would fail open on the next local dir.
 *
 * Only **git-tracked** files inside these trees are scanned — see
 * {@link gatherRepoRootTreeDocFiles}.
 *
 * @type {readonly string[]}
 */
export const ROOT_SCAN_TREES = Object.freeze([
  '.artibot/guides',
  '.artibot/adr',
  '.artibot/archive',
  'reports/SPLIT',
]);

/**
 * Individual tracked files under the repo root that join the tree scan.
 * `.artibot/project.md` is `ARTIBOT.md`'s first read-order entry and lives
 * beside the untracked locals, so it is named rather than swept.
 *
 * @type {readonly string[]}
 */
export const ROOT_SCAN_TREE_FILES = Object.freeze(['.artibot/project.md']);

/**
 * Minimum tracked Markdown files the root trees must contribute.
 *
 * Pinned at the measured count, like {@link MIN_ROOT_DOC_FILES}, because these
 * are the project's canon: a design document or ADR disappearing should fail
 * loudly rather than pass with slack. Raise it when the canon grows; if it
 * shrinks, RED is the right answer until the deletion is deliberate.
 *
 * Measured 2026-09-05 in worktree `split-artibot-ci-scope` @ base dd071ce3:
 *   `git ls-files -z -- .artibot/guides .artibot/adr .artibot/archive
 *    reports/SPLIT .artibot/project.md | tr '\0' '\n' | grep -c '\.md$'`
 *   → 95 (guides 77 · adr 11 · archive 4 · SPLIT 2 · project.md 1).
 * Count with `-z`: five ADR filenames are Korean and a non-`-z` listing wraps
 * them in C-quotes, which hides them from a `$`-anchored grep (86, not 95).
 */
export const MIN_ROOT_TREE_DOC_FILES = 95;

/**
 * Is a repo-relative POSIX path inside the root-tree scan scope?
 *
 * @param {string} rel - Path relative to the repo root, `/`-separated.
 * @returns {boolean} True when a listed tree or listed file contains it.
 */
function isInRootScanTrees(rel) {
  if (ROOT_SCAN_TREE_FILES.includes(rel)) return true;
  return ROOT_SCAN_TREES.some((tree) => rel.startsWith(`${tree}/`));
}

/**
 * Gather the tracked Markdown files under {@link ROOT_SCAN_TREES} and
 * {@link ROOT_SCAN_TREE_FILES}.
 *
 * Enumeration goes through `git ls-files -z` rather than a disk walk so the
 * scan set is identical on every machine that holds the same commit. When git
 * cannot answer — not installed, not a work tree — this **throws** rather than
 * falling back to the filesystem: a quiet fallback would scan whatever local
 * files happen to exist and report a clean run for a different set than CI
 * sees. The scanners turn the throw into a `scan-denominator` failure.
 *
 * @param {object} [options]
 * @param {string[]} [options.tracked] - Repo-relative tracked paths to use
 *   instead of consulting git. Injected by tests so a fixture needs no
 *   `git init`; the same shape the resolver returns. Still filtered to the
 *   scan scope and to `.md`, so an injected list cannot widen the scan.
 * @returns {{ root: string|null, files: string[] }} The repo root in scope (or
 *   null outside the dev repo) and the absolute, sorted paths of its tracked
 *   tree docs.
 * @throws {Error} When the root is in scope and git cannot enumerate it.
 */
export function gatherRepoRootTreeDocFiles(options = {}) {
  const root = getRepoDocRoot();
  if (root === null) return { root: null, files: [] };
  let tracked;
  if (options.tracked !== undefined) {
    tracked = options.tracked;
  } else {
    try {
      tracked = runGitLsFiles(root, [...ROOT_SCAN_TREES, ...ROOT_SCAN_TREE_FILES]);
    } catch (err) {
      throw new Error(
        `cannot enumerate tracked docs under ${root}: git ls-files failed ` +
          `(${err.message}) — refusing to fall back to a disk walk`,
        { cause: err },
      );
    }
  }
  const files = tracked
    .filter((rel) => rel.toLowerCase().endsWith('.md'))
    .filter((rel) => isInRootScanTrees(rel))
    .map((rel) => path.join(root, rel))
    .sort();
  return { root, files };
}

/**
 * Check the root-tree denominator, mirroring {@link assertRootScanFloor}.
 * Returns no failure outside the dev repo.
 *
 * @param {string|null} root - Repo root in scope, or null.
 * @param {number} count - Tree files actually scanned.
 * @returns {string[]} Human-readable failures (empty when the floor is met).
 */
export function assertRootTreeScanFloor(root, count) {
  if (root === null) return [];
  if (count < MIN_ROOT_TREE_DOC_FILES) {
    return [`repo-root trees scanned ${count} file(s), below floor ${MIN_ROOT_TREE_DOC_FILES}`];
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
