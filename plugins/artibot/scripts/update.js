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

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNewerVersion } from '../lib/core/version-checker.js';
import { getPluginRoot } from '../lib/core/platform.js';
import { detectInstallMode, NATIVE_UPDATE_HINT } from '../lib/core/install-mode.js';
import {
  findBash,
  findInstallPs1,
  findInstallScript,
  findPowerShell,
  printManualInstructionsKo,
  resolveHome,
} from './update-platform.js';
import {
  assertGitHealth,
  findSourceRepo,
  popAutostash,
  pullLatestSource,
  resolveDefaultBranchPull,
  resolveRemoteDefaultBranch,
  stashIfDirty,
} from './update-git.js';
import {
  assertPostInstall,
  assertUpdatePrecondition,
  collectPostInstallInvariants,
  installLanded,
  renderInvariantTable,
} from './update-verify.js';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const FORCE      = args.includes('--force');
const DRY_RUN    = args.includes('--dry-run');

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
//
// The git source-repo discovery + pull machinery (findSourceRepo, stashIfDirty,
// popAutostash, resolveRemoteDefaultBranch, resolveDefaultBranchPull,
// resolveBranchPullArgs, attemptPull, pullLatestSource) plus the INV-7 pre-pull
// health gate (assertGitHealth) live in ./update-git.js — extracted to keep this
// file under the 800-line guideline. They are imported at the top, re-exported
// below for the existing unit tests, and wired into main() via pullLatestSource.

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
// Drift detection
// ---------------------------------------------------------------------------

/**
 * SHA-1 digest of a file's bytes, or null when the file is missing/unreadable.
 * Hash choice is deliberate: drift detection is integrity (not cryptographic),
 * SHA-1 keeps fingerprint format aligned with tests/hooks-schema-fingerprint.txt.
 */
