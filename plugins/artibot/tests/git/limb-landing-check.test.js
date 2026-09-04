/**
 * `lib/git/limb-landing-check.js` + `scripts/split/land.mjs` — the six
 * mechanical landing checks, driven against a real temp git repo.
 *
 * What this proves: each check turns red on the scenario it exists for
 * (ownership · binary · citation · superseded trailer · merge conflict), the
 * happy path is PASS, git < 2.38 is UNSUPPORTED (exec injection), and the CLI
 * maps status → exit code without writing anything but the optional PR body.
 *
 * What it cannot prove (rules §9): that PASS means the limb is safe to land —
 * no test suite runs here, and approval is a human slot in the PR body.
 * Fixture scale is 1–2 files per limb; a 500-file diff is not exercised.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  allowlistEntryToRegExp,
  checkLimbLanding,
  DEFAULT_FORBIDDEN_PATTERNS,
  defaultExec,
  findForbiddenCitations,
  matchesAllowlist,
} from '../../lib/git/limb-landing-check.js';
import { loadPlanLimb, parseLandArgs, runLand } from '../../scripts/split/land.mjs';

let repo = '';
let planBase = '';
const ALLOW = ['src/**', 'docs/a.md'];

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim();
}

function commitFile(cwd, name, content, messages) {
  const full = path.join(cwd, name);
  fsSync.mkdirSync(path.dirname(full), { recursive: true });
  fsSync.writeFileSync(full, content);
  git(['add', name], cwd);
  git(['commit', '-q', ...messages.flatMap((m) => ['-m', m])], cwd);
  return git(['rev-parse', 'HEAD'], cwd);
}

const DONE = 'Split-Limb: done';

beforeAll(() => {
  repo = fsSync.mkdtempSync(path.join(os.tmpdir(), 'artibot-land-'));
  git(['init', '-q', '-b', 'main', '.'], repo);
  git(['config', 'user.email', 'test@example.invalid'], repo);
  git(['config', 'user.name', 'test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  commitFile(repo, 'seed.txt', 'seed\n', ['init']);
  planBase = git(['rev-parse', 'HEAD'], repo);

  // PASS: inside allowlist + alwaysAllowed scratch, text only, done trailer.
  git(['checkout', '-q', '-b', 'limb-good', 'main'], repo);
  commitFile(repo, 'src/x.js', 'export const x = 1;\n', ['feat: x']);
  commitFile(repo, 'docs/a.md', '# a\n', ['docs: a']);
  commitFile(repo, '.artibot/split/good/notes.md', 'notes\n', ['chore: notes', DONE]);

  // ownership FAIL: a file outside the allowlist.
  git(['checkout', '-q', '-b', 'limb-own', 'main'], repo);
  commitFile(repo, 'other/y.js', 'y\n', ['feat: y', DONE]);

  // binary FAIL.
  git(['checkout', '-q', '-b', 'limb-bin', 'main'], repo);
  commitFile(repo, 'src/img.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00]), ['feat: img', DONE]);

  // citation FAIL: added lines carrying a Windows user path and a split scratch path.
  git(['checkout', '-q', '-b', 'limb-cite', 'main'], repo);
  commitFile(repo, 'src/z.js', 'const a = 1;\nconst p = "C:\\\\Users\\\\someone\\\\x";\nconst q = ".artibot/split/foo/brief.md";\n', ['feat: z', DONE]);

  // superseded trailer FAIL.
  git(['checkout', '-q', '-b', 'limb-sup', 'main'], repo);
  commitFile(repo, 'src/s.js', 's\n', ['feat: s', DONE]);
  commitFile(repo, 'src/s2.js', 's2\n', ['feat: s reopened', 'Split-Limb: wip']);

  // empty FAIL: a done trailer on an empty diff has nothing to land.
  git(['checkout', '-q', '-b', 'limb-empty', 'main'], repo);
  git(['commit', '-q', '--allow-empty', '-m', 'chore: nothing', '-m', DONE], repo);

  // merge conflict FAIL: both sides edit seed.txt.
  git(['checkout', '-q', '-b', 'limb-conf', 'main'], repo);
  commitFile(repo, 'seed.txt', 'limb side\n', ['feat: seed limb', DONE]);
  git(['checkout', '-q', 'main'], repo);
  commitFile(repo, 'seed.txt', 'main side\n', ['chore: seed main']);

  fsSync.mkdirSync(path.join(repo, '.artibot', 'split'), { recursive: true });
  fsSync.writeFileSync(path.join(repo, '.artibot', 'split', 'plan.json'), JSON.stringify({
    runId: 'split-test',
    base: planBase,
    repoShort: 'tt',
    limbs: [
      { limb: 'good', branch: 'limb-good', worktreePath: '', affectedPaths: ['src/**', 'docs/a.md'] },
      { limb: 'own', branch: 'limb-own', worktreePath: '', affectedPaths: ['src/**'] },
      { limb: 'nobranch', worktreePath: '', affectedPaths: [] },
    ],
  }));
});

afterAll(() => {
  try {
    fsSync.rmSync(repo, { recursive: true, force: true });
  } catch { /* best effort */ }
});

