/**
 * `scripts/orca/close.mjs` — the guards that run before any deleting command is
 * PRINTED (DESIGN §4.4 close, §10 change 4, §11.6).
 *
 * WHAT THIS PROVES, on real disk: a landed limb passes landing -> report copy ->
 * junction teardown (the real `worktree-setup.mjs --teardown` child process, over
 * a real NTFS junction) -> reparse point 0 -> clean tree, and only then are the
 * commands output; the junction's TARGET survives the teardown (the parent's
 * dependencies); every failure stops at its own step with no deleting line
 * printed; and nothing here ever calls Orca (the executor sees git only).
 *
 * The replay note printed with the commands quotes facts MEASURED in P0 (the
 * first `worktree rm` failing with Permission denied, a retry with different
 * flags being refused, an identical-flag replay succeeding); the last block pins
 * that wording to the real receipts `wt-a-rm-force.json`, `wt-a-rm-retry.json`
 * and `wt-a-rm-retry2.json`, so a refreshed fixture that disagrees turns it red.
 *
 * WHAT IT CANNOT PROVE: that Orca's removal behaves that way today (the script
 * never runs it — the receipts are the evidence), what an npm-installed
 * `node_modules` (not a junction) does to the walk, a worktree with tens of
 * thousands of files (the cap is exercised with a tiny limit), or a UI deletion
 * done by the user instead of this flow — which no script can stop.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeOrcaRun } from '../../lib/git/orca-run-file.js';
import { copyReport, findReparsePoints, main, parseArgs, runClose } from '../../scripts/orca/close.mjs';
import { defaultExec, runWorktreeSetup, toPosix } from '../../scripts/orca/status.mjs';

// Git-heavy: each case spawns many git processes; alone the file passes in under a minute, but with sibling lanes running vitest
// one case hit the 30 s default (2026-11-19) - same budget raise as tests/commands/usage-table-steps.test.js.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'receipts');
const SCRIPT = path.resolve(HERE, '..', '..', 'scripts', 'orca', 'close.mjs');
const RUN_ID = 'run_3c01547fc37f';
const REPO_ID = 'd56eb7c9-5a43-4fcf-8c27-05cfbf914642';

const receipt = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf-8'));

// ── real git and disk ───────────────────────────────────────────────────────

const GIT_ENV = {
  ...process.env, GIT_AUTHOR_NAME: 'tester', GIT_AUTHOR_EMAIL: 'tester@example.test', GIT_COMMITTER_NAME: 'tester', GIT_COMMITTER_EMAIL: 'tester@example.test',
};
const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, env: GIT_ENV, encoding: 'utf-8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const roots = [];
const tempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
};

// A git checkout root with no run.json: the --parent guard needs a repo, so 'run.json absent' is then the reason reported.
const emptyRepo = () => {
  const dir = tempDir('orca-empty-');
  git(dir, 'init', '-q', '-b', 'master');
  return dir;
};

const NODE_MODULES = ['plugins', 'artibot', 'node_modules'];
const contractDir = (root, limb) => path.join(root, '.artibot', 'split', limb);

/** Parent repo: ignores node_modules and the contract folder like the real repo, owns a node_modules with a sentinel. */
function makeWorld() {
  const root = tempDir('orca-cl-');
  const repo = path.join(root, 'repo');
  git(root, 'init', '-q', '-b', 'master', repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.artibot/\n');
  git(repo, 'add', '.gitignore');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'update-ref', 'refs/remotes/origin/master', base);
  fs.mkdirSync(path.join(repo, ...NODE_MODULES), { recursive: true });
  fs.writeFileSync(path.join(repo, ...NODE_MODULES, 'sentinel.txt'), 'parent dependency\n');
  return { root, repo, base };
}

