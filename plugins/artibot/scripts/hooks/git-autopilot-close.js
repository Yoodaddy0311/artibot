#!/usr/bin/env node
/**
 * Git Autopilot — Stop hook.
 * On session end:
 *   1. Stage and commit any remaining changes (final commit)
 *   2. Optionally squash all WIP commits into one clean commit
 *   3. Push the autopilot branch to remote
 * @module scripts/hooks/git-autopilot-close
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { parseJSON, readStdin } from '../utils/index.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';
import { resolveBaseBranch } from '../../lib/git/resolve-base.js';
import { isAutopilotAllowed } from '../../lib/autopilot/repo-identity.js';

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------

/**
 * Hard ceiling on how many commits a single squash pass will collapse.
 * Prevents catastrophic resets if merge-base resolution accidentally points
 * at an ancient ancestor (e.g. root commit).
 */
const MAX_SQUASH_COMMITS = 50;

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/**
 * Run git with argv-array (shell-free).
 *
 * @param {string[]} args
 * @param {object} [opts]
 * @returns {string} trimmed stdout (throws on non-zero exit)
 */
function gitRun(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    ...opts,
  }).trim();
}

/**
 * Run git silently (discards stdout); throws on non-zero exit.
 *
 * @param {string[]} args
 * @param {object} [opts]
 * @returns {void}
 */
function gitSilent(args, opts = {}) {
  execFileSync('git', args, { stdio: 'ignore', ...opts });
}

/**
 * Get the repo root via git rev-parse.
 * @returns {string|null}
 */
function getRepoRoot() {
  try {
    return gitRun(['rev-parse', '--show-toplevel']);
  } catch {
    return null;
  }
}

/**
 * Load .git/autopilot.json. Returns null if disabled or missing.
 * @param {string} repoRoot
 * @returns {object|null}
 */
function loadConfig(repoRoot) {
  const configPath = path.join(repoRoot, '.git', 'autopilot.json');
  if (!existsSync(configPath)) return null;
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return config.enabled === false ? null : config;
  } catch {
    return null;
  }
}

/**
 * Get the current git branch name.
 * @param {string} cwd
 * @returns {string}
 */
function getCurrentBranch(cwd) {
  try {
    return gitRun(['branch', '--show-current'], { cwd });
  } catch {
    return '';
  }
}

/**
 * Check whether there are any staged or unstaged changes.
 * @param {string} cwd
 * @returns {boolean}
 */
function hasDirtyWorkspace(cwd) {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Commit all remaining changes with a "session close" message.
 * @param {string} cwd
 * @returns {boolean}
 */
function commitClose(cwd) {
  try {
    gitSilent(['add', '-A'], { cwd });
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    gitSilent(
      ['commit', '-m', `chore: artibot session close [${timestamp}]`, '--no-verify'],
      { cwd }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Count the number of WIP commits since the branch diverged from its base.
 * WIP commits are identified by the "wip: artibot auto-save" prefix.
 * @param {string} cwd
 * @param {string} baseBranch
 * @returns {number}
 */
function countWipCommits(cwd, baseBranch) {
  if (!baseBranch) return 0;
  try {
    const mergeBase = gitRun(['merge-base', 'HEAD', baseBranch], { cwd });
    if (!mergeBase) return 0;

    const log = gitRun(
      ['log', '--oneline', '--grep=^wip: artibot auto-save', `${mergeBase}..HEAD`],
      { cwd }
    );
    return log.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * Squash all WIP commits into a single clean commit.
 * Soft-resets to merge-base then re-commits everything as one commit.
 *
 * Safety guards:
 *   - merge-base must be a non-empty string.
 *   - Total commits since merge-base must be < MAX_SQUASH_COMMITS to avoid
 *     accidentally squashing through an ancient ancestor.
 *
 * @param {string} cwd
 * @param {string} baseBranch
 * @param {number} wipCount
 * @returns {boolean}
 */
function squashWipCommits(cwd, baseBranch, wipCount) {
  if (wipCount < 2) return true; // Nothing to squash
  if (!baseBranch) return false;

  try {
    const mergeBase = gitRun(['merge-base', 'HEAD', baseBranch], { cwd });
    // Guard: empty merge-base means resolution failed — refuse to reset.
    if (!mergeBase) return false;

    const totalCommitsRaw = gitRun(['rev-list', '--count', `${mergeBase}..HEAD`], { cwd });
    const totalCommits = parseInt(totalCommitsRaw, 10);

    if (Number.isNaN(totalCommits) || totalCommits < 2) return true;
    // Guard: refuse to squash absurd ranges (likely ancient-base mis-resolution).
    if (totalCommits > MAX_SQUASH_COMMITS) return false;

    // Soft-reset to merge-base, re-commit everything as one clean commit
    gitSilent(['reset', '--soft', mergeBase], { cwd });
    const timestamp = new Date().toISOString().slice(0, 10);
    gitSilent(
      ['commit', '-m', `feat: artibot session work [${timestamp}]`, '--no-verify'],
      { cwd }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Push the current branch to origin.
 * @param {string} cwd
 * @param {string} branch
 * @returns {boolean}
 */
function pushBranch(cwd, branch) {
  try {
    gitSilent(['push', 'origin', branch, '--no-verify'], { cwd });
    return true;
  } catch {
    // Try setting upstream on first push
    try {
      gitSilent(['push', '-u', 'origin', branch, '--no-verify'], { cwd });
      return true;
    } catch {
      return false;
    }
  }
}

// -------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw) ?? {};

  const repoRoot = getRepoRoot();
  if (!repoRoot) return;

  // Capture-only gate: skip all git writes for repos outside the allowlist.
  if (!isAutopilotAllowed(repoRoot)) return;

  const config = loadConfig(repoRoot);
  if (!config) return;

  const log = (msg) => process.stderr.write(`[artibot:git-autopilot-close] ${msg}\n`);
  const branch = getCurrentBranch(repoRoot);
  const branchPrefix = config.branchPrefix ?? 'artibot/';
  const baseBranch = resolveBaseBranch(repoRoot, config);

  // Step 1: Commit remaining changes
  if (hasDirtyWorkspace(repoRoot)) {
    const committed = commitClose(repoRoot);
    log(committed ? 'Final changes committed' : 'Final commit failed — check git status');
  } else {
    log('No uncommitted changes at session close');
  }

  // Step 2: Squash WIP commits (only on autopilot branches)
  if (config.squashWipOnClose && branch.startsWith(branchPrefix)) {
    const wipCount = countWipCommits(repoRoot, baseBranch);
    if (wipCount > 0) {
      const squashed = squashWipCommits(repoRoot, baseBranch, wipCount);
      log(
        squashed
          ? `Squashed ${wipCount} WIP commit(s) into clean commit`
          : 'WIP squash failed — commits preserved as-is'
      );
    }
  }

  // Step 3: Push to remote
  if (config.autoPushOnStop) {
    const pushed = pushBranch(repoRoot, branch);
    log(pushed ? `Pushed "${branch}" to origin` : `Push failed — run: git push origin ${branch}`);
  }

  void hookData;
}

main().catch(createErrorHandler('git-autopilot-close', { exit: true }));
