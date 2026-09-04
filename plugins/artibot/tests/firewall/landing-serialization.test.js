/**
 * Firewall — batch landings on the same (repo, branch) must serialize, and the
 * landing sequence must handle a moved base exactly once before stopping.
 *
 * Two halves:
 *   1. `lib/git/landing-lock.js` — single-string key sanitisation, O_EXCL
 *      mutual exclusion (in-process AND across real child processes racing on
 *      one key), token-guarded release, stale reclaim.
 *   2. `lib/git/batch-landing.js#landBatch` — against a LOCAL BARE REMOTE with
 *      an injected check-run source: happy path (1 push, 1 wait, ff), base
 *      moved once (rebuild + `--force-with-lease` + ff, `rebuilds:1`), base
 *      moved twice (`needs-human`), lock held (`locked`, nothing pushed), old
 *      git (`degraded`, nothing pushed), no check-run source (`not-green`,
 *      master untouched).
 *
 * ── What this gate cannot see (rules §9) ────────────────────────────────────
 *   - **Remote TOCTOU.** The lock is a file on ONE host. A second machine, a CI
 *     job, or a human pushing from elsewhere is invisible to it. What guards
 *     that window is the base re-read right before the ff push plus git's own
 *     non-fast-forward rejection; this suite simulates "moved while waiting"
 *     by pushing from inside the fake check-run poll, which exercises the
 *     re-read path but NOT a push that lands in the microseconds between the
 *     re-read and our push. That last window is handled by the `ff push
 *     refused` branch, which is reached here only via the re-read, not via a
 *     real race.
 *   - **GitHub itself.** `strict:true` / `enforce_admins:true` / required
 *     contexts are branch-protection behaviour on the live remote; a bare
 *     local remote accepts any fast-forward. The `gh api` check-run fetcher
 *     (`makeGhCheckRunsFetcher`) is never called here.
 *   - **The 10-minute ceiling as wall-clock.** `pollMs:0` and an injected
 *     `sleep` make the loop instant; only the attempt count is exercised.
 *   - **PID liveness across hosts.** Stale reclaim by dead PID is only
 *     attempted for a holder on the same hostname; a foreign-host record is
 *     reclaimed by age alone, and that path is tested only with an injected
 *     clock.
 *   - **Reclaim under concurrency.** The cross-process race disables reclaim
 *     inside the children (`isPidAlive: () => true`, `staleMs` a day) so the
 *     assertion is about `O_EXCL` alone and cannot depend on spawn timing.
 *     Two reclaimers racing on one stale file is therefore not exercised —
 *     the module relies on the second `wx` losing, which is the same
 *     primitive, but no test here pins it.
 *     Those two knobs did NOT in fact disable reclaim until 2026-09-04: a
 *     child that read the winner's file inside the window between
 *     `openSync(path,'wx')` and `writeSync` got no record at all, and neither
 *     knob is consulted without one, so it unlinked a live lock and also
 *     printed `ok`. That is what this suite failed on twice that day (Windows
 *     Node 22, Linux Node 24: 2 of 6 children `ok`). The claim holds now
 *     because an unparseable file is stale by `mtime` alone; the deterministic
 *     unit coverage for that rule is `tests/git/landing-lock.test.js`.
 *
 * Temp repos only — never the user's repository.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  acquireLandingLock,
  buildLandingLockKey,
  getLandingLockPath,
  readLandingLock,
  releaseLandingLock,
} from '../../lib/git/landing-lock.js';
import { composeScopedKey } from '../../lib/git/repo-identity.js';
import {
  integrationBranchName,
  landBatch,
  summarizeCheckRuns,
  waitForGreen,
} from '../../lib/git/batch-landing.js';
import { runGit } from '../../lib/git/merge-preflight.js';

const execFileAsync = promisify(execFile);
// Anchored to THIS file, not to process.cwd(). The child processes below import
// this path, so a cwd-relative `path.resolve` made the race test depend on where
// the runner was launched from: `npx vitest` at the repo root resolves the
// workspace to plugins/artibot but leaves cwd at the repo root, so the path came
// out as <repo>/lib/git/landing-lock.js and the children died with
// ERR_MODULE_NOT_FOUND (measured 2026-08-30: 1 failed | 15 passed). The specifier
// is deliberately the same '../../lib/git/landing-lock.js' the static import at
// the top of this file uses, so the two can never drift to different modules.
const LOCK_MODULE = fileURLToPath(new URL('../../lib/git/landing-lock.js', import.meta.url));

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

/** Push an empty-change commit onto origin/main from the work clone (the "other writer"). */
function moveOriginMain() {
  git(['fetch', '--quiet', 'origin', 'main'], work);
  const tip = git(['rev-parse', 'FETCH_HEAD'], work);
  const tree = git(['rev-parse', `${tip}^{tree}`], work);
  const sha = git(['commit-tree', tree, '-p', tip, '-m', 'other writer'], work);
  git(['push', '--quiet', 'origin', `${sha}:refs/heads/main`], work);
  return sha;
}

