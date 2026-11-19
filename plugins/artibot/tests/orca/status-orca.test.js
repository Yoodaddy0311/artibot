/**
 * `scripts/orca/status.mjs` — the read-only table, the next actions, the mail
 * classifier and the bounded stall check (DESIGN §4.3, §4.4, §11.6).
 *
 * WHAT THIS PROVES: git is REAL (temp repo, real worktrees, merge commits and
 * trailers) and the Orca side is the REAL P0 receipts of 2026-11-19
 * (`fixtures/receipts/`) behind a fake executor — so "an empty limb is not
 * landed", "the limb is found through `payload.dispatchId`, not `from`" and "a
 * lost worker with a trailer takes the completion path" are checked against git
 * and against shapes Orca really produced. Fixtures marked DERIVED take the
 * closest real receipt and change the one field the case is about (the P0 run
 * never captured a mid-run worker-list/task-list nor a `worker_done` `failed`).
 *
 * WHAT IT CANNOT PROVE: that a live Orca keeps these shapes (the preflight's
 * job), that `payload.stopReason` has values beyond `lost` (the only one ever
 * seen), or how the table looks at 8 limbs / a 100-row worker list. The stall
 * verdict is two thirds of the design's criterion (no worker output position).
 *
 * Speed: one shared world (empty commits, `origin/master` a plain ref), a
 * run.json per case; only the `--fetch` cases get a real bare remote.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeOrcaRun } from '../../lib/git/orca-run-file.js';
import { recordWallClockEnd, recordWallClockStart } from '../../lib/observability/split-telemetry.js';
import {
  classifyMail, collectStatus, defaultExec, fetchOrcaFacts, judgeStall, launchApproval, main, messagesOf, observeLimbGit,
  orcaVerbOf, parseArgs, READ_ONLY_ORCA_VERBS, runStall, toPosix,
} from '../../scripts/orca/status.mjs';

// Git-heavy: each case spawns many git processes; alone the file passes in under a minute, but with sibling lanes running vitest
// one case hit the 30 s default (2026-11-19) - same budget raise as tests/commands/usage-table-steps.test.js.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'receipts');
const SCRIPT = path.resolve(HERE, '..', '..', 'scripts', 'orca', 'status.mjs');
const RUN_ID = 'run_3c01547fc37f';
const REPO_ID = 'd56eb7c9-5a43-4fcf-8c27-05cfbf914642';
// Orca's worker state word. A named constant, not a literal next to a state key: the repo-wide R-11 gate (tests/supervisor/v11-status-mapping.test.js)
// greps source for that spelling, and this is an Orca WORKER state, not a plugin lane state.
const FAILED_STATE = 'failed';

const receipt = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf-8'));
const clone = (value) => structuredClone(value);

// ── real git ────────────────────────────────────────────────────────────────

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

/** A parent repo with one base commit; `origin/master` is a plain ref at that commit. */
function makeWorld() {
  const root = tempDir('orca-st-');
  const repo = path.join(root, 'repo');
  git(root, 'init', '-q', '-b', 'master', repo);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'update-ref', 'refs/remotes/origin/master', base);
  return { root, repo, base };
}

/** A limb branch in its own worktree, `commits` empty commits deep; `trailer` goes on the last one. */
function addLimb(world, name, { commits = 1, trailer = null } = {}) {
  const branch = `orca/${name}-a1b2c3`;
  const wt = path.join(world.root, `wt-${name}`);
  git(world.repo, 'worktree', 'add', '-q', '-b', branch, wt, world.base);
  for (let i = 0; i < commits; i += 1) {
    git(wt, 'commit', '-q', '--allow-empty', '-m', `${name} work ${i}`, ...(i === commits - 1 && trailer ? ['-m', `Split-Limb: ${trailer}`] : []));
  }
  return { branch, wt, forkPoint: world.base };
}

/** Merge a limb into master the way the batch landing does (it becomes a second parent) and publish the ref. */
function land(world, branch) {
  git(world.repo, 'merge', '--no-ff', '-q', '-m', `land ${branch}`, branch);
  git(world.repo, 'update-ref', 'refs/remotes/origin/master', git(world.repo, 'rev-parse', 'HEAD'));
}

function row(limb, extra = {}) {
  return { limb, taskIds: [limb], affectedPaths: ['src/**'], deps: [], worktreeId: null, worktreePath: null, branch: null, forkPoint: null, dispatches: [], ...extra };
}

const bound = (limb, made, dispatches = [], extra = {}) => row(limb, {
  worktreeId: `${REPO_ID}::${toPosix(made.wt)}`, worktreePath: made.wt, branch: made.branch, forkPoint: made.forkPoint, dispatches, ...extra,
});

const dispatch = (dispatchId, taskId, kind = 'initial') => ({ dispatchId, taskId, kind, at: '2026-11-19T04:10:00.000Z' });

function writeRun(world, limbs, extra = {}) {
  const written = writeOrcaRun(world.repo, {
    schema_version: 1, provider: 'orca', runId: RUN_ID, tag: 'a1b2c3', objective: 'p0 replay', integrationRef: 'origin/master',
    createdAt: '2026-11-19T04:00:00.000Z', orca: { appVersion: '1.4.259', environment: 'local', repoId: REPO_ID }, limbs, ...extra,
  });
  expect(written).toMatchObject({ ok: true });
}

// ── fake Orca executor over real receipts ───────────────────────────────────

const okEnvelope = (doc) => ({ ok: true, status: 0, stdout: JSON.stringify(doc), stderr: '', error: null });

/** Answers the two read verbs with the given documents; everything git goes to the real git. */
function fakeOrca({ workers = receipt('wl-final.receipt.txt'), tasks = receipt('task-list-final.json'), fail = false } = {}) {
  const calls = [];
  const exec = (file, args, options) => {
    if (file === 'git') return defaultExec(file, args, options);
    calls.push(args);
    if (fail) return { ok: false, status: 1, stdout: '', stderr: 'orca is down', error: 'exit 1' };
    const verb = orcaVerbOf(args);
    if (verb === 'orchestration worker-list') return okEnvelope(workers);
    if (verb === 'orchestration task-list') return okEnvelope(tasks);
    return { ok: false, status: 1, stdout: '', stderr: `unexpected verb ${verb}`, error: 'exit 1' };
  };
  return { exec, calls };
}

