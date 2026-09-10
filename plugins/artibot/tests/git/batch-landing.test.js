/**
 * `lib/git/batch-landing.js` — the integration branch itself, against a LOCAL
 * BARE REMOTE. Two defects observed in production and pinned here:
 *
 *   1. **Re-run on a stale side branch.** The first push carried no lease, so a
 *      leftover `ci/split-<run>` from an earlier attempt with the same run id
 *      made the push a non-fast-forward and the whole batch came back
 *      `push-failed` (retro `reports/SPLIT/split-5f9fe3.md` :14, "2회차
 *      push-failed"). The first push now always carries
 *      `--force-with-lease=refs/heads/<branch>:<expect>`, where `<expect>` is
 *      the remote tip we just read, or the empty string when the branch is
 *      absent.
 *   2. **Doubled prefix.** Run ids are already `split-<sid>`, so
 *      `ci/split-` + `split-5f9fe3` produced `ci/split-split-5f9fe3`.
 *
 * ── The empty lease value, measured not assumed ──────────────────────────────
 * `--force-with-lease=<ref>:` with an empty expectation means "this ref must
 * not exist". Measured directly on **git 2.54.0.windows.1** (2026-09-10):
 * absent → accepted (exit 0); present → rejected `! [rejected] ... (stale
 * info)` (exit 1). Case (d) below re-measures the accepting half inside the
 * suite so a git that drops the behaviour turns this file red rather than
 * silently degrading the first push to unprotected.
 *
 * ── What this suite cannot see (rules §9) ───────────────────────────────────
 *   - **A real remote.** A bare local remote has no branch protection, no
 *     `strict:true`, no required contexts; it accepts any fast-forward. CI is
 *     an injected fake, `makeGhCheckRunsFetcher` is never called.
 *   - **A real concurrent writer.** Case (c) simulates the race by moving the
 *     remote ref from inside an `exec` wrapper, in-process and strictly ordered
 *     between our tip read and our push. It proves the lease *value* is
 *     honoured; it does not prove anything about two OS processes interleaving.
 *   - **Scale.** Two limbs, three commits. Nothing here says how merge-tree
 *     behaves on a real batch, and nothing here measures wall-clock: `pollMs:0`
 *     plus an injected `sleep` make the green wait instant.
 *
 * Temp repos only — never the user's repository.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { integrationBranchName, landBatch } from '../../lib/git/batch-landing.js';
import { runGit } from '../../lib/git/merge-preflight.js';

let root = '';
let lockDir = '';
let origin = '';
let work = '';

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim();
}

function originTip(branch) {
  try {
    return git(['rev-parse', '--verify', `refs/heads/${branch}`], origin);
  } catch {
    return null;
  }
}

/**
 * Create `branch` on origin at a parentless commit: guaranteed NOT an ancestor
 * of anything we build, so a plain push to it is a non-fast-forward. The branch
 * must not already exist (this is a plain push, by design — the fixture may not
 * use the very force semantics under test).
 */
function seedUnrelatedBranch(branch) {
  git(['fetch', '--quiet', 'origin', 'main'], work);
  const tree = git(['rev-parse', 'FETCH_HEAD^{tree}'], work);
  const sha = git(['commit-tree', tree, '-m', `stale ${branch}`], work);
  git(['push', '--quiet', 'origin', `${sha}:refs/heads/${branch}`], work);
  return sha;
}

/** Move a ref inside the bare remote directly — the "other writer", no push. */
function setOriginRef(branch, sha) {
  git(['update-ref', `refs/heads/${branch}`, sha], origin);
  return sha;
}

/**
 * Fast-forward origin/main by one commit and return the new tip. Its parent is
 * the previous tip, so a test needing "two commits both ancestors of the batch"
 * can make them itself instead of assuming earlier tests left a history behind.
 */
function advanceOriginMain() {
  git(['fetch', '--quiet', 'origin', 'main'], work);
  const tip = git(['rev-parse', 'FETCH_HEAD'], work);
  const tree = git(['rev-parse', `${tip}^{tree}`], work);
  const sha = git(['commit-tree', tree, '-p', tip, '-m', 'window commit'], work);
  git(['push', '--quiet', 'origin', `${sha}:refs/heads/main`], work);
  return sha;
}

