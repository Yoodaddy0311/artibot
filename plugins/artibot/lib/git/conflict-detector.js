/**
 * Real-time git conflict detector and pre-emptive rebase helper.
 * Predicts which files are likely to conflict before a merge/rebase,
 * and attempts a pre-emptive rebase to surface conflicts early.
 *
 * @module lib/git/conflict-detector
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hasConflictMarkers } from './conflict-parser.js';
import { readFile } from 'node:fs/promises';
import { logError } from '../core/error.js';

const execFileAsync = promisify(execFile);

/**
 * @typedef {Object} ConflictPrediction
 * @property {string[]} likelyConflicts  - Files predicted to conflict
 * @property {string[]} safe             - Files changed on both branches but unlikely to conflict
 * @property {string} targetBranch       - The branch being analyzed against
 */

/**
 * @typedef {Object} PreemptiveResult
 * @property {boolean} success          - Whether rebase completed cleanly
 * @property {string[]} conflictFiles   - Files with conflicts after rebase attempt
 * @property {string} [error]           - Error message if rebase failed unexpectedly
 */

/**
 * @typedef {Object} DetectResult
 * @property {ConflictPrediction} prediction
 * @property {PreemptiveResult|null} preemptive  - null if preemptive rebase was skipped
 * @property {string[]} activeConflicts          - Files with conflict markers right now
 */

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

/**
 * Predict which files are likely to conflict when merging targetBranch.
 * Uses `git diff --name-only` to find files changed on both branches.
 *
 * @param {string} targetBranch - Branch to merge/rebase onto (e.g. 'main')
 * @param {string} cwd          - Repository root
 * @returns {Promise<ConflictPrediction>}
 */
export async function predictConflictFiles(targetBranch, cwd) {
  const [ourFiles, theirFiles] = await Promise.all([
    getChangedFiles('HEAD', `${targetBranch}...HEAD`, cwd),
    getChangedFiles('HEAD', `HEAD...${targetBranch}`, cwd),
  ]);

  const theirSet = new Set(theirFiles);
  const likelyConflicts = [];
  const safe = [];

  for (const f of ourFiles) {
    if (theirSet.has(f)) {
      likelyConflicts.push(f);
    } else {
      safe.push(f);
    }
  }

  return Object.freeze({ likelyConflicts, safe, targetBranch });
}

/**
 * Get files changed between two git refs using `git diff --name-only`.
 *
 * @param {string} _base   - Unused; kept for signature clarity
 * @param {string} range   - Git range expression (e.g. 'main...HEAD')
 * @param {string} cwd
 * @returns {Promise<string[]>}
 */
async function getChangedFiles(_base, range, cwd) {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--name-only', range], { cwd });
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (err) {
    logError('conflict-detector', `git diff failed for range ${range}`, err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Pre-emptive rebase
// ---------------------------------------------------------------------------

/**
 * Attempt a pre-emptive rebase onto targetBranch in a detached worktree state.
 * This surfaces conflicts before they reach the developer's working tree.
 *
 * WARNING: This modifies the git state. Only call in a safe environment
 * (e.g., a temporary worktree or CI). Aborts the rebase on conflict.
 *
 * @param {string} targetBranch
 * @param {string} cwd
 * @returns {Promise<PreemptiveResult>}
 */
export async function attemptPreemptiveRebase(targetBranch, cwd) {
  try {
    await execFileAsync('git', ['rebase', targetBranch], { cwd, timeout: 60_000 });
    return Object.freeze({ success: true, conflictFiles: [] });
  } catch (_err) {
    const conflictFiles = await findFilesWithConflictMarkers(cwd);
    await abortRebase(cwd);
    return Object.freeze({ success: false, conflictFiles });
  }
}

/**
 * Abort an in-progress git rebase.
 *
 * @param {string} cwd
 * @returns {Promise<void>}
 */
async function abortRebase(cwd) {
  try {
    await execFileAsync('git', ['rebase', '--abort'], { cwd });
  } catch (err) {
    logError('conflict-detector', 'Failed to abort rebase', err);
  }
}

/**
 * Find all tracked files that currently contain conflict markers.
 *
 * @param {string} cwd
 * @returns {Promise<string[]>}
 */
async function findFilesWithConflictMarkers(cwd) {
  let trackedFiles;
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '--modified'], { cwd });
    trackedFiles = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (err) {
    logError('conflict-detector', 'git ls-files failed', err);
    return [];
  }

  const results = await Promise.all(
    trackedFiles.map(async (f) => {
      try {
        const content = await readFile(`${cwd}/${f}`, 'utf8');
        return hasConflictMarkers(content) ? f : null;
      } catch {
        return null;
      }
    }),
  );

  return results.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Full detection pipeline: predict → optionally pre-emptive rebase → scan active conflicts.
 *
 * @param {string} targetBranch       - Branch to check against
 * @param {string} cwd                - Repository root
 * @param {Object} [options]
 * @param {boolean} [options.preemptive=false] - Whether to attempt pre-emptive rebase
 * @returns {Promise<DetectResult>}
 */
export async function detectAndPreempt(targetBranch, cwd, options = {}) {
  const { preemptive = false } = options;

  const [prediction, activeConflicts] = await Promise.all([
    predictConflictFiles(targetBranch, cwd),
    findFilesWithConflictMarkers(cwd),
  ]);

  let preemptiveResult = null;
  if (preemptive && prediction.likelyConflicts.length > 0) {
    preemptiveResult = await attemptPreemptiveRebase(targetBranch, cwd);
  }

  return Object.freeze({
    prediction,
    preemptive: preemptiveResult,
    activeConflicts,
  });
}