/** A limb worktree with the node_modules junction in place, a report.md, and `commits` empty commits. */
function addLimb(world, name, { commits = 1, trailer = 'done', junction = true, report = `report of ${name}\n` } = {}) {
  const branch = `orca/${name}-a1b2c3`;
  const wt = path.join(world.root, `wt-${name}`);
  git(world.repo, 'worktree', 'add', '-q', '-b', branch, wt, world.base);
  for (let i = 0; i < commits; i += 1) {
    git(wt, 'commit', '-q', '--allow-empty', '-m', `${name} work ${i}`, ...(i === commits - 1 && trailer ? ['-m', `Split-Limb: ${trailer}`] : []));
  }
  if (junction) {
    fs.mkdirSync(path.join(wt, 'plugins', 'artibot'), { recursive: true });
    fs.symlinkSync(path.join(world.repo, ...NODE_MODULES), path.join(wt, ...NODE_MODULES), 'junction');
  }
  if (report !== null) {
    fs.mkdirSync(contractDir(wt, name), { recursive: true });
    fs.writeFileSync(path.join(contractDir(wt, name), 'report.md'), report);
  }
  return { name, branch, wt, forkPoint: world.base, link: path.join(wt, ...NODE_MODULES) };
}

function land(world, branch) {
  git(world.repo, 'merge', '--no-ff', '-q', '-m', `land ${branch}`, branch);
  git(world.repo, 'update-ref', 'refs/remotes/origin/master', git(world.repo, 'rev-parse', 'HEAD'));
}

const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

/**
 * Teardown runner. On Windows the REAL `worktree-setup.mjs --teardown` child runs over a real NTFS junction — the
 * platform where that was measured. Elsewhere a stand-in unlinks the same slot: the shipped teardown removes the link
 * with `rmdirSync`, which POSIX answers with ENOTDIR for a symlink to a directory. That has not been measured on a POSIX
 * host from here, so this suite does not lean on it (a follow-up for whoever targets Linux); the guards of close.mjs
 * itself are platform-independent and run everywhere.
 */
function standInTeardown(worktreePath) {
  const link = path.join(worktreePath, ...NODE_MODULES);
  if (!isLink(link)) return { ok: true, rows: [{ kind: 'skip', status: 'skipped', target: link, detail: 'absent' }], error: null };
  fs.unlinkSync(link);
  return { ok: true, rows: [{ kind: 'unlink', status: 'done', target: link, detail: 'unlinked (stand-in)' }], error: null };
}
const TEARDOWN = process.platform === 'win32' ? runWorktreeSetup : standInTeardown;

const dispatch = (dispatchId, taskId, kind = 'initial') => ({ dispatchId, taskId, kind, at: '2026-11-19T04:10:00.000Z' });

const boundRow = (made, dispatches = []) => ({
  limb: made.name, taskIds: [made.name], affectedPaths: ['src/**'], deps: [], worktreeId: `${REPO_ID}::${toPosix(made.wt)}`,
  worktreePath: made.wt, branch: made.branch, forkPoint: made.forkPoint, dispatches,
});

function writeRun(world, rows) {
  const written = writeOrcaRun(world.repo, {
    schema_version: 1, provider: 'orca', runId: RUN_ID, tag: 'a1b2c3', objective: 'p0 replay', integrationRef: 'origin/master',
    createdAt: '2026-11-19T04:00:00.000Z', orca: { appVersion: '1.4.259', environment: 'local', repoId: REPO_ID }, limbs: rows,
  });
  expect(written).toMatchObject({ ok: true });
}

/** Executor that records what it was asked and refuses to be Orca. */
function spyExec() {
  const calls = [];
  const exec = (file, args, options) => {
    calls.push({ file, args });
    return defaultExec(file, args, options);
  };
  return { exec, calls };
}

let world;
let L; // the limbs, by scenario

