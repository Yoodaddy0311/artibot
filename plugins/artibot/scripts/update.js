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
  // Includes Windows OneDrive-redirected Desktop paths (English + Korean
  // localized "바탕 화면") because OneDrive silently relocates ~/Desktop to
  // ~/OneDrive/Desktop on consumer setups — the primary maintainer's clone
  // lives at "OneDrive/바탕 화면/AI/artibot" exactly because of this.
  const oneDriveBase = path.join(home, 'OneDrive');
  const commonLocations = [
    path.join(home, 'Projects', 'Artibot'),
    path.join(home, 'projects', 'Artibot'),
    path.join(home, 'dev', 'Artibot'),
    path.join(home, 'artibot'),
    path.join(home, 'Projects', 'artibot'),
    path.join(home, 'projects', 'artibot'),
    path.join(home, 'src', 'Artibot'),
    path.join(home, 'src', 'artibot'),
    path.join(home, 'Desktop', 'AI', 'artibot'),
    path.join(home, 'Desktop', 'artibot'),
    path.join(oneDriveBase, 'Desktop', 'AI', 'artibot'),
    path.join(oneDriveBase, 'Desktop', 'artibot'),
    path.join(oneDriveBase, '바탕 화면', 'AI', 'artibot'),
    path.join(oneDriveBase, '바탕 화면', 'artibot'),
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
 * Stash a dirty working tree before pull, returning whether a stash was made.
 *
 * Root cause this addresses: tracked files that hooks auto-edit during a
 * session (e.g. `.artibot/SESSION-NOTES.md`) leave the working tree dirty, so
 * `git pull` refuses with "local changes would be overwritten". Because
 * `/update` is an explicit, user-initiated action (not the git-autopilot
 * interval auto-save), there is no concurrent stash to race with — a scoped
 * stash here is safe.
 *
 * @param {string} gitRoot
 * @returns {boolean} true when a stash entry was created (caller must pop)
 */
function stashIfDirty(gitRoot) {
  let dirty;
  try {
    dirty = execFileSync('git', ['status', '--porcelain'], {
      cwd: gitRoot, encoding: 'utf-8', timeout: 5000,
    }).trim();
  } catch {
    return false; // git status failed — don't risk a stash we can't reason about
  }
  if (!dirty) return false;

  try {
    execFileSync('git', ['stash', 'push', '--include-untracked', '-m', 'artibot-update-autostash'], {
      cwd: gitRoot, stdio: 'inherit', timeout: 15_000,
    });
    console.log('  Stashed local changes before pull (artibot-update-autostash).');
    return true;
  } catch (err) {
    console.warn(`  Warning: could not stash local changes: ${err.message}`);
    return false;
  }
}

/**
 * Restore a previously-created auto-stash after pull. A pop conflict is
 * surfaced as a warning (never thrown) and the stash is intentionally left on
 * the stack so the user can resolve it manually — losing their changes
 * silently would be worse than a noisy warning.
 *
 * @param {string} gitRoot
 */
function popAutostash(gitRoot) {
  try {
    execFileSync('git', ['stash', 'pop'], {
      cwd: gitRoot, stdio: 'inherit', timeout: 15_000,
    });
    console.log('  Restored local changes (stash pop).');
  } catch (err) {
    console.warn(`  Warning: stash pop hit a conflict: ${err.message}`);
    console.warn('  Your changes are preserved in `git stash list` (artibot-update-autostash).');
    console.warn('  Resolve manually with: git stash pop');
  }
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
/**
 * Resolve a fallback pull target when neither @{u} nor origin/<HEAD-branch>
 * resolves. Probes (in order): origin/artibot/master, origin/master,
 * origin/main. Last fall-through uses origin/main even when unverified so the
 * caller still gets a deterministic pullArgs array.
 *
 * @param {string} gitRoot
 * @returns {string[]} ['pull', remote, branch]
 */
function resolveDefaultBranchPull(gitRoot) {
  for (const ref of ['artibot/master', 'master', 'main']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', `origin/${ref}`], {
        cwd: gitRoot, stdio: 'ignore', timeout: 5000,
      });
      return ['pull', 'origin', ref];
    } catch { /* try next */ }
  }
  return ['pull', 'origin', 'main'];
}

