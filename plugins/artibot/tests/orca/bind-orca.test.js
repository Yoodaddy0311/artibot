/**
 * `scripts/orca/bind.mjs` and `templates/orca/PROMPT-TEMPLATE.md` — what is
 * recorded about a worktree Orca created, how it is equipped, and what the
 * worker is told (DESIGN §4.3, §4.4-7, §4.5, §10 change 8, §11.6).
 *
 * WHAT THIS PROVES: on a real git worktree, with the real `worktree-setup.mjs`
 * child process making a real junction, `bind worktree` records worktree id,
 * path, branch (without `refs/heads/`) and a write-once fork point; copies the
 * brief byte-exactly; renders a prompt with no unresolved placeholder; prints
 * the next command; refuses the main checkout, a branch the session hook would
 * relocate, a HEAD that already carries commits, and a second worktree for the
 * same limb; and only ever asks Orca a read verb. The Orca receipt it is fed is
 * the REAL `worktree show` receipt of 2026-11-19 with its environment fields
 * (id, path, head, branch) replaced by the temp worktree's — marked DERIVED.
 *
 * THE TEMPLATE has no document gate watching it (the design calls it a blind
 * spot, G8), so this file is its gate: the required sentences, the placeholder
 * set, no hidden characters, no pre-baked model id, no literal contract-folder
 * path, and agreement with the REAL Orca worker preamble fixture.
 *
 * WHAT IT CANNOT PROVE: that a worker obeys the template (behaviour, not text),
 * that the `[artibot:...]` hook behaviour on a worker prompt matches the /split
 * window (not measured), what a failed `worker-start` receipt looks like (the P0
 * run has none), or a worktree under a path with non-ASCII characters.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readOrcaRun, writeOrcaRun } from '../../lib/git/orca-run-file.js';
import { PROMPT_PLACEHOLDERS } from '../../lib/git/split-brief.js';
import {
  bindWorktree, ID_PATTERN, installLimbContract, main, parseArgs, RELOCATABLE_BRANCH_NAME, renderWorkerPrompt, TEMPLATE_PATH,
} from '../../scripts/orca/bind.mjs';
import { defaultExec, runWorktreeSetup, toPosix } from '../../scripts/orca/status.mjs';

// Git-heavy: each case spawns many git processes; alone the file passes in under a minute, but with sibling lanes running vitest
// one case hit the 30 s default (2026-11-19) - same budget raise as tests/commands/usage-table-steps.test.js.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');
const FIXTURES = path.join(HERE, 'fixtures', 'receipts');
const SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'orca', 'bind.mjs');
const RUN_ID = 'run_3c01547fc37f';
const REPO_ID = 'd56eb7c9-5a43-4fcf-8c27-05cfbf914642';

const receipt = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf-8'));
const clone = (value) => structuredClone(value);
const readText = (...parts) => fs.readFileSync(path.join(...parts), 'utf-8');

const BRIEF = ['# 줄기 brief', '', '## 소유 파일 allowlist', '- src/a/**', '', '## 비소유', '- 그 밖 전부', '', '## 완료 기준', '- 표적 테스트 통과', ''].join('\n');

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

// A git checkout root with no run.json: the --parent guard needs a repo, so 'run.json absent' is then the reason reported.
const emptyRepo = () => {
  const dir = tempDir('orca-empty-');
  git(dir, 'init', '-q', '-b', 'master');
  return dir;
};

const NODE_MODULES = ['plugins', 'artibot', 'node_modules'];
const contractDir = (root, limb) => path.join(root, '.artibot', 'split', limb);
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

let world;
let seq = 0;

/** A fresh worktree on its own branch, forked from the base commit. */
function addWorktree(branchName, { commits = 0 } = {}) {
  seq += 1;
  const wt = path.join(world.root, `wt-${seq}`);
  const branch = branchName ?? `orca/lim-${seq}-a1b2c3`;
  git(world.repo, 'worktree', 'add', '-q', '-b', branch, wt, world.base);
  for (let i = 0; i < commits; i += 1) git(wt, 'commit', '-q', '--allow-empty', '-m', `own work ${i}`);
  return { wt, branch, head: git(wt, 'rev-parse', 'HEAD') };
}

function limbRow(limb, extra = {}) {
  return { limb, taskIds: [limb], affectedPaths: ['src/a/**'], deps: [], worktreeId: null, worktreePath: null, branch: null, forkPoint: null, dispatches: [], ...extra };
}

function writeRun(limbs, extra = {}) {
  const written = writeOrcaRun(world.repo, {
    schema_version: 1, provider: 'orca', runId: RUN_ID, tag: 'a1b2c3', objective: 'bind test', integrationRef: 'origin/master',
    createdAt: '2026-11-19T04:00:00.000Z', orca: { appVersion: '1.4.259', environment: 'local', repoId: REPO_ID }, limbs, ...extra,
  });
  expect(written).toMatchObject({ ok: true });
}

const readRun = () => {
  const read = readOrcaRun(world.repo);
  expect(read.ok).toBe(true);
  return read.run;
};
const rowOf = (limb) => readRun().limbs.find((l) => l.limb === limb);

function writeBrief(limb, text = BRIEF) {
  fs.mkdirSync(contractDir(world.repo, limb), { recursive: true });
  fs.writeFileSync(path.join(contractDir(world.repo, limb), 'brief.md'), text);
}

// ── fake Orca over the real `worktree show` receipt ─────────────────────────

