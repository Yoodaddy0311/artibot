#!/usr/bin/env node
/**
 * Git Autopilot — Stop hook.
 * On session end:
 *   1. Stage and commit any remaining changes (final commit)
 *   2. Optionally squash all WIP commits into one clean commit
 *   3. Push the autopilot branch to remote
 * @module scripts/hooks/git-autopilot-close
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJSON, readStdin, resolveConfigPath } from '../utils/index.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';
import { isMergeBaseFresh, resolveBaseBranch } from '../../lib/git/resolve-base.js';
import { isAutopilotAllowed } from '../../lib/autopilot/repo-identity.js';

/**
 * Read `git.autopilot.bypassPreCommitHooks` / `bypassPrePushHooks` from
 * artibot.config.json. Defaults to false (honour user hooks). v4.7.2
 * (issue-scanner W4 P1-4): the previous unconditional `--no-verify` on
 * commit/push violated CLAUDE.md Git Safety Protocol.
 *
 * @returns {{ bypassPreCommitHooks: boolean, bypassPrePushHooks: boolean }}
 */
function readArtibotBypassFlags() {
  try {
    const cfg = JSON.parse(readFileSync(resolveConfigPath('artibot.config.json'), 'utf-8'));
    return {
      bypassPreCommitHooks: cfg?.git?.autopilot?.bypassPreCommitHooks === true,
      bypassPrePushHooks: cfg?.git?.autopilot?.bypassPrePushHooks === true,
    };
  } catch {
    return { bypassPreCommitHooks: false, bypassPrePushHooks: false };
  }
}

/**
 * Read the `closeOnStop` opt-in flag.
 *
 * Precedence (per-repo overrides plugin-wide, matching the bypass-flag pattern):
 *   1. `.git/autopilot.json` `closeOnStop === true` → enabled
 *   2. `artibot.config.json` `git.autopilot.closeOnStop === true` → enabled
 *   3. Otherwise (missing/false/undefined) → disabled (default)
 *
 * v4.11.3: default is `false`. Before v4.11.3 this hook fired on every Stop
 * (every agent turn) and produced a `chore: artibot session close [...]`
 * commit + push, creating dozens of noise commits per session. The
 * interval-based WIP save (`git-autopilot-save.js`) still provides crash
 * safety; this hook is now opt-in for users who specifically want a turn-end
 * commit/squash/push pipeline.
 *
 * @param {object|null} perRepoConfig parsed `.git/autopilot.json` (may be null)
 * @returns {boolean} true if the close pipeline should run
 */
function readCloseOnStopFlag(perRepoConfig) {
  if (perRepoConfig?.closeOnStop === true) return true;
  try {
    const cfg = JSON.parse(readFileSync(resolveConfigPath('artibot.config.json'), 'utf-8'));
    return cfg?.git?.autopilot?.closeOnStop === true;
  } catch {
    return false;
  }
}

/**
 * Read the `commitStrategy` setting from config.
 *
 * Precedence (per-repo overrides plugin-wide):
 *   1. `.git/autopilot.json` `commitStrategy`
 *   2. `artibot.config.json` `git.autopilot.commitStrategy`
 *   3. Default: `"interval"` (backward-compatible existing behavior)
 *
 * @param {object|null} perRepoConfig parsed `.git/autopilot.json` (may be null)
 * @returns {{ strategy: string, commitOnPhases: string[], requireTestPass: boolean, requireLintClean: boolean }}
 */
function readCommitStrategy(perRepoConfig) {
  const defaults = {
    strategy: 'interval',
    commitOnPhases: ['PLAN', 'EXECUTE', 'VERIFY', 'REPORT'],
    requireTestPass: true,
    requireLintClean: true,
  };

  // Check per-repo config first
  if (perRepoConfig?.commitStrategy) {
    const semantic = perRepoConfig.semanticCommit ?? {};
    return {
      strategy: perRepoConfig.commitStrategy,
      commitOnPhases: Array.isArray(semantic.commitOnPhases)
        ? semantic.commitOnPhases : defaults.commitOnPhases,
      requireTestPass: semantic.requireTestPass ?? defaults.requireTestPass,
      requireLintClean: semantic.requireLintClean ?? defaults.requireLintClean,
    };
  }

  // Fall back to artibot.config.json
  try {
    const cfg = JSON.parse(readFileSync(resolveConfigPath('artibot.config.json'), 'utf-8'));
    const gitAP = cfg?.git?.autopilot;
    if (gitAP?.commitStrategy) {
      const semantic = gitAP.semanticCommit ?? {};
      return {
        strategy: gitAP.commitStrategy,
        commitOnPhases: Array.isArray(semantic.commitOnPhases)
          ? semantic.commitOnPhases : defaults.commitOnPhases,
        requireTestPass: semantic.requireTestPass ?? defaults.requireTestPass,
        requireLintClean: semantic.requireLintClean ?? defaults.requireLintClean,
      };
    }
  } catch { /* fall through to defaults */ }

  return defaults;
}

