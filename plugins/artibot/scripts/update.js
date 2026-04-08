#!/usr/bin/env node
/**
 * update.js - Artibot version check and update script.
 *
 * Usage:
 *   node update.js [--check] [--force] [--dry-run]
 *
 * Flags:
 *   (none)     Auto-update: check version and install if update available
 *   --check    Check version only, do not update
 *   --force    Force reinstall regardless of current version
 *   --dry-run  Print what would happen without executing it
 *
 * Zero dependencies. Node 18+ built-ins only. ESM module format.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { isNewerVersion } from '../lib/core/version-checker.js';
import { getPluginRoot } from '../lib/core/platform.js';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const FORCE      = args.includes('--force');
const DRY_RUN    = args.includes('--dry-run');

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

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

// Note: This URL is also defined in version-checker.js (FETCH_TIMEOUT differs intentionally:
// version-checker uses 3s for non-blocking session-start checks; update.js uses 5s for explicit user action).
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
// Source update (git pull)
// ---------------------------------------------------------------------------

/**
 * Find the git source repo root.
 *
 * Strategy (ordered by priority):
 *   1. source-repo.json — saved by install.sh during initial install
 *   2. installScriptPath — walk up from install.sh looking for .git
 *   3. give up — return null (tarball install or deleted repo)
 *
 * @param {string} [installScriptDir] - Directory containing install.sh
 * @returns {{ gitRoot: string, pluginDir: string } | null}
 */
function findSourceRepo(installScriptDir) {
  // 1. Saved source-repo.json (most reliable)
  const home = resolveHome();
  const sourceJson = path.join(home, '.claude', 'artibot', 'source-repo.json');
  try {
    const data = JSON.parse(readFileSync(sourceJson, 'utf-8'));
    if (data.repoRoot && existsSync(path.join(data.repoRoot, '.git'))) {
      return { gitRoot: data.repoRoot, pluginDir: data.pluginDir || path.join(data.repoRoot, 'plugins', 'artibot') };
    }
    // source-repo.json exists but path is stale (different machine or moved repo)
    if (data.repoRoot) {
      console.warn(`  Warning: source-repo.json points to ${data.repoRoot} which no longer exists.`);
      console.warn('  Searching common locations...');
    }
  } catch {
    // source-repo.json not found or invalid — fall through
  }

  // 1.5. Auto-detect from common clone locations (handles cross-machine git pull)
  const commonLocations = [
    path.join(home, 'Projects', 'Artibot'),
    path.join(home, 'projects', 'Artibot'),
    path.join(home, 'dev', 'Artibot'),
    path.join(home, 'artibot'),
    path.join(home, 'Projects', 'artibot'),
    path.join(home, 'projects', 'artibot'),
    path.join(home, 'src', 'Artibot'),
    path.join(home, 'src', 'artibot'),
  ];
  for (const loc of commonLocations) {
    const pluginDir = path.join(loc, 'plugins', 'artibot');
    if (existsSync(path.join(loc, '.git')) && existsSync(path.join(pluginDir, 'package.json'))) {
      console.log(`  Found source repo at ${loc} (auto-detected)`);
      return { gitRoot: loc, pluginDir };
    }
  }

  // 2. Walk up from install.sh location
  if (installScriptDir) {
    let dir = path.resolve(installScriptDir);
    for (let i = 0; i < 5; i++) {
      if (existsSync(path.join(dir, '.git'))) {
        return { gitRoot: dir, pluginDir: installScriptDir };
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  return null;
}

/**
 * Pull latest source from the remote repository.
 *
 * Uses findSourceRepo() to locate the git repo, then runs `git pull`.
 * Non-fatal: if the repo is not found or pull fails, we log and continue.
 *
 * @param {string} [installScriptDir] - Directory containing install.sh
 * @returns {{ pulled: boolean, pluginDir: string | null }}
 */
function pullLatestSource(installScriptDir) {
  const repo = findSourceRepo(installScriptDir);

  if (!repo) {
    console.log('  Source repo not found. The update will use currently installed files.');
    console.log('  For full updates, clone the repo: git clone https://github.com/Yoodaddy0311/artibot.git');
    return { pulled: false, pluginDir: null };
  }

  try {
    // Detect current branch and its upstream remote for smart pull
    let pullCmd = 'git pull';
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: repo.gitRoot, encoding: 'utf-8', timeout: 5000,
      }).trim();
      let remote = 'origin';
      try {
        remote = execSync(`git config --get branch.${branch}.remote`, {
          cwd: repo.gitRoot, encoding: 'utf-8', timeout: 5000,
        }).trim() || 'origin';
      } catch {
        // No upstream configured — default to origin
      }
      pullCmd = `git pull ${remote} ${branch}`;
    } catch {
      // Fallback: try origin master, then origin main
      try {
        execSync('git rev-parse --verify origin/master', {
          cwd: repo.gitRoot, stdio: 'ignore', timeout: 5000,
        });
        pullCmd = 'git pull origin master';
      } catch {
        pullCmd = 'git pull origin main';
      }
    }

    console.log(`  Pulling latest source from ${repo.gitRoot}...`);
    execSync(pullCmd, {
      cwd: repo.gitRoot,
      stdio: 'inherit',
      timeout: 30_000,
    });
    console.log('  Source updated.');
    return { pulled: true, pluginDir: repo.pluginDir };
  } catch (err) {
    console.warn(`  Warning: git pull failed: ${err.message}`);
    console.warn('  Continuing with current local files.');
    return { pulled: false, pluginDir: repo.pluginDir };
  }
}

// ---------------------------------------------------------------------------
// Manual instructions (shown when automated update fails)
// ---------------------------------------------------------------------------