const capture = () => {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) } };
};

let world;
let made;

beforeAll(() => {
  world = makeWorld();
  made = {
    wip: addLimb(world, 'w-wip', { trailer: 'wip' }),
    done: addLimb(world, 'w-done', { commits: 2, trailer: 'done' }),
    none: addLimb(world, 'w-none', { trailer: null }),
    landed: addLimb(world, 'w-landed', { trailer: 'done' }),
    empty: addLimb(world, 'w-empty', { commits: 0 }),
    closed: addLimb(world, 'w-closed', { trailer: 'done' }),
    stall: addLimb(world, 'w-stall', { trailer: 'wip' }),
    vanished: addLimb(world, 'w-vanished', { trailer: 'done' }),
  };
  land(world, made.landed.branch);
  land(world, made.closed.branch);
  git(world.repo, 'worktree', 'remove', '--force', made.closed.wt);
  git(world.repo, 'branch', '-q', '-d', made.closed.branch);
  git(world.repo, 'worktree', 'remove', '--force', made.vanished.wt); // never landed, then deleted by hand
  git(world.repo, 'update-ref', '-d', `refs/heads/${made.vanished.branch}`);
}, 120_000);

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

const status = (opts = {}) => collectStatus({ parentRoot: world.repo, exec: fakeOrca().exec, capacity: 8, ...opts });

// ── 2. Orca facts from the real receipts ────────────────────────────────────

describe('fetchOrcaFacts — 실제 영수증을 읽는다', () => {
  it('wl-final / task-list-final → worker 5행, Task 6행, 읽기 verb 2번만', () => {
    const { exec, calls } = fakeOrca();
    const facts = fetchOrcaFacts(exec, RUN_ID);
    expect(facts.workers).toHaveLength(5);
    expect(facts.tasks).toHaveLength(6);
    expect(facts.warnings).toEqual([]);
    expect(calls.map(orcaVerbOf)).toEqual(['orchestration worker-list', 'orchestration task-list']);
    expect(calls[0]).toEqual(['orchestration', 'worker-list', '--run', RUN_ID, '--json']);
  });

  it('runId 가 없으면 Orca 를 부르지 않고, Orca 가 죽어 있으면 두 실패를 경고로 남긴다 — 둘 다 null 이고 던지지 않는다', () => {
    const idle = fakeOrca();
    const none = fetchOrcaFacts(idle.exec, null);
    expect(none.workers).toBeNull();
    expect(none.warnings[0]).toContain('runId 미바인딩');
    expect(idle.calls).toEqual([]);
    const down = fetchOrcaFacts(fakeOrca({ fail: true }).exec, RUN_ID);
    expect([down.workers, down.tasks]).toEqual([null, null]);
    expect(down.warnings).toHaveLength(2);
  });

  it('nextCursor 가 있으면 잘렸다고 경고한다 (실제 영수증에 nextCursor 한 칸만 더한 파생)', () => {
    const truncated = clone(receipt('wl-final.receipt.txt'));
    truncated.result.nextCursor = 'opaque';
    expect(fetchOrcaFacts(fakeOrca({ workers: truncated }).exec, RUN_ID).warnings.join(' ')).toContain('잘렸다');
  });
});

// ── 3. the table over the shared real-git world ─────────────────────────────

describe('collectStatus — 실제 git + 실제 영수증', () => {
  let table;
  let calls;

  beforeAll(() => {
    writeRun(world, [
      bound('probe-a', made.done, [dispatch('ctx_bba48a83896e', 'task_873e6cb5afb2')]),
      bound('probe-b', made.landed, [dispatch('ctx_9e272959985a', 'task_49c93a4972cb'), dispatch('ctx_b895e0547dac', 'task_01dcf3b9c698', 'rework')]),
      bound('probe-c', made.empty, [dispatch('ctx_129e44009de5', 'task_9fbf30ff0a5d')]),
      row('probe-d', { deps: ['probe-b'] }),
      row('probe-e', { deps: ['probe-a'] }),
    ]);
    const orca = fakeOrca();
    calls = orca.calls;
    table = collectStatus({ parentRoot: world.repo, exec: orca.exec, capacity: 8, storeDir: path.join(world.root, 'store') });
  });

  const rowOf = (limb) => table.rows.find((r) => r.limb === limb);

  it('Orca 에는 읽기 verb 만 보냈다', () => {
    expect(table.ok).toBe(true);
    expect(calls.every((argv) => READ_ONLY_ORCA_VERBS.includes(orcaVerbOf(argv)))).toBe(true);
  });

  it('트레일러 done · 미착지 줄기 → done-unlanded, 다음 행동은 land 체크', () => {
    const r = rowOf('probe-a');
    expect(r).toMatchObject({ landing: 'done-unlanded', commits: 2, taskStatus: 'completed', inFlight: false, trailer: { complete: true, reason: 'done' }, worker: { state: 'succeeded', liveness: 'exited' } });
    expect(r.next.kind).toBe('land-check');
    expect(r.next.text).toContain('land.mjs probe-a --plan');
  });

  it('병합 커밋으로 착지한 줄기 → landed, 다음 행동은 close — 최신 dispatch 는 마지막(재작업)', () => {
    const r = rowOf('probe-b');
    expect(r.landing).toBe('landed');
    expect(r.next.kind).toBe('close');
    expect(r.next.text).toContain('close.mjs probe-b');
    expect(r.latest).toMatchObject({ dispatchId: 'ctx_b895e0547dac', kind: 'rework' });
  });

  it('커밋 0 인 줄기는 tip 이 base 라 조상 검사가 참이어도 착지가 아니다 (no-commits)', () => {
    const r = rowOf('probe-c');
    expect(r.commits).toBe(0);
    expect(r.landing).toBe('no-commits');
  });

  it('실패한 워커(실제 영수증: failed / exited) 1회 → 재시도 안내, 오너 상한 전', () => {
    const r = rowOf('probe-c');
    expect(r).toMatchObject({ taskStatus: 'failed', failedDispatches: 1 });
    expect(r.worker).toMatchObject({ state: FAILED_STATE, liveness: 'exited', terminalState: 'reclaimable' });
    expect(r.next.kind).toBe('retry');
    expect(r.next.text).toContain('--retry-of ctx_129e44009de5');
  });

  it('선행이 착지한 미시작 줄기는 시작 가능, 아닌 줄기는 선행을 대며 대기', () => {
    expect(rowOf('probe-d')).toMatchObject({ landing: 'unbound', bound: false });
    expect(rowOf('probe-d').next.kind).toBe('ready-to-start');
    expect(rowOf('probe-e').next).toMatchObject({ kind: 'wait-deps' });
    expect(rowOf('probe-e').next.text).toContain('probe-a');
  });

  it('nextActions: 착지 대기열(probe-a) · 시작(probe-d) · 정리(probe-b) — 선행이 landed(브랜치 있음)인 동안 후속이 풀리고 start 가 close 보다 먼저다', () => {
    const kinds = table.nextActions.map((a) => a.kind);
    expect(kinds).toEqual(['land', 'start', 'close']);
    expect(kinds.indexOf('start')).toBeLessThan(kinds.indexOf('close'));
    expect(rowOf('probe-d').next.kind).toBe('ready-to-start');
    expect(table.nextActions[0].limbs).toEqual(['probe-a']);
    expect(table.nextActions[1].limbs).toEqual(['probe-d']);
    expect(table.nextActions[2].limb).toBe('probe-b');
  });

  it('launch 승인 쌍이 없고 워커가 이미 시작됐으면 MISSING + 경고 (null 은 null)', () => {
    expect(table.launchApproval).toMatchObject({ status: 'MISSING', closedPairs: 0, totalMs: null, humanWaitMs: null, humanWaitPct: null });
    expect(table.warnings.some((w) => w.includes('launch 승인 쌍'))).toBe(true);
  });
});