/** DERIVED: the real wt-a-show receipt with id / path / head / branch replaced by the temp worktree's. */
function showReceipt(made, overrides = {}) {
  const doc = clone(receipt('wt-a-show.json'));
  const p = toPosix(made.wt);
  const wt = doc.result.worktree;
  Object.assign(wt, { id: `${REPO_ID}::${p}`, path: p, head: made.head, branch: `refs/heads/${made.branch}`, displayName: path.basename(p), ...overrides });
  wt.git = { ...wt.git, path: wt.path, head: wt.head, branch: wt.branch };
  return doc;
}

function fakeOrca(respond) {
  const calls = [];
  const exec = (file, args, options) => {
    if (file === 'git') return defaultExec(file, args, options);
    calls.push(args);
    return respond(args);
  };
  return { exec, calls };
}

const okEnvelope = (doc) => ({ ok: true, status: 0, stdout: JSON.stringify(doc), stderr: '', error: null });
const showing = (made, overrides) => fakeOrca(() => okEnvelope(showReceipt(made, overrides)));

const CONFIG = JSON.parse(readText(PLUGIN_ROOT, 'artibot.config.json'));

const baseDeps = (exec, extra = {}) => ({
  cwd: world.repo, exec, runSetup: runWorktreeSetup, now: () => new Date('2026-11-19T05:00:00.000Z'), templatePath: TEMPLATE_PATH,
  contractSource: path.join(PLUGIN_ROOT, 'commands', 'team.md'), ...extra,
});

const wtArgs = (limb, selector, extra = {}) => ({ ok: true, sub: 'worktree', limb, selector, brief: null, parent: null, json: false, help: false, ...extra });

const capture = () => {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) } };
};

const cli = async (argv, extra = {}) => {
  const c = capture();
  const code = await main(argv, { cwd: world.repo, exec: defaultExec, runSetup: runWorktreeSetup, config: CONFIG, now: () => new Date('2026-11-19T05:00:00.000Z'), ...c.io, ...extra });
  return { code, out: c.out.join(''), err: c.err.join('') };
};

beforeAll(() => {
  world = { root: tempDir('orca-bd-') };
  world.repo = path.join(world.root, 'repo');
  git(world.root, 'init', '-q', '-b', 'master', world.repo);
  fs.writeFileSync(path.join(world.repo, '.gitignore'), 'node_modules/\n.artibot/\n');
  git(world.repo, 'add', '.gitignore');
  git(world.repo, 'commit', '-q', '-m', 'base');
  world.base = git(world.repo, 'rev-parse', 'HEAD');
  git(world.repo, 'update-ref', 'refs/remotes/origin/master', world.base);
  fs.mkdirSync(path.join(world.repo, ...NODE_MODULES), { recursive: true });
  fs.writeFileSync(path.join(world.repo, ...NODE_MODULES, 'sentinel.txt'), 'parent dependency\n');
}, 60_000);

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

// ── argv ────────────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('세 서브커맨드의 올바른 형태', () => {
    expect(parseArgs(['run', '--run-id', RUN_ID])).toMatchObject({ ok: true, sub: 'run', runId: RUN_ID });
    expect(parseArgs(['worktree', 'lim-a', '--worktree', `id:${REPO_ID}::C:/x`, '--brief', 'b.md', '--json'])).toMatchObject({ ok: true, sub: 'worktree', limb: 'lim-a', brief: 'b.md', json: true });
    expect(parseArgs(['dispatch', 'lim-a', '--task', 'task_873e6cb5afb2', '--dispatch', 'ctx_bba48a83896e', '--kind', 'rework'])).toMatchObject({ ok: true, sub: 'dispatch', kind: 'rework' });
    expect(parseArgs(['--help'])).toMatchObject({ ok: true, help: true });
  });

  it.each([
    [[], 'unknown or missing subcommand'],
    [['bind'], 'unknown or missing subcommand'],
    [['run'], '--run-id must match'],
    [['run', '--run-id', '../x'], '--run-id must match'],
    [['run', 'lim-a', '--run-id', RUN_ID], 'unexpected argument'],
    [['worktree', '--worktree', 'id:x'], '<limb> must match'],
    [['worktree', 'A', '--worktree', 'id:x'], '<limb> must match'],
    [['worktree', 'lim-a'], '--worktree <selector> is required'],
    [['worktree', 'lim-a', '--worktree', 'a\nb'], '--worktree <selector> is required'],
    [['dispatch', 'lim-a', '--task', 'task_873e6cb5afb2'], '--dispatch must match'],
    [['dispatch', 'lim-a', '--task', 'x y', '--dispatch', 'ctx_bba48a83896e'], '--task must match'],
    [['dispatch', 'lim-a', '--task', 'task_1a2b3c', '--dispatch', 'ctx_1a2b3c', '--kind', 'again'], '--kind must be one of'],
    [['worktree', 'lim-a', '--worktree'], 'requires a value'],
    [['run', '--run-id', RUN_ID, '--force'], 'unknown option'],
    [['worktree', 'lim-a', 'lim-b', '--worktree', 'id:x'], 'unexpected argument'],
  ])('거부 %j', (argv, fragment) => {
    const r = parseArgs(argv);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(fragment);
  });

  it('P0 영수증의 실제 id 는 ID_PATTERN 을 통과한다', () => {
    const ids = [receipt('task-a.json').result.taskId, receipt('ws-a.json').result.dispatchId, receipt('send-followup.json').result.dispatchId, receipt('send-followup.json').result.taskId];
    for (const id of ids) expect(id).toMatch(ID_PATTERN);
  });
});