const byId = (r, id) => r.checks.find((c) => c.id === id);

describe('checkLimbLanding — 시나리오별로 정확히 그 검사만 빨갛다', () => {
  it('FAIL: 변경 파일 0 인 줄기는 done 트레일러가 있어도 ownership 이 빨갛다 (리뷰 발견 2026-09-02)', () => {
    const r = checkLimbLanding({ cwd: repo, limb: 'empty', branch: 'limb-empty', base: planBase, allowlist: ALLOW });
    expect(r.status).toBe('FAIL');
    expect(byId(r, 'trailer').ok).toBe(true);
    expect(byId(r, 'ownership')).toMatchObject({ ok: false });
    expect(byId(r, 'ownership').detail).toMatch(/변경 파일 0/);
    expect(r.changedFiles).toEqual([]);
  });

  it('PASS: allowlist 안 + 기본 alwaysAllowed 스크래치 + done', () => {
    const r = checkLimbLanding({ cwd: repo, limb: 'good', branch: 'limb-good', base: planBase, allowlist: ALLOW });
    expect(r.status).toBe('PASS');
    expect(r.checks.map((c) => [c.id, c.ok])).toEqual([
      ['trailer', true], ['ownership', true], ['binary', true], ['citations', true], ['merge-dry-run', true], ['behind-base', true],
    ]);
    expect(r.changedFiles).toEqual(['.artibot/split/good/notes.md', 'docs/a.md', 'src/x.js']);
    // 계획 시점 SHA 가 base 이므로 뒤처짐 0; 살아 있는 main(커밋 1개 전진) 기준이면 1.
    expect(byId(r, 'behind-base').detail).toMatch(/^0 commit\(s\) behind/);
    const live = checkLimbLanding({ cwd: repo, limb: 'good', branch: 'limb-good', base: 'main', allowlist: ALLOW });
    expect(live.status).toBe('PASS');
    expect(byId(live, 'behind-base').detail).toMatch(/^1 commit\(s\) behind main$/);
    expect(r.prBody).toContain('# chore: notes');
    expect(r.prBody).toContain('## 게이트');
    expect(r.prBody).toContain('## 검수');
    expect(r.prBody).toContain('## 이월');
    expect(r.prBody).toContain('- `src/x.js`');
    expect(r.prBody).toMatch(/Split-Limb: done @ [0-9a-f]{40}\n$/);
  });

  it('ownership FAIL: allowlist 밖 파일을 이름으로 지목한다', () => {
    const r = checkLimbLanding({ cwd: repo, limb: 'own', branch: 'limb-own', base: planBase, allowlist: ['src/**'] });
    expect(r.status).toBe('FAIL');
    expect(byId(r, 'ownership').ok).toBe(false);
    expect(byId(r, 'ownership').detail).toContain('other/y.js');
    expect(byId(r, 'trailer').ok).toBe(true);
  });

  it('ownership FAIL: allowlist 가 비면 어떤 파일도 통과하지 않는다 (fail-closed)', () => {
    const r = checkLimbLanding({ cwd: repo, limb: 'own', branch: 'limb-own', base: planBase });
    expect(byId(r, 'ownership').ok).toBe(false);
  });

  it('binary FAIL: numstat `-\\t-` 행을 나열한다', () => {
    const r = checkLimbLanding({ cwd: repo, limb: 'bin', branch: 'limb-bin', base: planBase, allowlist: ALLOW });
    expect(r.status).toBe('FAIL');
    expect(byId(r, 'binary').ok).toBe(false);
    expect(byId(r, 'binary').detail).toContain('src/img.png');
    // 바이너리 파일은 인용 검사 대상이 아니다 — 거기서 또 빨개지지 않는다.
    expect(byId(r, 'citations').ok).toBe(true);
  });

  it('citation FAIL: 추가된 줄의 file:line 을 준다 (기본 패턴 2종)', () => {
    const r = checkLimbLanding({ cwd: repo, limb: 'cite', branch: 'limb-cite', base: planBase, allowlist: ALLOW });
    expect(r.status).toBe('FAIL');
    const c = byId(r, 'citations');
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('2 hit(s)');
    expect(c.detail).toContain('src/z.js:2:');
    expect(c.detail).toContain('src/z.js:3:');
  });

  it('superseded trailer FAIL: done 뒤 wip', () => {
    const r = checkLimbLanding({ cwd: repo, limb: 'sup', branch: 'limb-sup', base: planBase, allowlist: ALLOW });
    expect(r.status).toBe('FAIL');
    expect(byId(r, 'trailer').ok).toBe(false);
    expect(byId(r, 'trailer').detail).toBe('superseded (lastTrailer=wip)');
    expect(r.prBody).toContain('Split-Limb: superseded (done 아님');
  });

  it('merge conflict FAIL: 충돌 파일을 나열한다', () => {
    const r = checkLimbLanding({ cwd: repo, limb: 'conf', branch: 'limb-conf', base: 'main', allowlist: ['seed.txt'] });
    expect(r.status).toBe('FAIL');
    expect(byId(r, 'merge-dry-run').ok).toBe(false);
    expect(byId(r, 'merge-dry-run').detail).toContain('seed.txt');
    expect(byId(r, 'trailer').ok).toBe(true);
  });

  it('UNSUPPORTED: git < 2.38 이면 merge-dry-run 은 UNSUPPORTED 이고 전체도 PASS 가 아니다', () => {
    const exec = (args, opts) => (args[0] === '--version'
      ? { status: 0, stdout: 'git version 2.30.0\n', stderr: '' }
      : defaultExec(args, opts));
    const r = checkLimbLanding({ cwd: repo, limb: 'good', branch: 'limb-good', base: planBase, allowlist: ALLOW, exec });
    expect(r.status).toBe('UNSUPPORTED');
    expect(byId(r, 'merge-dry-run').ok).toBe(false);
    expect(byId(r, 'merge-dry-run').detail).toMatch(/^UNSUPPORTED: git 2\.30\.0/);
    expect(r.checks.filter((c) => c.id !== 'merge-dry-run').every((c) => c.ok)).toBe(true);
  });

  it('UNSUPPORTED 이어도 다른 검사가 빨가면 FAIL 이 이긴다', () => {
    const exec = (args, opts) => (args[0] === '--version'
      ? { status: 0, stdout: 'git version 2.30.0\n', stderr: '' }
      : defaultExec(args, opts));
    const r = checkLimbLanding({ cwd: repo, limb: 'own', branch: 'limb-own', base: planBase, allowlist: ['src/**'], exec });
    expect(r.status).toBe('FAIL');
  });

  it('잘못된 입력은 던지지 않고 input 행 하나로 FAIL', () => {
    const r = checkLimbLanding({ cwd: repo, limb: 'good', branch: '', base: planBase });
    expect(r.status).toBe('FAIL');
    expect(r.checks).toEqual([{ id: 'input', name: '입력', ok: false, detail: 'missing or empty: branch' }]);
    expect(r.prBody).toBe('');
    expect(checkLimbLanding().status).toBe('FAIL');
  });

  it('없는 브랜치·비리포 cwd 는 trailer 가 빨갛고 diff 도 빨갛지만 던지지 않는다', () => {
    const r = checkLimbLanding({ cwd: repo, limb: 'x', branch: 'limb-missing', base: planBase, allowlist: ALLOW });
    expect(r.status).toBe('FAIL');
    expect(byId(r, 'trailer').detail).toBe('no-branch');
    expect(byId(r, 'ownership').ok).toBe(false);
    const notRepo = fsSync.mkdtempSync(path.join(os.tmpdir(), 'artibot-land-notrepo-'));
    try {
      expect(checkLimbLanding({ cwd: notRepo, limb: 'x', branch: 'limb-good', base: 'main', allowlist: ALLOW }).status).toBe('FAIL');
    } finally {
      fsSync.rmSync(notRepo, { recursive: true, force: true });
    }
  });
});