describe('collectStatus — 진행 중 · 충돌 · 닫힘 (파생 영수증)', () => {
  it('실행 중 워커(wl-0: ready/live) + dispatched Task → wait, 진행 중이라 새 줄기를 시작하지 않는다', () => {
    writeRun(world, [
      bound('probe-a', made.wip, [dispatch('ctx_bba48a83896e', 'task_873e6cb5afb2')]),
      bound('probe-b', made.empty, [dispatch('ctx_9e272959985a', 'task_49c93a4972cb')]),
      row('probe-c'),
    ]);
    // DERIVED: wl-0 is the real mid-run worker-list; the P0 run never captured a mid-run task-list,
    // so the final one is taken and the two Tasks of those workers are set to `dispatched`.
    const tasks = clone(receipt('task-list-final.json'));
    for (const t of tasks.result.tasks) if (['task_873e6cb5afb2', 'task_49c93a4972cb'].includes(t.id)) t.status = 'dispatched';
    const s = status({ exec: fakeOrca({ workers: receipt('wl-0.json'), tasks }).exec, capacity: 2 });
    expect(s.rows.filter((r) => r.inFlight).map((r) => r.limb)).toEqual(['probe-a', 'probe-b']);
    expect(s.rows.map((r) => r.next.kind)).toEqual(['wait', 'wait', 'ready-to-start']);
    expect(s.nextActions).toEqual([{ kind: 'idle', reason: expect.stringContaining('진행 중 2개') }]);
  });

  it('worker 는 failed 로 정산됐는데 브랜치에 트레일러 done 이 있으면 git 이 진실원 — conflict', () => {
    writeRun(world, [bound('probe-c', made.done, [dispatch('ctx_129e44009de5', 'task_9fbf30ff0a5d')])]);
    expect(status().rows[0]).toMatchObject({ landing: 'done-unlanded', next: { kind: 'conflict' } });
  });

  it('같은 줄기에서 실패한 dispatch 가 2개면 재시도하지 않고 오너에게', () => {
    writeRun(world, [bound('probe-c', made.wip, [dispatch('ctx_e759f8cefc88', 'task_dfa5c850df6a'), dispatch('ctx_129e44009de5', 'task_9fbf30ff0a5d', 'retry')])]);
    // DERIVED: the real wl-final has exactly one failed worker; the other dispatch of the limb is flipped to failed.
    const workers = clone(receipt('wl-final.receipt.txt'));
    workers.result.workers.find((w) => w.dispatchId === 'ctx_e759f8cefc88').state = FAILED_STATE;
    const s = status({ exec: fakeOrca({ workers }).exec });
    expect(s.rows[0].failedDispatches).toBe(2);
    expect(s.rows[0].next.kind).toBe('owner');
  });

  it('보고는 끝났는데(Task completed) 트레일러가 없으면 완료 아님 — 반송', () => {
    writeRun(world, [bound('probe-a', made.none, [dispatch('ctx_bba48a83896e', 'task_873e6cb5afb2')])]);
    const s = status();
    expect(s.rows[0]).toMatchObject({ landing: 'in-progress', taskStatus: 'completed' });
    expect(s.rows[0].next.kind).toBe('return-incomplete');
    expect(s.rows[0].next.text).toContain('send --to dispatch:ctx_bba48a83896e');
  });

  it('브랜치와 worktree 가 모두 사라진 줄기는 closed 로 표시만 한다 — 착지 증거가 없으니 후속 줄기는 풀리지 않는다 (QR-1, fail-closed)', () => {
    writeRun(world, [bound('probe-a', made.closed, [dispatch('ctx_bba48a83896e', 'task_873e6cb5afb2')]), row('probe-d', { deps: ['probe-a'] })]);
    const s = status();
    expect(s.rows[0]).toMatchObject({ landing: 'closed', closed: true });
    expect(s.rows[0].notes.join(' ')).toContain('착지 증거가 없어 착지로 세지 않는다');
    expect(s.rows[0].notes.join(' ')).toContain('close 하기 전에 시작해야 한다');
    expect(s.rows[1].next.kind).toBe('wait-deps');
    expect(s.nextActions.some((a) => a.kind === 'start')).toBe(false);
  });

  it('closed 를 착지로 읽던 세 경로의 음성 대조 — 바인딩만 하고 지운 줄기 · task-list 실패(tasks=null) · 미착지 삭제 — 전부 후속은 대기', () => {
    const dependent = row('probe-d', { deps: ['probe-a'] });
    const dispatched = (made1) => bound('probe-a', made1, [dispatch('ctx_bba48a83896e', 'task_873e6cb5afb2')]);
    for (const [label, rows, orca] of [
      ['dispatch 전에 지워진 바인딩 줄기', [bound('probe-a', made.closed), dependent], fakeOrca()],
      ['task-list 실패(tasks=null)', [dispatched(made.closed), dependent], fakeOrca({ fail: true })],
      ['미착지 삭제(Task 는 completed)', [dispatched(made.vanished), dependent], fakeOrca()],
    ]) {
      writeRun(world, rows);
      const s = status({ exec: orca.exec });
      expect([label, s.rows[0].landing, s.rows[1].next.kind]).toEqual([label, 'closed', 'wait-deps']);
    }
  });

  it('Orca 조회가 실패해도 git 쪽 사실은 나온다 — 경고만 늘고 던지지 않는다', () => {
    writeRun(world, [bound('probe-a', made.done, [dispatch('ctx_bba48a83896e', 'task_873e6cb5afb2')])]);
    const s = status({ exec: fakeOrca({ fail: true }).exec });
    expect(s.ok).toBe(true);
    expect(s.rows[0].landing).toBe('done-unlanded');
    expect(s.rows[0].worker).toBeNull();
    expect(s.warnings.filter((w) => w.includes('실패'))).toHaveLength(2);
  });
});