describe('RELOCATABLE_BRANCH_NAME — 세션 훅의 정규식과 같다', () => {
  it('훅 소스의 상수와 문자 그대로 일치한다 (복사본이 따로 늙지 않게)', () => {
    const hook = readText(PLUGIN_ROOT, 'scripts', 'hooks', 'git-autopilot-session.js');
    const found = /const RELOCATABLE_BRANCH_NAME = \/(.+)\/;/.exec(hook);
    expect(found).not.toBeNull();
    expect(RELOCATABLE_BRANCH_NAME.source).toBe(found[1]);
  });

  it("슬래시가 든 이름은 옮겨지지 않고, 슬래시 없는 이름은 옮겨진다", () => {
    expect(RELOCATABLE_BRANCH_NAME.test('orca/lim-a-a1b2c3')).toBe(false);
    expect(RELOCATABLE_BRANCH_NAME.test('orca-lim-a-a1b2c3')).toBe(true);
  });
});

// ── bind run ────────────────────────────────────────────────────────────────

describe('bind run', () => {
  it('Orca runId 를 한 번 기록하고, 같은 값은 멱등이며, 다른 값은 거부한다', async () => {
    writeRun([limbRow('lim-a')], { runId: null });
    const first = await cli(['run', '--run-id', RUN_ID, '--json']);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.out)).toMatchObject({ ok: true, sub: 'run', runId: RUN_ID, alreadyBound: false });
    expect(readRun().runId).toBe(RUN_ID);
    expect(readRun().limbs).toHaveLength(1); // nothing else moved
    expect(JSON.parse((await cli(['run', '--run-id', RUN_ID, '--json'])).out)).toMatchObject({ ok: true, alreadyBound: true });
    const other = await cli(['run', '--run-id', 'run_other0000', '--json']);
    expect(other.code).toBe(1);
    expect(JSON.parse(other.out).error).toContain('이미 다른 Orca runId');
    expect(readRun().runId).toBe(RUN_ID);
  });

  it('run.json 이 없으면 사유를 낸다', async () => {
    const r = await cli(['run', '--run-id', RUN_ID, '--json'], { cwd: emptyRepo() });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).error).toContain('run.json');
  });

  it('--parent 는 체크아웃 루트여야 한다 — 하위 폴더나 git 리포가 아니면 세 서브커맨드 모두 run.json 을 건드리기 전에 거부한다', async () => {
    writeRun([limbRow('lim-a')], { runId: null });
    const before = JSON.stringify(readRun());
    const sub = path.join(world.repo, 'plugins', 'artibot'); // a shell whose cwd drifted into plugins/artibot
    fs.mkdirSync(sub, { recursive: true });
    const dispatchArgs = ['dispatch', 'lim-a', '--task', 'task_873e6cb5afb2', '--dispatch', 'ctx_bba48a83896e'];
    for (const argv of [['run', '--run-id', RUN_ID], ['worktree', 'lim-a', '--worktree', 'id:x'], dispatchArgs]) {
      const drifted = await cli([...argv, '--json'], { cwd: sub });
      expect([drifted.code, JSON.parse(drifted.out).error]).toEqual([1, expect.stringContaining('체크아웃 루트여야 한다')]);
      const notRepo = await cli([...argv, '--json'], { cwd: tempDir('orca-empty-') });
      expect(JSON.parse(notRepo.out).error).toContain('git 리포가 아니다');
    }
    expect(JSON.stringify(readRun())).toBe(before); // nothing was written
    expect(JSON.parse((await cli(['run', '--run-id', RUN_ID, '--json', '--parent', world.repo], { cwd: sub })).out)).toMatchObject({ ok: true });
  });
});

describe('bind — config 에 orca 블록이 없는 구 설치본', () => {
  it('정상이다: 이 스크립트는 orca.* 를 읽지 않고 agents.modelPolicy 만 읽는다 (블록 부재 · 빈 config · config 없음)', () => {
    const withoutOrca = structuredClone(CONFIG);
    delete withoutOrca.orca;
    for (const config of [withoutOrca, {}, null]) {
      writeRun([limbRow('lim-d')]);
      writeBrief('lim-d');
      const r = bindWorktree(wtArgs('lim-d', 'id:x'), baseDeps(showing(addWorktree()).exec), config);
      expect(r.ok).toBe(true);
    }
  });
});

// ── bind worktree: the full path ────────────────────────────────────────────

