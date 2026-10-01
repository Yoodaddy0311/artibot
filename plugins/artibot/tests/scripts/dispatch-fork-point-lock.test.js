/**
 * `scripts/split/dispatch.mjs#recordForkPoint` x `plan.json.lock` (SH-11 pre-flip condition 3).
 *
 * Every `plan.json` write now runs under `withFileLock(plan.json)`, and `recordForkPoint` is the caller that
 * runs on EVERY dispatch, key on or off. This file pins what dispatch does when that lock cannot be had:
 *   - the lock's wait budget runs out (`ELOCKTIMEOUT`): the fork point stays UNRECORDED and is REPORTED, the
 *     same class as a git failure — dispatch's job is the brief, and an unrecorded fork point costs `land` a
 *     fallback to `plan.base`, not the run. `value` is null on purpose, so the window is told `plan.base`
 *     (what `land` falls back to), never a base `land` will not use. A later dispatch retries;
 *   - anything else out of the plan write is a fault and still THROWS (the catch is one code wide).
 *
 * `tests/scripts/split-tools.test.js` owns the fork point's git half; this file is separate because that
 * file is already over a thousand lines and the stem rule gives `dispatch*` its own coverage file.
 *
 * What these cases cannot see (rules §9): the held lock is a HAND-WRITTEN record (this pid, this host, a stamp
 * that cannot age out), not a second process racing the dispatch — the cross-process behaviour of
 * `updatePlanJson` is measured in `tests/git/split-run-file.test.js` and
 * `tests/topology/split-state-bind-race.test.js`. A holder slower than the lock's stale threshold (10 s) is
 * reclaimed by the lock module, not reported here. The ~2 s wait is the lock module's own budget and is not
 * asserted. Measured on this Windows host only; POSIX is unmeasured.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withFileLock } from '../../lib/core/file-lock.js';
import { forkPointForLimb, readPlanJson, readRunJson } from '../../lib/git/split-run-file.js';
import * as dispatch from '../../scripts/split/dispatch.mjs';

const tmpDirs = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const git = (cwd, ...args) => execFileSync('git', args, { cwd, windowsHide: true, timeout: 15000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

/** The feeder is not under test; injecting it also keeps a host session id out of the run (it would reach the real store). */
const noFeed = () => ({ fed: false, skipped: 'not-under-test' });

/** A parent root with plan.json and one limb brief; the limb's worktree is a git repo with one commit on `main`. */
function seedParent(limb = 'auth') {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-dispatch-forklock-'));
  tmpDirs.push(parent);
  const splitDir = path.join(parent, '.artibot', 'split');
  const worktreePath = path.join(parent, '.claude', 'worktrees', `split-demo-${limb}`);
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.mkdirSync(path.join(splitDir, limb), { recursive: true });
  fs.writeFileSync(path.join(splitDir, limb, 'brief.md'), `# ${limb}\n\n## 소유 파일 allowlist\n- src/${limb}\n\n## 완료 기준\n- tests\n`);
  fs.writeFileSync(path.join(splitDir, 'plan.json'), JSON.stringify({
    runId: 'split-abc123',
    parentRoot: parent,
    repoShort: 'demo',
    base: 'deadbeef',
    parentSession: 'demo-a1',
    limbs: [{ limb, worktreePath, branch: `worktree-split-demo-${limb}`, affectedPaths: [`src/${limb}`] }],
  }, null, 2));

  git(worktreePath, 'init', '-q', '-b', 'main');
  git(worktreePath, 'config', 'user.email', 'b@example.invalid');
  git(worktreePath, 'config', 'user.name', 'B');
  git(worktreePath, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(worktreePath, 'f.txt'), 'x\n');
  git(worktreePath, 'add', 'f.txt');
  git(worktreePath, 'commit', '-q', '-m', 'init');
  return { parent, worktreePath, head: git(worktreePath, 'rev-parse', 'HEAD').trim() };
}

const planPathOf = (parent) => path.join(parent, '.artibot', 'split', 'plan.json');
const runPathOf = (parent) => path.join(parent, '.artibot', 'split', 'run.json');