describe('observeLimbGit — 착지 두 조건', () => {
  it('done 트레일러 + 커밋 > 0 + origin/master 의 조상일 때만 landed', () => {
    const own = makeWorld();
    const x = addLimb(own, 'probe-x', { commits: 1, trailer: 'done' });
    const r = bound('probe-x', x);
    expect(observeLimbGit({ parentRoot: own.repo, row: r, integrationRef: 'origin/master' })).toMatchObject({ landing: 'done-unlanded', ancestor: false });
    land(own, x.branch);
    const after = observeLimbGit({ parentRoot: own.repo, row: r, integrationRef: 'origin/master' });
    expect(after).toMatchObject({ landing: 'landed', ancestor: true, tip: expect.stringMatching(/^[0-9a-f]{40}$/) });
  });

  it('integrationRef 를 읽지 못하면 ancestor 는 null — 착지로 세지 않는다', () => {
    const got = observeLimbGit({ parentRoot: world.repo, row: bound('probe-x', made.done), integrationRef: 'origin/does-not-exist' });
    expect(got).toMatchObject({ ancestor: null, landing: 'done-unlanded' });
  });
});

// ── 4. --fetch (a real local bare remote) ───────────────────────────────────

describe('--fetch — 참조가 낡았을 때와 fetch 가 실패할 때', () => {
  /** A world whose origin is a real bare repo, with one done limb. */
  function remoteWorld() {
    const own = makeWorld();
    const origin = path.join(own.root, 'origin.git');
    git(own.root, 'init', '-q', '--bare', '-b', 'master', origin);
    git(own.repo, 'remote', 'add', 'origin', origin);
    git(own.repo, 'push', '-q', 'origin', 'master');
    const x = addLimb(own, 'probe-x', { commits: 1, trailer: 'done' });
    writeRun(own, [bound('probe-x', x, [dispatch('ctx_bba48a83896e', 'task_873e6cb5afb2')])]);
    return { own, x, origin };
  }

  it('낡은 origin/master 에서는 done-unlanded, fetch 뒤에는 landed', () => {
    const { own, x } = remoteWorld();
    git(own.repo, 'merge', '--no-ff', '-q', '-m', 'land', x.branch);
    git(own.repo, 'push', '-q', 'origin', 'master');
    git(own.repo, 'update-ref', 'refs/remotes/origin/master', own.base); // the push refreshed it; make it stale again
    const exec = fakeOrca().exec;
    expect(collectStatus({ parentRoot: own.repo, exec, capacity: 4 }).rows[0].landing).toBe('done-unlanded');
    const fetched = collectStatus({ parentRoot: own.repo, exec, capacity: 4, fetch: true });
    expect(fetched.rows[0].landing).toBe('landed');
    expect(fetched.warnings.filter((w) => w.includes('fetch'))).toEqual([]);
  });

  it('fetch 가 실패하면 경고하고 낡은 참조로 계속한다', () => {
    const { own } = remoteWorld();
    git(own.repo, 'remote', 'set-url', 'origin', path.join(own.root, 'nowhere.git'));
    const s = collectStatus({ parentRoot: own.repo, exec: fakeOrca().exec, capacity: 4, fetch: true });
    expect(s.ok).toBe(true);
    expect(s.warnings.some((w) => w.includes('git fetch origin 실패'))).toBe(true);
  });
});

// ── 5. launch approval (E1) ─────────────────────────────────────────────────