function originTip(branch) {
  try {
    return git(['rev-parse', '--verify', `refs/heads/${branch}`], origin);
  } catch {
    return null;
  }
}

const GREEN = { total_count: 1, check_runs: [{ status: 'completed', conclusion: 'success' }] };
const instant = { pollMs: 0, sleep: async () => {} };

beforeAll(() => {
  root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'artibot-landing-'));
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

describe('landing lock key', () => {
  it('is a single string with / and : sanitised, by the same rule as the feature lock', () => {
    expect(buildLandingLockKey('owner/repo', 'master')).toBe('owner-repo__master');
    expect(buildLandingLockKey('git@github.com:owner/repo.git', 'feat/x')).toBe('git-github.com-owner-repo.git__feat-x');
    expect(buildLandingLockKey('owner/repo', 'master')).toBe(composeScopedKey('owner/repo', 'master'));
    expect(buildLandingLockKey('root-0123abcd', 'master')).toBe('root-0123abcd__master');
    expect(() => buildLandingLockKey('', 'master')).toThrow(TypeError);
    expect(() => buildLandingLockKey('r', '')).toThrow(TypeError);
    expect(() => buildLandingLockKey('///', 'master')).toThrow(TypeError);
  });

  it('two repos with the same branch get different keys; the lock file name has no separators', () => {
    const a = buildLandingLockKey('owner/a', 'master');
    const b = buildLandingLockKey('owner/b', 'master');
    expect(a).not.toBe(b);
    expect(path.basename(getLandingLockPath(a, lockDir))).not.toMatch(/[/:\\]/);
    expect(getLandingLockPath(a, lockDir).endsWith('.landing.lock')).toBe(true);
  });
});

