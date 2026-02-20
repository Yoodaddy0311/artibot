#!/usr/bin/env node
/**
 * update.js - Artibot version check and update script.
 *
 * Usage:
 *   node update.js [--check] [--force] [--dry-run]
 *
 * Flags:
 *   --check    (default) Check version only, do not update
 *   --force    Force reinstall regardless of current version
 *   --dry-run  Print what would happen without executing it
 *
 * Zero dependencies. Node 18+ built-ins only. ESM module format.
 */

import { readFileSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { isNewerVersion } from '../lib/core/version-checker.js';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const CHECK   = args.includes('--check') || (!args.includes('--force') && !args.includes('--dry-run'));
const FORCE   = args.includes('--force');
const DRY_RUN = args.includes('--dry-run');

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the plugin root directory.
 * Prefers CLAUDE_PLUGIN_ROOT env var; falls back to two directories above this
 * script (scripts/update.js -> scripts/ -> plugin root).
 */
function resolvePluginRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    return path.resolve(process.env.CLAUDE_PLUGIN_ROOT);
  }
  return path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1')), '..');
}

/**
 * Resolve the user home directory cross-platform.
 */
function resolveHome() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

// ---------------------------------------------------------------------------
// Version reading
// ---------------------------------------------------------------------------

function readCurrentVersion(pluginRoot) {
  const configPath = path.join(pluginRoot, 'artibot.config.json');
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return config.version || '0.0.0';
  } catch {
    // Fallback to package.json
    try {
      const pkg = JSON.parse(readFileSync(path.join(pluginRoot, 'package.json'), 'utf-8'));
      return pkg.version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }
}

// ---------------------------------------------------------------------------
// GitHub API fetch (Node 18+ native fetch)
// ---------------------------------------------------------------------------

const GITHUB_API_URL = 'https://api.github.com/repos/Yoodaddy0311/artibot/releases/latest';
const FETCH_TIMEOUT_MS = 5000;

async function fetchLatestRelease() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(GITHUB_API_URL, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'artibot-update-script',
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub API returned HTTP ${response.status}`);
    }

    const data = await response.json();
    return data.tag_name || null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Manual instructions (shown when automated update fails)
// ---------------------------------------------------------------------------

function printManualInstructions() {
  console.log('');
  console.log('To update manually:');
  console.log('  claude plugin install artibot');
  console.log('');
  console.log('Or download the latest release from:');
  console.log('  https://github.com/Yoodaddy0311/artibot/releases/latest');
}

// ---------------------------------------------------------------------------
// Backup metadata
// ---------------------------------------------------------------------------

function saveBackupInfo(home, currentVersion) {
  const backupDir = path.join(home, '.claude', 'artibot');
  try {
    mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, 'update-backup.json');
    writeFileSync(backupPath, JSON.stringify({
      previousVersion: currentVersion,
      backupTimestamp: new Date().toISOString(),
    }, null, 2), 'utf-8');
  } catch {
    // Non-fatal: backup metadata is best-effort
  }
}

// ---------------------------------------------------------------------------
// Cache clearing
// ---------------------------------------------------------------------------

function clearCache(home) {
  const cachePath = path.join(home, '.claude', 'plugins', 'cache', 'artibot');
  if (existsSync(cachePath)) {
    rmSync(cachePath, { recursive: true, force: true });
    console.log(`  Cache cleared: ${cachePath}`);
  } else {
    console.log('  Cache directory not found (skipped).');
  }
}

// ---------------------------------------------------------------------------
// Plugin install
// ---------------------------------------------------------------------------

function runInstall() {
  execSync('claude plugin install artibot', { stdio: 'inherit', timeout: 300_000 });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const pluginRoot = resolvePluginRoot();
  const home = resolveHome();

  const currentVersion = readCurrentVersion(pluginRoot);
  console.log(`Artibot Update Check`);
  console.log(`====================`);
  console.log(`Installed version : v${currentVersion}`);

  // Fetch latest release tag from GitHub
  let latestVersion;
  try {
    latestVersion = await fetchLatestRelease();
    if (!latestVersion) {
      throw new Error('No release tag found in API response.');
    }
    console.log(`Latest version    : ${latestVersion}`);
  } catch (err) {
    const isTimeout = err.name === 'AbortError';
    console.error(`\nError fetching latest release: ${isTimeout ? 'request timed out after 5s' : err.message}`);
    console.error('Could not determine whether an update is available.');
    printManualInstructions();
    process.exit(1);
  }

  const updateAvailable = isNewerVersion(currentVersion, latestVersion);
  const aheadOfRelease = isNewerVersion(latestVersion, currentVersion);
  const upToDate = !updateAvailable && !aheadOfRelease;

  if (aheadOfRelease) {
    console.log(`\nStatus: Installed version is ahead of the latest release (pre-release or local build).`);
  } else if (upToDate) {
    console.log(`\nStatus: Already up to date.`);
  } else {
    console.log(`\nStatus: Update available (${currentVersion} -> ${latestVersion})`);
  }

  // --check mode: stop here
  if (CHECK && !FORCE) {
    if (updateAvailable) {
      console.log('\nRun `/artibot:update --force` to install the update.');
    }
    process.exit(0);
  }

  // Determine if we should proceed with install
  const shouldInstall = FORCE || updateAvailable;

  if (!shouldInstall) {
    console.log('\nNothing to install. Use --force to reinstall anyway.');
    process.exit(0);
  }

  // Show update plan
  console.log('');
  console.log('Update Plan');
  console.log('-----------');
  console.log(`  1. Save backup metadata to ~/.claude/artibot/update-backup.json`);
  console.log(`  2. Clear plugin cache at ~/.claude/plugins/cache/artibot/`);
  console.log(`  3. Run: claude plugin install artibot`);

  if (DRY_RUN) {
    console.log('\n[dry-run] No changes made. Remove --dry-run to execute.');
    process.exit(0);
  }

  // Execute update
  console.log('');
  console.log('Applying update...');

  // Step 1: Save backup metadata
  saveBackupInfo(home, currentVersion);
  console.log('  Backup metadata saved.');

  // Step 2: Clear cache
  clearCache(home);

  // Step 3: Install
  console.log('  Installing via: claude plugin install artibot');
  try {
    runInstall();
  } catch (err) {
    console.error(`\nInstall command failed: ${err.message}`);
    console.error('The cache has already been cleared. Please complete the update manually:');
    printManualInstructions();
    process.exit(1);
  }

  console.log('');
  console.log('Update complete.');
  console.log('RESTART REQUIRED: Please restart Claude Code for the update to take effect.');
}

main().catch((err) => {
  console.error(`[artibot:update] Unexpected error: ${err.message}`);
  process.exit(1);
});
