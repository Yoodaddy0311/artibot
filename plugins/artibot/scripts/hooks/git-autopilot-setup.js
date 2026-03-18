#!/usr/bin/env node
/**
 * Git Autopilot — Initial setup script.
 * Creates .git/autopilot.json with default configuration.
 * Run once per repository: node scripts/hooks/git-autopilot-setup.js
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

// -------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------

async function main() {
  let repoRoot;
  try {
    repoRoot = getRepoRoot();
  } catch {
    process.stderr.write('[artibot:git-autopilot-setup] Not inside a git repository.\n');
    process.exit(1);
  }

  const configPath = path.join(repoRoot, '.git', 'autopilot.json');
  const existing = existsSync(configPath) ? readExistingConfig(configPath) : {};
  const isUpdate = Object.keys(existing).length > 0;

  const config = {
    ...DEFAULT_CONFIG,
    ...existing,
    lastSetupAt: new Date().toISOString(),
  };

  try {
    atomicWriteSync(configPath, config);
  } catch (err) {
    logHookError('git-autopilot-setup', 'Failed to write config', err);
    process.exit(1);
  }

  const verb = isUpdate ? 'Updated' : 'Created';
  process.stdout.write(`[artibot:git-autopilot-setup] ${verb} ${configPath}\n`);
  process.stdout.write(`  WIP interval: ${config.wipIntervalMinutes}m\n`);
  process.stdout.write(`  Auto-pull: ${config.autoPullOnSession}\n`);
  process.stdout.write(`  Auto-push: ${config.autoPushOnStop}\n`);
  process.stdout.write(`  Squash WIP: ${config.squashWipOnClose}\n`);
  process.stdout.write(`  Conflict strategy: ${config.conflictStrategy}\n`);
}

main().catch((err) => {
  logHookError('git-autopilot-setup', err.message || String(err));
  process.exit(1);
});
