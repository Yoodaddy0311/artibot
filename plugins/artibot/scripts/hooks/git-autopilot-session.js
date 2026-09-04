#!/usr/bin/env node
/**
 * Git Autopilot — SessionStart hook.
 * On every new Claude Code session:
 *   1. Reads .git/autopilot.json config (skip if missing or disabled)
 *   2. Auto-pulls latest changes from remote (with conflict auto-resolution)
 *   3. Switches to or creates the autopilot working branch
 * @module scripts/hooks/git-autopilot-session
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { parseJSON, readStdin } from '../utils/index.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';
import { autoResolveAll } from './git-autopilot-merge.js';
import { isAutopilotAllowed } from '../../lib/autopilot/repo-identity.js';
import { isSplitLimbBranch } from '../../lib/git/repo-identity.js';
import { resolveBaseBranch } from '../../lib/git/resolve-base.js';
import { gitPath } from '../../lib/git/git-dir.js';
import { isMainEntry } from './_main-entry.js';

// Throttle: skip `git pull` if a successful pull happened within this window.
// 5 minutes is aggressive enough to save ~800ms on every rapid-fire session
// restart while still picking up remote changes reasonably quickly in practice.
const PULL_THROTTLE_MS = 5 * 60 * 1000;

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/**
 * Run git with argv-array (shell-free) and return trimmed stdout.
 *
 * @param {string[]} args
 * @param {object} [opts]
 * @returns {string}
 */
function gitRun(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    ...opts,
  }).trim();
}

/**
 * Run git silently (no captured output); throws on non-zero exit.
 *
 * @param {string[]} args
 * @param {object} [opts]
 * @returns {void}
 */
function gitSilent(args, opts = {}) {
  execFileSync('git', args, { stdio: 'ignore', ...opts });
}

/**
 * Get the repo root via git rev-parse.
 * @returns {string|null}
 */
function getRepoRoot() {
  try {
    return gitRun(['rev-parse', '--show-toplevel']);
  } catch {
    return null;
  }
}

/**
 * Load .git/autopilot.json config.
 * @param {string} repoRoot
 * @returns {object|null} Parsed config or null if not found / disabled
 */
function loadConfig(repoRoot) {
  const configPath = gitPath(repoRoot, 'autopilot.json');
  if (!existsSync(configPath)) return null;
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return config.enabled === false ? null : config;
  } catch {
    return null;
  }
}

/**
 * Get the current git branch name.
 * @param {string} cwd
 * @returns {string}
 */
function getCurrentBranch(cwd) {
  try {
    return gitRun(['branch', '--show-current'], { cwd });
  } catch {
    return '';
  }
}

/**
 * Pull latest changes. Returns true if successful.
 * @param {string} cwd
 * @returns {boolean}
 */