beforeAll(() => {
  world = makeWorld();
  L = {
    landed: addLimb(world, 'lim-landed', { commits: 2 }),
    unlanded: addLimb(world, 'lim-unlanded'),
    empty: addLimb(world, 'lim-empty', { commits: 0 }),
    dirty: addLimb(world, 'lim-dirty'),
    foreign: addLimb(world, 'lim-foreign'),
    abandon: addLimb(world, 'lim-abandon', { trailer: 'wip' }),
    bare: addLimb(world, 'lim-bare', { trailer: 'wip' }),
    nodir: addLimb(world, 'lim-nodir', { junction: false, report: null }),
    gone: addLimb(world, 'lim-gone', { junction: false, report: null }),
    failing: addLimb(world, 'lim-failing'),
    nl: addLimb(world, 'lim-nl'), // run.json tampered: a newline inside a dispatch id
    sq: addLimb(world, 'lim-sq', { trailer: 'wip' }), // run.json tampered: a typographic quote inside a task id
    nm: addLimb(world, 'lim-nm'), // a real node_modules (not the link slot) holding links: direct and scoped children
  };
  for (const key of ['landed', 'dirty', 'foreign', 'nodir', 'gone', 'failing', 'nl', 'nm']) land(world, L[key].branch);
  fs.mkdirSync(path.join(L.nm.wt, 'tools', 'node_modules', '@scope'), { recursive: true });
  fs.symlinkSync(path.join(world.repo, ...NODE_MODULES), path.join(L.nm.wt, 'tools', 'node_modules', 'pkg-link'), 'junction');
  fs.symlinkSync(path.join(world.repo, ...NODE_MODULES), path.join(L.nm.wt, 'tools', 'node_modules', '@scope', 'scoped-link'), 'junction');
  fs.writeFileSync(path.join(L.dirty.wt, 'scratch.txt'), 'uncommitted work\n');
  fs.mkdirSync(path.join(L.foreign.wt, 'tools'), { recursive: true });
  fs.symlinkSync(path.join(world.repo, ...NODE_MODULES), path.join(L.foreign.wt, 'tools', 'link'), 'junction');
  git(world.repo, 'worktree', 'remove', '--force', L.nodir.wt);
  git(world.repo, 'worktree', 'remove', '--force', L.gone.wt);
  git(world.repo, 'branch', '-q', '-d', L.gone.branch);
  writeRun(world, [
    boundRow(L.landed, [dispatch('ctx_9e272959985a', 'task_49c93a4972cb'), dispatch('ctx_b895e0547dac', 'task_01dcf3b9c698', 'rework')]),
    boundRow(L.unlanded, [dispatch('ctx_bba48a83896e', 'task_873e6cb5afb2')]),
    boundRow(L.empty, [dispatch('ctx_e759f8cefc88', 'task_dfa5c850df6a')]),
    boundRow(L.dirty, [dispatch('ctx_111111111111', 'task_111111111111')]),
    boundRow(L.foreign, [dispatch('ctx_222222222222', 'task_222222222222')]),
    boundRow(L.abandon, [dispatch('ctx_129e44009de5', 'task_9fbf30ff0a5d')]),
    boundRow(L.bare, []),
    boundRow(L.nodir, [dispatch('ctx_333333333333', 'task_333333333333')]),
    boundRow(L.gone, [dispatch('ctx_444444444444', 'task_444444444444')]),
    boundRow(L.failing, [dispatch('ctx_555555555555', 'task_555555555555')]),
    boundRow(L.nl, [dispatch('ctx_bad\nrelease', 'task_666666666666')]),
    boundRow(L.sq, [dispatch('ctx_777777777777', 'task_7\u{201C}77')]),
    boundRow(L.nm, [dispatch('ctx_888888888888', 'task_888888888888')]),
    { limb: 'lim-unbound', taskIds: ['lim-unbound'], affectedPaths: [], deps: [], worktreeId: null, worktreePath: null, branch: null, forkPoint: null, dispatches: [] },
  ]);
}, 180_000);

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

const args = (limb, extra = {}) => ({ ok: true, limb, abandon: false, parent: null, json: false, help: false, ...extra });
const close = (limb, { abandon = false, deps = {} } = {}) => {
  const spy = spyExec();
  const result = runClose(args(limb, { abandon }), { cwd: world.repo, exec: spy.exec, runSetup: TEARDOWN, ...deps });
  return { result, calls: spy.calls };
};
const stepNames = (result) => result.checks.map((c) => `${c.name}:${c.ok ? 'PASS' : 'FAIL'}`);

// ── argv ────────────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('limb · --abandon · --parent · --json 을 읽는다', () => {
    expect(parseArgs(['lim-a', '--abandon', '--parent', 'p', '--json'])).toMatchObject({ ok: true, limb: 'lim-a', abandon: true, parent: 'p', json: true });
    expect(parseArgs(['--help'])).toMatchObject({ ok: true, help: true });
  });

  it.each([
    [[], 'missing <limb>'],
    [['a', 'b'], 'unexpected argument'],
    [['a', '--force'], 'unknown option'],
    [['a', '--parent'], 'requires a value'],
  ])('거부 %j', (argv, fragment) => {
    const r = parseArgs(argv);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(fragment);
  });
});

// ── the happy path, on real disk ────────────────────────────────────────────

