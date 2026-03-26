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
import { execSync } from 'node:child_process';
import path from 'node:path';
import { parseJSON, readStdin } from '../utils/index.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/**
 * Get the repo root via git rev-parse.
 * @returns {string|null}
 */
function getRepoRoot() {
  try {
    return execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
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
    return execSync('git branch --show-current', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
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
    const status = execSync('git status --porcelain', {
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
    execSync('git add -A', { cwd, stdio: 'ignore' });
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    execSync(
      `git commit -m "chore: artibot session close [${timestamp}]" --no-verify`,
      { cwd, stdio: 'ignore' }
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
 * @param {string} branch
 * @param {string} branchPrefix
 * @returns {number}
 */
function countWipCommits(cwd, branch, branchPrefix) {
  try {
    // Find the merge-base between this branch and its non-autopilot ancestor
    const baseBranch = branch.replace(branchPrefix, '');
    const mergeBase = execSync(`git merge-base HEAD ${baseBranch}`, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    const log = execSync(
      `git log --oneline --grep="^wip: artibot auto-save" ${mergeBase}..HEAD`,
      {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );
    return log.trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * Squash all WIP commits into a single clean commit via interactive rebase.
 * Uses --autosquash with fixup! prefix pattern.
 * Falls back to soft-reset + recommit if rebase is unavailable.
 * @param {string} cwd
 * @param {string} branch
 * @param {string} branchPrefix
 * @param {number} wipCount
 * @returns {boolean}
 */
function squashWipCommits(cwd, branch, branchPrefix, wipCount) {
  if (wipCount < 2) return true; // Nothing to squash

  try {
    const baseBranch = branch.replace(branchPrefix, '');
    const mergeBase = execSync(`git merge-base HEAD ${baseBranch}`, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    const totalCommits = parseInt(
      execSync(`git rev-list --count ${mergeBase}..HEAD`, {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
      10
    );

    if (totalCommits < 2) return true;

    // Soft-reset to merge-base, re-commit everything as one clean commit
    execSync(`git reset --soft ${mergeBase}`, { cwd, stdio: 'ignore' });
    const timestamp = new Date().toISOString().slice(0, 10);
    execSync(
      `git commit -m "feat: artibot session work [${timestamp}]" --no-verify`,
      { cwd, stdio: 'ignore' }
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
    execSync(`git push origin ${branch} --no-verify`, { cwd, stdio: 'ignore' });
    return true;
  } catch {
    // Try setting upstream on first push
    try {
      execSync(`git push -u origin ${branch} --no-verify`, { cwd, stdio: 'ignore' });
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

  const config = loadConfig(repoRoot);
  if (!config) return;

  const log = (msg) => process.stderr.write(`[artibot:git-autopilot-close] ${msg}\n`);
  const branch = getCurrentBranch(repoRoot);
  const branchPrefix = config.branchPrefix ?? 'artibot/';

  // Step 1: Commit remaining changes
  if (hasDirtyWorkspace(repoRoot)) {
    const committed = commitClose(repoRoot);
    log(committed ? 'Final changes committed' : 'Final commit failed — check git status');
  } else {
    log('No uncommitted changes at session close');
  }

  // Step 2: Squash WIP commits (only on autopilot branches)
  if (config.squashWipOnClose && branch.startsWith(branchPrefix)) {
    const wipCount = countWipCommits(repoRoot, branch, branchPrefix);
    if (wipCount > 0) {
      const squashed = squashWipCommits(repoRoot, branch, branchPrefix, wipCount);
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