describe('bind worktree — 기록 · 장비 · 다음 명령 (실제 worktree, 실제 junction)', () => {
  let made;
  let result;
  let orca;

  beforeAll(() => {
    writeRun([limbRow('lim-a')]);
    writeBrief('lim-a');
    fs.writeFileSync(path.join(contractDir(world.repo, 'lim-a'), 'leader-addendum.md'), 'extra instruction\n');
    made = addWorktree();
    orca = showing(made);
    result = bindWorktree(wtArgs('lim-a', `id:${REPO_ID}::${toPosix(made.wt)}`), baseDeps(orca.exec), CONFIG);
  });

  it('성공하고, Orca 에는 worktree show 한 번(읽기 verb)만 물었다', () => {
    expect(result.ok).toBe(true);
    expect(orca.calls).toEqual([['worktree', 'show', '--worktree', `id:${REPO_ID}::${toPosix(made.wt)}`, '--json']]);
  });

  it('관측값을 기록한다 — worktree id, 경로, refs/heads/ 를 뗀 브랜치, 분기점 = 생성 직후 HEAD', () => {
    const row = rowOf('lim-a');
    expect(row).toMatchObject({ worktreeId: `${REPO_ID}::${toPosix(made.wt)}`, branch: made.branch, forkPoint: world.base });
    expect(path.resolve(row.worktreePath)).toBe(path.resolve(made.wt));
    expect(result.binding).toEqual({ worktreeId: row.worktreeId, worktreePath: row.worktreePath, branch: made.branch, forkPoint: world.base });
    expect(result.selector).toBe(`id:${row.worktreeId}`);
  });

  it('junction 은 진짜로 놓였고 그 너머로 부모의 의존성이 보인다', () => {
    expect(isLink(path.join(made.wt, ...NODE_MODULES))).toBe(true);
    expect(readText(made.wt, ...NODE_MODULES, 'sentinel.txt')).toBe('parent dependency\n');
    expect(result.setup.some((r) => r.kind === 'link' && r.status === 'done')).toBe(true);
  });

  it('브리프는 바이트 그대로 복사되고 보충 지시 파일도 따라간다', () => {
    const dest = contractDir(made.wt, 'lim-a');
    expect(fs.readFileSync(path.join(dest, 'brief.md')).equals(Buffer.from(BRIEF, 'utf-8'))).toBe(true);
    expect(readText(dest, 'leader-addendum.md')).toBe('extra instruction\n');
    expect(result.contract.siblings).toEqual([{ name: 'leader-addendum.md', copied: true }]);
  });

  it('prompt.md 는 미해결 placeholder 없이 렌더되고 머리표·경로·계약이 들어 있다', () => {
    const prompt = readText(contractDir(made.wt, 'lim-a'), 'prompt.md');
    expect(prompt).not.toMatch(/\{[A-Z][A-Z0-9_]*\}/);
    expect(prompt.split('\n')[0]).toBe(`[orca limb] run=${RUN_ID} limb=lim-a · worktree=${toPosix(made.wt)} · branch=${made.branch} · base=${world.base} · parent=${toPosix(world.repo)}`);
    expect(prompt).toContain(`${toPosix(contractDir(made.wt, 'lim-a'))}/brief.md`);
    expect(prompt).toContain(`${toPosix(contractDir(made.wt, 'lim-a'))}/report.md`);
    expect(prompt).toContain(`${toPosix(contractDir(world.repo, 'lim-a'))}/brief.md`);
    expect(prompt).toContain('[보고 계약]');
    expect(prompt).toContain('SendMessage(to="main")');
    expect(prompt).not.toContain('{리더 이름}');
    expect(prompt).toContain('[모델 운용 정책');
  });

  it('다음에 칠 명령은 task-create --spec-file <prompt.md> 하나이고 실행되지 않았다', () => {
    const spec = toPosix(path.join(contractDir(made.wt, 'lim-a'), 'prompt.md'));
    expect(result.next).toContain('orca orchestration task-create --spec-file');
    expect(result.next).toContain(spec);
    expect(result.next).toContain('--task-title lim-a --json');
    expect(orca.calls.every((argv) => argv[0] === 'worktree' && argv[1] === 'show')).toBe(true);
  });

  it('같은 명령을 다시 쳐도 멱등 — 분기점은 write-once 라 워커가 커밋한 뒤에도 옮겨가지 않는다', () => {
    git(made.wt, 'commit', '-q', '--allow-empty', '-m', 'worker commit');
    const newHead = git(made.wt, 'rev-parse', 'HEAD');
    const again = bindWorktree(wtArgs('lim-a', `id:${REPO_ID}::${toPosix(made.wt)}`), baseDeps(showing({ ...made, head: newHead }).exec), CONFIG);
    expect(again.ok).toBe(true);
    expect(again.binding.forkPoint).toBe(world.base);
    expect(rowOf('lim-a').forkPoint).toBe(world.base);
    expect(newHead).not.toBe(world.base);
  });

  it('CLI: 사람이 읽는 출력에 바인딩 요약과 다음 명령이 있고, --json 은 문서 1개', async () => {
    writeRun([limbRow('lim-b')]);
    writeBrief('lim-b');
    const m2 = addWorktree();
    const exec = showing(m2).exec;
    const text = await cli(['worktree', 'lim-b', '--worktree', `id:${REPO_ID}::${toPosix(m2.wt)}`], { exec });
    expect(text.code).toBe(0);
    expect(text.out).toContain('바인딩 완료: limb lim-b');
    expect(text.out).toContain('다음에 칠 명령');
    expect(text.out).toContain('$ orca orchestration task-create');
    const json = await cli(['worktree', 'lim-b', '--worktree', `id:${REPO_ID}::${toPosix(m2.wt)}`, '--json'], { exec });
    expect(JSON.parse(json.out)).toMatchObject({ ok: true, sub: 'worktree', limb: 'lim-b' });
  });
});

// ── bind worktree: refusals ─────────────────────────────────────────────────