/**
 * An `exec` that records the argv of every `git push` before delegating. The
 * lease has to be witnessed in the ARGV: `landBatch` writes its `lease …` log
 * line before the push and unconditionally, so a log assertion alone stays
 * green even if the `--force-with-lease` flag is deleted from the push.
 */
function capturingExec(pushes, beforePush) {
  return (args, opts) => {
    if (args[0] === 'push') {
      pushes.push(args);
      if (beforePush) beforePush(args);
    }
    return runGit(args, opts);
  };
}

/** The recorded push that targets `branch`, or undefined. */
function branchPush(pushes, branch) {
  return pushes.find((args) => args.some((a) => a.endsWith(`:refs/heads/${branch}`)));
}

const GREEN = { total_count: 1, check_runs: [{ status: 'completed', conclusion: 'success' }] };
const instant = { pollMs: 0, sleep: async () => {} };

const common = () => ({
  cwd: work,
  limbs: ['L1', 'L3'],
  base: 'main',
  remote: 'origin',
  repoIdentity: 'owner/repo',
  lockDir,
  wait: instant,
  fetchCheckRuns: async () => GREEN,
});

beforeAll(() => {
  root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'artibot-batch-landing-'));
  lockDir = path.join(root, 'locks');
  origin = path.join(root, 'origin.git');
  work = path.join(root, 'work');
  git(['init', '-q', '--bare', '-b', 'main', origin]);
  fsSync.mkdirSync(work);
  git(['init', '-q', '-b', 'main', '.'], work);
  git(['config', 'user.email', 'test@example.invalid'], work);
  git(['config', 'user.name', 'test'], work);
  git(['config', 'core.autocrlf', 'false'], work);
  git(['remote', 'add', 'origin', origin], work);
  fsSync.writeFileSync(path.join(work, 'f.txt'), 'a\nb\nc\n', 'utf-8');
  git(['add', '.'], work);
  git(['commit', '-qm', 'init'], work);
  git(['push', '--quiet', 'origin', 'main'], work);

  git(['checkout', '-qb', 'L1'], work);
  fsSync.writeFileSync(path.join(work, 'f.txt'), 'a1\nb\nc\n', 'utf-8');
  git(['commit', '-qam', 'l1'], work);
  git(['checkout', '-q', 'main'], work);
  git(['checkout', '-qb', 'L3'], work);
  fsSync.writeFileSync(path.join(work, 'h.txt'), 'z\n', 'utf-8');
  git(['add', 'h.txt'], work);
  git(['commit', '-qm', 'l3'], work);
  git(['checkout', '-q', 'main'], work);
});

afterAll(() => {
  try {
    fsSync.rmSync(root, { recursive: true, force: true });
  } catch { /* best effort */ }
});

describe('integration branch naming', () => {
  it('strips exactly one leading split- so a split-<sid> run id is not doubled', () => {
    expect(integrationBranchName('split-5f9fe3')).toBe('ci/split-5f9fe3');
    // Only the LEADING token is stripped — an embedded `split-` is data.
    expect(integrationBranchName('team-split-abc:1')).toBe('ci/split-team-split-abc-1');
    expect(integrationBranchName('split-split-x')).toBe('ci/split-split-x');
    expect(integrationBranchName('release-7')).toBe('ci/split-release-7');
  });

  it('rejects a run id that is nothing but the stripped prefix', () => {
    expect(() => integrationBranchName('split-')).toThrow(TypeError);
    expect(() => integrationBranchName('///')).toThrow(TypeError);
    expect(() => integrationBranchName('')).toThrow(TypeError);
  });
});