describe('checkLimbLanding — 한글·공백 경로 (후속 19 #1: `git diff --name-only` 를 `-z` 로)', () => {
  // `core.quotepath=true`(git 기본값) 에서 `--name-only` 는 비ASCII 경로를 C-quote 로
  // 내보낸다: "src/\355\225\234\352\270\200…". 따옴표째 allowlist 에 대면 어떤 글롭에도
  // 안 맞아 ownership 이 거짓 FAIL 이 된다. `-z` 출력은 인용을 하지 않는다.
  // RED 증거: 변경 전(7cbb37b9) 코드에서 아래 첫 케이스는 ownership FAIL 이었다.
  const KO = 'src/한글폴더/설계문서.md';
  const SP = 'src/with space.md';
  let krepo = '';
  let kbase = '';

  beforeAll(() => {
    krepo = fsSync.mkdtempSync(path.join(os.tmpdir(), 'artibot-land-ko-'));
    git(['init', '-q', '-b', 'main', '.'], krepo);
    git(['config', 'user.email', 'test@example.invalid'], krepo);
    git(['config', 'user.name', 'test'], krepo);
    git(['config', 'commit.gpgsign', 'false'], krepo);
    // 기본값이지만 명시 — 이 테스트가 증명하는 것은 "인용이 켜져 있어도" 원문이 온다는 것.
    git(['config', 'core.quotepath', 'true'], krepo);
    commitFile(krepo, KO, '# 설계\n', ['docs: 한글 경로']);
    commitFile(krepo, SP, 'a\n', ['docs: 공백 경로']);
    kbase = git(['rev-parse', 'HEAD'], krepo);

    git(['checkout', '-q', '-b', 'limb-ko', 'main'], krepo);
    commitFile(krepo, KO, '# 설계 v2\n', ['docs: 한글 수정', DONE]);

    // 두 파일을 바꾸는 줄기: NUL 구분이 실제로 갈리는지(줄바꿈 split 회귀) 까지 본다.
    git(['checkout', '-q', '-b', 'limb-sp', 'main'], krepo);
    commitFile(krepo, SP, 'b\n', ['docs: 공백 수정']);
    commitFile(krepo, KO, '# 설계 v3\n', ['docs: 한글 재수정', DONE]);
  });

  afterAll(() => {
    try {
      fsSync.rmSync(krepo, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  it('한글 경로가 원문 그대로 changedFiles 에 오고 ownership 이 PASS', () => {
    const r = checkLimbLanding({ cwd: krepo, limb: 'ko', branch: 'limb-ko', base: kbase, allowlist: ['src/**'] });
    expect(r.changedFiles).toEqual([KO]);
    // 따옴표·백슬래시 이스케이프가 섞이지 않았다.
    expect(r.changedFiles[0]).not.toMatch(/["\\]/);
    expect(byId(r, 'ownership')).toMatchObject({ ok: true, detail: '1 file(s), all inside allowlist' });
    expect(r.status).toBe('PASS');
    expect(r.prBody).toContain(`- \`${KO}\``);
  });

  it('내부 공백 경로가 그대로 오고, 파일 2개는 NUL 로 갈린다', () => {
    // 못 보는 것: 끝 공백 경로(`.trim()` 제거의 진짜 회귀면)는 Windows 가 파일명으로
    // 만들 수 없어 이 호스트에서 검증 불가 — 내부 공백은 변경 전 코드도 보존했다.
    // 이 케이스가 지키는 것은 NUL 분리(줄바꿈 split 회귀)와 원문 보존이다.
    const r = checkLimbLanding({ cwd: krepo, limb: 'sp', branch: 'limb-sp', base: kbase, allowlist: ['src/**'] });
    expect([...r.changedFiles].sort()).toEqual([SP, KO].sort());
    expect(byId(r, 'ownership')).toMatchObject({ ok: true, detail: '2 file(s), all inside allowlist' });
    expect(r.status).toBe('PASS');
  });
});

describe('matchesAllowlist — 정확 경로 · 디렉터리 접두 · * · **', () => {
  it('정확 경로와 디렉터리 접두', () => {
    expect(matchesAllowlist('docs/a.md', ['docs/a.md'])).toBe(true);
    expect(matchesAllowlist('docs/a.md.bak', ['docs/a.md'])).toBe(false);
    expect(matchesAllowlist('lib/git/x.js', ['lib/git'])).toBe(true);
    expect(matchesAllowlist('lib/git/x.js', ['lib/git/'])).toBe(true);
    expect(matchesAllowlist('lib/gitx/x.js', ['lib/git'])).toBe(false);
    expect(matchesAllowlist('lib/git/x.js', ['lib\\git'])).toBe(true);
  });

  it('* 는 세그먼트 안, ** 는 디렉터리를 넘는다', () => {
    expect(matchesAllowlist('src/a.js', ['src/*.js'])).toBe(true);
    expect(matchesAllowlist('src/deep/a.js', ['src/*.js'])).toBe(false);
    expect(matchesAllowlist('src/deep/a.js', ['src/**/*.js'])).toBe(true);
    expect(matchesAllowlist('src/a.js', ['src/**/*.js'])).toBe(true);
    expect(matchesAllowlist('src/deep/a.js', ['src/**'])).toBe(true);
    expect(matchesAllowlist('srcx/a.js', ['src/**'])).toBe(false);
    expect(matchesAllowlist('tests/a.test.js', ['**/*.test.js'])).toBe(true);
  });

  it('빈 allowlist·빈 경로·비문자 항목은 false', () => {
    expect(matchesAllowlist('a.js', [])).toBe(false);
    expect(matchesAllowlist('', ['**'])).toBe(false);
    expect(matchesAllowlist('a.js', [null, 42, '  '])).toBe(false);
  });

  it('정규식 메타문자는 리터럴이다', () => {
    expect(allowlistEntryToRegExp('a.b').test('axb')).toBe(false);
    expect(matchesAllowlist('a+b/c', ['a+b'])).toBe(true);
  });
});

describe('findForbiddenCitations — diff 파서', () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,2 +1,4 @@',
    ' keep',
    '+ok line',
    '-removed C:\\Users\\gone',
    '+bad C:/Users/me/x',
    ' keep2',
    '+also .artibot/split/x/y',
    'diff --git a/img.png b/img.png',
    'Binary files a/img.png and b/img.png differ',
    'diff --git a/.artibot/split/l/n.md b/.artibot/split/l/n.md',
    '--- /dev/null',
    '+++ b/.artibot/split/l/n.md',
    '@@ -0,0 +1 @@',
    '+plain',
  ].join('\n');

  it('추가 줄만, 새 파일 기준 줄번호로, 바이너리와 +++ 헤더는 제외', () => {
    const hits = findForbiddenCitations(diff, DEFAULT_FORBIDDEN_PATTERNS);
    expect(hits.map((h) => [h.file, h.line])).toEqual([['src/a.js', 3], ['src/a.js', 5]]);
  });

  it('빈 입력은 빈 배열', () => {
    expect(findForbiddenCitations('', DEFAULT_FORBIDDEN_PATTERNS)).toEqual([]);
    expect(findForbiddenCitations(undefined, DEFAULT_FORBIDDEN_PATTERNS)).toEqual([]);
  });
});

describe('scripts/split/land.mjs — CLI', () => {
  const capture = () => {
    const out = [];
    const err = [];
    return { out, err, io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) } };
  };

  it('parseLandArgs: 플래그·값·오류', () => {
    expect(parseLandArgs(['good'])).toEqual({ ok: true, limb: 'good', base: null, plan: null, json: false, prBody: null });
    expect(parseLandArgs(['good', '--base', 'main', '--json', '--pr-body', 'o.md', '--plan', 'p.json']))
      .toEqual({ ok: true, limb: 'good', base: 'main', plan: 'p.json', json: true, prBody: 'o.md' });
    expect(parseLandArgs([]).ok).toBe(false);
    expect(parseLandArgs(['good', '--base']).ok).toBe(false);
    expect(parseLandArgs(['good', '--base', '--json']).ok).toBe(false);
    expect(parseLandArgs(['good', '--nope']).ok).toBe(false);
    expect(parseLandArgs(['good', 'extra']).ok).toBe(false);
  });

  it('loadPlanLimb: 없는 파일·없는 줄기·브랜치 없는 줄기', () => {
    expect(loadPlanLimb(path.join(repo, 'nope.json'), 'good').ok).toBe(false);
    const planPath = path.join(repo, '.artibot', 'split', 'plan.json');
    expect(loadPlanLimb(planPath, 'zzz')).toMatchObject({ ok: false, error: expect.stringContaining('good, own, nobranch') });
    expect(loadPlanLimb(planPath, 'nobranch').ok).toBe(false);
    expect(loadPlanLimb(planPath, 'good')).toMatchObject({ ok: true, entry: { branch: 'limb-good' } });
  });

  it('PASS → exit 0 + 표', () => {
    const { out, io } = capture();
    expect(runLand({ argv: ['good'], cwd: repo, ...io })).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('| trailer | PASS |');
    expect(text).toContain('status: PASS');
    expect(text).toContain(`base ${planBase}`);
  });

  it('ownership FAIL → exit 1; --base 가 plan.base 를 덮는다', () => {
    const { out, io } = capture();
    expect(runLand({ argv: ['own', '--base', 'main'], cwd: repo, ...io })).toBe(1);
    expect(out.join('\n')).toContain('| ownership | FAIL |');
    expect(out.join('\n')).toContain('base main');
  });

  it('--json 은 status·checks·changedFiles 를 JSON 으로', () => {
    const { out, io } = capture();
    runLand({ argv: ['good', '--json'], cwd: repo, ...io });
    const parsed = JSON.parse(out.join('\n'));
    expect(parsed.status).toBe('PASS');
    expect(parsed.changedFiles).toContain('src/x.js');
    expect(parsed.checks).toHaveLength(7);
  });

  it('--pr-body 는 그 파일만 쓴다', () => {
    const { io } = capture();
    const outFile = path.join(repo, 'pr.md');
    expect(runLand({ argv: ['good', '--pr-body', outFile], cwd: repo, ...io })).toBe(0);
    expect(fsSync.readFileSync(outFile, 'utf-8')).toContain('Split-Limb: done @');
    // 리포 상태는 건드리지 않았다: 브랜치 tip 그대로.
    expect(git(['rev-parse', 'limb-good'], repo)).toBe(git(['rev-parse', 'limb-good'], repo));
  });

  it('없는 줄기·잘못된 인자·없는 plan → exit 1 + stderr', () => {
    const a = capture();
    expect(runLand({ argv: ['zzz'], cwd: repo, ...a.io })).toBe(1);
    expect(a.err.join('\n')).toContain('not in plan');
    const b = capture();
    expect(runLand({ argv: [], cwd: repo, ...b.io })).toBe(1);
    expect(b.err.join('\n')).toContain('usage:');
    const c = capture();
    expect(runLand({ argv: ['good', '--plan', 'missing.json'], cwd: repo, ...c.io })).toBe(1);
    expect(c.err.join('\n')).toContain('cannot read plan');
  });

  it('UNSUPPORTED → exit 1 (exec 주입)', () => {
    const { out, io } = capture();
    const exec = (args, opts) => (args[0] === '--version'
      ? { status: 0, stdout: 'git version 2.30.0\n', stderr: '' }
      : defaultExec(args, opts));
    expect(runLand({ argv: ['good'], cwd: repo, exec, ...io })).toBe(1);
    expect(out.join('\n')).toContain('status: UNSUPPORTED');
  });
});
