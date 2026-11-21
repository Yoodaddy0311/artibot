/**
 * Preflight tree comparison after M11 (2026-11-21).
 *
 * `engine.js#pinProjectRoot` made every new lock holder record the PROJECT
 * ROOT as its `cwd` (`resolveLockScope` reads `options.projectRoot`), while the
 * command driver still hands preflight the raw shell cwd
 * (`commands/autopilot.md` Step 1.5: `runPreflight({ cwd: process.cwd(), … })`).
 * Comparing the two raw strings turned a same-checkout peer into an
 * "other worktree" peer the moment the shell sat in a subdirectory, so
 * `repoConcurrency` downgraded fail → warn: a fail-open regression.
 *
 * These cases build a real directory layout (a `.git` directory for the main
 * checkout, a `.git` FILE for a linked worktree — the marker
 * `lib/git/project-root.js#resolveProjectRoot` looks for first), so the
 * normalization under test is the production one, not a stub.
 *
 * WHAT THIS CANNOT SEE: the repo identity is injected (`owner/repo`), so
 * whether two directories really share a repository is assumed, not measured —
 * that is `repo-identity.test.js`'s job.
 *
 * @module tests/autopilot/preflight-project-root
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runIndividualCheck } from '../../lib/autopilot/preflight.js';

let tmp;
let repo;
let worktree;

beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'ap-preflight-root-'));
  repo = path.join(tmp, '내 리포');
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  mkdirSync(path.join(repo, 'plugins', 'artibot', 'lib'), { recursive: true });
  mkdirSync(path.join(repo, 'docs'), { recursive: true });
  worktree = path.join(repo, '.claude', 'worktrees', 'limb-1');
  mkdirSync(path.join(worktree, 'src'), { recursive: true });
  writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'limb-1')}\n`);
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** The spelling `pinProjectRoot` records: canonical, via resolveProjectRoot. */
const pinned = (p) => realpathSync.native(p);

const lockOf = (cwd, featureKey = 'task-b') => ({
  lockKey: `owner-repo__${featureKey}`,
  stale: false,
  holder: { pid: 1, sessionId: 'sess-peer', acquiredAt: 1, featureKey, repoIdentity: 'owner/repo', cwd },
});

const check = (askerCwd, holderCwd) => runIndividualCheck(
  'repoConcurrency',
  { cwd: askerCwd, featureKey: 'task-a', sessionId: 'sess-own' },
  { resolveRepoIdentity: () => 'owner/repo', listLocks: () => [lockOf(holderCwd)] },
);

describe('repoConcurrency — both sides normalized to the project root', () => {
  it('fails when the asker is in a subdirectory and the holder pinned the repo top (M11 regression)', () => {
    const r = check(path.join(repo, 'plugins', 'artibot'), pinned(repo));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/same repo\+tree: task-b/);
  });

  it('fails when an older holder recorded a raw subdirectory cwd and the asker is at the top', () => {
    const r = check(repo, path.join(repo, 'docs'));
    expect(r.status).toBe('fail');
  });

  it('fails when both sides sit in different subdirectories of one checkout', () => {
    const r = check(path.join(repo, 'plugins', 'artibot', 'lib'), path.join(repo, 'docs'));
    expect(r.status).toBe('fail');
  });

  it('keeps a linked worktree isolated from the main checkout (holder in the worktree)', () => {
    const r = check(path.join(repo, 'plugins', 'artibot'), pinned(worktree));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/same repo, other worktree: task-b/);
  });

  it('keeps a linked worktree isolated from the main checkout (asker in the worktree)', () => {
    const r = check(path.join(worktree, 'src'), pinned(repo));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/other worktree/);
  });

  it('fails inside one linked worktree: subdirectory asker, worktree-top holder', () => {
    const r = check(path.join(worktree, 'src'), pinned(worktree));
    expect(r.status).toBe('fail');
  });

  it('still fails closed when the holder recorded no cwd', () => {
    const r = check(path.join(repo, 'plugins'), undefined);
    expect(r.status).toBe('fail');
  });
});

describe('peerNotice — "this repo" is the project root, not the shell cwd', () => {
  it('counts a peer in a sibling subdirectory of the same checkout', () => {
    const listAgents = () => [
      { name: 'sibling', cwd: path.join(repo, 'docs') },
      { name: 'elsewhere', cwd: tmp },
    ];
    const r = runIndividualCheck(
      'peerNotice',
      { cwd: path.join(repo, 'plugins', 'artibot'), featureKey: 'task-a' },
      { listAgents },
    );
    expect(r.status).toBe('pass');
    // `tmp` is an ANCESTOR of the repo — overlap counts it, as before.
    expect(r.detail).toMatch(/^2 peer session\(s\) in this repo: sibling, elsewhere$/);
  });
});