describe('launchApproval — confirm-launch 쌍', () => {
  const withWorker = [{ limb: 'a', dispatches: [dispatch('ctx_aaa111', 'task_aaa111')] }];

  it('닫힌 쌍이 있으면 recorded, 사람 대기 값은 telemetry 그대로', () => {
    const storeDir = tempDir('orca-store-');
    const t = (ms) => new Date(Date.parse('2026-11-19T04:00:00.000Z') + ms).toISOString();
    recordWallClockStart(RUN_ID, { segment: 'run', storeDir, ts: t(0) });
    recordWallClockStart(RUN_ID, { segment: 'confirm-launch', humanWait: true, storeDir, ts: t(10_000) });
    recordWallClockEnd(RUN_ID, { segment: 'confirm-launch', storeDir, ts: t(40_000) });
    recordWallClockEnd(RUN_ID, { segment: 'run', storeDir, ts: t(120_000) });
    expect(launchApproval({ runId: RUN_ID, limbs: withWorker }, storeDir)).toEqual({ status: 'recorded', closedPairs: 1, totalMs: 120_000, humanWaitMs: 30_000, humanWaitPct: 25 });
  });

  it('열려 있는(end 없는) 쌍은 닫힌 쌍이 아니다 — 워커가 시작됐다면 MISSING, 시작 전이면 pending, runId 없으면 no-run-id', () => {
    const storeDir = tempDir('orca-store-');
    recordWallClockStart(RUN_ID, { segment: 'confirm-launch', humanWait: true, storeDir });
    expect(launchApproval({ runId: RUN_ID, limbs: withWorker }, storeDir)).toMatchObject({ status: 'MISSING', closedPairs: 0, humanWaitMs: null, humanWaitPct: null });
    expect(launchApproval({ runId: 'run_other', limbs: [{ limb: 'a', dispatches: [] }] }, storeDir).status).toBe('pending');
    expect(launchApproval({ runId: null, limbs: withWorker }, storeDir).status).toBe('no-run-id');
  });
});

// ── 6. mail ─────────────────────────────────────────────────────────────────