/**
 * Detect whether the autopilot phase has transitioned since the last check.
 *
 * Reads the current phase from `hookData.phase` (set by the autopilot
 * runtime) and compares against the last recorded phase in
 * `.git/autopilot-state.json`.
 *
 * @param {object} hookData - The hook payload (may contain `phase`)
 * @param {string} repoRoot - Repository root path
 * @returns {{ transitioned: boolean, completedPhase: string|null }}
 */
function detectPhaseTransition(hookData, repoRoot) {
  const currentPhase = hookData?.phase ?? null;
  if (!currentPhase || typeof currentPhase !== 'string') {
    return { transitioned: false, completedPhase: null };
  }

  const statePath = path.join(repoRoot, '.git', 'autopilot-state.json');
  let lastPhase = null;

  try {
    const raw = readFileSync(statePath, 'utf-8');
    const state = JSON.parse(raw);
    lastPhase = state?.lastPhase ?? null;
  } catch {
    // No state file yet — first run; lastPhase stays null (initialized above).
  }

  const transitioned = currentPhase !== lastPhase;
  // The "completed" phase is the PREVIOUS phase (the one that just ended),
  // which is lastPhase when a transition occurs. On the very first run
  // (lastPhase is null), the current phase is being entered but nothing has
  // completed yet — so completedPhase is null.
  const completedPhase = transitioned && lastPhase ? lastPhase : null;

  return { transitioned, completedPhase };
}

/**
 * Persist the current phase to `.git/autopilot-state.json`.
 *
 * @param {string} repoRoot
 * @param {string|null} phase
 */
function savePhaseState(repoRoot, phase) {
  const statePath = path.join(repoRoot, '.git', 'autopilot-state.json');
  const state = { lastPhase: phase, updatedAt: new Date().toISOString() };
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
  } catch {
    // Best-effort — state loss means at worst an extra commit next time.
  }
}

/**
 * Generate a semantic commit message based on the completed autopilot phase.
 *
 * Phase → commit-type mapping:
 *   PLAN    → docs(autopilot)
 *   EXECUTE → feat(autopilot)
 *   VERIFY  → fix(autopilot) (if changes exist) / chore(autopilot) (if clean)
 *   REPORT  → docs(autopilot)
 *   IMPROVE → refactor(autopilot)
 *
 * The summary includes `git diff --stat HEAD` info (file count + top 3 names).
 *
 * @param {string} completedPhase
 * @param {string} cwd - Working directory (repo root)
 * @returns {string} formatted commit message
 */
function generateSemanticMessage(completedPhase, cwd) {
  /** @type {Record<string, string>} */
  const phaseTypeMap = {
    PLAN: 'docs(autopilot)',
    EXECUTE: 'feat(autopilot)',
    VERIFY: 'chore(autopilot)',
    REPORT: 'docs(autopilot)',
    IMPROVE: 'refactor(autopilot)',
  };

  // For VERIFY, check whether there are actual code changes staged;
  // if so, upgrade to fix(autopilot).
  let commitType = phaseTypeMap[completedPhase] ?? 'chore(autopilot)';
  if (completedPhase === 'VERIFY') {
    try {
      const diffStat = gitRun(['diff', '--stat', '--cached'], { cwd });
      if (diffStat.length > 0) {
        commitType = 'fix(autopilot)';
      }
    } catch { /* keep chore */ }
  }

  // Build summary from diff --stat HEAD
  let summary = `${completedPhase.toLowerCase()} phase work`;
  try {
    const diffOutput = gitRun(['diff', '--stat', 'HEAD'], { cwd });
    if (diffOutput) {
      const lines = diffOutput.split('\n').filter(Boolean);
      // Last line is typically the summary like "3 files changed, 10 insertions(+), 2 deletions(-)"
      const summaryLine = lines[lines.length - 1] || '';
      const fileCountMatch = summaryLine.match(/(\d+)\s+file/);
      const fileCount = fileCountMatch ? fileCountMatch[1] : '0';

      // Extract top 3 file names from diff lines (format: " path/to/file | 3 +++")
      const fileNames = lines
        .slice(0, -1) // exclude summary line
        .map((l) => l.trim().split(/\s+\|/)[0]?.trim())
        .filter(Boolean)
        .slice(0, 3);

      const fileList = fileNames.length > 0 ? fileNames.join(', ') : '';
      summary = fileList
        ? `${fileCount} file(s): ${fileList}`
        : `${fileCount} file(s) changed`;
    }
  } catch {
    // Fallback: use generic summary (already set above)
  }

  return `${commitType}: ${summary} [${completedPhase} complete]`;
}