/**
 * Probe whether `origin/<branch>` exists locally, returning the matching
 * `git pull` args when it does and falling back to the default-branch
 * resolver otherwise. Extracted from pullLatestSource() to keep the
 * upstream-detection try/catch nest under max-depth=4 (eslint cap).
 *
 * @param {string} gitRoot
 * @param {string} branch
 * @returns {string[]} pull args
 */
function resolveBranchPullArgs(gitRoot, branch) {
  try {
    execFileSync('git', ['rev-parse', '--verify', `origin/${branch}`], {
      cwd: gitRoot, stdio: 'ignore', timeout: 5000,
    });
    return ['pull', 'origin', branch];
  } catch {
    // origin/<current-branch> doesn't exist — try default branches.
    return resolveDefaultBranchPull(gitRoot);
  }
}

function pullLatestSource(installScriptDir) {
  const repo = findSourceRepo(installScriptDir);

  if (!repo) {
    console.log('  Source repo not found. The update will use currently installed files.');
    console.log('  For full updates, clone the repo: git clone https://github.com/Yoodaddy0311/artibot.git');
    return { pulled: false, pluginDir: null };
  }

  try {
    // Detect current branch + upstream remote for smart pull.
    //
    // Security: pullArgs MUST be passed to execFileSync as an array — never
    // interpolated into a shell string. Branch names CAN contain shell
    // metachars (semicolons, backticks). String interpolation would let a
    // malicious origin (or a tampered local repo) inject arbitrary shell.
    let pullArgs = ['pull'];
    // Upstream-first resolution: read the actual configured upstream of HEAD
    // via `git rev-parse --abbrev-ref @{u}`. This returns "remote/branch"
    // (e.g. "origin/artibot/master") and is the authoritative source — only
    // fall back to candidate branches when no upstream is configured.
    //
    // The previous fallback ordering (origin/artibot/master -> origin/master
    // -> origin/main) ran unconditionally on rev-parse HEAD failure and could
    // pull a non-tracked branch INTO the current HEAD, fabricating divergent
    // history. The autopilot-drift-fix-2026-05-16 incident hit exactly this.
    try {
      const upstream = execFileSync('git', ['rev-parse', '--abbrev-ref', '@{u}'], {
        cwd: repo.gitRoot, encoding: 'utf-8', timeout: 5000,
      }).trim();
      const slashIdx = upstream.indexOf('/');
      if (slashIdx > 0) {
        const remote = upstream.slice(0, slashIdx);
        const branch = upstream.slice(slashIdx + 1);
        pullArgs = ['pull', remote, branch];
      } else {
        // Malformed upstream (no slash) — treat as no-upstream case
        throw new Error('upstream lacks remote/ prefix');
      }
    } catch {
      // No upstream configured. Resolve current branch and try matching
      // remote refs first; only fall back to default branches if HEAD itself
      // is detached or untracked.
      try {
        const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: repo.gitRoot, encoding: 'utf-8', timeout: 5000,
        }).trim();
        pullArgs = (branch && branch !== 'HEAD')
          ? resolveBranchPullArgs(repo.gitRoot, branch)
          : resolveDefaultBranchPull(repo.gitRoot);
      } catch {
        pullArgs = resolveDefaultBranchPull(repo.gitRoot);
      }
    }

    // Auto-stash a dirty working tree so hook-edited tracked files (e.g.
    // .artibot/SESSION-NOTES.md) don't block the pull. Pop afterwards in the
    // finally so the stash is always restored even if the pull throws.
    const stashed = stashIfDirty(repo.gitRoot);
    try {
      console.log(`  Pulling latest source from ${repo.gitRoot}...`);
      execFileSync('git', pullArgs, {
        cwd: repo.gitRoot,
        stdio: 'inherit',
        timeout: 30_000,
      });
      console.log('  Source updated.');
    } finally {
      if (stashed) popAutostash(repo.gitRoot);
    }
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
 * Find install.sh by searching multiple candidate paths.
 * CLAUDE_PLUGIN_ROOT may point to a deleted cache directory after clearCache(),
 * so we check the source repo path first, then the installed copy, then the env var.
 */