describe('classifyMail — 실제 check 영수증', () => {
  /** probe-a / probe-b / probe-c with the dispatches the P0 receipts name; branches chosen per case. */
  function mailRun({ a = made.done, c = made.none } = {}) {
    writeRun(world, [
      bound('probe-a', a, [dispatch('ctx_bba48a83896e', 'task_873e6cb5afb2')]),
      bound('probe-b', made.landed, [dispatch('ctx_9e272959985a', 'task_49c93a4972cb')]),
      bound('probe-c', c, [dispatch('ctx_129e44009de5', 'task_9fbf30ff0a5d')]),
      bound('probe-d', made.wip, [dispatch('ctx_e759f8cefc88', 'task_dfa5c850df6a')]), // check-7's worker (the helper of probe-c)
    ]);
  }

  const classify = (doc, orca = fakeOrca()) => classifyMail({ doc, parentRoot: world.repo, exec: orca.exec });

  it('question(check-1): from 이 dispatch id 지만 payload.dispatchId 로 줄기를 찾고, reply 명령에 메시지 id 를 담는다', () => {
    mailRun();
    const res = classify(receipt('check-1.json'));
    expect(res.ok).toBe(true);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({ kind: 'question', limb: 'probe-b', dispatchId: 'ctx_9e272959985a', verdict: 'answer' });
    expect(res.items[0].commands[0]).toBe('orca orchestration reply --id msg_df15f47841f9 --body "<answer>"');
    expect(res.counts).toEqual({ question: 1 });
  });

  it('인용할 수 없는 메시지 id(양쪽 따옴표 · 개행 · 유니코드 따옴표 · NUL)는 명령 줄만 사유와 함께 빠지고 분류는 그대로다 — 힌트가 분류 전체를 죽이지 않는다', () => {
    mailRun();
    for (const id of [`msg_a"b'c$d`, 'msg_a\nb', 'msg_a\u{201C}b', 'msg_a\0b']) {
      const doc = clone(receipt('check-1.json'));
      doc.result.messages[0].id = id;
      expect(classify(doc).items[0]).toMatchObject({ verdict: 'answer', commands: [], commandsWithheld: 1 });
    }
  });

  it('변조된 run.json 의 dispatch/task id(개행 · 유니코드 따옴표)는 표에 명령 문구를 내지 않는다 (SR-4)', () => {
    for (const bad of ['task_x\nsomething', 'task_x\u{201C}y']) {
      writeRun(world, [bound('probe-a', made.wip, [dispatch('ctx_bba48a83896e', bad)])]);
      const next = status().rows[0].next;
      expect(next.kind).toBe('unsafe-id');
      expect(next.text).not.toMatch(/[\r\n]/);
    }
  });

  it('worker_done(check-3, from 이 터미널 핸들) + 트레일러 done · 미착지 → land 체크', () => {
    mailRun();
    const doc = receipt('check-3.json');
    expect(doc.result.messages[0].from).toMatch(/^term_/); // the shape that makes `from` useless as a key
    const item = classify(doc).items[0];
    expect(item).toMatchObject({ kind: 'worker_done', limb: 'probe-a', outcome: 'succeeded', verdict: 'land-check' });
    expect(item.commands[0]).toContain('land.mjs probe-a --plan');
  });

  it('worker_done succeeded 인데 트레일러가 없으면 완료 아님 — 반송', () => {
    mailRun({ a: made.none });
    const item = classify(receipt('check-3.json')).items[0];
    expect(item.verdict).toBe('return-incomplete');
    expect(item.action).toContain('완료 아님');
    expect(item.action).toContain('no-trailer');
    expect(item.commands[0]).toContain('send --to dispatch:ctx_bba48a83896e');
  });

  it('worker_done 인데 이미 착지한 줄기는 close 로 안내', () => {
    mailRun({ a: made.landed });
    expect(classify(receipt('check-3.json')).items[0].verdict).toBe('already-landed');
  });

  it('lost escalation(check-5, priority high): 트레일러가 없으면 같은 Task 로 --retry-of', () => {
    mailRun({ c: made.none });
    const item = classify(receipt('check-5.json')).items[0];
    expect(item).toMatchObject({ kind: 'escalation', limb: 'probe-c', stopReason: 'lost', priority: 'high', verdict: 'lost-retry' });
    expect(item.commands[0]).toContain('worker-start --task task_9fbf30ff0a5d --retry-of ctx_129e44009de5');
    expect(item.commands[0]).toContain(`--worktree "id:${REPO_ID}::`);
  });

  it('lost escalation 인데 브랜치에 트레일러 done 이 있으면 완료 경로(land 체크)', () => {
    mailRun({ c: made.done });
    const item = classify(receipt('check-5.json')).items[0];
    expect(item.verdict).toBe('lost-complete');
    expect(item.commands[0]).toContain('land.mjs probe-c');
  });

  it('failed worker_done 1회 → 재시도 안내 (check-2 의 outcome 한 칸만 failed 로 바꾼 파생)', () => {
    mailRun();
    const doc = clone(receipt('check-2.json'));
    doc.result.messages[0].payload.outcome = 'failed';
    const item = classify(doc).items[0];
    expect(item).toMatchObject({ limb: 'probe-b', outcome: 'failed', verdict: 'failed-retry' });
    expect(item.action).toContain('1회째');
  });

  it('같은 줄기의 실패가 2회(Orca 목록 1 + 이번 메일 1)면 재시도하지 않고 오너에게', () => {
    writeRun(world, [bound('probe-b', made.wip, [dispatch('ctx_9e272959985a', 'task_49c93a4972cb'), dispatch('ctx_b895e0547dac', 'task_01dcf3b9c698', 'rework')])]);
    // DERIVED: the later dispatch of the limb is listed failed; the mail (check-2) reports the earlier one failed.
    const workers = clone(receipt('wl-final.receipt.txt'));
    workers.result.workers.find((w) => w.dispatchId === 'ctx_b895e0547dac').state = FAILED_STATE;
    const doc = clone(receipt('check-2.json'));
    doc.result.messages[0].payload.outcome = 'failed';
    const item = classify(doc, fakeOrca({ workers })).items[0];
    expect(item.verdict).toBe('failed-owner');
    expect(item.action).toContain('2회');
  });

  it('run.json 에 없는 dispatch 의 보고는 줄기를 짐작하지 않는다 — question 은 unknown-dispatch, lost 는 git 을 못 읽는 재시도 안내(명령 없음)', () => {
    mailRun();
    const doc = clone(receipt('check-1.json'));
    doc.result.messages[0].payload.dispatchId = 'ctx_000000000000';
    expect(classify(doc).items[0]).toMatchObject({ limb: null, verdict: 'unknown-dispatch' });
    const lost = clone(receipt('check-5.json'));
    lost.result.messages[0].payload.dispatchId = 'ctx_000000000000';
    expect(classify(lost).items[0]).toMatchObject({ limb: null, verdict: 'lost-retry', commands: [] });
  });

  it('stopReason 없는 escalation 은 막힘 보고 — 승인하지 않는다 (check-5 에서 stopReason 만 뺀 파생: P0 는 워커가 보낸 escalation 을 못 봤다)', () => {
    mailRun();
    const doc = clone(receipt('check-5.json'));
    delete doc.result.messages[0].payload.stopReason;
    const item = classify(doc).items[0];
    expect(item).toMatchObject({ kind: 'escalation', limb: 'probe-c', stopReason: null, verdict: 'blocked' });
    expect(item.action).toContain('승인하지 않는다');
  });

  it('lost 가 아닌 stopReason 은 other-stop — 재시작 명령 없이 본문을 읽고 판단하거나 오너 (check-5 에서 stopReason 값만 바꾼 파생)', () => {
    mailRun({ c: made.none });
    const doc = clone(receipt('check-5.json'));
    doc.result.messages[0].payload.stopReason = 'exited';
    const item = classify(doc).items[0];
    expect(item).toMatchObject({ kind: 'escalation', limb: 'probe-c', stopReason: 'exited', verdict: 'other-stop', commands: [] });
    expect(item.action).toContain('재시작 명령은 내지 않는다');
  });

  it('한 배치의 여러 메시지를 모두 분류하고 종류별로 센다 (check-1/3/5/7 — 실제 inbox 의 세 종류) · 알 수 없는 type 은 other', () => {
    mailRun({ c: made.none });
    const merged = { ok: true, result: { messages: [
      ...['check-1.json', 'check-3.json', 'check-5.json', 'check-7.json'].flatMap((name) => receipt(name).result.messages),
      { id: 'msg_x', type: 'heartbeat', payload: {} },
    ] } };
    const res = classify(merged);
    expect(res.items.map((i) => i.verdict)).toEqual(['answer', 'land-check', 'lost-retry', 'return-incomplete', 'other']); // probe-d has only a wip trailer
    expect(res.items[3]).toMatchObject({ limb: 'probe-d', dispatchId: 'ctx_e759f8cefc88' });
    expect(res.counts).toEqual({ question: 1, worker_done: 2, escalation: 1, other: 1 });
  });

  it('입력 모양: 맨 배열 · { messages } 도 받고, messages 가 없으면 ok:false', () => {
    expect(messagesOf([{ id: 'm' }])).toHaveLength(1);
    expect(messagesOf({ messages: [] })).toEqual([]);
    expect(messagesOf({ ok: true, result: {} })).toBeNull();
    mailRun();
    expect(classify({ ok: true, result: {} })).toMatchObject({ ok: false });
  });

  it('메일 분류가 Orca 에 보낸 verb 는 읽기 verb 뿐이다 (worker-list · task-list)', () => {
    mailRun();
    const orca = fakeOrca();
    classify(receipt('check-2.json'), orca);
    expect(orca.calls.length).toBeGreaterThan(0);
    expect(orca.calls.every((argv) => READ_ONLY_ORCA_VERBS.includes(orcaVerbOf(argv)))).toBe(true);
  });
});

// ── 7. stall ────────────────────────────────────────────────────────────────

