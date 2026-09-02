/**
 * `scripts/split/watch.mjs` — pure helpers plus two end-to-end runs:
 * an empty parent (everything missing, exit 0) and a temp git repo with one
 * finished limb (trailer read, health `done`), both with `--store-dir` under
 * `os.tmpdir()` so the real `runtime/split/` is never written.
 *
 * Not covered: a live session lock with a living pid (needs a running
 * `claude --worktree`), and `ListAgents` — the dashboard does not use it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collect,
  fmtAge,
  parseArgs,
  parseLocks,
  renderNotice,
  renderTable,
  resolveLimbs,
} from '../../scripts/split/watch.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'split', 'watch.mjs');

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

describe('pure helpers', () => {
  it('parseArgs', () => {
    const a = parseArgs(['--json', '--run-id', 'r1', '--parent', 'C:/p', '--store-dir', 'C:/s']);
    expect(a).toEqual({ json: true, runId: 'r1', parent: path.resolve('C:/p'), storeDir: path.resolve('C:/s') });
    expect(parseArgs([]).storeDir).toBe(undefined);
  });

  it('resolveLimbs: plan limbs first (branch/worktreePath kept), run.json bare names derive the branch, no duplicates', () => {
    const plan = { limbs: [{ limb: 'a', branch: 'worktree-split-repo-a', worktreePath: 'C:/w/a' }, { limb: 'b' }] };
    const run = { limbs: ['a', 'c', 'Bad/Name', 7] };
    expect(resolveLimbs(plan, run, 'repo')).toEqual([
      { limb: 'a', branch: 'worktree-split-repo-a', worktreePath: 'C:/w/a' },
      { limb: 'b', branch: null, worktreePath: null },
      { limb: 'c', branch: 'worktree-split-repo-c', worktreePath: null },
      { limb: 'Bad/Name', branch: 'worktree-split-repo-Bad-Name', worktreePath: null },
    ]);
    expect(resolveLimbs(null, { limbs: ['x'] }, '')).toEqual([{ limb: 'x', branch: null, worktreePath: null }]);
  });

  it('parseLocks reads lock reason and pid per worktree', () => {
    const text = [
      'worktree C:/r', 'HEAD abc', 'branch refs/heads/master', '',
      'worktree C:/r/.claude/worktrees/x', 'HEAD def', 'branch refs/heads/worktree-x', 'locked claude session x-1a (pid 4242)', '',
      'worktree C:/r/.claude/worktrees/y', 'HEAD 123', 'branch refs/heads/worktree-y', 'locked', '',
    ].join('\n');
    const m = parseLocks(text);
    const key = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
    expect(m.get(key('C:/r'))).toEqual({ locked: false, reason: null, pid: null });
    expect(m.get(key('C:/r/.claude/worktrees/x'))).toEqual({ locked: true, reason: 'claude session x-1a (pid 4242)', pid: 4242 });
    expect(m.get(key('C:/r/.claude/worktrees/y'))).toEqual({ locked: true, reason: null, pid: null });
    expect(parseLocks(null).size).toBe(0);
  });

  it('fmtAge / renderTable / renderNotice keep null as null and 미측정', () => {
    expect(fmtAge(null)).toBe('-');
    expect(fmtAge(59 * 60000)).toBe('59m');
    expect(fmtAge(125 * 60000)).toBe('2h 5m');
    const table = renderTable([{ limb: 'a', ops: 'active', supervisor: '-', complete: 'no/no-trailer', lastCommit: '3m', heartbeat: '-', health: 'unknown' }]);
    expect(table.split('\n')).toHaveLength(3);
    expect(table).toContain('| a    | active    | -          | no/no-trailer   | 3m          | -         | unknown |');
    const empty = { segments: [], unpaired: [], totalMs: null, humanWaitMs: null, humanWaitPct: null };
    const n = renderNotice(empty, null, 50);
    expect(n.verdict).toBe('미측정');
    expect(n.text).toContain('humanWaitPct=null');
    expect(renderNotice({ ...empty, humanWaitPct: 51, humanWaitMs: 1, totalMs: 2 }, 'T', 50).verdict).toBe('초과');
    expect(renderNotice({ ...empty, humanWaitPct: 49, humanWaitMs: 1, totalMs: 2 }, 'T', 50).verdict).toBe('미만');
    expect(renderNotice({ ...empty, humanWaitPct: 49, humanWaitMs: 1, totalMs: 2 }, 'T', null).verdict).toBe('미측정');
  });
});

describe('end to end', () => {
  /** @type {string} */ let empty = '';
  /** @type {string} */ let repo = '';
  /** @type {string} */ let storeDir = '';

  beforeAll(() => {
    empty = mkdtempSync(path.join(os.tmpdir(), 'watch-empty-'));
    storeDir = mkdtempSync(path.join(os.tmpdir(), 'watch-store-'));
    repo = mkdtempSync(path.join(os.tmpdir(), 'watch-repo-'));
    git(['init', '-q', '-b', 'master'], repo);
    git(['config', 'user.email', 't@example.com'], repo);
    git(['config', 'user.name', 't'], repo);
    git(['config', 'commit.gpgsign', 'false'], repo);
    writeFileSync(path.join(repo, 'a.txt'), 'base\n');
    git(['add', 'a.txt'], repo);
    git(['commit', '-q', '-m', 'base'], repo);
    git(['checkout', '-q', '-b', 'worktree-split-repo-a'], repo);
    writeFileSync(path.join(repo, 'a.txt'), 'limb\n');
    git(['commit', '-q', '-am', 'feat: limb a\n\nSplit-Limb: done'], repo);
    git(['checkout', '-q', 'master'], repo);
    mkdirSync(path.join(repo, '.artibot', 'split'), { recursive: true });
    writeFileSync(path.join(repo, '.artibot', 'split', 'plan.json'), JSON.stringify({
      runId: 'split-watch1', base: 'master', repoShort: 'repo',
      limbs: [{ limb: 'a', branch: 'worktree-split-repo-a' }, { limb: 'b', branch: 'worktree-split-repo-b' }],
    }));
    writeFileSync(path.join(repo, '.artibot', 'split', 'run.json'), JSON.stringify({
      runId: 'split-watch1', lanes: { a: { state: 'closing' }, b: 'awaiting-dispatch' },
    }));
  });
  afterAll(() => {
    for (const d of [empty, storeDir, repo]) rmSync(d, { recursive: true, force: true });
  });

  it('empty parent: exit 0, says what is missing, prints the table header and the notice', () => {
    const out = execFileSync(process.execPath, [SCRIPT, '--parent', empty, '--store-dir', storeDir], { encoding: 'utf-8', windowsHide: true });
    expect(out).toContain('runId 미확인');
    expect(out).toContain('missing: plan.json; run.json; runId (pass --run-id)');
    expect(out).toContain('| limb | ops state | supervisor |');
    expect(out).toContain('humanWaitPct=null');
    expect(out).toContain('→ 미측정');
    expect(existsSync(path.join(storeDir, 'undefined.state.json'))).toBe(false);
  });

  it('temp repo: trailer → complete/done, ops states from run.json, state.json written under --store-dir only', async () => {
    const r = await collect({ parent: repo, runId: null, storeDir, nowMs: Date.now() });
    expect(r.runId).toBe('split-watch1');
    expect(r.missing).toEqual([]);
    expect(r.run.state).toBe('CREATED');
    expect(r.run.statePath).toBe(path.join(storeDir, 'split-watch1.state.json'));
    expect(existsSync(r.run.statePath)).toBe(true);
    const a = r.lanes.find((l) => l.limb === 'a');
    const b = r.lanes.find((l) => l.limb === 'b');
    expect(a).toMatchObject({ opsState: 'closing', complete: true, reason: 'done', supervisorState: null, sessionPresent: null });
    expect(a.health.health).toBe('done');
    expect(typeof a.lastCommitAt).toBe('string');
    expect(a.lastCommitAgeMs).toBeGreaterThanOrEqual(0);
    expect(b).toMatchObject({ opsState: 'awaiting-dispatch', complete: false, reason: 'no-branch', lastCommitAt: null, heartbeatAt: null });
    expect(b.health.health).toBe('unknown');
    expect(r.notice.verdict).toBe('미측정');
    expect(existsSync(path.join(PLUGIN_ROOT, 'runtime', 'split', 'split-watch1.state.json'))).toBe(false);

    const json = execFileSync(process.execPath, [SCRIPT, '--json', '--parent', repo, '--store-dir', storeDir], { encoding: 'utf-8', windowsHide: true });
    const parsed = JSON.parse(json);
    expect(parsed.lanes.map((l) => [l.limb, l.health.health])).toEqual([['a', 'done'], ['b', 'unknown']]);
    const text = execFileSync(process.execPath, [SCRIPT, '--parent', repo, '--store-dir', storeDir], { encoding: 'utf-8', windowsHide: true });
    expect(text).toContain('| a    | closing           |');
    expect(text).toContain('yes/done');
    expect(text).toContain('(state cache written:');
  });
});