describe('O_EXCL mutual exclusion', () => {
  it('second acquire on the same key is refused with the holder; release needs the token', () => {
    const key = buildLandingLockKey('owner/repo', 'master');
    const first = acquireLandingLock(key, { lockDir, sessionId: 's1' });
    expect(first.ok).toBe(true);
    const second = acquireLandingLock(key, { lockDir, sessionId: 's2' });
    expect(second.ok).toBe(false);
    expect(second.holder?.sessionId).toBe('s1');
    expect(second.holder?.pid).toBe(process.pid);

    expect(releaseLandingLock(key, { lockDir, token: 'wrong' })).toBe(false);
    expect(readLandingLock(key, { lockDir })?.token).toBe(first.token);
    expect(releaseLandingLock(key, { lockDir, token: first.token })).toBe(true);
    expect(readLandingLock(key, { lockDir })).toBeNull();

    const third = acquireLandingLock(key, { lockDir, sessionId: 's3' });
    expect(third.ok).toBe(true);
    releaseLandingLock(key, { lockDir, token: third.token });
  });

  it('different keys do not exclude each other', () => {
    const a = acquireLandingLock(buildLandingLockKey('owner/a', 'master'), { lockDir });
    const b = acquireLandingLock(buildLandingLockKey('owner/b', 'master'), { lockDir });
    expect(a.ok && b.ok).toBe(true);
    releaseLandingLock(buildLandingLockKey('owner/a', 'master'), { lockDir, token: a.token });
    releaseLandingLock(buildLandingLockKey('owner/b', 'master'), { lockDir, token: b.token });
  });

  it('reclaims a holder whose record is older than staleMs (injected clock)', () => {
    const key = buildLandingLockKey('owner/stale', 'master');
    let t = 1_000_000;
    const now = () => t;
    const first = acquireLandingLock(key, { lockDir, now, staleMs: 1000 });
    expect(first.ok).toBe(true);
    t += 500;
    expect(acquireLandingLock(key, { lockDir, now, staleMs: 1000 }).ok).toBe(false);
    t += 600;
    const reclaimed = acquireLandingLock(key, { lockDir, now, staleMs: 1000 });
    expect(reclaimed.ok).toBe(true);
    expect(reclaimed.reclaimed).toBe(true);
    // The evicted holder's late release must not remove the new holder's lock.
    expect(releaseLandingLock(key, { lockDir, token: first.token })).toBe(false);
    expect(readLandingLock(key, { lockDir })?.token).toBe(reclaimed.token);
    releaseLandingLock(key, { lockDir, token: reclaimed.token });
  });

  it('reclaims a same-host holder whose pid is dead (injected liveness)', () => {
    const key = buildLandingLockKey('owner/dead', 'master');
    const first = acquireLandingLock(key, { lockDir });
    expect(first.ok).toBe(true);
    const r = acquireLandingLock(key, { lockDir, isPidAlive: () => false });
    expect(r.ok).toBe(true);
    expect(r.reclaimed).toBe(true);
    releaseLandingLock(key, { lockDir, token: r.token });
  });

  it('real child processes racing on one key: exactly one wins', async () => {
    const key = buildLandingLockKey('owner/race', 'master');
    // Reclaim is DISABLED inside the children (`isPidAlive` always true,
    // `staleMs` a day) so the only way a child can print "ok" is to be the one
    // whose `openSync(path, 'wx')` created the file. Without this the test
    // measured spawn timing, not exclusion: a child that arrives after the
    // winner has exited sees a dead pid and legitimately reclaims. Observed
    // 6/6 "ok" at 21:48 (children strictly sequential) and 2/6 "ok" at 22:18
    // and 22:40 under full-suite load (spawn stagger > the 2.5s hold the
    // first fix used). Reclaim itself is covered by the two tests above.
    //
    // The children report reclaim SEPARATELY from exclusion. Both were once
    // printed as "ok", so the 2-of-6 CI failures on 2026-09-04 could not say
    // whether `O_EXCL` had broken or a reclaim had fired — it was the latter,
    // through the empty-file window (`landing-lock.js` module header). A
    // "reclaimed" here now means the staleness rule leaked, not that two
    // processes got a descriptor from `wx`.
    const script = [
      `const m = await import(${JSON.stringify(pathToFileURL(LOCK_MODULE).href)});`,
      `const r = m.acquireLandingLock(${JSON.stringify(key)}, { lockDir: ${JSON.stringify(lockDir)}, staleMs: 86_400_000, isPidAlive: () => true });`,
      'process.stdout.write(r.reclaimed ? "reclaimed" : (r.ok ? "ok" : "held"));',
    ].join('\n');
    const n = 6;
    const results = await Promise.all(
      Array.from({ length: n }, () =>
        execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
          encoding: 'utf-8',
          windowsHide: true,
        }).then((r) => r.stdout.trim()),
      ),
    );
    // No child may reclaim: with a day-long `staleMs` and a live pid there is
    // no legitimate stale path, so a "reclaimed" is the defect, reported as
    // itself instead of masquerading as a second `wx` winner.
    expect(results.filter((x) => x === 'reclaimed')).toHaveLength(0);
    expect(results.filter((x) => x === 'ok')).toHaveLength(1);
    expect(results.filter((x) => x === 'held')).toHaveLength(n - 1);
    // The winner's pid is now dead; the parent (default reclaim rules) takes it back.
    const after = acquireLandingLock(key, { lockDir });
    expect(after.ok).toBe(true);
    expect(after.reclaimed).toBe(true);
    releaseLandingLock(key, { lockDir, token: after.token });
  });
});

describe('waitForGreen (port of release.yml wait_for_green)', () => {
  it('summarises check runs like the jq filters', () => {
    expect(summarizeCheckRuns(null)).toEqual({ total: 0, pending: 0, failed: 0 });
    expect(summarizeCheckRuns({
      total_count: 3,
      check_runs: [
        { status: 'completed', conclusion: 'success' },
        { status: 'in_progress', conclusion: null },
        { status: 'completed', conclusion: 'failure' },
      ],
    })).toEqual({ total: 3, pending: 1, failed: 1 });
  });

  it('is fail-closed without a fetcher, red on failure, green only when nothing is pending', async () => {
    expect((await waitForGreen('x', {})).green).toBe(false);
    const red = await waitForGreen('x', {
      ...instant,
      fetchCheckRuns: async () => ({ total_count: 1, check_runs: [{ status: 'completed', conclusion: 'failure' }] }),
    });
    expect(red.green).toBe(false);
    expect(red.polls).toBe(1);
    let calls = 0;
    const eventually = await waitForGreen('x', {
      ...instant,
      attempts: 5,
      fetchCheckRuns: async () => {
        calls += 1;
        if (calls < 3) return { total_count: 0, check_runs: [] };
        return GREEN;
      },
    });
    expect(eventually.green).toBe(true);
    expect(eventually.polls).toBe(3);
    const ceiling = await waitForGreen('x', { ...instant, attempts: 2, fetchCheckRuns: async () => null });
    expect(ceiling.green).toBe(false);
    expect(ceiling.reason).toMatch(/within 2 polls/);
  });

  it('integration branch name is prefixed and branch-safe', () => {
    expect(integrationBranchName('team-split-abc:1')).toBe('ci/split-team-split-abc-1');
    expect(() => integrationBranchName('///')).toThrow(TypeError);
  });
});

