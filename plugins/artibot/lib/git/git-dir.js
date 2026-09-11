/**
 * Git directory resolution.
 *
 * A repository's git directory is NOT always `<root>/.git/`. Inside a linked
 * worktree, `<root>/.git` is a regular FILE containing `gitdir: <path>`, and the
 * real directory lives at `<main>/.git/worktrees/<name>/`. Joining `'.git'` onto
 * a worktree root therefore produces a path that cannot be written to and, on
 * read, silently resolves to nothing.
 *
 * That split is what makes partial adoption dangerous: if one hook writes
 * through this module and another still joins `'.git'` by hand, a worktree
 * session writes its state to the real git dir and reads it back from a path
 * that does not exist. The state does not merely go stale — the two halves
 * disagree about where it lives. Convert call sites together, not one at a time.
 *
 * @module lib/git/git-dir
 */

import fsSync from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * How long to wait for `git rev-parse` before giving up.
 *
 * Derived from the hook budgets, not chosen for the spawn. Six hooks reach this
 * module, and the tightest slot budget among them is 5000ms:
 *
 * | hook                     | slot                    | budget |
 * |--------------------------|-------------------------|--------|
 * | git-autopilot-guard.js   | PreToolUse Write\|Edit  | 5s     |
 * | git-autopilot-setup.js   | SessionStart            | 5000   |
 * | git-autopilot-save.js    | UserPromptSubmit        | 5000   |
 * | session-notes.js         | Stop                    | 5000   |
 * | git-autopilot-session.js | SessionStart            | 10000  |
 * | git-autopilot-close.js   | Stop                    | 15000  |
 *
 * A spawn budget must fit inside the tightest of those minus the dispatcher's
 * own headroom: 5000 − 3000 (`HEADROOM_MS`, `tests/firewall/hook-timeout-budget
 * .test.js:54`) = 2000. Raising this to 5000 would let a slow git consume the
 * entire slot, and the host or dispatcher would then kill the hook outright —
 * the verdict is dropped silently rather than degraded, which is the shape of
 * the 4.59.0 ReDoS incident.
 *
 * The load tail exceeds this. None of the following was measured here; each
 * figure is attributed to whoever did measure it:
 *
 *   - 280-340ms unloaded, 800-970ms under load — the 2026-09-11 load brief's
 *     investigator measurement.
 *   - a tail of 2,040ms from that same brief, and 2,880ms from this limb's own
 *     load probe over 217 files.
 *   - "a ~31-worker parallel vitest run" is `availableParallelism` (32) minus
 *     one. It is ASSUMED, not counted: nobody enumerated the live workers.
 *
 * That tail is why the answer is to spawn *less*, not to wait longer.
 *
 * Note `HEADROOM_MS` describes itself as a conservative budget rather than a
 * profiled number, so 2000 is derived from an estimate, not from a measured
 * safety margin. If that constant is ever backed by a profile, redo this.
 *
 * Resolution now reads the on-disk layout first, so the hook path makes zero
 * spawns: all six hooks pass a `rev-parse --show-toplevel` root, and a
 * top-level path always has a readable layout. A spawn happens only for a
 * non-top-level cwd, a non-repository, or when `GIT_DIR`/`GIT_WORK_TREE` is
 * set — unless the Claude session itself was launched inside a git hook
 * environment (`GIT_DIR`/`GIT_WORK_TREE` set), in which case every call takes
 * the spawn arm on the 2000ms budget, same as before this change. That is not
 * hypothetical: git runs pre-push with an absolute `GIT_DIR` and, in a linked
 * worktree, no `GIT_WORK_TREE` (measured 2026-09-05, recorded at
 * `tests/ci/ci-utils.test.js` in the `gitTrackedNames under a hook
 * environment` suite).
 */
const GIT_TIMEOUT_MS = 2000;

/**
 * @typedef {'ok'|'not-a-repo'|'timeout'|'git-missing'|'spawn-failed'|'bad-input'} GitDirReason
 */

/**
 * Classify a thrown `execSync` error into a reason code.
 *
 * Shapes measured on Windows (cmd.exe shell) 2026-09-11:
 *
 * | failure            | code       | status | signal  |
 * |--------------------|------------|--------|---------|
 * | timeout            | ETIMEDOUT  | null   | SIGTERM |
 * | not a repository   | —          | 128    | null    |
 * | git not on PATH    | —          | 1      | null    |
 * | cwd does not exist | ENOENT     | null   | null    |
 *
 * Note `ENOENT` means *the child could not be spawned*, which on Windows is the
 * absent-cwd case — not a missing git. Because `execSync` goes through a shell,
 * a missing git surfaces as the shell's own "command not found" status: 1 from
 * `cmd.exe`, 127 from a POSIX `sh`. Those two statuses are a heuristic, not a
 * guarantee; a real git could in principle exit 1. Nothing branches on
 * `git-missing` today — it exists so the distinction is reportable.
 *
 * @param {unknown} err - The error thrown by execSync.
 * @returns {GitDirReason} Reason code, never 'ok'.
 */
