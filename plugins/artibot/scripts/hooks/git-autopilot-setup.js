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
import { isAutopilotAllowed } from '../../lib/autopilot/repo-identity.js';
import { isMainEntry } from './_main-entry.js';

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------

// v4.7.8: WIP interval bumped 30 → 120. Memory and SESSION-NOTES.md now
// preserve session context, so frequent code-snapshot commits are no longer
// the primary safety net. 2h still preserves work against crashes/reboots
// without flooding the branch with 16 WIP commits per day.
const DEFAULT_CONFIG = {
  version: 2,
  enabled: true,
  wipIntervalMinutes: 120,
  autoPullOnSession: true,
  autoPushOnStop: true,
  // v4.11.3: per-turn `chore: artibot session close` 커밋 폭주 방지 — Stop hook의
  // git-autopilot-close.js가 commit/push 단계를 실행하기 전에 이 플래그를 검사.
  // false 면 close hook이 no-op로 종료. WIP interval save는 영향 없음(crash safety 보존).
  // 이전 동작(매 turn auto-commit)을 원하면 `.git/autopilot.json`에서 true로 토글.
  closeOnStop: false,
  squashWipOnClose: true,
  branchPrefix: 'artibot/',
  conflictStrategy: 'union',
  guardEnabled: true,
  lastSetupAt: null,
};

/**
 * Migrate v1 → v2: bump wipIntervalMinutes 30 → 120 IF the user still has
 * the old default (never customized). Custom values are preserved.
 *
 * @param {object} existing parsed .git/autopilot.json (may be empty {})
 * @returns {object} possibly migrated copy
 */
function migrateConfig(existing) {
  const existingVersion = typeof existing.version === 'number' ? existing.version : 1;
  if (existingVersion < 2 && existing.wipIntervalMinutes === 30) {
    return { ...existing, wipIntervalMinutes: 120 };
  }
  return existing;
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/**
 * Normalize a path by collapsing a duplicated trailing
 * `plugins/artibot/plugins/artibot` segment. Defensive guard against
 * worktree edge cases where a caller mistakenly prepends plugin-root
 * twice (observed in the wild via `plugins/artibot/plugins/artibot/...`
 * ENOENT errors).
 *
 * @param {string} p
 * @returns {string}
 */
function stripDoublePluginPath(p) {
  if (!p) return p;
  const forward = p.replace(/\\/g, '/');
  if (/\/plugins\/artibot\/plugins\/artibot\/?$/i.test(forward)) {
    return path.normalize(forward.replace(/\/plugins\/artibot\/?$/i, ''));
  }
  return p;
}

/**
 * Resolve the repository working-tree root via git rev-parse. Works in
 * both regular checkouts and linked worktrees (returns the worktree dir,
 * not the main repo).
 * @returns {string} Absolute path to repo/worktree root
 */
function getRepoRoot() {
  const out = execSync('git rev-parse --show-toplevel', {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim();
  return stripDoublePluginPath(path.resolve(out));
}

/**
 * Resolve the per-worktree git directory. In a worktree this is
 * `<main>/.git/worktrees/<name>/`, in a normal repo this is `<root>/.git/`.
 * Always a real directory we can safely write to (unlike the worktree's
 * top-level `.git` which is a pointer file).
 * @returns {string} Absolute path to git dir
 */
function getGitDir() {
  const out = execSync('git rev-parse --absolute-git-dir', {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim();
  return path.resolve(out);
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
  let gitDir;
  try {
    repoRoot = getRepoRoot();
    gitDir = getGitDir();
  } catch {
    // Not in a git repo — silent no-op (hook fires on every SessionStart,
    // so shell-started-outside-a-repo cases should not log errors).
    return 'no-repo';
  }

  // Use the resolved git dir (handles worktrees where `<root>/.git` is a
  // pointer file, not a directory; writing autopilot.json there fails with
  // ENOTDIR/ENOENT).
  const configPath = path.join(gitDir, 'autopilot.json');
  const hasExisting = existsSync(configPath);

  // Capture-only mode (v4.4.0+): autopilot.json create AND refresh both
  // require the repo to be either (a) explicitly listed in the user-level
  // allowlist, (b) the artibot plugin repo itself (grandfathered via
  // plugin.json), or (c) a one-shot --init invocation.
  //
  // Without this guard, hooks fire in every repo where stale config files
  // were deployed by older versions, polluting unrelated project histories
  // with `wip: artibot auto-save` and `chore: artibot session close` commits.
  const allowed = isAutopilotAllowed(repoRoot) || isArtibotRepo(repoRoot);
  if (!allowed && !wantsInit) {
    return hasExisting ? 'skipped-not-allowed' : 'skipped';
  }

  const existing = hasExisting ? migrateConfig(readExistingConfig(configPath)) : {};
  const config = {
    ...DEFAULT_CONFIG,
    ...existing,
    version: 2,
    lastSetupAt: new Date().toISOString(),
  };

  try {
    atomicWriteSync(configPath, config);
  } catch (err) {
    logHookError('git-autopilot-setup', 'Failed to write config', err);
    return 'error';
  }

  const verb = hasExisting ? 'Updated' : 'Created';
  // Claude Code parses hook stdout as JSON — log lines must go to stderr to
  // avoid SessionStart parse errors (CRITICAL: prior stdout caused JSON
  // pollution every session start).
  process.stderr.write(`[artibot:git-autopilot-setup] ${verb} ${configPath}\n`);
  process.stderr.write(`  WIP interval: ${config.wipIntervalMinutes}m\n`);
  process.stderr.write(`  Auto-pull: ${config.autoPullOnSession}\n`);
  process.stderr.write(`  Auto-push: ${config.autoPushOnStop}\n`);
  process.stderr.write(`  Squash WIP: ${config.squashWipOnClose}\n`);
  process.stderr.write(`  Conflict strategy: ${config.conflictStrategy}\n`);

  return hasExisting ? 'updated' : 'created';
}

// Direct-run guard: importing this module (tests) must not execute the hook.
// Production is unaffected — the dispatcher spawns this file as argv[1].
//
// Was `argv[1].endsWith('git-autopilot-setup.js')`: a suffix test, so any path
// ending in that name (a copy, a sibling checkout, `my-git-autopilot-setup.js`)
// satisfied it, and a relative argv[1] was compared unresolved. Identity on the
// resolved path is the check every other hook now uses.
if (isMainEntry(import.meta.url)) {
  main().then((outcome) => {
    if (outcome === 'error') process.exit(1);
  }).catch((err) => {
    logHookError('git-autopilot-setup', err.message || String(err));
    process.exit(1);
  });
}