describe('bind worktree — 거부는 아무것도 기록하지 않는다', () => {
  const before = () => JSON.stringify(readRun());

  it('메인 체크아웃을 가리키는 선택자(isMainWorktree 또는 부모 경로)는 거부', () => {
    writeRun([limbRow('lim-a')]);
    writeBrief('lim-a');
    const snapshot = before();
    const main1 = bindWorktree(wtArgs('lim-a', 'id:main'), baseDeps(showing({ wt: world.repo, branch: 'master', head: world.base }, { isMainWorktree: true }).exec), CONFIG);
    expect(main1.ok).toBe(false);
    expect(main1.error).toContain('메인 체크아웃');
    const sameAsParent = bindWorktree(wtArgs('lim-a', 'id:main'), baseDeps(showing({ wt: world.repo, branch: 'master', head: world.base }).exec), CONFIG);
    expect(sameAsParent.error).toContain('메인 체크아웃');
    expect(before()).toBe(snapshot);
  });

  it("브랜치에 '/' 가 없으면 세션 훅이 옮겨 버리므로 거부", () => {
    writeRun([limbRow('lim-a')]);
    writeBrief('lim-a');
    const made = addWorktree('orca-no-slash-a1b2c3');
    const snapshot = before();
    const r = bindWorktree(wtArgs('lim-a', 'id:x'), baseDeps(showing(made).exec), CONFIG);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("'/' 가 없다");
    expect(before()).toBe(snapshot);
  });

  it('분리된 HEAD(브랜치 없음)는 거부', () => {
    writeRun([limbRow('lim-a')]);
    const made = addWorktree();
    const r = bindWorktree(wtArgs('lim-a', 'id:x'), baseDeps(showing(made, { branch: null }).exec), CONFIG);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('브랜치를 읽지 못했다');
  });

  it('worktree show 가 실패하면 그 사유로 닫는다 (실제 ok:false 영수증의 메시지 형태)', () => {
    writeRun([limbRow('lim-a')]);
    const failing = fakeOrca(() => ({ ok: false, status: 1, stdout: JSON.stringify(receipt('wt-a-rm.json')), stderr: '', error: 'exit 1' }));
    const r = bindWorktree(wtArgs('lim-a', 'id:gone'), baseDeps(failing.exec), CONFIG);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('worktree show 실패');
  });

  it('이미 자기 커밋이 있는 HEAD 는 분기점으로 기록하지 않는다 — base 에 섞여 land 가 놓친다', () => {
    writeRun([limbRow('lim-a')]);
    writeBrief('lim-a');
    const made = addWorktree(undefined, { commits: 1 });
    const snapshot = before();
    const r = bindWorktree(wtArgs('lim-a', 'id:x'), baseDeps(showing(made).exec), CONFIG);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('조상이 아니다');
    expect(before()).toBe(snapshot);
  });

  it('forkPoint 가 비어 있는데 dispatch 가 이미 있으면 다시 재지 않는다', () => {
    writeRun([limbRow('lim-a', { dispatches: [{ dispatchId: 'ctx_bba48a83896e', taskId: 'task_873e6cb5afb2', kind: 'initial', at: '2026-11-19T04:10:00.000Z' }] })]);
    const r = bindWorktree(wtArgs('lim-a', 'id:x'), baseDeps(showing(addWorktree()).exec), CONFIG);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('이미 dispatch 가 있다');
  });

  it('이미 다른 worktree 에 묶인 줄기를 다시 묶으면 거부 (첫 worktree 가 고아가 된다)', () => {
    const first = addWorktree();
    writeRun([limbRow('lim-a', { worktreeId: `${REPO_ID}::${toPosix(first.wt)}`, worktreePath: first.wt, branch: first.branch, forkPoint: world.base })]);
    writeBrief('lim-a');
    const second = addWorktree();
    const snapshot = before();
    const r = bindWorktree(wtArgs('lim-a', 'id:x'), baseDeps(showing(second).exec), CONFIG);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('다른 worktree');
    expect(before()).toBe(snapshot);
  });

  it('runId 미바인딩 · 모르는 줄기 · run.json 없음은 안내와 함께 거부', () => {
    writeRun([limbRow('lim-a')], { runId: null });
    const made = addWorktree();
    expect(bindWorktree(wtArgs('lim-a', 'id:x'), baseDeps(showing(made).exec), CONFIG).error).toContain('bind.mjs run');
    writeRun([limbRow('lim-a')]);
    expect(bindWorktree(wtArgs('lim-zzz', 'id:x'), baseDeps(showing(made).exec), CONFIG).error).toContain('run.json 에 없다');
    const none = bindWorktree(wtArgs('lim-a', 'id:x'), baseDeps(showing(made).exec, { cwd: emptyRepo() }), CONFIG);
    expect(none.error).toContain('run.json');
  });

  it('예상 못 한 예외는 스택 대신 { ok:false, error } 와 exit 1 이다', async () => {
    writeRun([limbRow('lim-a')]);
    const r = await cli(['worktree', 'lim-a', '--worktree', 'id:x', '--json'], { exec: () => { throw new Error('boom'); } });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toEqual({ ok: false, error: 'unexpected failure: boom' });
  });

  it('integrationRef 를 읽지 못하면 경고하고 기록한다 (확인 불가 ≠ 거부)', () => {
    writeRun([limbRow('lim-a')], { integrationRef: 'origin/not-there' });
    writeBrief('lim-a');
    const made = addWorktree();
    const r = bindWorktree(wtArgs('lim-a', 'id:x'), baseDeps(showing(made).exec), CONFIG);
    expect(r.ok).toBe(true);
    expect(r.warnings[0]).toContain('확인하지 못했다');
  });
});