function fileHash(filePath) {
  try {
    return createHash('sha1').update(readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Detect drift between the installed source's hooks.json and every cached
 * copy under ~/.claude/plugins/cache/artibot/artibot/<version>/.
 *
 * Why hooks.json specifically: it is what Claude Code loads at session start
 * and the file that caused the v4.6.4 → v4.8.2 silent regression. If the
 * cached copy diverges from the source, restarting Claude Code reloads stale
 * hooks even though `/update` reports "already up to date".
 *
 * Returns:
 *   { drift: false }                              — no cache present or all match
 *   { drift: true, sourceHash, mismatches: [...] }
 *     where each mismatch is { version, cacheHash }
 */
function detectHookDrift(pluginRoot, home) {
  const sourceHooks = path.join(pluginRoot, 'hooks', 'hooks.json');
  const sourceHash = fileHash(sourceHooks);
  if (!sourceHash) {
    return { drift: false, reason: 'source hooks.json unreadable' };
  }

  const cacheRoot = path.join(home, '.claude', 'plugins', 'cache', 'artibot', 'artibot');
  if (!existsSync(cacheRoot)) {
    return { drift: false, reason: 'no plugin cache present' };
  }

  let entries;
  try {
    entries = readdirSync(cacheRoot, { withFileTypes: true });
  } catch {
    return { drift: false, reason: 'cache root unreadable' };
  }

  const mismatches = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const cacheHooks = path.join(cacheRoot, entry.name, 'hooks', 'hooks.json');
    const cacheHash = fileHash(cacheHooks);
    if (cacheHash === null) continue; // missing cache file isn't drift — it's incomplete cache
    if (cacheHash !== sourceHash) {
      mismatches.push({ version: entry.name, cacheHash });
    }
  }

  if (mismatches.length === 0) {
    return { drift: false, sourceHash };
  }
  return { drift: true, sourceHash, mismatches };
}

// ---------------------------------------------------------------------------
// Plugin install
// ---------------------------------------------------------------------------

/**
 * Run the installer for the current platform.
 *
 * Windows: prefer the native PowerShell installer (install.ps1) when both a
 * PowerShell runtime and the .ps1 file are present — it is the flat-copy
 * installer authored specifically for Windows and is far more robust than
 * shelling out to a (often absent) bash. Only when install.ps1 OR a PowerShell
 * runtime is missing do we fall back to bash + install.sh. When neither runtime
 * exists, print Korean manual instructions and graceful-exit (no crash).
 *
 * Non-Windows: unchanged — bash + install.sh.
 *
 * @param {string} preResolvedPath - Pre-resolved install.sh path (may be null)
 * @param {string} [preResolvedPs1] - Pre-resolved install.ps1 path (may be null)
 */
function runInstall(preResolvedPath, preResolvedPs1) {
  const installScript = preResolvedPath || findInstallScript();

  // --- Windows: PowerShell-first path ---------------------------------------
  if (process.platform === 'win32') {
    const ps1 = preResolvedPs1 || findInstallPs1();
    if (ps1) {
      const powershell = findPowerShell();
      if (powershell) {
        console.log(`  Running PowerShell installer: ${ps1}`);
        execFileSync(
          powershell,
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
          { stdio: 'inherit', timeout: 300_000 },
        );
        return;
      }
      console.warn('  PowerShell not found; falling back to bash + install.sh.');
    }
    // No install.ps1 (or no PowerShell): fall through to bash path below.
  }

  if (!installScript) {
    // On Windows with neither a usable ps1 path nor install.sh, surface Korean
    // guidance and graceful-exit instead of throwing an opaque error.
    if (process.platform === 'win32') {
      printManualInstructionsKo(preResolvedPs1 || findInstallPs1(), null);
      process.exit(1);
    }
    throw new Error(
      'install.sh not found. Searched: source repo, ~/.claude/artibot/, CLAUDE_PLUGIN_ROOT.\n' +
      'Run manually: cd <artibot-repo>/plugins/artibot && bash install.sh'
    );
  }

  const bash = findBash();
  if (!bash) {
    if (process.platform === 'win32') {
      // Both PowerShell-install.ps1 and bash are unavailable — graceful exit
      // with Korean manual instructions rather than a crash.
      printManualInstructionsKo(preResolvedPs1 || findInstallPs1(), installScript);
      process.exit(1);
    }
    throw new Error(
      'bash not found. On Windows, install Git for Windows: https://git-scm.com/download/win\n' +
      'Or run manually in Git Bash: bash "' + installScript + '"'
    );
  }

  execFileSync(bash, [installScript], { stdio: 'inherit', timeout: 300_000 });
}

// ---------------------------------------------------------------------------
// Post-install verification
// ---------------------------------------------------------------------------
//
// The pre/post-condition gates (installLanded, assertUpdatePrecondition,
// collectPostInstallInvariants, assertPostInstall, renderInvariantTable) live in
// ./update-verify.js — extracted to keep this file under the 800-line guideline
// and to give the "never silently no-op" invariants a single unit-testable home.
// They are imported at the top and wired into main() below.

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

  // Install-mode gate (B3): the git-pull + install.sh flow below assumes the
  // LEGACY flat install (~/.claude/artibot + git source). A NATIVE marketplace
  // install runs from the plugin cache and is updated by Claude Code itself, so
  // running the legacy flow there makes wrong path assumptions. Detect and, for
  // a confident native install, print the correct command and exit cleanly.
  // Ambiguous layouts stay conservative: warn once and fall through to legacy.
  const installMode = detectInstallMode({ pluginRoot, home });
  if (installMode.mode === 'native') {
    console.log('');
    console.log('Status: Native marketplace install detected.');
    console.log('This copy runs from the Claude plugin cache — update it with:');
    console.log(`  ${NATIVE_UPDATE_HINT}`);
    console.log('(The built-in git-pull + install.sh updater is for the legacy flat install only.)');
    process.exit(0);
  }
  if (installMode.mode === 'ambiguous') {
    console.warn(`  [warn] Install layout ambiguous (${installMode.reason}); proceeding with the legacy updater.`);
  }

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
      console.log('\nRun `/update --force` to force reinstall, or just `/update` to auto-update.');
    }
    process.exit(0);
  }

  // Drift detection: even when the version matches, the plugin cache at
  // ~/.claude/plugins/cache/artibot/artibot/<version>/ can diverge from the
  // source if a previous install bumped only the marketplace mirror. Compare
  // hooks.json hashes — divergence is the smoking gun for the v4.6.4 → v4.8.2
  // hook regression pattern. Skip in --check mode (no install allowed).
  const driftReport = !CHECK_ONLY ? detectHookDrift(pluginRoot, home) : { drift: false };
  if (driftReport.drift) {
    console.log('');
    console.log('Hook drift detected:');
    for (const m of driftReport.mismatches) {
      console.log(`  cache v${m.version} hooks.json (${m.cacheHash.slice(0, 8)}) ≠ source (${driftReport.sourceHash.slice(0, 8)})`);
    }
    console.log('  Triggering reinstall to resync cache.');
  }

  // Determine if we should proceed with install
  const shouldInstall = FORCE || updateAvailable || driftReport.drift;

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

  // Step 0: Pre-resolve installer paths BEFORE clearing cache
  //         (CLAUDE_PLUGIN_ROOT may point to cache, which gets deleted).
  //         On Windows the PowerShell installer (install.ps1) is preferred and
  //         is sufficient on its own, so we accept either installer being found.
  const installScriptPath = findInstallScript();
  const installPs1Path = findInstallPs1();
  const isWin = process.platform === 'win32';
  const haveAnyInstaller = installScriptPath || (isWin && installPs1Path);
  if (!haveAnyInstaller) {
    console.error('\nCannot find install.sh (or install.ps1) before cache clear. Aborting to avoid broken state.');
    printManualInstructions();
    process.exit(1);
  }
  if (installScriptPath) console.log(`  install.sh found: ${installScriptPath}`);
  if (isWin && installPs1Path) console.log(`  install.ps1 found: ${installPs1Path}`);

  // Step 1: Save backup metadata
  saveBackupInfo(home, currentVersion);
  console.log('  Backup metadata saved.');

  // Step 2: Pull latest source (git pull)
  //         Find source repo via the installer's directory (sh path when
  //         available, otherwise the ps1 path on Windows).
  const installerDir = path.dirname(installScriptPath || installPs1Path);

  // Step 2.0: Pre-pull git health gate (INV-7). Asserts .git presence + a
  // knowable working-tree state + a resolvable remote pull target BEFORE the
  // pull. This is advisory diagnostics: a failed check is logged (the pull may
  // still no-op), and the post-install invariants are the hard gate. Surfacing
  // it here turns the silent "pull found no remote ref" case into a visible
  // reason early in the run.
  const healthRepo = findSourceRepo(installerDir);
  if (healthRepo) {
    const health = assertGitHealth(healthRepo.gitRoot);
    if (health.ok) {
      console.log(`  Git health OK (pull target: origin/${health.pullTarget}${health.dirty ? ', working tree dirty — will auto-stash' : ''}).`);
    } else {
      console.warn(`  Git health check flagged: ${health.reason} (at ${healthRepo.gitRoot}).`);
      console.warn('  The pull may fail or no-op; post-install invariants will catch a false success.');
    }
  }

  const { pulled, pluginDir } = pullLatestSource(installerDir);

  // If pull succeeded and the source repo has fresh installers, prefer them.
  let finalInstallPath = installScriptPath;
  let finalPs1Path = installPs1Path;
  if (pulled && pluginDir) {
    const freshInstall = path.join(pluginDir, 'install.sh');
    if (existsSync(freshInstall)) {
      console.log(`  Using updated install.sh: ${freshInstall}`);
      finalInstallPath = freshInstall;
    }
    const freshPs1 = path.join(pluginDir, 'install.ps1');
    if (isWin && existsSync(freshPs1)) {
      console.log(`  Using updated install.ps1: ${freshPs1}`);
      finalPs1Path = freshPs1;
    }
  }

  // Step 2.5: Pre-condition gate (INV-2) — refuse a guaranteed no-op BEFORE
  // running the installer. If a real update is pending but no fresh source was
  // pulled AND the only installer we can run lives under the installed copy
  // (~/.claude/artibot, i.e. self-install), the copy phase will be skipped and
  // the installer exits 0 having changed nothing. Block here with a clear,
  // recoverable message instead of running it and falsely reporting success.
  const installerPluginDir = path.dirname((isWin && finalPs1Path) ? finalPs1Path : finalInstallPath);
  const pre = assertUpdatePrecondition({
    updateAvailable,
    pulled,
    sourcePluginDir: pulled ? pluginDir : null,
    installTargetDir: installerPluginDir,
    home,
  });
  if (!pre.ok) {
    console.error('');
    console.error(`Refusing to run a no-op install (${pre.reason}): an update to ${latestVersion} is`);
    console.error('  pending, but no fresh source was pulled and the only available installer is the');
    console.error('  already-installed copy — running it would change nothing yet report success.');
    console.error('  Most likely the source git pull failed (deleted/renamed remote branch) or no');
    console.error('  source clone exists on this machine.');
    printManualInstructions();
    process.exit(1);
  }

  // Step 3: Run install BEFORE clearing cache (prevents broken state on failure)
  console.log(`  Installing via: ${(isWin && finalPs1Path) ? finalPs1Path : finalInstallPath}`);
  try {
    runInstall(finalInstallPath, finalPs1Path);
  } catch (err) {
    console.error(`\nInstall command failed: ${err.message}`);
    console.error('Cache was preserved. Please complete the update manually:');
    printManualInstructions();
    process.exit(1);
  }

  // Step 4: Clear cache AFTER successful install
  clearCache(home);

  // Step 4.5: Post-install verification — assert the termination invariants
  // before claiming success. Re-read the version from the INSTALLED copy
  // (~/.claude/artibot), not the source pluginRoot, then collect INV-1/3/4/5/6
  // (version landing, hooks-copy completeness, marketplace-mirror consistency,
  // cache no-drift, no-op marker) and render a from->to self-check table. Any
  // failure is a false-success risk (the artibot/master dead-branch incident) —
  // surface it loudly with manual recovery instead of a quiet "Update complete".
  const installedRoot = path.join(home, '.claude', 'artibot');
  const installedNow = readCurrentVersion(installedRoot);
  const invariants = collectPostInstallInvariants({
    home,
    installedRoot,
    sourcePluginRoot: pulled ? pluginDir : null,
    installedVersion: installedNow,
    latestVersion,
    updateAvailable,
  });
  const postCheck = assertPostInstall(invariants);
  console.log('');
  console.log('Post-install self-check:');
  console.log(renderInvariantTable(invariants));
  if (!postCheck.ok) {
    console.error('');
    console.error(`Update did NOT land cleanly — ${postCheck.failures.length} invariant(s) failed:`);
    for (const f of postCheck.failures) {
      console.error(`  ${f.id} ${f.label}: ${f.detail}`);
    }
    console.error('  The installer most likely copied no new files — e.g. the source git pull');
    console.error('  failed (deleted/renamed remote branch) and install fell back to the');
    console.error('  already-installed copy (self-install no-op).');
    printManualInstructions();
    process.exit(1);
  }

  // Step 5: Swarm autodetect — auto-activate federated learning from the
  // committed swarm-profile.json (if present). One-time per repoUrl+machine.
  try {
    const newPluginRoot = path.join(home, '.claude', 'artibot');
    const autodetectPath = path.join(newPluginRoot, 'scripts', 'swarm-autodetect.js');
    if (existsSync(autodetectPath)) {
      const result = execFileSync(process.execPath, [autodetectPath, '--auto'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000,
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

// Only run main() when invoked as a CLI script, not when imported by tests.
const isCliEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCliEntrypoint) {
  main().catch((err) => {
    console.error(`[update] Unexpected error: ${err.message}`);
    process.exit(1);
  });
}

// Named exports for unit testing. Leaves CLI behavior unchanged.
//
// Git helpers (findSourceRepo, stashIfDirty, popAutostash,
// resolveRemoteDefaultBranch, resolveDefaultBranchPull) and the INV-7 health
// gate (assertGitHealth) now live in ./update-git.js — they are imported at the
// top and RE-EXPORTED here so the existing update.test.js / install-update.test.js
// import sites keep working unchanged (single public surface = update.js).
export {
  readCurrentVersion,
  resolveHome,
  findInstallScript,
  findInstallPs1,
  findBash,
  findPowerShell,
  findSourceRepo,
  saveBackupInfo,
  clearCache,
  detectHookDrift,
  fileHash,
  stashIfDirty,
  popAutostash,
  resolveRemoteDefaultBranch,
  resolveDefaultBranchPull,
  assertGitHealth,
  installLanded,
};