describe('dispatch.mjs recordForkPoint — plan.json.lock', () => {
  it('a lock that outlasts the wait budget leaves the fork point UNRECORDED and the dispatch intact; the next dispatch retries', async () => {
    const { parent, head } = seedParent();
    const lockPath = `${planPathOf(parent)}.lock`;
    // What a live process writes: neither of the lock module's stale rules (dead pid on this host, older than 10 s)
    // applies, so dispatch waits out the real budget and does not take the lock over. The stamp is dated an hour
    // ahead so no machine load can age it past the 10 s threshold between this line and the acquire.
    const held = JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'held-by-the-test', timestamp: Date.now() + 3_600_000 });
    fs.writeFileSync(lockPath, held);
    const planBefore = fs.readFileSync(planPathOf(parent));

    const out = [];
    const code = await dispatch.main(['auth', '--json'], { cwd: parent, config: null, feedLimb: noFeed, stdout: (s) => out.push(s), stderr: (s) => out.push(s) });
    expect(code, out.join('')).toBe(0); // reported, not thrown
    const r = JSON.parse(out.join(''));

    expect(r.forkPoint).toMatchObject({ value: null, recorded: false, ref: 'main' });
    expect(r.forkPoint.reason).toMatch(/plan\.json lock not acquired/);
    expect(r.forkPoint.reason).toContain(head); // names the fork point it could not record...
    expect(r.forkPoint.reason).toContain('(via main)');
    expect(r.forkPoint.reason).toMatch(/not acquired within \d+ms/); // ...and carries the lock module's own message

    // Nothing was recorded, and the holder's lock is exactly as it was: never stolen, never removed.
    expect(fs.readFileSync(planPathOf(parent))).toEqual(planBefore);
    expect(forkPointForLimb(readPlanJson(parent), 'auth')).toBeNull();
    expect(fs.readFileSync(lockPath, 'utf-8')).toBe(held);

    // The window is told plan.base — the base `land` will fall back to — not the fork point that was not recorded.
    const prompt = fs.readFileSync(r.promptPath, 'utf-8');
    expect(prompt).toContain('base=deadbeef');
    expect(prompt).not.toContain(`base=${head}`);
    expect(r.pointer).toContain('(base: deadbeef)');

    // The rest of the dispatch ran.
    expect(r.copied).toBe(true);
    expect(readRunJson(parent).lanes.auth.state).toBe('active');

    // CONTROL: the holder lets go and the very same dispatch records — so the refusal above was the lock, not the fixture.
    fs.rmSync(lockPath);
    const retry = await dispatch.runDispatch(dispatch.parseArgs(['auth']), { cwd: parent, config: null, feedLimb: noFeed });
    expect(retry.forkPoint).toEqual({ value: head, recorded: true, reason: null, ref: 'main' });
    expect(forkPointForLimb(readPlanJson(parent), 'auth')).toBe(head);
    expect(retry.prompt).toContain(`base=${head}`);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('any other plan write failure stays loud: a re-entrant plan.json lock rejects the dispatch and nothing is written', async () => {
    const { parent, worktreePath } = seedParent();
    const planBefore = fs.readFileSync(planPathOf(parent));

    // ELOCKREENTRANT needs no clock: this process already holds plan.json.lock, so the nested `updatePlanJson` is
    // refused at once (a logic error, not contention). `runDispatch` has no `await` before it records the fork
    // point, so its synchronous prefix reaches `updatePlanJson` while the lock is held here.
    let pending = null;
    withFileLock(planPathOf(parent), () => {
      pending = dispatch.runDispatch(dispatch.parseArgs(['auth']), { cwd: parent, config: null, feedLimb: noFeed });
    });
    await expect(pending).rejects.toMatchObject({ code: 'ELOCKREENTRANT' });

    expect(fs.readFileSync(planPathOf(parent))).toEqual(planBefore);
    expect(fs.existsSync(runPathOf(parent))).toBe(false); // no lane write
    expect(fs.existsSync(path.join(worktreePath, '.artibot'))).toBe(false); // no brief, no prompt
    expect(fs.existsSync(`${planPathOf(parent)}.lock`)).toBe(false); // and the caller's own lock was released
  });
});