function classifyGitError(err) {
  const code = err?.code;
  const status = err?.status;
  if (code === 'ETIMEDOUT') return 'timeout';
  if (status === 128) return 'not-a-repo';
  if (status === 1 || status === 127) return 'git-missing';
  return 'spawn-failed';
}

/**
 * Resolve the git directory, reporting *why* when it cannot be resolved.
 *
 * `getGitDir` collapses every failure into `null`, which is the right contract
 * for callers that only need a path but the wrong one for anybody deciding what
 * to do next: "not a repository" is a normal, permanent condition worth
 * skipping on, while "timed out" is a transient condition that says nothing
 * about whether a repository is there. Tests in particular could not tell the
 * two apart, so a machine slow enough to blow the budget made assertions about
 * non-repositories pass for the wrong reason.
 *
 * Never throws, for the same reason `getGitDir` does not.
 *
 * ── Resolution order ───────────────────────────────────────────────────────
 * The on-disk layout is consulted BEFORE git, and the ordering is the whole
 * performance argument: every hook that reaches this module passes a
 * `rev-parse --show-toplevel` root, a top-level path always has a readable
 * layout, so the hook path spawns nothing at all and cannot time out. git still
 * runs for everything the layout cannot answer — a cwd below the root, a
 * non-repository — and remains authoritative when `GIT_DIR` or `GIT_WORK_TREE`
 * is set, because those deliberately override what the directory looks like.
 *
 * Stated as a rule: the layout wins wherever a layout exists; git is consulted
 * only when no layout is present or `GIT_DIR`/`GIT_WORK_TREE` is set. A
 * `core.worktree` override is NOT detected — seeing it would mean reading the
 * config, which is the spawn this ladder exists to avoid. A repository using
 * `core.worktree` therefore resolves by layout and may disagree with git.
 *
 * `via` says which arm answered, so a caller or test can tell a cheap answer
 * from a spawned one. It is absent on failure, where nothing answered.
 *
 * @param {string} cwd - Directory to resolve from.
 * @param {{ timeoutMs?: number }} [options] - Spawn budget override; tests inject
 *   a tiny value to produce a real timeout without a hung git, or a generous one
 *   to assert a classification without racing the budget. Beware `0`: `execSync`
 *   reads it as "no limit", so it disables the timeout rather than expiring at
 *   once. Only `??` guards the default, so an explicit `0` does reach execSync.
 * @returns {{ dir: string|null, reason: GitDirReason, via?: 'layout'|'git' }}
 *   Resolved dir with reason `'ok'`, or `null` with the reason it failed.
 */
export function resolveGitDir(cwd, options = {}) {
  if (!cwd || typeof cwd !== 'string') return { dir: null, reason: 'bad-input' };

  // An explicit GIT_DIR/GIT_WORK_TREE overrides the directory's appearance, and
  // only git knows how to apply it. Skipping the layout keeps the env vars
  // working rather than silently answering from the wrong directory.
  if (!process.env.GIT_DIR && !process.env.GIT_WORK_TREE) {
    const fromLayout = gitDirFromLayout(cwd);
    if (fromLayout) return { dir: fromLayout, reason: 'ok', via: 'layout' };
  }

  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  try {
    const out = execSync('git rev-parse --absolute-git-dir', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs,
      windowsHide: true,
    });
    const resolved = String(out).trim();
    // Empty stdout with a zero exit is not a shape git produces here; treat it
    // as a failed spawn rather than inventing a path from it.
    if (!resolved) return { dir: null, reason: 'spawn-failed' };
    return { dir: path.resolve(resolved), reason: 'ok', via: 'git' };
  } catch (err) {
    return { dir: null, reason: classifyGitError(err) };
  }
}

/**
 * Resolve the git directory for a working directory.
 *
 * Returns the per-worktree git dir (`<main>/.git/worktrees/<name>`) inside a
 * linked worktree and `<root>/.git` in an ordinary checkout — in both cases a
 * real directory that can be written to.
 *
 * Never throws: hooks call this on paths that may not be repositories at all,
 * and a hook that throws takes the whole session event down with it. Callers
 * get `null` and decide. Callers that need to know *which* failure they hit
 * should use `resolveGitDir` instead.
 *
 * `execSync` with a constant command, matching the hook it was promoted from
 * (`git-autopilot-setup.js`) and the rest of the hook layer: there is nothing
 * to interpolate here, and the hooks' tests drive git through a single
 * `execSync` seam.
 *
 * @param {string} cwd - Directory to resolve from.
 * @returns {string|null} Absolute git directory, or null when it cannot be resolved.
 */
export function getGitDir(cwd) {
  return resolveGitDir(cwd).dir;
}

/** `gitdir: <path>` — the sole contents of a linked worktree's `.git` file. */
const GITDIR_POINTER_RE = /^gitdir:\s*(.+)$/m;