describe('착지한 줄기 — 모든 guard 통과 뒤에만 명령을 낸다', () => {
  let first;
  let calls;

  beforeAll(() => {
    ({ result: first, calls } = close('lim-landed'));
  });

  it('guard 는 landing → report → teardown → reparse → clean 순서로 전부 PASS', () => {
    expect(first.ok).toBe(true);
    expect(stepNames(first)).toEqual(['landing:PASS', 'report:PASS', 'teardown:PASS', 'reparse:PASS', 'clean:PASS']);
    expect(first.checks[0].detail).toContain('착지 확인');
  });

  it('junction 은 제거됐고 그 대상(부모의 node_modules)은 멀쩡하다', () => {
    expect(isLink(L.landed.link)).toBe(false);
    expect(fs.existsSync(L.landed.link)).toBe(false);
    expect(fs.readFileSync(path.join(world.repo, ...NODE_MODULES, 'sentinel.txt'), 'utf-8')).toBe('parent dependency\n');
  });

  it('report.md 는 삭제 명령이 나오기 전에 부모의 오케스트레이션 폴더로 복사됐다', () => {
    const copied = path.join(world.repo, '.artibot', 'orca', 'lim-landed', 'report.md');
    expect(fs.readFileSync(copied, 'utf-8')).toBe('report of lim-landed\n');
    expect(first.checks[1].report).toMatchObject({ status: 'copied', path: copied });
  });

  it('명령: dispatch 마다 worker-release(최신 먼저) 뒤에 worktree rm — 선택자는 id:<worktreeId>', () => {
    expect(first.commands).toHaveLength(3);
    expect(first.commands[0]).toBe('orca orchestration worker-release --dispatch ctx_b895e0547dac');
    expect(first.commands[1]).toBe('orca orchestration worker-release --dispatch ctx_9e272959985a');
    expect(first.commands[2]).toContain('orca worktree rm --worktree');
    expect(first.commands[2]).toContain(`id:${REPO_ID}::${toPosix(L.landed.wt)}`);
    expect(first.commands[2]).toContain('--delete-branch --json');
  });

  it('검증 명령 3개(git 등록 · 브랜치 · Orca 목록)와 replay 안내를 함께 낸다', () => {
    expect(first.verify).toHaveLength(3);
    expect(first.verify[0]).toContain('git worktree list --porcelain');
    expect(first.verify[1]).toContain(`git branch --list ${L.landed.branch}`);
    expect(first.verify[2]).toContain('orca worktree list');
    expect(first.onFailure).toContain('종료코드를 믿지 말고');
    expect(first.onFailure).toContain('같은 플래그로 1회만');
  });

  it('이 스크립트는 아무것도 지우지 않는다 — worktree 와 브랜치는 그대로, Orca 는 한 번도 부르지 않았다', () => {
    expect(fs.existsSync(L.landed.wt)).toBe(true);
    expect(git(world.repo, 'rev-parse', '--verify', `refs/heads/${L.landed.branch}`)).toMatch(/^[0-9a-f]{40}$/);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.file === 'git')).toBe(true);
  });

  it('다시 실행해도 같은 결과 — 멱등 (같은 report 는 already-copied)', () => {
    const { result: again } = close('lim-landed');
    expect(again.ok).toBe(true);
    expect(again.checks[1].report.status).toBe('already-copied');
    expect(again.commands).toEqual(first.commands);
  });

  it('worker 가 report 를 고쳐 다시 쓰면 덮어쓰지 않고 report-2.md 로 보존한다', () => {
    fs.writeFileSync(path.join(contractDir(L.landed.wt, 'lim-landed'), 'report.md'), 'second report\n');
    const { result: again } = close('lim-landed');
    expect(again.checks[1].report.status).toBe('copied');
    const dir = path.join(world.repo, '.artibot', 'orca', 'lim-landed');
    expect(fs.readFileSync(path.join(dir, 'report.md'), 'utf-8')).toBe('report of lim-landed\n');
    expect(fs.readFileSync(path.join(dir, 'report-2.md'), 'utf-8')).toBe('second report\n');
  });
});

// ── every failure stops at its own step ─────────────────────────────────────