function gitPull(cwd) {
  try {
    gitSilent(['pull', '--rebase', '--autostash'], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a recent pull was made. Avoids redundant network round-trips
 * on rapid session restarts. Reads `lastPullAt` from `.git/autopilot.json`.
 *
 * @param {string} repoRoot
 * @returns {boolean} true if pull should be skipped (recent enough)
 */
function isPullThrottled(repoRoot) {
  try {
    const configPath = gitPath(repoRoot, 'autopilot.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (!config.lastPullAt) return false;
    const age = Date.now() - new Date(config.lastPullAt).getTime();
    return age < PULL_THROTTLE_MS;
  } catch {
    return false;
  }
}

/**
 * Persist the last-pull timestamp into `.git/autopilot.json`.
 * Errors are swallowed — throttling is advisory, not critical.
 *
 * @param {string} repoRoot
 */
function recordPullTimestamp(repoRoot) {
  try {
    const configPath = gitPath(repoRoot, 'autopilot.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.lastPullAt = new Date().toISOString();
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch {
    // Ignore — throttling will fall back to pulling next time
  }
}

/**
 * Check whether git is currently in an active rebase state.
 * @param {string} cwd
 * @returns {boolean}
 */
function isRebaseInProgress(cwd) {
  try {
    const gitDir = gitRun(['rev-parse', '--git-dir'], { cwd });
    const rebaseMerge = path.join(cwd, gitDir, 'rebase-merge');
    const rebaseApply = path.join(cwd, gitDir, 'rebase-apply');
    return existsSync(rebaseMerge) || existsSync(rebaseApply);
  } catch {
    return false;
  }
}

/**
 * Merge new commits from the canonical base branch (e.g. `origin/master`)
 * into the current autopilot working branch. Solves the "another computer
 * pushed v4.7.5 to master, this computer's `artibot/master` never sees it"
 * problem: `git pull` only fetches `origin/<current-branch>`, so releases
 * pushed directly to the base branch from another machine are invisible
 * until the user manually merges.
 *
 * Behavior:
 *   - Only runs on autopilot branches (prefix-matched)
 *   - Skips when current branch IS the base branch
 *   - Verifies `origin/<base>` exists before merge attempt
 *   - On conflict: aborts the merge (workspace stays clean) and logs
 *
 * @param {string} cwd
 * @param {string} currentBranch
 * @param {object} config
 * @returns {{ merged: number, conflict: boolean }}
 */
function syncFromBaseBranch(cwd, currentBranch, config) {
  const branchPrefix = config.branchPrefix ?? 'artibot/';
  if (!currentBranch.startsWith(branchPrefix)) return { merged: 0, conflict: false };

  const base = resolveBaseBranch(cwd, config);
  if (!base || base === currentBranch) return { merged: 0, conflict: false };

  const remoteRef = base.startsWith('origin/') ? base : `origin/${base}`;
  try {
    gitSilent(['rev-parse', '--verify', '--quiet', remoteRef], { cwd });
  } catch {
    return { merged: 0, conflict: false };
  }

  let ahead;
  try {
    ahead = parseInt(gitRun(['rev-list', '--count', `HEAD..${remoteRef}`], { cwd }), 10);
  } catch {
    return { merged: 0, conflict: false };
  }
  if (!Number.isFinite(ahead) || ahead <= 0) return { merged: 0, conflict: false };

  try {
    gitSilent(['merge', remoteRef, '--no-edit', '--no-ff'], { cwd });
    return { merged: ahead, conflict: false };
  } catch {
    try { gitSilent(['merge', '--abort'], { cwd }); } catch { /* ignore */ }
    return { merged: 0, conflict: true };
  }
}

/**
 * Branch-name shape the hook is allowed to relocate HEAD away from.
 *
 * This is an allowlist by construction: only a name whose autopilot sibling
 * is derivable byte-for-byte (`main` → `artibot/main`) qualifies. A namespaced
 * branch (`ci/release-v4.46.0`, `release/1.2`, `chore/deps`) would have to be
 * rewritten into `artibot/ci-release-v4-46-0` — a lossy, collision-prone
 * mapping, and in practice those namespaces carry human landing flows that the
 * hook must not take over. Stating it as "which names may move" rather than
 * "which prefixes to skip" makes an unfamiliar prefix fail closed (stay put)
 * instead of fail open (relocate).
 *
 * Also rejects the empty string, i.e. detached HEAD, where the derived name
 * would be a bare `artibot/` that git refuses.
 */
const RELOCATABLE_BRANCH_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Ensure the autopilot branch exists and is checked out.
 * Creates from current HEAD if new.
 *
 * Two guards keep HEAD where the operator put it:
 *   - Direct-on-base: when the working branch IS the repo's base/default
 *     branch (e.g. `master`), we do NOT relocate onto an `artibot/<base>`
 *     sibling. Workflows that commit directly to the default branch would
 *     otherwise have HEAD silently yanked away on every SessionStart, risking
 *     commits landing on a stale sibling base.
 *   - Name allowlist: see {@link RELOCATABLE_BRANCH_NAME}.
 *   - Split limb: a `/split` limb branch belongs to another provider and is
 *     the ref its own status/landing machinery reads by name. See below.
 *
 * @param {string} cwd
 * @param {string} branchPrefix
 * @param {string} currentBranch
 * @param {object} [config] - Parsed autopilot config (for base-branch resolution)
 * @returns {string} Name of the branch switched to (or current if already correct)
 */
function ensureAutopilotBranch(cwd, branchPrefix, currentBranch, config) {
  if (currentBranch.startsWith(branchPrefix)) return currentBranch;

  // Only branch names the hook may take over — everything else stays put.
  if (!RELOCATABLE_BRANCH_NAME.test(currentBranch)) return currentBranch;

  // A `/split` limb branch stays put. The name gate above cannot catch these:
  // `worktree-split-<repo-short>-<limb>` is pure `[A-Za-z0-9_-]`, so it is
  // mechanically derivable and passes. But derivability is not ownership —
  // the limb branch is created by the built-in worktree provider and read BY
  // NAME by `/split status` and `land` (`lib/git/repo-identity.js
  // #isSplitLimbBranch`), which reject the `artibot/`-prefixed form. Measured
  // 2026-09-04: a full-repo `vitest` run fired this hook inside four `/split`
  // worktrees and relocated all four limbs, after which `status` showed no
  // limbs and `land` reported `no-commits` on finished work
  // (`.artibot/split/gotchas.md` #18, #22).
  //
  // Asked semantically rather than added to RELOCATABLE_BRANCH_NAME on
  // purpose: that regex answers "is this name derivable", and the naming rule
  // lives in one module. A second copy of the shape here would drift from it.
  // Note this is narrower than the prefix — a plain `worktree-probe1` from
  // `claude --worktree probe1` is not a limb and still relocates.
  if (isSplitLimbBranch(currentBranch)) return currentBranch;

  // Stay put when already on the canonical base/default branch.
  const base = resolveBaseBranch(cwd, config);
  const baseLocal = base && base.startsWith('origin/') ? base.slice('origin/'.length) : base;
  if (baseLocal && currentBranch === baseLocal) return currentBranch;

  const autopilotBranch = `${branchPrefix}${currentBranch}`;

  try {
    // Check if branch already exists
    gitSilent(
      ['show-ref', '--verify', '--quiet', `refs/heads/${autopilotBranch}`],
      { cwd }
    );
    // Branch exists — switch to it
    gitSilent(['checkout', autopilotBranch], { cwd });
  } catch {
    // Branch does not exist — create from current HEAD
    gitSilent(['checkout', '-b', autopilotBranch], { cwd });
  }

  return autopilotBranch;
}

// -------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------

export async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw) ?? {};

  const repoRoot = getRepoRoot();
  if (!repoRoot) return; // Not a git repo — skip silently

  // Capture-only gate: do not auto-pull, branch-switch, or modify config
  // in repos outside the allowlist. Learning capture remains unaffected.
  if (!isAutopilotAllowed(repoRoot)) return;

  const config = loadConfig(repoRoot);
  if (!config) return; // Autopilot disabled or not set up

  const currentBranch = getCurrentBranch(repoRoot);
  const log = (msg) => process.stderr.write(`[artibot:git-autopilot-session] ${msg}\n`);

  // Step 1: Auto-pull (throttled — skip if last pull attempt was within PULL_THROTTLE_MS).
  // Timestamp is recorded regardless of success: the throttle protects against
  // repeated attempts (which cost ~800ms each) even when the pull fails.
  if (config.autoPullOnSession && !isPullThrottled(repoRoot)) {
    const pulled = gitPull(repoRoot);
    recordPullTimestamp(repoRoot);
    if (pulled) {
      log(`Pulled latest changes on "${currentBranch}"`);
      const sync = syncFromBaseBranch(repoRoot, currentBranch, config);
      if (sync.merged > 0) {
        log(`Merged ${sync.merged} commit(s) from base branch into "${currentBranch}"`);
      } else if (sync.conflict) {
        log('Base-branch sync had conflicts — aborted; resolve manually with `git merge origin/<base>`');
      }
    } else {
      if (!isRebaseInProgress(repoRoot)) {
        log('git pull failed (no rebase in progress) — skipping conflict resolution');
      } else {
        log('git pull failed — attempting conflict auto-resolution');
        const { results, allResolved } = autoResolveAll(repoRoot);
        if (allResolved && results.length > 0) {
          log(`Auto-resolved ${results.length} conflict(s)`);
          try {
            gitSilent(['rebase', '--continue'], { cwd: repoRoot });
          } catch {
            log('rebase --continue failed — manual resolution may be required');
            gitSilent(['rebase', '--abort'], { cwd: repoRoot });
          }
        } else if (!allResolved) {
          const unresolved = results.filter((r) => !r.resolved).map((r) => r.filePath);
          log(`Could not auto-resolve: ${unresolved.join(', ')} — manual resolution required`);
        } else {
          // rebase in progress but no conflicted files — abort stale rebase
          log('Rebase in progress but no conflicts found — aborting stale rebase');
          gitSilent(['rebase', '--abort'], { cwd: repoRoot });
        }
      }
    }
  }

  // Step 2: Ensure autopilot branch
  const branchPrefix = config.branchPrefix ?? 'artibot/';
  const activeBranch = ensureAutopilotBranch(repoRoot, branchPrefix, currentBranch, config);
  if (activeBranch !== currentBranch) {
    log(`Switched to autopilot branch "${activeBranch}"`);
  }

  // Suppress hook from altering Claude's prompt — no stdout output
  void hookData;
}

// Direct-run guard: importing this module (tests, or anything reaching for
// `git-autopilot-merge.js` through here) must not execute a real SessionStart —
// main() blocks on stdin and, past its gates, relocates HEAD (`checkout`) and
// rewrites history (`pull --rebase`, `merge`). Production is unaffected:
// `_sessionstart-dispatcher.js` spawns this file as argv[1].
if (isMainEntry(import.meta.url)) {
  main().catch(createErrorHandler('git-autopilot-session', { exit: true }));
}
