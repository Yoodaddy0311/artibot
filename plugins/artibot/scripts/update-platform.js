/**
 * update-platform.js - Platform/runtime detection helpers for update.js.
 *
 * Extracted from update.js to keep that orchestration script under the 800-line
 * file guideline. These helpers locate installers (install.sh / install.ps1) and
 * runtimes (bash / PowerShell) across platforms, resolve the home directory, and
 * print Korean manual-install guidance when no runtime is available.
 *
 * Behavior is identical to the original update.js definitions — this is a pure
 * code move (no logic change).
 *
 * Zero dependencies. Node 18+ built-ins only. ESM module format.
 */

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { getPluginRoot } from '../lib/core/platform.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the user home directory cross-platform.
 */
export function resolveHome() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

// ---------------------------------------------------------------------------
// Plugin install
// ---------------------------------------------------------------------------

/**
 * Find install.sh by searching multiple candidate paths.
 * CLAUDE_PLUGIN_ROOT may point to a deleted cache directory after clearCache(),
 * so we check the source repo path first, then the installed copy, then the env var.
 */
export function findInstallScript() {
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
export function findInstallPs1() {
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
export function inferBashFromGitExecPath() {
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
export function inferBashFromWhere() {
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
export function findBash() {
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
export function findPowerShell() {
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
export function printManualInstructionsKo(ps1Path, shPath) {
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