describe('실패는 자기 step 에서 멈추고 삭제 명령을 내지 않는다', () => {
  it('미착지(done · origin/master 에 없음) → landing 에서 멈춘다 — 부작용 0 (junction · report 그대로)', () => {
    const { result } = close('lim-unlanded');
    expect(result.ok).toBe(false);
    expect(stepNames(result)).toEqual(['landing:FAIL']);
    expect(result.error).toContain('done-unlanded');
    expect(result.error).toContain('git fetch origin');
    expect(result.commands).toBeUndefined();
    expect(isLink(L.unlanded.link)).toBe(true);
    expect(fs.existsSync(path.join(world.repo, '.artibot', 'orca', 'lim-unlanded'))).toBe(false);
  });

  it('커밋 0 인 줄기는 조상 검사가 참이어도 닫지 않는다 (no-commits)', () => {
    const { result } = close('lim-empty');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('커밋이 없다');
    expect(isLink(L.empty.link)).toBe(true);
  });

  it('커밋되지 않은 변경 → teardown 뒤 clean 에서 멈춘다 (report 는 이미 안전하게 복사됨)', () => {
    const { result } = close('lim-dirty');
    expect(result.ok).toBe(false);
    expect(stepNames(result)).toEqual(['landing:PASS', 'report:PASS', 'teardown:PASS', 'reparse:PASS', 'clean:FAIL']);
    expect(result.error).toContain('scratch.txt');
    expect(result.error).toContain('삭제하면 사라진다');
    expect(result.error).toContain('teardown 이 이미 junction 을 제거했다');
    expect(result.error).toContain('bind.mjs worktree 를 다시 실행(멱등)해 junction 을 복구한다');
    expect(fs.existsSync(path.join(world.repo, '.artibot', 'orca', 'lim-dirty', 'report.md'))).toBe(true);
    expect(fs.existsSync(path.join(L.dirty.wt, 'scratch.txt'))).toBe(true);
  });

  it('설정에 없는 junction 이 남아 있으면 reparse 에서 닫힌다 — 대상은 건드리지 않았다', () => {
    const { result } = close('lim-foreign');
    expect(result.ok).toBe(false);
    expect(stepNames(result)).toEqual(['landing:PASS', 'report:PASS', 'teardown:PASS', 'reparse:FAIL']);
    expect(result.error).toContain('reparse point 가 남아 있다');
    expect(result.error).toContain('tools/link');
    expect(fs.existsSync(path.join(world.repo, ...NODE_MODULES, 'sentinel.txt'))).toBe(true);
  });

  it('teardown 이 거부/실패하면 그 step 에서 닫는다 (주입한 실패)', () => {
    const runSetup = () => ({ ok: false, rows: [{ kind: 'refuse', status: 'refused', target: 'x', detail: 'not a reparse point' }], error: 'refuse x: not a reparse point' });
    const { result } = close('lim-failing', { deps: { runSetup } });
    expect(result.ok).toBe(false);
    expect(stepNames(result)).toEqual(['landing:PASS', 'report:PASS', 'teardown:FAIL']);
    expect(result.error).toContain('not a reparse point');
    expect(isLink(L.failing.link)).toBe(true);
  });

  it('설정에 없는 node_modules 안의 직계·@scope 링크는 reparse 에서 닫힌다 — 이전에는 node_modules 내부를 안 봐서 통과했다 (SR-2 음성 대조)', () => {
    const { result } = close('lim-nm');
    expect(result.ok).toBe(false);
    expect(stepNames(result)).toEqual(['landing:PASS', 'report:PASS', 'teardown:PASS', 'reparse:FAIL']);
    expect(result.error).toContain('reparse point 가 남아 있다(2)');
    expect(result.error).toContain('tools/node_modules/pkg-link');
    expect(result.error).toContain('tools/node_modules/@scope/scoped-link');
  });

  it('탐색 상한을 넘으면 reparse point 0 을 증명하지 못한 것으로 닫는다 (작은 상한으로 검증)', () => {
    const { result } = close('lim-failing', { deps: { maxWalkEntries: 1 } });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('증명하지 못했다');
  });

  it('worktree 폴더가 없고 브랜치만 남은 착지 줄기는 teardown·reparse·clean 을 건너뛰고 명령은 낸다', () => {
    const { result } = close('lim-nodir');
    expect(result.ok).toBe(true);
    expect(stepNames(result)).toEqual(['landing:PASS', 'report:PASS', 'teardown:PASS', 'reparse:PASS', 'clean:PASS']);
    expect(result.checks[2].detail).toContain('이미 없다');
    expect(result.checks[1].report.status).toBe('absent');
    expect(result.commands.some((c) => c.includes('worktree rm'))).toBe(true);
  });

  it('--parent 는 체크아웃 루트여야 한다 — 하위 폴더나 git 리포가 아니면 run.json 을 읽기 전에 거부하고 아무것도 하지 않는다', () => {
    const sub = path.join(world.repo, 'plugins', 'artibot'); // a shell whose cwd drifted into plugins/artibot
    fs.mkdirSync(sub, { recursive: true });
    const drifted = close('lim-landed', { deps: { cwd: sub } }).result;
    expect([drifted.ok, drifted.error]).toEqual([false, expect.stringContaining('체크아웃 루트여야 한다')]);
    const notRepo = close('lim-landed', { deps: { cwd: tempDir('orca-empty-') } }).result;
    expect([notRepo.ok, notRepo.error, notRepo.checks]).toEqual([false, expect.stringContaining('git 리포가 아니다'), undefined]);
  });

  it('변조된 run.json 의 id(개행 · 유니코드 따옴표)는 모든 guard 를 통과해도 명령을 내지 않는다 — 사유와 함께 거부 (SR-4)', () => {
    const landed = close('lim-nl').result;
    expect(landed).toMatchObject({ ok: false, error: expect.stringContaining('명령 줄을 안전하게 만들 수 없다') });
    expect(landed.checks.map((c) => c.ok)).toEqual([true, true, true, true, true]); // every guard passed; only the command line was refused
    expect(landed.commands).toBeUndefined();
    const abandoned = close('lim-sq', { abandon: true }).result;
    expect(abandoned).toMatchObject({ ok: false, error: expect.stringContaining('명령 줄을 안전하게 만들 수 없다') });
    expect(abandoned.commands).toBeUndefined();
  });

  it('브랜치와 worktree 가 모두 없으면 이미 닫힌 것 — 할 일이 없다', () => {
    const { result } = close('lim-gone');
    expect(result).toMatchObject({ ok: true, alreadyClosed: true, commands: [], checks: [] });
  });

  it('run.json 에 없는 줄기 · 바인딩 안 된 줄기 · run.json 없음은 ok:false', () => {
    expect(close('lim-nope').result.error).toContain('run.json 에 없다');
    expect(close('lim-unbound').result.error).toContain('바인딩되지 않았다');
    const none = runClose(args('lim-a'), { cwd: emptyRepo(), exec: defaultExec, runSetup: TEARDOWN });
    expect(none.ok).toBe(false);
    expect(none.error).toContain('run.json');
  });
});

