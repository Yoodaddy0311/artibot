#!/usr/bin/env node
/**
 * Git Autopilot — setup script (opt-in, v2.7.1+).
 *
 * Policy:
 *   - If .git/autopilot.json already exists → refresh it (lastSetupAt, merge defaults).
 *   - If it does NOT exist → do nothing, unless one of:
 *       (a) --init flag is passed explicitly by the user, OR
 *       (b) this is the Artibot repo itself (detected via plugin.json).
 *
 * Prior behavior (≤ v2.7.0): this hook auto-created autopilot.json in every
 * git repo whenever Claude Code started a session. Because Artibot installs
 * globally, that meant unrelated projects got `artibot/` branch prefixes and
 * `wip: artibot auto-save` commits injected into their history. The policy
 * above restores opt-in semantics.
 *
 * Manual activation in a non-Artibot repo (do this only when you want it):
 *   node ~/.claude/artibot/scripts/hooks/git-autopilot-setup.js --init
 *
 * Manual deactivation:
 *   rm .git/autopilot.json
 *
 * @module scripts/hooks/git-autopilot-setup
 */

import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { atomicWriteSync } from '../utils/index.js';
import { logHookError } from '../../lib/core/hook-utils.js';

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  version: 1,
  enabled: true,
  wipIntervalMinutes: 30,
  autoPullOnSession: true,
  autoPushOnStop: true,
  squashWipOnClose: true,
  branchPrefix: 'artibot/',
  conflictStrategy: 'union',
  guardEnabled: true,
  lastSetupAt: null,
};

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/**
 * Resolve the repository root using git rev-parse.
 * @returns {string} Absolute path to repo root
 */
function getRepoRoot() {
  return execSync('git rev-parse --show-toplevel', {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * Read existing autopilot config, merging with defaults.
 * @param {string} configPath
 * @returns {object}
 */
function readExistingConfig(configPath) {
  try {
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Detect whether the current repo is the Artibot plugin itself.
 * Used to grandfather in autopilot activation for Artibot's own development,
 * while keeping other repos opt-in.
 * @param {string} repoRoot
 * @returns {boolean}
 */
function isArtibotRepo(repoRoot) {
  try {
    const pluginJsonPath = path.join(repoRoot, 'plugins', 'artibot', '.claude-plugin', 'plugin.json');
    if (!existsSync(pluginJsonPath)) return false;
    const parsed = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
    return parsed?.name === 'artibot';
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------

/**
 * Exported so tests can drive it with mocked fs/child_process.
 * Returns `'skipped' | 'created' | 'updated' | 'no-repo' | 'error'` for testability.
 * @param {string[]} [argv] - Extra args (defaults to process.argv.slice(2))
 * @returns {Promise<string>}
 */
export async function main(argv) {
  const args = argv ?? process.argv.slice(2);
  const wantsInit = args.includes('--init');

  let repoRoot;
  try {
    repoRoot = getRepoRoot();
  } catch {
    // Not in a git repo — silent no-op (hook fires on every SessionStart,
    // so shell-started-outside-a-repo cases should not log errors).
    return 'no-repo';
  }

  const configPath = path.join(repoRoot, '.git', 'autopilot.json');
  const hasExisting = existsSync(configPath);

  // Opt-in gate: skip silently unless one of three activation paths.
  if (!hasExisting && !wantsInit && !isArtibotRepo(repoRoot)) {
    return 'skipped';
  }

  const existing = hasExisting ? readExistingConfig(configPath) : {};
  const config = {
    ...DEFAULT_CONFIG,
    ...existing,
    lastSetupAt: new Date().toISOString(),
  };

  try {
    atomicWriteSync(configPath, config);
  } catch (err) {
    logHookError('git-autopilot-setup', 'Failed to write config', err);
    return 'error';
  }

  const verb = hasExisting ? 'Updated' : 'Created';
  process.stdout.write(`[artibot:git-autopilot-setup] ${verb} ${configPath}\n`);
  process.stdout.write(`  WIP interval: ${config.wipIntervalMinutes}m\n`);
  process.stdout.write(`  Auto-pull: ${config.autoPullOnSession}\n`);
  process.stdout.write(`  Auto-push: ${config.autoPushOnStop}\n`);
  process.stdout.write(`  Squash WIP: ${config.squashWipOnClose}\n`);
  process.stdout.write(`  Conflict strategy: ${config.conflictStrategy}\n`);

  return hasExisting ? 'updated' : 'created';
}

// CLI entry — only runs when this file is invoked directly, not on import.
const isCliEntry = process.argv[1] && process.argv[1].endsWith('git-autopilot-setup.js');
if (isCliEntry) {
  main().then((outcome) => {
    if (outcome === 'error') process.exit(1);
  }).catch((err) => {
    logHookError('git-autopilot-setup', err.message || String(err));
    process.exit(1);
  });
}
