/**
 * Preflight tree comparison after M11 (2026-11-21).
 *
 * `project-root-pin.js#pinProjectRoot` made every new lock holder record the PROJECT
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

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runIndividualCheck } from '../../lib/autopilot/preflight.js';
import { resolveProjectRoot as realResolveProjectRoot } from '../../lib/git/project-root.js';

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

  it('counts a peer at the filesystem root — an ancestor like any other', () => {
    // A root key already ends in a separator; appending another one made the
    // containment test `c:\\` and missed every path beneath it.
    const r = runIndividualCheck(
      'peerNotice',
      { cwd: path.join(repo, 'plugins', 'artibot'), featureKey: 'task-a' },
      { listAgents: () => [{ name: 'at-root', cwd: path.parse(repo).root }] },
    );
    expect(r.detail).toBe('1 peer session(s) in this repo: at-root');
  });

  it('does not count a sibling whose name merely starts with the project folder name, either way round', () => {
    // Containment is by path SEGMENT: `…\내 리포2` is not inside `…\내 리포`, and
    // `…\내 리` does not contain it. A bare string prefix said both were.
    const longer = path.join(tmp, '내 리포2');
    const shorter = path.join(tmp, '내 리');
    mkdirSync(path.join(longer, 'src'), { recursive: true });
    mkdirSync(shorter, { recursive: true });
    const r = runIndividualCheck(
      'peerNotice',
      { cwd: path.join(repo, 'plugins', 'artibot'), featureKey: 'task-a' },
      { listAgents: () => [{ name: 'longer', cwd: path.join(longer, 'src') }, { name: 'shorter', cwd: shorter }] },
    );
    expect(r.detail).toBe('0 peer session(s) in this repo');
  });

  it('counts a peer whose cwd no longer exists below a link to the checkout', () => {
    // realpath fails on the deleted tail, so the link spelling was kept and the
    // peer never matched the canonical project root. The nearest EXISTING
    // ancestor is canonicalized instead. A directory junction on win32 (no
    // admin needed), a plain symlink elsewhere.
    const linkDir = mkdtempSync(path.join(tmp, 'link-'));
    const alias = path.join(linkDir, 'alias');
    symlinkSync(repo, alias, 'junction');
    expect(existsSync(path.join(alias, 'docs'))).toBe(true); // the link really resolves
    const gone = path.join(alias, 'gone', 'deleted-subdir');
    expect(existsSync(gone)).toBe(false);
    const r = runIndividualCheck(
      'peerNotice',
      { cwd: path.join(repo, 'plugins', 'artibot'), featureKey: 'task-a' },
      { listAgents: () => [{ name: 'gone', cwd: gone }] },
    );
    expect(r.detail).toBe('1 peer session(s) in this repo: gone');
  });

  it('resolves the own project root once per check, not once per row', () => {
    const resolveProjectRoot = vi.fn((p) => realResolveProjectRoot(p));
    const rows = ['docs', 'plugins', 'missing', 'plugins/artibot/lib', 'docs']
      .map((rel, i) => ({ name: `p${i}`, cwd: path.join(repo, rel) }));
    const r = runIndividualCheck(
      'peerNotice',
      { cwd: path.join(repo, 'plugins', 'artibot'), featureKey: 'task-a' },
      { listAgents: () => rows, resolveProjectRoot },
    );
    expect(r.detail).toBe('5 peer session(s) in this repo: p0, p1, p2, p3, p4'); // denominator
    expect(resolveProjectRoot).toHaveBeenCalledTimes(1);
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
  /**
   * `tmp` in 8.3 form, or null when there is no usable one: short names are
   * disabled on the volume, or cmd's echo came back in the OEM codepage and
   * decoded into a path that does not exist (a non-ASCII segment ABOVE `tmp`,
   * e.g. a Korean TEMP). A mangled spelling must skip, not run the cases.
   */
  function shortTmp() {
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${tmp}") do @echo %~sI"`], {
      encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true,
    }).trim();
    if (!out || out.toLowerCase() === tmp.toLowerCase() || !existsSync(out)) return null;
    return out;
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

  it('peerNotice counts a peer whose short-spelled cwd no longer exists', (ctx) => {
    const short = shortTmp();
    if (!short) ctx.skip();
    const gone = path.join(short, '내 리포', 'gone', 'deleted-subdir');
    expect(existsSync(gone)).toBe(false);
    const r = runIndividualCheck(
      'peerNotice',
      { cwd: path.join(repo, 'plugins', 'artibot'), featureKey: 'task-a' },
      { listAgents: () => [{ name: 'gone', cwd: gone }] },
    );
    expect(r.detail).toBe('1 peer session(s) in this repo: gone');
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