// ── --abandon ───────────────────────────────────────────────────────────────

describe('--abandon — worktree 와 브랜치는 남기고 처분만 Orca 에 남긴다', () => {
  it('착지를 요구하지 않고 teardown · report 복사는 똑같이 하며, 명령은 task-update 하나', () => {
    const { result } = close('lim-abandon', { abandon: true });
    expect(result.ok).toBe(true);
    expect(stepNames(result)).toEqual(['landing:PASS', 'report:PASS', 'teardown:PASS', 'reparse:PASS', 'clean:PASS']);
    expect(result.checks[0].detail).toContain('--abandon');
    expect(isLink(L.abandon.link)).toBe(false);
    expect(fs.existsSync(path.join(world.repo, '.artibot', 'orca', 'lim-abandon', 'report.md'))).toBe(true);
    expect(result.commands).toEqual([`orca orchestration task-update --id task_9fbf30ff0a5d --status failed --result cancelled --run ${RUN_ID} --json`]);
    expect(result.verify).toEqual([]);
    expect(result.note).toContain('worktree 와 브랜치는 남긴다');
    expect(fs.existsSync(L.abandon.wt)).toBe(true);
    expect(git(world.repo, 'rev-parse', '--verify', `refs/heads/${L.abandon.branch}`)).toMatch(/^[0-9a-f]{40}$/);
  });

  it('미커밋 변경은 --abandon 에서는 정보일 뿐 막지 않는다', () => {
    fs.writeFileSync(path.join(L.abandon.wt, 'draft.txt'), 'half done\n');
    const { result } = close('lim-abandon', { abandon: true });
    expect(result.ok).toBe(true);
    expect(result.checks[4].detail).toContain('--abandon: 정보');
    expect(result.checks[4].detail).toContain('draft.txt');
  });

  it('시작된 워커가 없으면 Orca 에 남길 처분이 없다 — 명령 0개', () => {
    const { result } = close('lim-bare', { abandon: true });
    expect(result.ok).toBe(true);
    expect(result.commands).toEqual([]);
    expect(result.note).toContain('시작된 워커가 없다');
  });
});