function findInstallScript() {
  // Candidates are labelled by ACTUAL origin (source repo vs installed copy
  // vs plugin cache). When update.js runs from the per-version plugin cache
  // (~/.claude/plugins/cache/artibot/artibot/<v>/scripts/), the "source repo"
  // candidate previously labelled here is actually the cache itself —
  // mislabelling pointed debuggers at the wrong directory during hook-drift
  // postmortems.
  const candidates = [];
  const home = resolveHome();
  const claudeCacheRoot = path.join(home, '.claude', 'plugins', 'cache', 'artibot');

  // 1. <this-file>/../install.sh — could be source repo OR cache. Detect by
  //    whether the resolved path sits under the Claude plugin cache root.
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const localRoot = path.resolve(scriptDir, '..');
  const localCandidate = path.join(localRoot, 'install.sh');
  const localIsCache = localCandidate.startsWith(claudeCacheRoot);
  candidates.push({
    path: localCandidate,
    label: localIsCache ? 'plugin cache' : 'source repo',
  });

  // 2. Installed copy in ~/.claude/artibot/
  candidates.push({
    path: path.join(home, '.claude', 'artibot', 'install.sh'),
    label: 'installed copy (~/.claude/artibot/)',
  });

  // 3. CLAUDE_PLUGIN_ROOT (may be stale after cache clear, checked last)
  try {
    const envRoot = getPluginRoot();
    candidates.push({
      path: path.join(envRoot, 'install.sh'),
      label: 'CLAUDE_PLUGIN_ROOT',
    });
  } catch {
    // getPluginRoot may fail if env var points to deleted dir
  }

  for (const c of candidates) {
    if (existsSync(c.path)) {
      console.log(`  install.sh resolved via ${c.label}: ${c.path}`);
      return c.path;
    }
  }

  return null;
}

/**
 * Locate install.ps1 by searching the same candidate paths as findInstallScript()
 * but for the PowerShell installer. On Windows the .ps1 installer is the more
 * robust path (it is the native flat-copy installer authored for Windows), so we
 * resolve it independently and prefer it in runInstall().
 *
 * Mirrors findInstallScript()'s priority order: local (source repo OR cache) →
 * installed copy (~/.claude/artibot/) → CLAUDE_PLUGIN_ROOT.
 *
 * @returns {string | null} Absolute path to install.ps1, or null when absent
 */