/**
 * Create a semantic commit for a completed autopilot phase.
 * Stages all changes and commits with the semantic message.
 *
 * @param {string} cwd
 * @param {string} completedPhase
 * @param {{ bypassPreCommitHooks?: boolean }} [opts]
 * @returns {boolean} true if commit succeeded
 */
function commitSemantic(cwd, completedPhase, opts = {}) {
  try {
    gitSilent(['add', '-A'], { cwd });
    const message = generateSemanticMessage(completedPhase, cwd);
    const args = ['commit', '-m', message];
    if (opts.bypassPreCommitHooks === true) args.push('--no-verify');
    gitSilent(args, { cwd });
    return true;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------

/**
 * Hard ceiling on how many commits a single squash pass will collapse.
 * Prevents catastrophic resets if merge-base resolution accidentally points
 * at an ancient ancestor (e.g. root commit).
 */
const MAX_SQUASH_COMMITS = 50;

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/**
 * Run git with argv-array (shell-free).
 *
 * @param {string[]} args
 * @param {object} [opts]
 * @returns {string} trimmed stdout (throws on non-zero exit)
 */
function gitRun(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    ...opts,
  }).trim();
}

/**
 * Run git silently (discards stdout); throws on non-zero exit.
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
 * Check whether there are any staged or unstaged changes.
 * @param {string} cwd
 * @returns {boolean}
 */