describe('bind worktree — 장비 단계 실패는 바인딩을 남기고 재실행을 허용한다', () => {
  it('브리프가 없으면 실패하되 바인딩은 기록돼 있고, 브리프를 쓴 뒤 같은 명령이 성공한다', () => {
    writeRun([limbRow('lim-c')]);
    const made = addWorktree();
    const exec = showing(made).exec;
    const first = bindWorktree(wtArgs('lim-c', 'id:x'), baseDeps(exec), CONFIG);
    expect(first.ok).toBe(false);
    expect(first.bound).toBe(true);
    expect(first.error).toContain('브리프가 없다');
    expect(first.error).toContain('바인딩은 기록됐다');
    expect(rowOf('lim-c').branch).toBe(made.branch);
    expect(fs.existsSync(path.join(contractDir(made.wt, 'lim-c'), 'prompt.md'))).toBe(false);
    writeBrief('lim-c');
    const second = bindWorktree(wtArgs('lim-c', 'id:x'), baseDeps(exec), CONFIG);
    expect(second.ok).toBe(true);
    expect(second.binding.forkPoint).toBe(world.base);
  });

  it('브리프에 필수 절(소유·완료)이 없으면 거부', () => {
    writeRun([limbRow('lim-c')]);
    writeBrief('lim-c', '# 아무 절도 없는 브리프\n');
    const r = bindWorktree(wtArgs('lim-c', 'id:x'), baseDeps(showing(addWorktree()).exec), CONFIG);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('필수 절');
  });

  it('junction/프로비저닝이 실패하면 워커를 시작하지 않는다 — prompt 는 쓰이지 않는다', () => {
    writeRun([limbRow('lim-c')]);
    writeBrief('lim-c');
    const made = addWorktree();
    const runSetup = () => ({ ok: false, rows: [], error: 'link refused' });
    const r = bindWorktree(wtArgs('lim-c', 'id:x'), baseDeps(showing(made).exec, { runSetup }), CONFIG);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('워커를 시작하지 않는다');
    expect(r.error).toContain('link refused');
    expect(fs.existsSync(path.join(contractDir(made.wt, 'lim-c'), 'prompt.md'))).toBe(false);
  });

  it('템플릿에 모르는 placeholder 가 있으면 fail-closed', () => {
    writeRun([limbRow('lim-c')]);
    writeBrief('lim-c');
    const templatePath = path.join(tempDir('orca-tpl-'), 'bad.md');
    fs.writeFileSync(templatePath, 'run={RUN} unknown={NOT_A_THING}\n{REPORT_CONTRACT}\n{MODEL_POLICY}\n');
    const r = bindWorktree(wtArgs('lim-c', 'id:x'), baseDeps(showing(addWorktree()).exec, { templatePath }), CONFIG);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('unresolved placeholders');
    expect(r.error).toContain('{NOT_A_THING}');
  });

  it('--brief 로 다른 위치의 브리프를 쓰면 그 폴더의 leader-addendum.md 가 따라간다', () => {
    writeRun([limbRow('lim-c')]);
    const custom = tempDir('orca-brief-');
    fs.writeFileSync(path.join(custom, 'my-brief.md'), BRIEF.replace('표적', '맞춤'));
    fs.writeFileSync(path.join(custom, 'leader-addendum.md'), 'custom addendum\n');
    const made = addWorktree();
    const r = bindWorktree(wtArgs('lim-c', 'id:x', { brief: path.join(custom, 'my-brief.md') }), baseDeps(showing(made).exec), CONFIG);
    expect(r.ok).toBe(true);
    expect(readText(contractDir(made.wt, 'lim-c'), 'brief.md')).toContain('맞춤');
    expect(readText(contractDir(made.wt, 'lim-c'), 'leader-addendum.md')).toBe('custom addendum\n');
  });
});

// ── bind dispatch ───────────────────────────────────────────────────────────

