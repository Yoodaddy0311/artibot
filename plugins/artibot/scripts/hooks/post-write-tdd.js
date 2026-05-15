#!/usr/bin/env node
/**
 * PostToolUse hook: TDD regression-test suggester.
 *
 * When Write/Edit touches a `lib/**\/*.js` source file (non-test), checks
 * whether a mirror test file exists under `tests/<same-structure>/<name>.test.js`.
 * If absent, emits an advisory `[artibot:suggest-tdd ...]` token so the agent
 * knows to delegate to the `tdd-guide` agent for regression coverage.
 *
 * Strictly advisory — never blocks. Ignores `*.test.js` / `*.spec.js` to
 * prevent recursion. Timeout budget ≤ 2 s.
 *
 * @module scripts/hooks/post-write-tdd
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { getPluginRoot, parseJSON, readStdin, writeStdout } from '../utils/index.js';
import {
  createErrorHandler,
  extractFilePath,
  extractToolName,
  isArtibotRepo,
  normalizePath,
} from '../../lib/core/hook-utils.js';
import { getRepoRoot } from '../../lib/git/repo-root-cache.js';

/**
 * Determine whether the file should be considered a non-test source file
 * under `lib/`.
 * @param {string} normalizedPath - forward-slash path
 * @returns {boolean}
 */
export function isLibSourceFile(normalizedPath) {
  if (!normalizedPath) return false;
  if (!normalizedPath.endsWith('.js')) return false;
  if (normalizedPath.endsWith('.test.js')) return false;
  if (normalizedPath.endsWith('.spec.js')) return false;
  // Must include a `/lib/` segment (anchored so `/mylib/` doesn't match).
  return /(?:^|\/)lib\//.test(normalizedPath);
}

/**
 * Given a normalized path, extract the portion starting at `lib/`.
 * e.g. `/a/b/lib/foo/bar.js` -> `lib/foo/bar.js`
 * @param {string} normalizedPath
 * @returns {string|null}
 */
export function extractLibRelative(normalizedPath) {
  const match = normalizedPath.match(/(?:^|\/)(lib\/.+\.js)$/);
  return match ? match[1] : null;
}

/**
 * Compute the expected test file path for a given `lib/...js` relative path.
 * e.g. `lib/foo/bar.js` -> `tests/foo/bar.test.js`
 * @param {string} libRelative - path beginning with `lib/`
 * @returns {string}
 */
export function expectedTestPath(libRelative) {
  const stripped = libRelative.replace(/^lib\//, '');
  const withoutExt = stripped.replace(/\.js$/, '');
  return `tests/${withoutExt}.test.js`;
}

/**
 * Build the advisory TDD suggestion token.
 * @param {string} libRelative - e.g. `lib/foo.js`
 * @param {string} testRelative - e.g. `tests/foo.test.js`
 * @returns {string}
 */
export function buildTddMessage(libRelative, testRelative) {
  return `[artibot:suggest-tdd target=${libRelative} test=${testRelative}]`;
}

/**
 * Resolve a plugin-relative path to an absolute filesystem path.
 * @param {string} relative
 * @returns {string}
 */
function resolveFromPluginRoot(relative) {
  return path.join(getPluginRoot(), relative);
}

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);
  if (!hookData) return;

  const toolName = extractToolName(hookData);
  if (toolName !== 'Write' && toolName !== 'Edit') return;

  const filePath = extractFilePath(hookData);
  if (!filePath) return;

  // Artibot scope guard: this advisory only makes sense inside the Artibot
  // plugin repo (where the lib/ → tests/ mirror convention is enforced).
  // In unrelated user projects, every lib/*.js Edit was emitting noisy
  // [artibot:suggest-tdd ...] tokens against directory layouts that do not
  // follow this convention.
  if (!isArtibotRepo(getRepoRoot())) return;

  const normalized = normalizePath(filePath);
  if (!isLibSourceFile(normalized)) return;

  const libRelative = extractLibRelative(normalized);
  if (!libRelative) return;

  const testRelative = expectedTestPath(libRelative);
  const absoluteTestPath = resolveFromPluginRoot(testRelative);

  if (existsSync(absoluteTestPath)) return;

  const message = buildTddMessage(libRelative, testRelative);
  process.stderr.write(`[artibot:post-write-tdd] missing_test=${testRelative}\n`);

  writeStdout({ message });
}

main().catch(createErrorHandler('post-write-tdd', { exit: true }));