describe('landBatch against a local bare remote', () => {
  const common = () => ({
    cwd: work,
    limbs: ['L1', 'L3'],
    base: 'main',
    remote: 'origin',
    repoIdentity: 'owner/repo',
    lockDir,
    wait: instant,
  });

  it('happy path: one push, green, fast-forward; lock released', async () => {
    const before = originTip('main');
    let polls = 0;
    const r = await landBatch({ ...common(), runId: 'happy', fetchCheckRuns: async () => { polls += 1; return GREEN; } });
    expect(r.status).toBe('landed');
    expect(r.rebuilds).toBe(0);
    expect(r.base).toBe(before);
    expect(polls).toBe(1);
    expect(originTip('main')).toBe(r.sha);
    expect(originTip('ci/split-happy')).toBe(r.sha);
    expect(git(['show', `${r.sha}:h.txt`], origin)).toBe('z');
    expect(readLandingLock(buildLandingLockKey('owner/repo', 'main'), { lockDir })).toBeNull();
    // Shared checkout untouched.
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], work)).toBe('main');
    expect(git(['status', '--porcelain'], work)).toBe('');
  });

  it('base moved once while waiting → rebuild on the new base, force-with-lease, land (rebuilds=1)', async () => {
    let moved = null;
    let polls = 0;
    const r = await landBatch({
      ...common(),
      runId: 'moved-once',
      fetchCheckRuns: async () => {
        polls += 1;
        if (polls === 1) moved = moveOriginMain();
        return GREEN;
      },
    });
    expect(r.status).toBe('landed');
    expect(r.rebuilds).toBe(1);
    expect(polls).toBe(2);
    expect(r.base).toBe(moved);
    expect(originTip('main')).toBe(r.sha);
    // The rebuilt batch descends from the moved tip, not the stale one.
    expect(git(['merge-base', '--is-ancestor', moved, r.sha], origin)).toBe('');
    expect(r.log.some((l) => /moved .* while waiting/.test(l))).toBe(true);
  });

  it('base keeps moving → exactly one rebuild, then needs-human with the branch left for a person', async () => {
    const r = await landBatch({
      ...common(),
      runId: 'moved-twice',
      fetchCheckRuns: async () => { moveOriginMain(); return GREEN; },
    });
    expect(r.status).toBe('needs-human');
    expect(r.rebuilds).toBe(1);
    expect(originTip('main')).not.toBe(r.sha);
    expect(originTip('ci/split-moved-twice')).toBe(r.sha);
    expect(readLandingLock(buildLandingLockKey('owner/repo', 'main'), { lockDir })).toBeNull();
  });

  it('lock held by another landing → locked, nothing pushed', async () => {
    const key = buildLandingLockKey('owner/repo', 'main');
    const held = acquireLandingLock(key, { lockDir, sessionId: 'other' });
    const r = await landBatch({ ...common(), runId: 'locked', fetchCheckRuns: async () => GREEN });
    expect(r.status).toBe('locked');
    expect(r.holder?.sessionId).toBe('other');
    expect(originTip('ci/split-locked')).toBeNull();
    releaseLandingLock(key, { lockDir, token: held.token });
  });

  it('old git → degraded (serial), nothing pushed', async () => {
    const exec = (args, opts) => (args[0] === '--version'
      ? { status: 0, stdout: 'git version 2.37.0\n', stderr: '' }
      : runGit(args, opts));
    const r = await landBatch({ ...common(), runId: 'old-git', exec, fetchCheckRuns: async () => GREEN });
    expect(r.status).toBe('degraded');
    expect(r.reason).toMatch(/serial/);
    expect(originTip('ci/split-old-git')).toBeNull();
  });

  it('no check-run source → not-green, branch pushed but base untouched', async () => {
    const before = originTip('main');
    const r = await landBatch({ ...common(), runId: 'no-ci' });
    expect(r.status).toBe('not-green');
    expect(originTip('main')).toBe(before);
    expect(originTip('ci/split-no-ci')).toBe(r.sha);
  });
});
