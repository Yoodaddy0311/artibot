#!/usr/bin/env node
/**
 * Git Autopilot — UserPromptSubmit hook.
 * Triggers a WIP (work-in-progress) auto-save commit when the configurable
 * interval has elapsed since the last save. Transparent to the user —
 * does not modify the prompt (no stdout write).
 * @module scripts/hooks/git-autopilot-save
 */

import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { atomicWriteSync, parseJSON, readStdin, resolveConfigPath } from '../utils/index.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';
import { isAutopilotAllowed } from '../../lib/autopilot/repo-identity.js';

/**
 * Read `git.autopilot.bypassPreCommitHooks` from artibot.config.json.
 * Defaults to false (honour pre-commit hooks). v4.7.2 (issue-scanner W4 P1-3):
 * the previous unconditional `--no-verify` violated CLAUDE.md Git Safety
 * Protocol — opt-in is now required.
 * @returns {boolean}
 */
function readArtibotBypassPreCommitHooks() {
  try {
    const cfg = JSON.parse(readFileSync(resolveConfigPath('artibot.config.json'), 'utf-8'));
    return cfg?.git?.autopilot?.bypassPreCommitHooks === true;
  } catch {
    return false;
  }
}

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
      timeout: 2000,
      windowsHide: true,
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
 * Load the WIP state file (.git/autopilot-state.json).
 * @param {string} repoRoot
 * @returns {{ lastWipAt: string|null }}
 */
function loadState(repoRoot) {
  const statePath = path.join(repoRoot, '.git', 'autopilot-state.json');
  if (!existsSync(statePath)) return { lastWipAt: null };
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch {
    return { lastWipAt: null };
  }
}

/**
 * Save the WIP state with updated timestamp.
 * @param {string} repoRoot
 * @param {object} state
 */
function saveState(repoRoot, state) {
  const statePath = path.join(repoRoot, '.git', 'autopilot-state.json');
  atomicWriteSync(statePath, state);
}

/**
 * Check whether there are staged or unstaged changes to commit.
 * @param {string} cwd
 * @returns {boolean}
 */
function hasDirtyWorkspace(cwd) {
  try {
    const status = execSync('git status --porcelain', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      windowsHide: true,
    });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Stage all changes and create a WIP commit.
 *
 * v4.7.2 (issue-scanner W4 P1-3): pre-commit hooks are honored by default.
 * Set `git.autopilot.bypassPreCommitHooks: true` in artibot.config.json to
 * restore the pre-v4.7.2 behavior of passing `--no-verify`. The default
 * (`false`) lets secret-scan / lint / test gates fail the auto-save commit
 * instead of silently committing through them — see CLAUDE.md Git Safety
 * Protocol.
 *
 * @param {string} cwd
 * @param {{ bypassPreCommitHooks?: boolean }} [opts]
 * @returns {boolean} true if commit succeeded
 */
function createWipCommit(cwd, opts = {}) {
  try {
    execSync('git add -A', { cwd, stdio: 'ignore', timeout: 2000, windowsHide: true });
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const bypass = opts.bypassPreCommitHooks === true;
    const noVerify = bypass ? ' --no-verify' : '';
    execSync(`git commit -m "wip: artibot auto-save [${timestamp}]"${noVerify}`, {
      cwd,
      stdio: 'ignore',
      timeout: 5000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
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
  // Learning subsystems (lifelong-learner / GRPO / swarm) are unaffected.
  if (!isAutopilotAllowed(repoRoot)) return;

  const config = loadConfig(repoRoot);
  if (!config) return;

  const intervalMs = (config.wipIntervalMinutes ?? 30) * 60 * 1000;
  const state = loadState(repoRoot);
  const now = Date.now();
  const lastWip = state.lastWipAt ? new Date(state.lastWipAt).getTime() : 0;

  if (now - lastWip < intervalMs) return; // Not yet time

  if (!hasDirtyWorkspace(repoRoot)) {
    // Nothing to save — update timestamp to avoid rechecking immediately
    saveState(repoRoot, { ...state, lastWipAt: new Date(now).toISOString() });
    return;
  }

  // bypassPreCommitHooks: per-repo override (.git/autopilot.json) takes
  // precedence; falls back to artibot.config.json git.autopilot.bypassPreCommitHooks.
  const bypassPreCommitHooks = config?.bypassPreCommitHooks === true
    || readArtibotBypassPreCommitHooks();
  const saved = createWipCommit(repoRoot, { bypassPreCommitHooks });
  const newTimestamp = new Date(now).toISOString();
  saveState(repoRoot, { ...state, lastWipAt: newTimestamp });

  if (saved) {
    process.stderr.write(`[artibot:git-autopilot-save] WIP auto-saved at ${newTimestamp}\n`);
  } else {
    process.stderr.write('[artibot:git-autopilot-save] WIP commit failed — check git status\n');
  }

  // Do not write to stdout — pass prompt through unchanged
  void hookData;
}

main().catch(createErrorHandler('git-autopilot-save', { exit: true }));
