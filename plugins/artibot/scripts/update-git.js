/**
 * update-git.js - Git source-repo discovery + pull orchestration for update.js.
 *
 * Extracted from update.js to keep that orchestration script under the 800-line
 * guideline AND to give the source-pull machinery (repo discovery, dirty-tree
 * auto-stash, branch/upstream resolution, retry-on-renamed-default-branch) a
 * single, unit-testable home.
 *
 * Direction of dependency (NO cycle): update.js imports FROM this module; this
 * module never imports update.js. The only sibling it depends on is
 * update-platform.js (resolveHome) — a pure leaf with no back-edge to update.js.
 *
 * Root incident this guards: the artibot/master -> master remote-branch rename
 * left clones pulling a deleted ref, so `git pull` failed silently and /update
 * fell back to a no-op self-install while still reporting success. The resolver
 * here follows origin/HEAD across renames and retries once against the remote's
 * real default branch before giving up.
 *
 * Pre-pull health invariant (asserted by update.js before any pull):
 *   INV-7 git health — .git present + working-tree state knowable + a usable
 *          remote pull target resolvable. A failed health check is surfaced (not
 *          thrown) so update.js can refuse a doomed pull instead of running one
 *          that silently no-ops.
 *
 * Security: pull/branch args are ALWAYS passed to execFileSync as an array,
 * never interpolated into a shell string. Branch names can contain shell
 * metacharacters; string interpolation would let a tampered/malicious origin
 * inject arbitrary shell.
 *
 * Zero dependencies. Node 18+ built-ins only. ESM module format.
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { resolveHome } from './update-platform.js';

// ---------------------------------------------------------------------------
// Source-repo discovery
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
export function findSourceRepo(installScriptDir) {
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

// ---------------------------------------------------------------------------
// Dirty-tree auto-stash
// ---------------------------------------------------------------------------

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
export function stashIfDirty(gitRoot) {
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
export function popAutostash(gitRoot) {
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

// ---------------------------------------------------------------------------
// Branch / upstream resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the remote's actual default branch via origin/HEAD — the
 * authoritative answer to "which branch should this clone track?". When a remote
 * branch is renamed or deleted (e.g. the artibot/master -> master rename that
 * broke /update), a clone's configured upstream and any hardcoded guess list go
 * stale, but origin/HEAD follows the rename. If origin/HEAD was never populated
 * on this clone, ask the remote once via `git remote set-head --auto`, then
 * re-read.
 *
 * @param {string} gitRoot
 * @returns {string | null} bare branch name (e.g. 'master'), or null when offline/undeterminable
 */
export function resolveRemoteDefaultBranch(gitRoot) {
  const readHead = () => {
    try {
      const ref = execFileSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
        cwd: gitRoot, encoding: 'utf-8', timeout: 5000,
      }).trim();
      return ref.startsWith('origin/') ? ref.slice('origin/'.length) : null;
    } catch {
      return null;
    }
  };

  const existing = readHead();
  if (existing) return existing;

  // origin/HEAD not set on this clone — ask the remote, then retry the read.
  try {
    execFileSync('git', ['remote', 'set-head', 'origin', '--auto'], {
      cwd: gitRoot, stdio: 'ignore', timeout: 10_000,
    });
  } catch {
    return null;
  }
  return readHead();
}

/**
 * Resolve a fallback pull target when neither @{u} nor origin/<HEAD-branch>
 * resolves. Prefers the remote's real default branch (origin/HEAD); only when
 * that is undeterminable (e.g. offline) does it probe a minimal guess list
 * (master, main). The dead 'artibot/master' guess is intentionally dropped —
 * keeping it is what made /update pull a deleted remote ref and silently no-op.
 *
 * @param {string} gitRoot
 * @returns {string[]} ['pull', remote, branch]
 */
export function resolveDefaultBranchPull(gitRoot) {
  const defaultBranch = resolveRemoteDefaultBranch(gitRoot);
  if (defaultBranch) return ['pull', 'origin', defaultBranch];

  for (const ref of ['master', 'main']) {
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
export function resolveBranchPullArgs(gitRoot, branch) {
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

// ---------------------------------------------------------------------------
// INV-7 — pre-pull git health
// ---------------------------------------------------------------------------

/**
 * Assert, BEFORE any pull, that the repo at gitRoot is in a state where a pull
 * can plausibly succeed. Never throws — returns a structured result so update.js
 * can refuse a doomed pull (which would otherwise silently no-op and falsely
 * report success) with a clear reason.
 *
 * Three checks (INV-7):
 *   1. .git present        — gitRoot is actually a repo
 *   2. working-tree state  — `git status --porcelain` is runnable (state knowable)
 *   3. remote pull target  — a usable origin branch resolves (origin/HEAD or a
 *                            verifiable origin/<default>)
 *
 * @param {string} gitRoot
 * @returns {{ ok: boolean, reason: string|null, dirty: boolean, pullTarget: string|null }}
 */
export function assertGitHealth(gitRoot) {
  const fail = (reason) => ({ ok: false, reason, dirty: false, pullTarget: null });

  if (!gitRoot || !existsSync(path.join(gitRoot, '.git'))) {
    return fail('not-a-git-repo');
  }

  // Working-tree state must be knowable (status runnable). An unrunnable status
  // means we cannot reason about a safe stash/pull.
  let dirty;
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: gitRoot, encoding: 'utf-8', timeout: 5000,
    });
    dirty = out.trim().length > 0;
  } catch {
    return fail('status-unreadable');
  }

  // A usable remote pull target must resolve. resolveDefaultBranchPull always
  // returns a triple, but we additionally verify the chosen origin/<branch>
  // actually exists so an offline clone with no fetched refs fails honestly.
  const pullArgs = resolveDefaultBranchPull(gitRoot);
  const target = pullArgs[2];
  try {
    execFileSync('git', ['rev-parse', '--verify', `origin/${target}`], {
      cwd: gitRoot, stdio: 'ignore', timeout: 5000,
    });
  } catch {
    return { ok: false, reason: 'no-remote-target', dirty, pullTarget: null };
  }

  return { ok: true, reason: null, dirty, pullTarget: target };
}