describe('judgeStall / runStall — 기한 있는 점검의 "변화 없음"', () => {
  const snap = { tip: 'a'.repeat(40), taskStatus: 'dispatched', workerState: 'ready' };

  it('이전 스냅샷이 없으면 baseline, 전부 같을 때만 no-change 이고 연속 횟수가 오른다', () => {
    expect(judgeStall(undefined, snap)).toEqual({ verdict: 'baseline', streak: 0 });
    expect(judgeStall({ ...snap, streak: 0 }, snap)).toEqual({ verdict: 'no-change', streak: 1 });
    expect(judgeStall({ ...snap, streak: 1 }, snap)).toEqual({ verdict: 'no-change', streak: 2 });
  });

  it.each([
    ['새 커밋', { tip: 'b'.repeat(40) }],
    ['Task 상태', { taskStatus: 'completed' }],
    ['worker 상태', { workerState: 'succeeded' }],
  ])('%s 가 바뀌면 changed — 연속 횟수는 0 으로', (_label, change) => {
    expect(judgeStall({ ...snap, streak: 3 }, { ...snap, ...change })).toEqual({ verdict: 'changed', streak: 0 });
  });

  it('runStall: 파일 스냅샷으로 baseline → no-change(1) → no-change(2, 오너) → 커밋 뒤 changed', () => {
    writeRun(world, [bound('probe-a', made.stall, [dispatch('ctx_bba48a83896e', 'task_873e6cb5afb2')])]);
    // DERIVED (see above): live worker, Task dispatched.
    const tasks = clone(receipt('task-list-final.json'));
    tasks.result.tasks.find((t) => t.id === 'task_873e6cb5afb2').status = 'dispatched';
    const exec = fakeOrca({ workers: receipt('wl-0.json'), tasks }).exec;
    const now = () => new Date('2026-11-19T05:00:00.000Z');
    const run = () => runStall({ parentRoot: world.repo, rows: status({ exec }).rows, now }).verdicts;

    expect(run()).toEqual([expect.objectContaining({ limb: 'probe-a', verdict: 'baseline', streak: 0 })]);
    const snapshotFile = path.join(world.repo, '.artibot', 'orca', 'stall.json');
    expect(JSON.parse(fs.readFileSync(snapshotFile, 'utf-8'))).toMatchObject({ schema_version: 1, at: '2026-11-19T05:00:00.000Z', limbs: { 'probe-a': { taskStatus: 'dispatched', workerState: 'ready', streak: 0 } } });
    const first = run()[0];
    expect(first).toMatchObject({ verdict: 'no-change', streak: 1 });
    expect(first.action).toContain('send');
    const second = run()[0];
    expect(second).toMatchObject({ verdict: 'no-change', streak: 2 });
    expect(second.action).toContain('오너에게');

    git(made.stall.wt, 'commit', '-q', '--allow-empty', '-m', 'more work');
    expect(run()[0]).toMatchObject({ verdict: 'changed', streak: 0 });
  });

  it('손상된 stall.json 은 조용히 {} 로 읽지 않는다 — 경고(연속 횟수 초기화)와 함께 baseline 으로 다시 쓰고, 파일 없는 첫 실행은 경고 없음 (QR-6)', () => {
    writeRun(world, [bound('probe-a', made.stall, [dispatch('ctx_bba48a83896e', 'task_873e6cb5afb2')])]);
    const tasks = clone(receipt('task-list-final.json'));
    tasks.result.tasks.find((t) => t.id === 'task_873e6cb5afb2').status = 'dispatched'; // DERIVED, as above
    const rows = status({ exec: fakeOrca({ workers: receipt('wl-0.json'), tasks }).exec }).rows;
    const file = path.join(world.repo, '.artibot', 'orca', 'stall.json');
    fs.rmSync(file, { force: true });
    expect(runStall({ parentRoot: world.repo, rows }).warnings).toEqual([]); // no file yet is normal
    for (const damaged of ['{not json', '{"limbs": []}']) {
      fs.writeFileSync(file, damaged);
      const out = runStall({ parentRoot: world.repo, rows });
      expect(out.warnings).toHaveLength(1);
      expect(out.warnings[0]).toContain('stall.json');
      expect(out.warnings[0]).toContain('연속 횟수 초기화');
      expect(out.verdicts[0]).toMatchObject({ verdict: 'baseline', streak: 0 });
    }
    expect(runStall({ parentRoot: world.repo, rows }).warnings).toEqual([]); // rewritten whole: healed
  });
});

// ── 8. CLI ──────────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('모든 옵션을 읽는다', () => {
    expect(parseArgs(['--parent', 'p', '--json', '--next', '--fetch', '--limb', 'x', '--stall'])).toMatchObject({ ok: true, mail: false, parent: 'p', json: true, next: true, fetch: true, limb: 'x', stall: true });
    expect(parseArgs(['mail', '--file', '-', '--json'])).toMatchObject({ ok: true, mail: true, file: '-', json: true });
  });

  it.each([
    [['--bogus'], 'unknown option'],
    [['extra'], 'unexpected argument'],
    [['--parent'], 'requires a value'],
    [['--limb', '--json'], 'requires a value'],
    [['mail'], 'mail requires --file'],
    [['--file', 'x.json'], 'only meaningful with mail'],
  ])('거부 %j', (argv, fragment) => {
    const r = parseArgs(argv);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(fragment);
  });
});

