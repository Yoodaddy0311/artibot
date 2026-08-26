/**
 * Firewall — checkpoint stash cleanup must not drop another worktree's stash.
 *
 * `refs/stash` is shared by every worktree of a repository. Measured 2026-08-26
 * on a two-worktree temp repo: a stash pushed from the linked worktree renumbers
 * the entries the main checkout sees, so what was `stash@{0}` becomes
 * `stash@{1}`. `git stash list` therefore yields positions, not identities.
 *
 * `cleanupOldStashes` collects indices in one pass and drops them in another. If
 * anything pushes a stash in between — a second worktree, a parallel agent, the
 * user — every recorded index is off by one and the loop deletes stashes that
 * were never checkpoints. Losing a user's stash is unrecoverable; falling behind
 * on retention is not. The fix re-resolves each index to the SHA it had at list
 * time and aborts the cleanup on the first mismatch.
 *
 * These tests drive the real `cleanupOldStashes` from the save hook.
 *
 * These tests drive the real `cleanupOldStashes`. One of them reaches the guard
 * itself: `cleanupOldStashes` takes an injectable `stashShaAt`, so a test can
 * answer one commit while pinning and a different one at re-check — what a
 * shifted `refs/stash` looks like from inside the loop — and assert that
 * nothing is dropped. Deleting the guard line turns that case red (mutation
 * run, 2026-08-26); before the seam existed the whole file stayed green with
 * the guard removed, which is why the seam was added rather than trusted.
 *
 * WHAT THIS STILL DOES NOT COVER:
 *   - Real cross-process interleaving. The injected resolver simulates the
 *     shift; it does not prove the timing window behaves under an actual
 *     concurrent `git stash push` from another worktree or a second agent.
 *   - A user's own manual stash arriving mid-cleanup. Same window, same
 *     simulation gap.
 *   - Whether the hook is registered or ever fires. Existence is not operation.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupOldStashes } from '../../scripts/hooks/git-autopilot-save.js';

let repo = '';
let worktree = '';

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim();
}

/** Build a stash entry without disturbing the working tree, as the hook does. */
function storeStash(cwd, label, content) {
  fsSync.writeFileSync(path.join(cwd, 'seed.txt'), `${content}\n`, 'utf-8');
  const sha = git(['stash', 'create'], cwd);
  git(['stash', 'store', '-m', label, sha], cwd);
  git(['checkout', '--', 'seed.txt'], cwd);
  return sha;
}

/** What `stashShaAt` would really answer for an index. */
function realSha(cwd, idx) {
  try {
    return git(['rev-parse', `stash@{${idx}}`], cwd);
  } catch {
    return null;
  }
}

function stashLabels(cwd) {
  const raw = git(['stash', 'list'], cwd);
  return raw ? raw.split('\n').filter(Boolean) : [];
}

beforeAll(() => {
  repo = fsSync.mkdtempSync(path.join(os.tmpdir(), 'artibot-stashiso-'));
  git(['init', '-q', '-b', 'main', '.'], repo);
  git(['config', 'user.email', 'test@example.invalid'], repo);
  git(['config', 'user.name', 'test'], repo);
  fsSync.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n', 'utf-8');
  git(['add', 'seed.txt'], repo);
  git(['commit', '-qm', 'init'], repo);
  worktree = path.join(repo, 'linked-wt');
  git(['worktree', 'add', '-q', worktree, '-b', 'wt-branch'], repo);
});

afterAll(() => {
  try {
    fsSync.rmSync(repo, { recursive: true, force: true });
  } catch { /* best effort */ }
});