/**
 * Canonicalize a path the way git reports it.
 *
 * Two spellings of one directory is precisely the split this module exists to
 * prevent: a caller that resolves through git on one run and through the
 * filesystem on the next would key its state off two different strings.
 *
 * Measured directly, 2026-09-11 on Windows, comparing both arms:
 *
 * | checkout reached via | plain join | after realpath |
 * |----------------------|------------|----------------|
 * | path with an 8.3 short name | differs from git | matches git |
 * | a directory junction        | differs from git | matches git |
 * | linked worktree, either of the above | matches git | matches git |
 *
 * So git resolves a junction to its real target, and `realpathSync.native`
 * resolves it the same way; expanding short names and restoring on-disk casing
 * covers the rest. The worktree shape needs no help either way, because the
 * pointer file already stores a real absolute path. This is why git's own
 * answer is left untouched — canonicalizing the layout arm alone is what makes
 * the two agree, and it was measured rather than assumed.
 *
 * NOT measured: `subst` drives and mapped network drives. Both are plausible
 * ways for the two arms to disagree and neither has been checked.
 *
 * Falls back to the input when the path cannot be canonicalized, which keeps
 * this a normalization step and not a second existence check.
 *
 * @param {string} target - Absolute path to canonicalize.
 * @returns {string} Canonical absolute path.
 */
function canonicalize(target) {
  try {
    return fsSync.realpathSync.native(target);
  } catch {
    return target;
  }
}

/**
 * Accept a candidate git directory only if it actually is one.
 *
 * Reading the layout before asking git means the layout can now *answer*, so it
 * must be as strict as git about what counts. An empty `.git/` directory, or a
 * pointer aimed at one, is a directory that exists and is not a repository: git
 * reports 128 for it, and without this check the layout arm would hand back a
 * path where the previous code returned null — widening `getGitDir`'s contract
 * by accident. `HEAD` is present in every shape that reaches here, ordinary
 * checkout and per-worktree dir alike, and costs one stat.
 *
 * @param {string} candidate - Absolute path to a possible git directory.
 * @returns {string|null} Canonical path, or null when it is not a git directory.
 */
function validated(candidate) {
  try {
    if (!fsSync.statSync(candidate).isDirectory()) return null;
    if (!fsSync.statSync(path.join(candidate, 'HEAD')).isFile()) return null;
    return canonicalize(candidate);
  } catch {
    return null;
  }
}

/**
 * Resolve the git directory from the on-disk layout alone, without running git.
 *
 * This exists because the literal `<root>/.git` fallback is only correct for
 * one of the two repository shapes. In an ordinary checkout `.git` really is
 * the directory. In a linked worktree it is a *pointer file*, so joining onto
 * it yields a path under a file — exactly the defect this module was written to
 * prevent. As long as the fallback fires only for non-repositories that
 * distinction never shows up, but a timeout makes it fire inside a perfectly
 * healthy worktree, and then the caller silently reads and writes state to a
 * path that cannot exist.
 *
 * The filesystem already holds the answer, so reading it costs no spawn and
 * cannot time out. Returns null when there is no git layout to read at all,
 * which is the honest answer for a non-repository.
 *
 * @param {string} repoRoot - Repository or worktree root.
 * @returns {string|null} Absolute git directory, or null when the layout is absent.
 */
export function gitDirFromLayout(repoRoot) {
  if (!repoRoot || typeof repoRoot !== 'string') return null;
  try {
    const dotGit = path.join(repoRoot, '.git');
    const stat = fsSync.statSync(dotGit);
    if (stat.isDirectory()) return validated(path.resolve(dotGit));
    if (!stat.isFile()) return null;

    const pointer = GITDIR_POINTER_RE.exec(fsSync.readFileSync(dotGit, 'utf-8'));
    if (!pointer) return null;
    // Worktree pointers are absolute in practice; submodule pointers are
    // relative to the file's own directory. `resolve` handles both.
    return validated(path.resolve(repoRoot, pointer[1].trim()));
  } catch {
    // Absent cwd, unreadable file, pointer to nothing. Same contract as the
    // rest of the module: no throwing into a hook.
    return null;
  }
}

/**
 * Build a path inside the repository's git directory.
 *
 * Use this instead of `path.join(repoRoot, '.git', ...)` — it is the whole
 * point of the module. Resolution is `resolveGitDir` (layout, then git) and,
 * when that yields nothing, the literal `<repoRoot>/.git`.
 *
 * The literal now only fires where there is no git layout at all, which is the
 * case it was written for: in a non-repository that path does not exist either
 * way, so the caller's `existsSync` check fails as before and the hook skips.
 *
 * Always returns a string, never null. Twelve hook call sites join onto this
 * value and stat, read, or write it; a null would throw inside a hook and take
 * the session event down. Reporting the failure instead of papering over it is
 * possible only at those call sites, via `resolveGitDir` — this function's
 * contract is "give me a path", and it is used from code that must not throw.
 *
 * The fallbacks live here so no hook has to spell `'.git'`.
 *
 * @param {string} repoRoot - Repository or worktree root.
 * @param {...string} segments - Path segments to append to the git directory.
 * @returns {string} Absolute path inside the git directory.
 */
export function gitPath(repoRoot, ...segments) {
  const gitDir = resolveGitDir(repoRoot).dir || path.join(repoRoot, '.git');
  return path.join(gitDir, ...segments);
}