// ---------------------------------------------------------------------------
// Pull orchestration
// ---------------------------------------------------------------------------

/**
 * Run a single `git pull` attempt with dirty-tree auto-stash/restore.
 * Never throws: a failed pull is caught, logged, and reported as `false` so the
 * caller can decide whether to retry against a different branch.
 *
 * @param {string} gitRoot
 * @param {string[]} pullArgs - e.g. ['pull', 'origin', 'master']
 * @returns {boolean} true when the pull succeeded
 */
export function attemptPull(gitRoot, pullArgs) {
  // Auto-stash a dirty working tree so hook-edited tracked files (e.g.
  // .artibot/SESSION-NOTES.md) don't block the pull. Pop in the finally so the
  // stash is always restored even if the pull throws.
  const stashed = stashIfDirty(gitRoot);
  try {
    console.log(`  Pulling latest source from ${gitRoot} (${pullArgs.slice(1).join(' ')})...`);
    execFileSync('git', pullArgs, { cwd: gitRoot, stdio: 'inherit', timeout: 30_000 });
    console.log('  Source updated.');
    return true;
  } catch (err) {
    console.warn(`  Warning: git pull failed: ${err.message}`);
    return false;
  } finally {
    if (stashed) popAutostash(gitRoot);
  }
}

/**
 * Resolve the `git pull` args for the repo: upstream-first (@{u}), then the
 * current branch's matching origin ref, then the remote default branch.
 * Extracted from pullLatestSource() to keep that function's nesting under the
 * eslint max-depth=4 cap.
 *
 * @param {string} gitRoot
 * @returns {string[]} pull args (e.g. ['pull', 'origin', 'master'])
 */
function resolvePullArgs(gitRoot) {
  // Upstream-first: read the actual configured upstream of HEAD via
  // `git rev-parse --abbrev-ref @{u}` -> "remote/branch". Authoritative source;
  // only fall back to candidate branches when no upstream is configured.
  //
  // The previous fallback ordering (origin/artibot/master -> origin/master ->
  // origin/main) ran unconditionally on rev-parse HEAD failure and could pull a
  // non-tracked branch INTO the current HEAD, fabricating divergent history.
  // The autopilot-drift-fix-2026-05-16 incident hit exactly this.
  try {
    const upstream = execFileSync('git', ['rev-parse', '--abbrev-ref', '@{u}'], {
      cwd: gitRoot, encoding: 'utf-8', timeout: 5000,
    }).trim();
    const slashIdx = upstream.indexOf('/');
    if (slashIdx > 0) {
      return ['pull', upstream.slice(0, slashIdx), upstream.slice(slashIdx + 1)];
    }
    throw new Error('upstream lacks remote/ prefix');
  } catch {
    // No upstream configured. Resolve current branch and try matching remote
    // refs first; only fall back to default branches if HEAD is detached.
    return resolveCurrentBranchPullArgs(gitRoot);
  }
}

/**
 * Resolve pull args from the current branch name, falling back to the remote
 * default when HEAD is detached or unreadable. Split out of resolvePullArgs() to
 * keep the try/catch nesting under eslint max-depth=4.
 *
 * @param {string} gitRoot
 * @returns {string[]} pull args
 */
function resolveCurrentBranchPullArgs(gitRoot) {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: gitRoot, encoding: 'utf-8', timeout: 5000,
    }).trim();
    return (branch && branch !== 'HEAD')
      ? resolveBranchPullArgs(gitRoot, branch)
      : resolveDefaultBranchPull(gitRoot);
  } catch {
    return resolveDefaultBranchPull(gitRoot);
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
export function pullLatestSource(installScriptDir) {
  const repo = findSourceRepo(installScriptDir);

  if (!repo) {
    console.log('  Source repo not found. The update will use currently installed files.');
    console.log('  For full updates, clone the repo: git clone https://github.com/Yoodaddy0311/artibot.git');
    return { pulled: false, pluginDir: null };
  }

  try {
    const pullArgs = resolvePullArgs(repo.gitRoot);

    // First attempt with the resolved pull args (upstream or current-branch).
    if (attemptPull(repo.gitRoot, pullArgs)) {
      return { pulled: true, pluginDir: repo.pluginDir };
    }

    // Self-heal: the configured target may be a deleted/renamed remote branch
    // (the artibot/master -> master rename hit exactly this — the pull fails on
    // "couldn't find remote ref"). Retry once against the remote's ACTUAL
    // default branch (origin/HEAD) before giving up, unless that's the same
    // target we just tried.
    const fallbackArgs = resolveDefaultBranchPull(repo.gitRoot);
    const sameTarget = fallbackArgs[1] === pullArgs[1] && fallbackArgs[2] === pullArgs[2];
    if (!sameTarget) {
      console.warn(`  Retrying against remote default branch: origin/${fallbackArgs[2]}`);
      if (attemptPull(repo.gitRoot, fallbackArgs)) {
        return { pulled: true, pluginDir: repo.pluginDir };
      }
    }

    console.warn('  Continuing with current local files.');
    return { pulled: false, pluginDir: repo.pluginDir };
  } catch (err) {
    console.warn(`  Warning: git pull failed: ${err.message}`);
    console.warn('  Continuing with current local files.');
    return { pulled: false, pluginDir: repo.pluginDir };
  }
}
