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
import { execFileSync } from 'node:child_process';
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

/**
 * Windows 8.3 short names (2026-11-21, GitHub Windows runner: os.tmpdir() is
 * `C:\Users\RUNNER~1\AppData\Local\Temp`). `resolveProjectRoot` answers in the
 * LONG spelling, so any side compared without canonicalizing kept the short one
 * and never matched: peerNotice counted 0 of 2, and a holder whose recorded cwd
 * no longer exists resolved to a SHORT-spelled root and passed as "other
 * worktree" (fail-open). The short spelling is derived here with cmd's `%~sI`
 * so this runs on any Windows host, not only one whose TEMP is already short.
 * Only `tmp` (ASCII) is shortened — cmd's output codepage would mangle the
 * Korean segment below it.
 */
describe.runIf(process.platform === 'win32')('8.3 short-name spellings (win32)', () => {
  /** `tmp` in 8.3 form, or null when the volume has short names disabled. */
  function shortTmp() {
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${tmp}") do @echo %~sI"`], {
      encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true,
    }).trim();
    return out && out.toLowerCase() !== tmp.toLowerCase() ? out : null;
  }

  it('peerNotice counts short-spelled peers against a long-spelled project root', (ctx) => {
    const short = shortTmp();
    if (!short) ctx.skip(); // 8.3 generation off on this volume: nothing to exercise
    const sRepo = path.join(short, '내 리포');
    const r = runIndividualCheck(
      'peerNotice',
      { cwd: path.join(sRepo, 'plugins', 'artibot'), featureKey: 'task-a' },
      { listAgents: () => [{ name: 'sibling', cwd: path.join(sRepo, 'docs') }, { name: 'elsewhere', cwd: short }] },
    );
    expect(r.detail).toMatch(/^2 peer session\(s\) in this repo: sibling, elsewhere$/);
  });

  it('repoConcurrency fails for a holder whose short-spelled cwd no longer exists', (ctx) => {
    const short = shortTmp();
    if (!short) ctx.skip();
    const sRepo = path.join(short, '내 리포');
    const r = check(path.join(repo, 'plugins', 'artibot'), path.join(sRepo, 'gone', 'deleted-subdir'));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/same repo\+tree: task-b/);
  });
});