function findInstallPs1() {
  const candidates = [];
  const home = resolveHome();

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  candidates.push(path.join(path.resolve(scriptDir, '..'), 'install.ps1'));
  candidates.push(path.join(home, '.claude', 'artibot', 'install.ps1'));
  try {
    candidates.push(path.join(getPluginRoot(), 'install.ps1'));
  } catch {
    // getPluginRoot may fail if env var points to a deleted dir
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Infer the Git for Windows bash.exe path from `git --exec-path`.
 *
 * `git --exec-path` returns e.g. "C:/Program Files/Git/mingw64/libexec/git-core";
 * bash.exe lives at "<install>/bin/bash.exe". We walk up from libexec to the
 * Git install root and append bin/bash.exe. Returns null when git is absent or
 * the inferred path doesn't exist.
 *
 * @returns {string | null}
 */
function inferBashFromGitExecPath() {
  try {
    const execPath = execFileSync('git', ['--exec-path'], {
      encoding: 'utf-8', timeout: 5000,
    }).trim();
    if (!execPath) return null;
    // .../mingw64/libexec/git-core -> walk up to the Git install root.
    const coreDir = execPath.replace(/[/\\]/g, path.sep);
    // git-core -> libexec -> mingw64 (or mingw32 / usr) -> install root
    const installRoot = path.resolve(coreDir, '..', '..', '..');
    const candidate = path.join(installRoot, 'bin', 'bash.exe');
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a bash on PATH via `where bash` (Windows). Returns the first hit, or
 * null when `where` finds nothing.
 *
 * @returns {string | null}
 */
function inferBashFromWhere() {
  try {
    const out = execFileSync('where', ['bash'], {
      encoding: 'utf-8', timeout: 5000,
    }).trim();
    const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return first && existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

/**
 * Find a working bash executable on the current platform.
 * On non-Windows systems, returns 'bash' directly.
 * On Windows, searches common installation paths across distributions:
 * Git for Windows (Program Files + LOCALAPPDATA), Scoop, Chocolatey, plus
 * `git --exec-path` inference and a PATH lookup via `where bash`.
 *
 * @returns {string | null} Path to bash executable, or null if not found
 */
function findBash() {
  if (process.platform !== 'win32') return 'bash';

  const home = resolveHome();
  const candidates = [
    'bash', // Available via PATH (e.g., Git Bash in PATH)
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
    // Scoop (per-user install): ~/scoop/apps/git/current/bin/bash.exe
    path.join(home, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
    // Chocolatey shim
    'C:\\ProgramData\\chocolatey\\bin\\bash.exe',
  ];

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore', timeout: 5000 });
      return candidate;
    } catch {
      continue;
    }
  }

  // Fall back to dynamic discovery: infer from git's own exec-path, then PATH.
  for (const inferred of [inferBashFromGitExecPath(), inferBashFromWhere()]) {
    if (!inferred) continue;
    try {
      execFileSync(inferred, ['--version'], { stdio: 'ignore', timeout: 5000 });
      return inferred;
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Find a working PowerShell executable on Windows. Prefers Windows PowerShell
 * (`powershell.exe`, always present on Win10/11) then PowerShell 7+ (`pwsh`).
 * Returns null on non-Windows or when neither responds.
 *
 * @returns {string | null}
 */
function findPowerShell() {
  if (process.platform !== 'win32') return null;

  const candidates = ['powershell.exe', 'powershell', 'pwsh.exe', 'pwsh'];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
        stdio: 'ignore', timeout: 8000,
      });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Korean guidance shown when no installer runtime (powershell/bash) is found.
 * Printed to stderr; the caller graceful-exits with a non-zero code instead of
 * throwing an opaque stack trace.
 *
 * @param {string | null} ps1Path
 * @param {string | null} shPath
 */
function printManualInstructionsKo(ps1Path, shPath) {
  console.error('');
  console.error('자동 업데이트를 실행할 수 없습니다 (PowerShell·bash 모두 찾지 못함).');
  console.error('아래 방법으로 직접 업데이트해 주세요:');
  console.error('');
  if (process.platform === 'win32') {
    if (ps1Path) {
      console.error('  [PowerShell 권장]');
      console.error(`    powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1Path}"`);
      console.error('');
    }
    console.error('  [Git Bash]');
    console.error('    Git for Windows 설치: https://git-scm.com/download/win');
    console.error(`    설치 후: bash "${shPath || 'install.sh'}"`);
  } else {
    console.error('  cd <artibot-repo>/plugins/artibot');
    console.error('  git pull origin master');
    console.error('  bash install.sh');
  }
  console.error('');
  console.error('또는 최신 릴리스를 직접 내려받으세요:');
  console.error('  https://github.com/Yoodaddy0311/artibot/releases/latest');
}

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
};