describe('landBatch integration branch', () => {
  it('lands on ci/split-<sid> and never creates the doubled ci/split-split-<sid>', async () => {
    const r = await landBatch({ ...common(), runId: 'split-xyz' });
    expect(r.status).toBe('landed');
    expect(r.branch).toBe('ci/split-xyz');
    expect(originTip('ci/split-xyz')).toBe(r.sha);
    expect(originTip('ci/split-split-xyz')).toBeNull();
  });

  // The run id here deliberately has NO leading `split-`, so the branch name is
  // the same under the doubled-prefix defect and under the fix. Otherwise the
  // naming defect renames the branch out from under the seeded stale ref and
  // this test goes green without ever reaching a non-fast-forward push.
  it('re-run over a stale side branch lands instead of failing non-fast-forward', async () => {
    const branch = 'ci/split-rerun-5f9fe3';
    const stale = seedUnrelatedBranch(branch);
    expect(originTip(branch)).toBe(stale);

    const r = await landBatch({ ...common(), runId: 'rerun-5f9fe3' });
    expect(r.branch).toBe(branch);
    expect(r.reason).toBe('fast-forward push accepted');
    expect(r.status).toBe('landed');
    expect(originTip(branch)).toBe(r.sha);
    expect(originTip('main')).toBe(r.sha);
    expect(r.log).toContain(`lease ${branch}: ${stale}`);
  });

  it('takes the lease with an empty expectation when the branch is absent', async () => {
    const branch = 'ci/split-fresh-1';
    expect(originTip(branch)).toBeNull();
    const pushes = [];
    const r = await landBatch({ ...common(), runId: 'fresh-1', exec: capturingExec(pushes) });
    expect(r.status).toBe('landed');
    expect(originTip(branch)).toBe(r.sha);
    expect(originTip('main')).toBe(r.sha);
    // The accepting half of the empty lease value on this git, witnessed in the
    // argv: the flag was present with an empty expectation AND git took it.
    const push = branchPush(pushes, branch);
    expect(push).toBeDefined();
    expect(push).toContain(`--force-with-lease=refs/heads/${branch}:`);
    expect(r.log).toContain(`lease ${branch}: absent`);
  });

  // The pre-state is chosen so a LEASELESS push would succeed: the branch sits
  // on an ancestor of the batch both before and after the other writer moves
  // it, so every update here is a fast-forward and git's own non-fast-forward
  // rejection cannot be what fails the push. Only the lease value can.
  it('is fail-closed: a writer moving the branch between the read and the push aborts the landing', async () => {
    const branch = 'ci/split-raced-1';
    // The two ancestors are made here, not borrowed from whatever earlier tests
    // left on main: reading `main^1` assumed a history this test had not built,
    // so running this case alone (`-t "fail-closed"`) died in `rev-parse` on the
    // root commit instead of testing the lease.
    const parent = originTip('main');
    const tip = advanceOriginMain();
    expect(tip).not.toBe(parent);
    setOriginRef(branch, parent);
    const mainBefore = tip;
    let moved = null;

    // Delegates everything, but the instant the integration-branch push is
    // about to run — after landBatch has read the tip and baked it into the
    // lease — a third party moves the ref. The lease value is now stale.
    const pushes = [];
    const exec = capturingExec(pushes, (args) => {
      if (!moved && args.some((a) => a.endsWith(`:refs/heads/${branch}`))) moved = setOriginRef(branch, tip);
    });

    const r = await landBatch({ ...common(), runId: 'raced-1', exec });
    expect(moved).toBe(tip);
    expect(moved).not.toBe(parent);
    expect(r.status).toBe('push-failed');
    expect(r.reason).toMatch(/rejected|stale info|non-fast-forward/i);
    expect(branchPush(pushes, branch)).toContain(`--force-with-lease=refs/heads/${branch}:${parent}`);
    expect(originTip(branch)).toBe(moved);
    expect(originTip('main')).toBe(mainBefore);
  });

  it('leases only its own branch and leaves another run\'s side branch untouched', async () => {
    const other = seedUnrelatedBranch('ci/split-other');
    const pushes = [];
    const r = await landBatch({ ...common(), runId: 'mine', exec: capturingExec(pushes) });
    expect(r.status).toBe('landed');
    expect(r.branch).toBe('ci/split-mine');
    // A force-with-lease is still a force: the blast radius must be exactly one
    // branch. Nothing we ran may even NAME another run's branch.
    expect(originTip('ci/split-other')).toBe(other);
    expect(pushes.flat().join(' ')).not.toContain('ci/split-other');
    expect(branchPush(pushes, 'ci/split-mine')).toContain('--force-with-lease=refs/heads/ci/split-mine:');
  });
});