describe('bind dispatch — 추가 전용 영수증', () => {
  // ws-b2 is the worker-start the P0 follow-up (`send` -> delivery reopened) refers to through followUpOf.
  const first = { task: receipt('ws-b2.json').result.taskId, dispatch: receipt('ws-b2.json').result.dispatchId };
  const followUp = receipt('send-followup.json').result;

  it('첫 dispatch 는 initial, 같은 기록은 멱등이다', async () => {
    writeRun([limbRow('lim-a')]);
    const r = await cli(['dispatch', 'lim-a', '--task', first.task, '--dispatch', first.dispatch, '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, alreadyRecorded: false, count: 1, dispatch: { dispatchId: first.dispatch, taskId: first.task, kind: 'initial', at: '2026-11-19T05:00:00.000Z' } });
    const again = JSON.parse((await cli(['dispatch', 'lim-a', '--task', first.task, '--dispatch', first.dispatch, '--json'])).out);
    expect(again).toMatchObject({ ok: true, alreadyRecorded: true, count: 1 });
    expect(rowOf('lim-a').dispatches).toHaveLength(1);
  });

  it('두 번째 dispatch 는 --kind 를 명시해야 한다 — 재작업 영수증(send 의 reopened) 의 새 Task/dispatch 를 rework 로 기록', async () => {
    const missing = await cli(['dispatch', 'lim-a', '--task', followUp.taskId, '--dispatch', followUp.dispatchId, '--json']);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.out).error).toContain('--kind');
    const ok = await cli(['dispatch', 'lim-a', '--task', followUp.taskId, '--dispatch', followUp.dispatchId, '--kind', 'rework', '--json']);
    expect(JSON.parse(ok.out)).toMatchObject({ ok: true, count: 2, dispatch: { kind: 'rework' } });
    expect(rowOf('lim-a').dispatches.map((d) => d.kind)).toEqual(['initial', 'rework']);
    expect(followUp.followUpOf).toBe(first.dispatch); // the receipt itself says whose follow-up it is
  });

  it('같은 dispatch id 를 다른 줄기/Task 로 기록하려 하면 거부 — 한 dispatch 는 한 줄기에만 속한다', async () => {
    writeRun([limbRow('lim-a'), limbRow('lim-b')]);
    await cli(['dispatch', 'lim-a', '--task', first.task, '--dispatch', first.dispatch, '--json']);
    const other = await cli(['dispatch', 'lim-b', '--task', first.task, '--dispatch', first.dispatch, '--json']);
    expect(other.code).toBe(1);
    expect(JSON.parse(other.out).error).toContain('이미 limb lim-a');
    const differentTask = await cli(['dispatch', 'lim-a', '--task', 'task_aaaaaaaaaaaa', '--dispatch', first.dispatch, '--json']);
    expect(differentTask.code).toBe(1);
  });

  it('retry 기록과 모르는 줄기, 사람용 출력', async () => {
    writeRun([limbRow('lim-a', { dispatches: [{ dispatchId: first.dispatch, taskId: first.task, kind: 'initial', at: '2026-11-19T04:10:00.000Z' }] })]);
    const text = await cli(['dispatch', 'lim-a', '--task', first.task, '--dispatch', 'ctx_retry0000001', '--kind', 'retry']);
    expect(text.code).toBe(0);
    expect(text.out).toContain('retry');
    expect(text.out).toContain('턴을 끝낸다');
    const unknown = await cli(['dispatch', 'lim-zzz', '--task', first.task, '--dispatch', 'ctx_other0000001', '--json']);
    expect(unknown.code).toBe(1);
    expect(JSON.parse(unknown.out).error).toContain('run.json 에 없다');
  });
});

// ── the template: its own gate ──────────────────────────────────────────────