// ── building blocks ─────────────────────────────────────────────────────────

describe('findReparsePoints — 실제 junction 탐지', () => {
  it('junction 을 찾되 따라 들어가지 않는다 — 일반 node_modules 는 직계 자식과 @scope 직계 자식까지만 보고, 그 아래(패키지 내부)는 들어가지 않는다 (SR-2)', () => {
    const root = tempDir('orca-walk-');
    const target = tempDir('orca-walk-target-');
    fs.writeFileSync(path.join(target, 'inside.txt'), 'x');
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', '@scope'), { recursive: true });
    fs.symlinkSync(target, path.join(root, 'node_modules', 'pkg', 'deep-link'), 'junction'); // inside a package: not entered
    fs.symlinkSync(target, path.join(root, 'node_modules', 'direct-link'), 'junction'); // node_modules/<pkg>
    fs.symlinkSync(target, path.join(root, 'node_modules', '@scope', 'scoped-link'), 'junction'); // node_modules/@<scope>/<pkg>
    fs.symlinkSync(target, path.join(root, 'a', 'b', 'link'), 'junction');
    const walk = findReparsePoints(root);
    expect(walk.found.map(toPosix).sort()).toEqual([
      toPosix(path.join(root, 'a', 'b', 'link')), toPosix(path.join(root, 'node_modules', '@scope', 'scoped-link')), toPosix(path.join(root, 'node_modules', 'direct-link')),
    ].sort());
    expect(walk.capped).toBe(false);
    expect(walk.unreadable).toEqual([]);
  });

  it('node_modules 항목 자체가 junction 이면 보고한다', () => {
    const root = tempDir('orca-walk-');
    const target = tempDir('orca-walk-target-');
    fs.symlinkSync(target, path.join(root, 'node_modules'), 'junction');
    expect(findReparsePoints(root).found).toHaveLength(1);
  });

  it('node_modules 의 자식도 같은 상한을 쓴다 — 자식이 많은 node_modules 에서 상한에 닿으면 증명 실패(capped)', () => {
    const root = tempDir('orca-walk-');
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    for (let i = 0; i < 6; i += 1) fs.mkdirSync(path.join(root, 'node_modules', `pkg${i}`));
    expect(findReparsePoints(root, { maxEntries: 4 }).capped).toBe(true);
    expect(findReparsePoints(root).capped).toBe(false);
  });

  it('상한을 넘으면 capped, 깨끗한 폴더는 found 0', () => {
    const root = tempDir('orca-walk-');
    for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x');
    expect(findReparsePoints(root, { maxEntries: 3 }).capped).toBe(true);
    expect(findReparsePoints(root).found).toEqual([]);
  });
});

describe('copyReport', () => {
  it('원본이 없으면 absent, 같은 내용은 already-copied, 다른 내용은 다음 번호로 보존', () => {
    const dir = tempDir('orca-rep-');
    const source = path.join(dir, 'report.md');
    const dest = path.join(dir, 'out');
    expect(copyReport(source, dest)).toEqual({ status: 'absent', path: null });
    fs.writeFileSync(source, 'one\n');
    expect(copyReport(source, dest).status).toBe('copied');
    expect(copyReport(source, dest).status).toBe('already-copied');
    fs.writeFileSync(source, 'two\n');
    expect(copyReport(source, dest)).toMatchObject({ status: 'copied', path: path.join(dest, 'report-2.md') });
    expect(copyReport(source, dest)).toMatchObject({ status: 'already-copied', path: path.join(dest, 'report-2.md') });
  });
});

// ── output ──────────────────────────────────────────────────────────────────