describe('checkpoint stash cleanup under a shared refs/stash', () => {
  it('confirms the hazard: refs/stash is shared and renumbers across worktrees', () => {
    const before = storeStash(repo, 'artibot-checkpoint-shared-probe', 'from-main');
    expect(git(['rev-parse', 'refs/stash'], repo)).toBe(git(['rev-parse', 'refs/stash'], worktree));
    expect(git(['rev-parse', 'stash@{0}'], repo)).toBe(before);

    // A push from the OTHER worktree shifts what stash@{0} means in this one.
    storeStash(worktree, 'user-work-from-worktree', 'from-worktree');
    expect(git(['rev-parse', 'stash@{0}'], repo)).not.toBe(before);
    expect(git(['rev-parse', 'stash@{1}'], repo)).toBe(before);

    git(['stash', 'clear'], repo);
  });

  it("leaves another worktree's stash alive when indices move mid-cleanup", () => {
    git(['stash', 'clear'], repo);

    // 12 checkpoints — two over the retention limit of 10, so cleanup will act.
    for (let i = 0; i < 12; i++) storeStash(repo, `artibot-checkpoint-${i}`, `ckpt-${i}`);
    const userSha = storeStash(worktree, 'PRECIOUS-user-stash', 'do-not-drop');

    expect(stashLabels(repo)).toHaveLength(13);
    expect(git(['rev-parse', 'stash@{0}'], repo)).toBe(userSha);

    cleanupOldStashes(repo, 10);

    const survivors = stashLabels(repo);
    // The user's stash must still be there, whatever happened to retention.
    expect(survivors.some((l) => l.includes('PRECIOUS-user-stash'))).toBe(true);
    expect(git(['cat-file', '-t', userSha], repo)).toBe('commit');
    // And nothing that is not a checkpoint may have been dropped.
    const nonCheckpoints = survivors.filter((l) => !l.includes('artibot-checkpoint-'));
    expect(nonCheckpoints).toHaveLength(1);
  });

  // NOTE: this asserts the ordinary path only. It does NOT reach the SHA
  // re-check — nothing shifts the indices during the call. See the file header.
  it('drops surplus checkpoints when nothing disturbs the indices', () => {
    git(['stash', 'clear'], repo);
    for (let i = 0; i < 12; i++) storeStash(repo, `artibot-checkpoint-${i}`, `ckpt-${i}`);
    const total = stashLabels(repo).length;
    expect(total).toBe(12);

    // Every entry is a checkpoint and none moved, so cleanup may proceed.
    cleanupOldStashes(repo, 10);
    expect(stashLabels(repo).length).toBeLessThan(total);
  });

  it('does nothing when the checkpoint count is within the retention limit', () => {
    git(['stash', 'clear'], repo);
    for (let i = 0; i < 3; i++) storeStash(repo, `artibot-checkpoint-${i}`, `small-${i}`);
    const before = stashLabels(repo);
    cleanupOldStashes(repo, 10);
    expect(stashLabels(repo)).toEqual(before);
  });

  it('aborts without dropping when the ref moves between pinning and re-check', () => {
    git(['stash', 'clear'], repo);
    for (let i = 0; i < 12; i++) storeStash(repo, `artibot-checkpoint-${i}`, `ckpt-${i}`);
    const before = stashLabels(repo);
    expect(before).toHaveLength(12);

    // A concurrent push cannot be wedged into the window between the collection
    // pass and the drop pass from out here, so the injected resolver plays that
    // role: it answers honestly while pinning, then reports a different commit
    // at re-check — precisely what a shifted `refs/stash` looks like from
    // inside the loop. Every real git call still runs.
    let pinning = true;
    const shifted = (cwd, idx) => (pinning ? realSha(cwd, idx) : `${realSha(cwd, idx)}-moved`);

    const seen = [];
    cleanupOldStashes(repo, 10, {
      stashShaAt: (cwd, idx) => {
        seen.push(idx);
        const out = shifted(cwd, idx);
        // 12 checkpoints get pinned first; the drop pass starts after that.
        if (seen.length >= 12) pinning = false;
        return out;
      },
    });

    // Guard tripped on the first drop, so nothing was removed.
    expect(stashLabels(repo)).toEqual(before);
    expect(stashLabels(repo)).toHaveLength(12);
  });

  it('never throws on a directory that is not a repository', () => {
    const notARepo = fsSync.mkdtempSync(path.join(os.tmpdir(), 'artibot-nostash-'));
    try {
      expect(() => cleanupOldStashes(notARepo, 10)).not.toThrow();
    } finally {
      fsSync.rmSync(notARepo, { recursive: true, force: true });
    }
  });
});