function hasDirtyWorkspace(cwd) {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
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
 * Commit all remaining changes with a "session close" message.
 *
 * v4.7.2 (issue-scanner W4 P1-4): pre-commit hooks are honoured by default.
 * `--no-verify` is only added when `bypassPreCommitHooks` is true (set via
 * .git/autopilot.json or artibot.config.json git.autopilot.bypassPreCommitHooks).
 * The default lets secret-scan / lint / test gates fail the auto-save commit
 * instead of silently committing through them.
 *
 * @param {string} cwd
 * @param {{ bypassPreCommitHooks?: boolean }} [opts]
 * @returns {boolean}
 */
function commitClose(cwd, opts = {}) {
  try {
    gitSilent(['add', '-A'], { cwd });
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const args = ['commit', '-m', `chore: artibot session close [${timestamp}]`];
    if (opts.bypassPreCommitHooks === true) args.push('--no-verify');
    gitSilent(args, { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Count the number of WIP commits since the branch diverged from its base.
 * WIP commits are identified by the "wip: artibot auto-save" prefix.
 * @param {string} cwd
 * @param {string} baseBranch
 * @returns {number}
 */
function countWipCommits(cwd, baseBranch) {
  if (!baseBranch) return 0;
  try {
    const mergeBase = gitRun(['merge-base', 'HEAD', baseBranch], { cwd });
    if (!mergeBase) return 0;

    const log = gitRun(
      ['log', '--oneline', '--grep=^wip: artibot auto-save', `${mergeBase}..HEAD`],
      { cwd }
    );
    return log.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * Squash all WIP commits into a single clean commit.
 * Soft-resets to merge-base then re-commits everything as one commit.
 *
 * Safety guards:
 *   - merge-base must be a non-empty string.
 *   - Total commits since merge-base must be < MAX_SQUASH_COMMITS to avoid
 *     accidentally squashing through an ancient ancestor.
 *
 * @param {string} cwd
 * @param {string} baseBranch
 * @param {number} wipCount
 * @returns {boolean}
 */
function squashWipCommits(cwd, baseBranch, wipCount, opts = {}) {
  if (wipCount < 2) return true; // Nothing to squash
  if (!baseBranch) return false;

  try {
    const mergeBase = gitRun(['merge-base', 'HEAD', baseBranch], { cwd });
    // Guard: empty merge-base means resolution failed — refuse to reset.
    if (!mergeBase) return false;

    // v4.5.12 — age sanity gate. If mergeBase resolves to an ancient
    // ancestor (older than 30 days from HEAD) the most likely cause is
    // a stale default branch (origin/HEAD pointing at a branch the
    // working branch never actually forked from). Refuse to squash —
    // soft-resetting through dozens of legitimate commits would corrupt
    // PR history (see the v4.6.0 Phase 3+4 incident).
    if (!isMergeBaseFresh(mergeBase, cwd, 30)) return false;

    const totalCommitsRaw = gitRun(['rev-list', '--count', `${mergeBase}..HEAD`], { cwd });
    const totalCommits = parseInt(totalCommitsRaw, 10);

    if (Number.isNaN(totalCommits) || totalCommits < 2) return true;
    // Guard: refuse to squash absurd ranges (likely ancient-base mis-resolution).
    if (totalCommits > MAX_SQUASH_COMMITS) return false;

    // Soft-reset to merge-base, re-commit everything as one clean commit.
    // v4.7.2 (P1-4): re-commit honours bypassPreCommitHooks like commitClose().
    gitSilent(['reset', '--soft', mergeBase], { cwd });
    const timestamp = new Date().toISOString().slice(0, 10);
    const args = ['commit', '-m', `feat: artibot session work [${timestamp}]`];
    if (opts.bypassPreCommitHooks === true) args.push('--no-verify');
    gitSilent(args, { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Push the current branch to origin.
 *
 * v4.7.2 (issue-scanner W4 P1-4): pre-push hooks are honoured by default.
 * `--no-verify` is only added when `bypassPrePushHooks` is true. The previous
 * unconditional `--no-verify` was a "safer than recursion" workaround, but it
 * also bypassed legitimate user pre-push gates (test runs, secret scan).
 * Honouring hooks by default and providing an explicit opt-out is the right
 * trade-off — the inner 12s timeout still caps any pre-push hang.
 *
 * @param {string} cwd
 * @param {string} branch
 * @param {{ bypassPrePushHooks?: boolean }} [opts]
 * @returns {boolean}
 */
function pushBranch(cwd, branch, opts = {}) {
  const noVerify = opts.bypassPrePushHooks === true ? ['--no-verify'] : [];
  try {
    gitSilent(['push', 'origin', branch, ...noVerify], { cwd, timeout: 12000 });
    return true;
  } catch {
    // Try setting upstream on first push
    try {
      gitSilent(['push', '-u', 'origin', branch, ...noVerify], { cwd, timeout: 12000 });
      return true;
    } catch {
      return false;
    }
  }
}

// -------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------

export async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw) ?? {};

  const repoRoot = getRepoRoot();
  if (!repoRoot) return;

  // Capture-only gate: skip all git writes for repos outside the allowlist.
  if (!isAutopilotAllowed(repoRoot)) return;

  const config = loadConfig(repoRoot);
  if (!config) return;

  const log = (msg) => process.stderr.write(`[artibot:git-autopilot-close] ${msg}\n`);

  // Determine commit strategy: "semantic" | "interval" | "none"
  const strategyConfig = readCommitStrategy(config);
  const { strategy } = strategyConfig;

  // -----------------------------------------------------------------------
  // Strategy: "none" — skip all git writes
  // -----------------------------------------------------------------------
  if (strategy === 'none') {
    log('commitStrategy=none — skipping all git writes');
    return;
  }

  // -----------------------------------------------------------------------
  // Strategy: "semantic" — phase-transition-driven commits
  // closeOnStop flag is IGNORED for semantic strategy.
  // -----------------------------------------------------------------------
  if (strategy === 'semantic') {
    const { transitioned, completedPhase } = detectPhaseTransition(hookData, repoRoot);

    // Always persist current phase so next invocation can detect transition.
    savePhaseState(repoRoot, hookData?.phase ?? null);

    if (!transitioned || !completedPhase) {
      log(transitioned
        ? 'Semantic commit: first phase entered — no completed phase yet'
        : 'Semantic commit: no phase transition — skipping commit');
      return;
    }

    // Only commit on configured phases.
    if (!strategyConfig.commitOnPhases.includes(completedPhase)) {
      log(`Semantic commit: phase ${completedPhase} not in commitOnPhases — skipping`);
      return;
    }

    const artibotFlags = readArtibotBypassFlags();
    const bypassPreCommitHooks = config?.bypassPreCommitHooks === true
      || artibotFlags.bypassPreCommitHooks;
    const bypassPrePushHooks = config?.bypassPrePushHooks === true
      || artibotFlags.bypassPrePushHooks;
    const branch = getCurrentBranch(repoRoot);

    // Only commit if there are actual changes.
    if (hasDirtyWorkspace(repoRoot)) {
      const committed = commitSemantic(repoRoot, completedPhase, { bypassPreCommitHooks });
      if (!committed && !bypassPreCommitHooks) {
        log(`Semantic commit failed for ${completedPhase} — pre-commit hook may have rejected`);
      } else {
        log(committed
          ? `Semantic commit: ${completedPhase} phase complete`
          : `Semantic commit failed for ${completedPhase} — check git status`);
      }
    } else {
      log(`Semantic commit: ${completedPhase} completed but no changes to commit`);
    }

    // Push if configured.
    if (config.autoPushOnStop) {
      const pushed = pushBranch(repoRoot, branch, { bypassPrePushHooks });
      if (!pushed && !bypassPrePushHooks) {
        log(`Push failed — pre-push hook may have rejected; run: git push origin ${branch}, or set git.autopilot.bypassPrePushHooks=true`);
      } else {
        log(pushed ? `Pushed "${branch}" to origin` : `Push failed — run: git push origin ${branch}`);
      }
    }

    return;
  }

  // -----------------------------------------------------------------------
  // Strategy: "interval" (default) — existing closeOnStop-gated behavior
  // -----------------------------------------------------------------------

  // v4.11.3 gate: turn-end commit/squash/push is opt-in. When disabled, log
  // once (so users can see why nothing happened) and return without touching
  // git state. Crash safety is still provided by `git-autopilot-save.js`
  // (interval-based WIP), which is independent of this hook.
  if (!readCloseOnStopFlag(config)) {
    log('closeOnStop=false — skipping commit/squash/push (set git.autopilot.closeOnStop=true to enable)');
    return;
  }

  const branch = getCurrentBranch(repoRoot);
  const branchPrefix = config.branchPrefix ?? 'artibot/';
  const baseBranch = resolveBaseBranch(repoRoot, config);

  // Per-repo override (.git/autopilot.json) takes precedence over plugin
  // artibot.config.json — same precedence as git-autopilot-save.js.
  const artibotFlags = readArtibotBypassFlags();
  const bypassPreCommitHooks = config?.bypassPreCommitHooks === true
    || artibotFlags.bypassPreCommitHooks;
  const bypassPrePushHooks = config?.bypassPrePushHooks === true
    || artibotFlags.bypassPrePushHooks;

  // Step 1: Commit remaining changes
  if (hasDirtyWorkspace(repoRoot)) {
    const committed = commitClose(repoRoot, { bypassPreCommitHooks });
    if (!committed && !bypassPreCommitHooks) {
      log('Final commit failed — pre-commit hook may have rejected; run `git commit` manually or set git.autopilot.bypassPreCommitHooks=true');
    } else {
      log(committed ? 'Final changes committed' : 'Final commit failed — check git status');
    }
  } else {
    log('No uncommitted changes at session close');
  }

  // Step 2: Squash WIP commits (only on autopilot branches).
  // squashFailed tracks whether un-squashed WIP commits remain — gating Step 3.
  let squashFailed = false;
  if (config.squashWipOnClose && branch.startsWith(branchPrefix)) {
    const wipCount = countWipCommits(repoRoot, baseBranch);
    if (wipCount > 0) {
      const squashed = squashWipCommits(repoRoot, baseBranch, wipCount, { bypassPreCommitHooks });
      squashFailed = !squashed;
      log(
        squashed
          ? `Squashed ${wipCount} WIP commit(s) into clean commit`
          : 'WIP squash failed — commits preserved as-is'
      );
    }
  }

  // Step 3: Push to remote — skipped when squash failed to prevent WIP commits
  // from leaking to origin. v4.7.7 (audit P1): pre-fix, `pushBranch` ran even
  // when `squashWipOnClose=true` failed, publishing the raw `wip: artibot
  // auto-save [...]` commits the squash was meant to hide.
  if (config.autoPushOnStop) {
    if (squashFailed) {
      log(`Push skipped — WIP squash failed, refusing to publish un-squashed WIP commits. Resolve manually then push: git push origin ${branch}`);
    } else {
      const pushed = pushBranch(repoRoot, branch, { bypassPrePushHooks });
      if (!pushed && !bypassPrePushHooks) {
        log(`Push failed — pre-push hook may have rejected; run: git push origin ${branch}, or set git.autopilot.bypassPrePushHooks=true`);
      } else {
        log(pushed ? `Pushed "${branch}" to origin` : `Push failed — run: git push origin ${branch}`);
      }
    }
  }

  void hookData;
}

// Direct-run guard: importing this module (tests) must not execute a real
// session close — main() blocks on stdin and, past its gates, commits, resets
// history (`reset --soft` during WIP squash) and pushes to origin. Production
// is unaffected: `_stop-dispatcher.js` spawns this file as argv[1].
const isDirectRun = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch(createErrorHandler('git-autopilot-close', { exit: true }));
}
