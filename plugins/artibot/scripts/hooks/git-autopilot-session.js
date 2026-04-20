#!/usr/bin/env node
/**
 * Git Autopilot — SessionStart hook.
 * On every new Claude Code session:
 *   1. Reads .git/autopilot.json config (skip if missing or disabled)
 *   2. Auto-pulls latest changes from remote (with conflict auto-resolution)
 *   3. Switches to or creates the autopilot working branch
 * @module scripts/hooks/git-autopilot-session
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { parseJSON, readStdin } from '../utils/index.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';
import { autoResolveAll } from './git-autopilot-merge.js';

// Throttle: skip `git pull` if a successful pull happened within this window.
// 5 minutes is aggressive enough to save ~800ms on every rapid-fire session
// restart while still picking up remote changes reasonably quickly in practice.
const PULL_THROTTLE_MS = 5 * 60 * 1000;

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
 * Load .git/autopilot.json config.
 * @param {string} repoRoot
 * @returns {object|null} Parsed config or null if not found / disabled
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
 * Pull latest changes. Returns true if successful.
 * @param {string} cwd
 * @returns {boolean}
 */
function gitPull(cwd) {
  try {
    execSync('git pull --rebase --autostash', {
      cwd,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a recent pull was made. Avoids redundant network round-trips
 * on rapid session restarts. Reads `lastPullAt` from `.git/autopilot.json`.
 *
 * @param {string} repoRoot
 * @returns {boolean} true if pull should be skipped (recent enough)
 */
function isPullThrottled(repoRoot) {
  try {
    const configPath = path.join(repoRoot, '.git', 'autopilot.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (!config.lastPullAt) return false;
    const age = Date.now() - new Date(config.lastPullAt).getTime();
    return age < PULL_THROTTLE_MS;
  } catch {
    return false;
  }
}

/**
 * Persist the last-pull timestamp into `.git/autopilot.json`.
 * Errors are swallowed — throttling is advisory, not critical.
 *
 * @param {string} repoRoot
 */
function recordPullTimestamp(repoRoot) {
  try {
    const configPath = path.join(repoRoot, '.git', 'autopilot.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.lastPullAt = new Date().toISOString();
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch {
    // Ignore — throttling will fall back to pulling next time
  }
}

/**
 * Check whether git is currently in an active rebase state.
 * @param {string} cwd
 * @returns {boolean}
 */
function isRebaseInProgress(cwd) {
  try {
    const gitDir = execSync('git rev-parse --git-dir', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const rebaseMerge = path.join(cwd, gitDir, 'rebase-merge');
    const rebaseApply = path.join(cwd, gitDir, 'rebase-apply');
    return existsSync(rebaseMerge) || existsSync(rebaseApply);
  } catch {
    return false;
  }
}

/**
 * Ensure the autopilot branch exists and is checked out.
 * Creates from current HEAD if new.
 * @param {string} cwd
 * @param {string} branchPrefix
 * @param {string} currentBranch
 * @returns {string} Name of the branch switched to (or current if already correct)
 */
function ensureAutopilotBranch(cwd, branchPrefix, currentBranch) {
  if (currentBranch.startsWith(branchPrefix)) return currentBranch;

  const baseName = currentBranch.replace(/[^a-zA-Z0-9_-]/g, '-');
  const autopilotBranch = `${branchPrefix}${baseName}`;

  try {
    // Check if branch already exists
    execSync(`git show-ref --verify --quiet refs/heads/${autopilotBranch}`, {
      cwd,
      stdio: 'ignore',
    });
    // Branch exists — switch to it
    execSync(`git checkout ${autopilotBranch}`, { cwd, stdio: 'ignore' });
  } catch {
    // Branch does not exist — create from current HEAD
    execSync(`git checkout -b ${autopilotBranch}`, { cwd, stdio: 'ignore' });
  }

  return autopilotBranch;
}

// -------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw) ?? {};

  const repoRoot = getRepoRoot();
  if (!repoRoot) return; // Not a git repo — skip silently

  const config = loadConfig(repoRoot);
  if (!config) return; // Autopilot disabled or not set up

  const currentBranch = getCurrentBranch(repoRoot);
  const log = (msg) => process.stderr.write(`[artibot:git-autopilot-session] ${msg}\n`);

  // Step 1: Auto-pull (throttled — skip if last pull attempt was within PULL_THROTTLE_MS).
  // Timestamp is recorded regardless of success: the throttle protects against
  // repeated attempts (which cost ~800ms each) even when the pull fails.
  if (config.autoPullOnSession && !isPullThrottled(repoRoot)) {
    const pulled = gitPull(repoRoot);
    recordPullTimestamp(repoRoot);
    if (pulled) {
      log(`Pulled latest changes on "${currentBranch}"`);
    } else {
      if (!isRebaseInProgress(repoRoot)) {
        log('git pull failed (no rebase in progress) — skipping conflict resolution');
      } else {
        log('git pull failed — attempting conflict auto-resolution');
        const { results, allResolved } = autoResolveAll(repoRoot);
        if (allResolved && results.length > 0) {
          log(`Auto-resolved ${results.length} conflict(s)`);
          // eslint-disable-next-line max-depth -- git rebase recovery requires nested try/catch
          try {
            execSync('git rebase --continue', { cwd: repoRoot, stdio: 'ignore' });
          } catch {
            log('rebase --continue failed — manual resolution may be required');
            execSync('git rebase --abort', { cwd: repoRoot, stdio: 'ignore' });
          }
        } else if (!allResolved) {
          const unresolved = results.filter((r) => !r.resolved).map((r) => r.filePath);
          log(`Could not auto-resolve: ${unresolved.join(', ')} — manual resolution required`);
        } else {
          // rebase in progress but no conflicted files — abort stale rebase
          log('Rebase in progress but no conflicts found — aborting stale rebase');
          execSync('git rebase --abort', { cwd: repoRoot, stdio: 'ignore' });
        }
      }
    }
  }

  // Step 2: Ensure autopilot branch
  const branchPrefix = config.branchPrefix ?? 'artibot/';
  const activeBranch = ensureAutopilotBranch(repoRoot, branchPrefix, currentBranch);
  if (activeBranch !== currentBranch) {
    log(`Switched to autopilot branch "${activeBranch}"`);
  }

  // Suppress hook from altering Claude's prompt — no stdout output
  void hookData;
}

main().catch(createErrorHandler('git-autopilot-session', { exit: true }));