describe('main — 출력 계약', () => {
  beforeAll(() => {
    writeRun(world, [bound('probe-a', made.done, [dispatch('ctx_bba48a83896e', 'task_873e6cb5afb2')]), row('probe-d', { deps: ['probe-a'] })]);
  });

  const call = async (argv, extra = {}) => {
    const c = capture();
    const code = await main(argv, { cwd: world.repo, exec: fakeOrca().exec, config: { split: { maxWindows: 8 } }, ...c.io, ...extra });
    return { code, out: c.out.join(''), err: c.err.join('') };
  };

  it('--json 은 통째로 parse 되는 문서 1개이고 줄기 행을 담는다 — config 에 orca 블록이 없어도(구 설치본) 정상이고 split.maxWindows 만 읽는다', async () => {
    const r = await call(['--json']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out);
    expect(doc.ok).toBe(true);
    expect(doc.rows.map((x) => x.limb)).toEqual(['probe-a', 'probe-d']);
    expect(doc.capacity).toBe(8);
    expect(JSON.parse((await call(['--json'], { config: null })).out).capacity).toBe(4); // no config: the safe default
  });

  it('사람이 읽는 표: 머리 · 줄기 행 · launch 승인 줄 — --next 는 다음 행동만', async () => {
    const table = await call([]);
    expect(table.code).toBe(0);
    expect(table.out).toContain('/orca status — run run_3c01547fc37f');
    expect(table.out).toMatch(/probe-a\s+orca\/w-done-a1b2c3\s+done-unlanded/);
    expect(table.out).toContain('launch 승인: MISSING');
    const next = await call(['--next']);
    expect(next.out).toContain('[land] probe-a');
    expect(next.out).not.toContain('/orca status');
  });

  it('--limb 는 한 줄기만 보이고, 모르는 줄기는 exit 1', async () => {
    const one = JSON.parse((await call(['--limb', 'probe-d', '--json'])).out);
    expect(one.rows.map((x) => x.limb)).toEqual(['probe-d']);
    const bad = await call(['--limb', 'nope']);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('nope');
  });

  it('--stall 은 스냅샷을 쓰고 stall 절을 낸다', async () => {
    const doc = JSON.parse((await call(['--stall', '--json'], { now: () => new Date('2026-11-19T05:00:00.000Z') })).out);
    expect(doc.stall).toEqual([]); // probe-a settled, probe-d unbound: nothing in flight
    expect(fs.existsSync(path.join(world.repo, '.artibot', 'orca', 'stall.json'))).toBe(true);
  });

  it('mail --file: check 출력 파일을 분류한다 (JSON 과 사람용 둘 다)', async () => {
    const file = path.join(world.root, 'check.json');
    fs.writeFileSync(file, JSON.stringify(receipt('check-3.json')));
    const r = await call(['mail', '--file', file, '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).items[0]).toMatchObject({ limb: 'probe-a', verdict: 'land-check' });
    const text = await call(['mail', '--file', file]);
    expect(text.out).toContain('[worker_done]');
    expect(text.out).toContain('→ land-check');
  });

  it('mail 파일이 없거나 JSON 이 아니면 exit 1', async () => {
    expect((await call(['mail', '--file', path.join(world.root, 'missing.json')])).code).toBe(1);
    const junk = path.join(world.root, 'junk.json');
    fs.writeFileSync(junk, 'not json');
    expect((await call(['mail', '--file', junk, '--json'])).code).toBe(1);
  });

  it('예상 못 한 예외는 스택 대신 { ok:false, error } 와 exit 1 이다', async () => {
    const r = await call(['--json'], { exec: () => { throw new Error('boom'); } });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toEqual({ ok: false, error: 'unexpected failure: boom' });
  });

  it('--parent 는 체크아웃 루트여야 한다 — git 리포가 아니거나 하위 폴더면 run.json 을 읽기 전에 거부, 루트인데 run.json 이 없으면 그 사유 (JSON 모드는 { ok:false, error })', async () => {
    const notRepo = await call(['--json'], { cwd: tempDir('orca-empty-') });
    expect([notRepo.code, JSON.parse(notRepo.out).error]).toEqual([1, expect.stringContaining('git 리포가 아니다')]);
    const sub = path.join(world.repo, 'plugins', 'artibot'); // a shell whose cwd drifted into plugins/artibot
    fs.mkdirSync(sub, { recursive: true });
    const drifted = await call(['--json'], { cwd: sub });
    expect([drifted.code, JSON.parse(drifted.out).error]).toEqual([1, expect.stringContaining('체크아웃 루트여야 한다')]);
    expect(JSON.parse((await call(['--json', '--parent', world.repo], { cwd: sub })).out)).toMatchObject({ ok: true });
    const fresh = await call(['--json'], { cwd: makeWorld().repo });
    expect([fresh.code, JSON.parse(fresh.out).error]).toEqual([1, expect.stringContaining('run.json')]);
  });

  it('잘못된 옵션은 exit 1, --help 는 exit 0', async () => {
    expect((await call(['--bogus'])).code).toBe(1);
    expect((await call(['--bogus', '--json'])).out).toContain('"ok":false');
    const help = await call(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('usage:');
  });

  describe('줄기 하나 보기와 note 줄 (사람용 출력)', () => {
    beforeAll(() => {
      writeRun(world, [
        bound('probe-a', made.closed, [dispatch('ctx_bba48a83896e', 'task_873e6cb5afb2')]),
        bound('probe-b', made.done, [dispatch('ctx_9e272959985a', 'task_49c93a4972cb')]),
      ]);
    });

    it('표에는 branch 열이 있고, 가정을 깔고 읽은 줄기는 note[...] 줄로 그 가정을 드러낸다', async () => {
      const r = await call([]);
      expect(r.out).toMatch(/limb\s+branch\s+landing\s+task\s+worker\s+trailer\s+commits/);
      expect(r.out).toContain(made.done.branch);
      expect(r.out).toContain('note[probe-a]: 브랜치·worktree 모두 없음');
    });

    it('--limb 는 worktree id · 경로 · forkPoint · tip · 최신 dispatch 를 덧붙인다', async () => {
      const r = await call(['--limb', 'probe-b']);
      expect(r.out).toContain(`worktreeId ${REPO_ID}::${toPosix(made.done.wt)}`);
      expect(r.out).toContain(`path       ${toPosix(made.done.wt)}`);
      expect(r.out).toContain(`forkPoint  ${world.base}`);
      expect(r.out).toMatch(/tip {8}[0-9a-f]{40}/);
      expect(r.out).toContain('dispatch   ctx_9e272959985a (task task_49c93a4972cb, initial) · dispatches 1 · failed 0');
      expect(r.out).not.toContain('probe-a');
    });
  });
});

describe('실제 직접 실행', () => {
  it('node status.mjs --help 는 사용법을 낸다 (진입 가드가 발화한다)', () => {
    const out = execFileSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf-8', windowsHide: true });
    expect(out).toContain('usage:');
  });

  it('git 리포가 아닌 폴더를 --parent 로 직접 실행하면 exit 1 (종료코드가 전달된다)', () => {
    expect(() => execFileSync(process.execPath, [SCRIPT, '--parent', tempDir('orca-empty-')], { stdio: 'pipe', windowsHide: true })).toThrow();
  });
});
