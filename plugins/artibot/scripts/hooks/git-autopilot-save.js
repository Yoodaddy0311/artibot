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
import { readStdin, parseJSON, atomicWriteSync } from '../utils/index.js';
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
    });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Stage all changes and create a WIP commit.
 * @param {string} cwd
 * @returns {boolean} true if commit succeeded
 */
function createWipCommit(cwd) {
  try {
    execSync('git add -A', { cwd, stdio: 'ignore' });
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    execSync(`git commit -m "wip: artibot auto-save [${timestamp}]" --no-verify`, {
      cwd,
      stdio: 'ignore',
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

  const saved = createWipCommit(repoRoot);
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