describe('PROMPT-TEMPLATE.md — 이 템플릿을 보는 다른 게이트는 없다', () => {
  const template = readText(PLUGIN_ROOT, 'templates', 'orca', 'PROMPT-TEMPLATE.md');
  const PRE_PASS = ['BRIEF_PATH', 'PARENT_BRIEF_PATH', 'REPORT_PATH'];

  it('placeholder 는 renderPrompt 의 닫힌 집합 + 경로 3개뿐이고 계약·정책 자리는 한 번씩이다', () => {
    const used = [...new Set([...template.matchAll(/\{([A-Z][A-Z0-9_]*)\}/g)].map((m) => m[1]))];
    for (const key of used) expect([...PROMPT_PLACEHOLDERS, ...PRE_PASS]).toContain(key);
    expect(template.match(/\{REPORT_CONTRACT\}/g)).toHaveLength(1);
    expect(template.match(/\{MODEL_POLICY\}/g)).toHaveLength(1);
    for (const key of ['RUN', 'LIMB', 'WORKTREE_PATH', 'BRANCH', 'BASE', 'PARENT_ROOT', ...PRE_PASS]) expect(used).toContain(key);
  });

  it.each([
    ['머리표', '[orca limb] run={RUN} limb={LIMB}'],
    ['브리프 먼저 읽기', '를 먼저 Read 하라'],
    ['소유 allowlist · 완료 기준', '소유 파일 allowlist'],
    ['완료 = 커밋 + 트레일러', '`Split-Limb: done` 트레일러'],
    ['worker_done 은 트레일러 뒤', '그 다음에 `worker_done`'],
    ['트레일러 없는 worker_done 은 완료 아님', '트레일러 없는 `worker_done` 은 완료로 처리되지 않고'],
    ['트레일러는 귀속 줄과 같은 문단', '귀속 줄(Co-Authored-By · Claude-Session)이 있으면 그것과 같은 문단'],
    ['실패를 숨기지 않는다', '--outcome failed'],
    ['AskUserQuestion 금지', '`AskUserQuestion` 을 쓰지 않는다'],
    ['ask / escalation / worker_done', '`ask` · `escalation` · `worker_done`'],
    ['사람 게이트 행동 금지', '사람 게이트에 걸리는 행동'],
    ['훅이 막으면 우회하지 않고 ask', '우회하지 말고'],
    ['보고 본문에 명령 원문 인용 금지', '셸 명령 원문을 인용하지 마라'],
    ['금지: stash·reset·checkout·ref 조작·worktree 생성', 'git stash · reset · checkout'],
    ['금지: 소유 밖 편집 · 리포 전체 테스트', '리포 전체 테스트 스위트'],
    ['junction 안에 설치·삭제 금지', 'junction'],
    ['줄기 내부 팬아웃은 Agent 도구', '팬아웃 수단은 Agent 도구다'],
    ['Orca worker-start 서브디스패치 금지', 'worker-start 하위 디스패치를 쓰지 않는다'],
    ['팀원에게는 보고 계약 전문', '[보고 계약] 을 그대로 넣는다'],
    ['창 → 리더 채널은 Orca', '위의 Orca 채널'],
  ])('필수 문장 — %s', (_label, phrase) => {
    expect(template).toContain(phrase);
  });

  it('Orca 가 실제로 준 워커 프리앰블(P0 fixture)과 같은 어휘를 쓴다 — 프리앰블이 바뀌면 이 줄이 빨개진다', () => {
    const preamble = readText(FIXTURES, 'preamble-a.txt');
    expect(preamble).toContain('Never use a local question prompt such as AskUserQuestion');
    expect(preamble).toContain('orca orchestration ask');
    expect(preamble).toContain('--type escalation');
    expect(preamble).toContain('--type worker_done');
    expect(preamble).toContain('--outcome failed');
    expect(preamble).toContain('--files-modified');
    expect(preamble).toContain('--report-path');
    // ... and the template names the same three channels and the same flags.
    for (const word of ['ask', 'escalation', 'worker_done', '--outcome failed', '--files-modified', '--report-path']) expect(template).toContain(word);
  });

  it('"명령 원문을 보고에 인용하지 마라" 규칙의 근거는 실제 P0 보고(check-2) 안에 있다', () => {
    const body = receipt('check-2.json').result.messages[0].body;
    expect(body).toContain('blocked my first worker_done attempt because the report body quoted');
  });

  it('모델 ID 를 박아 두지 않고, 계약 폴더 경로 리터럴도 없고, 보이지 않는 문자도 없다', () => {
    expect(template).not.toMatch(/claude-(?:opus|sonnet|haiku|fable)-\d/);
    expect(template).not.toContain(['.artibot', 'split'].join('/'));
    const hidden = [...template].filter((ch) => [0xfeff, 0xa0, 0x200b, 0x200c, 0x200d, 0x2060].includes(ch.codePointAt(0)));
    expect(hidden).toEqual([]);
    expect(template).not.toMatch(/\\u[0-9a-fA-F]{4}/);
  });

  it('실제 계약 블록과 설정으로 렌더하면 미해결 placeholder 가 0 이고 줄 수가 합리적이다', () => {
    const contract = ['[보고 계약]', '- 보고는 반드시 SendMessage(to="main") 로 보낸다.'].join('\n');
    const prompt = renderWorkerPrompt({
      templateText: template, run: { runId: RUN_ID }, limb: 'lim-a', binding: { worktreePath: world.repo, branch: 'orca/lim-a-a1b2c3', forkPoint: world.base },
      parentRoot: world.repo, config: CONFIG, contract,
    });
    expect(prompt.match(/\{[A-Z][A-Z0-9_]*\}/g)).toBeNull();
    expect(prompt.split('\n').length).toBeLessThan(80);
    expect(prompt).toContain('SendMessage(to="main")');
  });

  it('템플릿과 계약 블록이 CRLF 여도(Windows autocrlf 체크아웃) 렌더 결과에는 CR 이 없다', () => {
    const crlf = (text) => text.replace(/\r?\n/g, '\r\n');
    const contract = crlf(['[보고 계약]', '- 보고는 반드시 SendMessage(to="main") 로 보낸다.'].join('\n'));
    const prompt = renderWorkerPrompt({
      templateText: crlf(template), run: { runId: RUN_ID }, limb: 'lim-a', binding: { worktreePath: world.repo, branch: 'orca/lim-a-a1b2c3', forkPoint: world.base },
      parentRoot: world.repo, config: CONFIG, contract,
    });
    expect(crlf('a\nb')).toContain('\r'); // positive control: the helper really produces CRLF
    expect(prompt).not.toContain('\r');
    expect(prompt.split('\n')[0]).toMatch(/^\[orca limb\] run=/);
  });

  it('installLimbContract: 필수 절이 없는 브리프는 아무것도 쓰기 전에 거부', () => {
    const parent = tempDir('orca-parent-');
    const wt = tempDir('orca-wt-');
    fs.mkdirSync(contractDir(parent, 'lim-a'), { recursive: true });
    fs.writeFileSync(path.join(contractDir(parent, 'lim-a'), 'brief.md'), '# 빈 브리프\n');
    expect(() => installLimbContract({ parentRoot: parent, worktreePath: wt, limb: 'lim-a', prompt: 'p' })).toThrow(/필수 절/);
    expect(fs.existsSync(contractDir(wt, 'lim-a'))).toBe(false);
  });
});

describe('픽스처 위생 — 실제 GitHub 계정·사용자 경로가 영수증에 남아 있지 않다 (SR-5)', () => {
  it('모든 영수증의 github: 식별자는 중립 자리표시자이고 드라이브 문자 사용자 경로도 없다', () => {
    const names = fs.readdirSync(FIXTURES);
    expect(names.length).toBeGreaterThanOrEqual(29); // not a vacuous scan
    for (const name of names) {
      const text = readText(FIXTURES, name);
      for (const id of text.match(/github:[^"\s]*/g) ?? []) expect([name, id]).toEqual([name, 'github:example/repo']);
      expect([name, /[A-Za-z]:[\\/]+Users[\\/]/.test(text)]).toEqual([name, false]);
    }
    expect(names.filter((name) => name.endsWith('.json') && readText(FIXTURES, name).includes('github:'))).toEqual(['wt-a-show.json', 'wt-a.json']); // the scan does see the placeholder where it is
  });
});

describe('실제 직접 실행 — 진입 가드', () => {
  it('node bind.mjs --help 는 사용법을 낸다', () => {
    expect(execFileSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf-8', windowsHide: true })).toContain('usage:');
  });

  it('잘못된 인자는 exit 1 이 호출자에게 전달된다', () => {
    expect(() => execFileSync(process.execPath, [SCRIPT, 'run'], { stdio: 'pipe', windowsHide: true })).toThrow();
  });
});