describe('main — 출력 계약', () => {
  const capture = () => {
    const out = [];
    const err = [];
    return { out, err, io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) } };
  };
  const call = (argv, extra = {}) => {
    const c = capture();
    const code = main(argv, { cwd: world.repo, exec: defaultExec, runSetup: TEARDOWN, ...c.io, ...extra });
    return { code, out: c.out.join(''), err: c.err.join('') };
  };

  it('--json 성공: 문서 1개에 checks · commands · verify', () => {
    const r = call(['lim-landed', '--json']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out);
    expect(doc).toMatchObject({ ok: true, limb: 'lim-landed', abandon: false, alreadyClosed: false });
    expect(doc.checks).toHaveLength(5);
    expect(doc.commands.at(-1)).toContain('worktree rm');
  });

  it('사람이 읽는 출력: PASS 표 · "이 스크립트는 실행하지 않았다" · $ 명령 줄 · 검증 3개', () => {
    const r = call(['lim-landed']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('[PASS] landing');
    expect(r.out).toContain('실행하지 않았다');
    expect(r.out).toContain('  $ orca worktree rm');
    expect(r.out).toContain('검증(종료코드 대신 이 3개로 판정)');
  });

  it('실패는 exit 1 + stderr 에 사유와 "삭제 명령은 출력하지 않는다", stdout 은 비어 있다', () => {
    const r = call(['lim-unlanded']);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toContain('중단');
    expect(r.err).toContain('삭제 명령은 출력하지 않는다');
    expect(r.err).not.toContain('worktree rm');
  });

  it('--json 실패는 { ok:false, error, checks }', () => {
    const doc = JSON.parse(call(['lim-empty', '--json']).out);
    expect(doc).toMatchObject({ ok: false });
    expect(doc.checks.map((c) => c.name)).toEqual(['landing']);
  });

  it('예상 못 한 예외는 스택 대신 { ok:false, error } 와 exit 1 이고 삭제 명령은 없다', () => {
    const r = call(['lim-landed', '--json'], { exec: () => { throw new Error('boom'); } });
    expect(r.code).toBe(1);
    const doc = JSON.parse(r.out);
    expect(doc).toMatchObject({ ok: false, error: 'unexpected failure: boom', checks: [] });
    expect(doc.commands).toBeUndefined();
  });

  it('인자 오류는 exit 1, --help 는 exit 0', () => {
    expect(call([]).code).toBe(1);
    expect(JSON.parse(call(['--bogus', '--json']).out)).toMatchObject({ ok: false });
    const help = call(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('guards, in order');
  });
});

describe('실제 직접 실행 — 진입 가드', () => {
  it('node close.mjs --help 는 사용법을 낸다', () => {
    expect(execFileSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf-8', windowsHide: true })).toContain('usage:');
  });

  it('run.json 이 없는 폴더에서는 exit 1 이 호출자에게 전달된다', () => {
    expect(() => execFileSync(process.execPath, [SCRIPT, 'lim-a', '--parent', tempDir('orca-empty-')], { stdio: 'pipe', windowsHide: true })).toThrow();
  });
});

// ── the replay note is the measured fact ────────────────────────────────────

describe('replay 안내의 근거 — P0 removal 영수증', () => {
  it('첫 시도는 .git/worktrees/<name> Permission denied 로 ok:false (exit 1) — 안내가 이것을 말한다', () => {
    const first = receipt('wt-a-rm-force.json');
    expect(first.ok).toBe(false);
    expect(first.error.message).toContain('Permission denied');
    expect(first.error.message).toContain('.git/worktrees/');
    const { result } = close('lim-landed');
    expect(result.onFailure).toContain('Permission denied');
  });

  it('다른 플래그로의 재시도는 Orca 가 거부, 같은 플래그의 재시도는 removed:true — 안내가 같은 플래그를 요구한다', () => {
    expect(receipt('wt-a-rm-retry.json').error.message).toContain('different branch choice');
    expect(receipt('wt-a-rm-retry2.json')).toMatchObject({ ok: true, result: { removed: true } });
    expect(receipt('wt-b-rm-1.json').ok).toBe(false);
    expect(receipt('wt-b-rm-2.json')).toMatchObject({ ok: true, result: { removed: true } });
    expect(close('lim-landed').result.onFailure).toContain('같은 플래그로 1회만');
  });

  it('비-force 삭제는 junction 대상 내용이 untracked 로 보여 거부됐다 — teardown 이 clean 확인보다 먼저인 이유', () => {
    const refusal = receipt('wt-a-rm.json');
    expect(refusal.ok).toBe(false);
    expect(refusal.error.message).toMatch(/\?\? jtest\/sentinel\.txt/);
  });
});