function printManualInstructions() {
  console.log('');
  console.log('To update manually:');
  console.log('  cd <artibot-repo>/plugins/artibot');
  console.log('  git pull origin master');
  console.log('  bash install.sh');
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

/**
 * Find install.sh by searching multiple candidate paths.
 * CLAUDE_PLUGIN_ROOT may point to a deleted cache directory after clearCache(),
 * so we check the source repo path first, then the installed copy, then the env var.
 */
function findInstallScript() {
  const candidates = [];

  // 1. Source repo: this file lives in <repo>/plugins/artibot/scripts/update.js
  //    install.sh is at <repo>/plugins/artibot/install.sh
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, '..');
  candidates.push(path.join(repoRoot, 'install.sh'));

  // 2. Installed copy in ~/.claude/artibot/
  const home = resolveHome();
  candidates.push(path.join(home, '.claude', 'artibot', 'install.sh'));

  // 3. CLAUDE_PLUGIN_ROOT (may be stale after cache clear, checked last)
  try {
    const envRoot = getPluginRoot();
    candidates.push(path.join(envRoot, 'install.sh'));
  } catch {
    // getPluginRoot may fail if env var points to deleted dir
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Find a working bash executable on the current platform.
 * On non-Windows systems, returns 'bash' directly.
 * On Windows, searches common Git for Windows installation paths.
 *
 * @returns {string | null} Path to bash executable, or null if not found
 */
function findBash() {
  if (process.platform !== 'win32') return 'bash';

  const candidates = [
    'bash', // Available via PATH (e.g., Git Bash in PATH)
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];

  for (const candidate of candidates) {
    try {
      execSync(`"${candidate}" --version`, { stdio: 'ignore', timeout: 5000 });
      return candidate;
    } catch {
      continue;
    }
  }

  return null;
}

function runInstall(preResolvedPath) {
  const installScript = preResolvedPath || findInstallScript();
  if (!installScript) {
    throw new Error(
      'install.sh not found. Searched: source repo, ~/.claude/artibot/, CLAUDE_PLUGIN_ROOT.\n' +
      'Run manually: cd <artibot-repo>/plugins/artibot && bash install.sh'
    );
  }

  const bash = findBash();
  if (!bash) {
    throw new Error(
      'bash not found. On Windows, install Git for Windows: https://git-scm.com/download/win\n' +
      'Or run manually in Git Bash: bash "' + installScript + '"'
    );
  }

  execSync(`"${bash}" "${installScript}"`, { stdio: 'inherit', timeout: 300_000 });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const pluginRoot = getPluginRoot();
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

  // --check mode: stop here (explicit --check flag only)
  if (CHECK_ONLY && !FORCE) {
    if (updateAvailable) {
      console.log('\nRun `/artibot:update --force` to force reinstall, or just `/artibot:update` to auto-update.');
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
  console.log(`  2. Pull latest source from git (if available)`);
  console.log(`  3. Run: bash install.sh`);
  console.log(`  4. Clear plugin cache at ~/.claude/plugins/cache/artibot/`);

  if (DRY_RUN) {
    console.log('\n[dry-run] No changes made. Remove --dry-run to execute.');
    process.exit(0);
  }

  // Execute update
  console.log('');
  console.log('Applying update...');

  // Step 0: Pre-resolve install.sh path BEFORE clearing cache
  //         (CLAUDE_PLUGIN_ROOT may point to cache, which gets deleted)
  const installScriptPath = findInstallScript();
  if (!installScriptPath) {
    console.error('\nCannot find install.sh before cache clear. Aborting to avoid broken state.');
    printManualInstructions();
    process.exit(1);
  }
  console.log(`  install.sh found: ${installScriptPath}`);

  // Step 1: Save backup metadata
  saveBackupInfo(home, currentVersion);
  console.log('  Backup metadata saved.');

  // Step 2: Pull latest source (git pull)
  //         Find source repo via source-repo.json or install.sh location
  const { pulled, pluginDir } = pullLatestSource(path.dirname(installScriptPath));

  // If pull succeeded and source repo has install.sh, prefer that (freshly updated)
  let finalInstallPath = installScriptPath;
  if (pulled && pluginDir) {
    const freshInstall = path.join(pluginDir, 'install.sh');
    if (existsSync(freshInstall)) {
      console.log(`  Using updated install.sh: ${freshInstall}`);
      finalInstallPath = freshInstall;
    }
  }

  // Step 3: Run install BEFORE clearing cache (prevents broken state on failure)
  console.log(`  Installing via: ${finalInstallPath}`);
  try {
    runInstall(finalInstallPath);
  } catch (err) {
    console.error(`\nInstall command failed: ${err.message}`);
    console.error('Cache was preserved. Please complete the update manually:');
    printManualInstructions();
    process.exit(1);
  }

  // Step 4: Clear cache AFTER successful install
  clearCache(home);

  // Step 5: Swarm autodetect — emit hint if user has a profile but no consent.
  // Non-blocking, advisory only. Run from the freshly-installed plugin root.
  try {
    const newPluginRoot = path.join(home, '.claude', 'artibot');
    const autodetectPath = path.join(newPluginRoot, 'scripts', 'swarm-autodetect.js');
    if (existsSync(autodetectPath)) {
      const result = execSync(`node "${autodetectPath}" --quiet`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      });
      if (result && result.trim()) {
        console.log('');
        console.log(result);
      }
    }
  } catch {
    // Never block update on swarm autodetect
  }

  console.log('');
  console.log('Update complete.');
  console.log('RESTART REQUIRED: Please restart Claude Code for the update to take effect.');
}

main().catch((err) => {
  console.error(`[artibot:update] Unexpected error: ${err.message}`);
  process.exit(1);
});
