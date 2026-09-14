/**
 * `scripts/split/land.mjs` — base precedence `--base` > `forkPoint` > `plan.base`.
 *
 * WHAT THIS PROVES, and why it is a temp repo rather than a unit test: the
 * defect is a git RANGE, not a branch of JS. `plan.base` is the SHA at plan
 * time; the worktree is created later and forks off an integration branch that
 * has since advanced, so `plan.base...branch` sweeps in every commit that
 * landed in between and `ownership` FAILs on files no one on the limb touched.
 * Measured 2026-09-14 against the pre-change code, the `forkPoint` case below
 * printed `ownership FAIL — 1 outside allowlist: docs/other.md`; it is PASS
 * here. Only a real repo with a real advanced branch shows that.
 *
 * WHAT IT CANNOT PROVE (rules §9): that the leader no longer has to think about
 * the base. The fixture is 1 intervening commit and 1 changed file; a limb that
 * MERGED an advanced main is not exercised and is exactly the case `--base`
 * still exists for.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { effectiveBase, formatEffectiveBase, runLand } from '../../scripts/split/land.mjs';

const git = (args, cwd) => execFileSync('git', args, {
  cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
}).trim();

const capture = () => {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) } };
};

describe('runLand — forkPoint 가 plan.base 를 대신한다', () => {
  let repo = '';
  let b0 = '';
  let b1 = '';
  let planPath = '';

  /** Rewrite plan.json with (or without) a recorded fork point. */
  const writePlan = (extra) => fsSync.writeFileSync(planPath, JSON.stringify({
    runId: 'fork-test',
    base: b0,
    repoShort: 'tt',
    // No `.js` under `plugins/artibot/`, so the `lint` row is SKIP and this
    // fixture needs no worktree — same trick as `land-pin-tests.test.js`.
    limbs: [{ limb: 'mine', branch: 'limb-mine', worktreePath: '', affectedPaths: ['src/**'], ...extra }],
  }, null, 2));

  const run = (argv) => {
    const c = capture();
    const code = runLand({ argv, cwd: repo, ...c.io });
    return { code, text: c.out.join('\n'), err: c.err.join('\n') };
  };

  beforeAll(() => {
    repo = fsSync.mkdtempSync(path.join(os.tmpdir(), 'artibot-land-fork-'));
    git(['init', '-q', '-b', 'master', '.'], repo);
    git(['config', 'user.email', 'test@example.invalid'], repo);
    git(['config', 'user.name', 'test'], repo);
    git(['config', 'commit.gpgsign', 'false'], repo);

    fsSync.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
    git(['add', 'seed.txt'], repo);
    git(['commit', '-q', '-m', 'chore: seed'], repo);
    b0 = git(['rev-parse', 'HEAD'], repo);

    // master advances — ANOTHER limb's batch lands while this plan is open.
    fsSync.mkdirSync(path.join(repo, 'docs'), { recursive: true });
    fsSync.writeFileSync(path.join(repo, 'docs', 'other.md'), 'another limb\n');
    git(['add', 'docs/other.md'], repo);
    git(['commit', '-q', '-m', 'docs: another limb landed'], repo);
    b1 = git(['rev-parse', 'HEAD'], repo);

    // This limb's worktree is cut from b1, not from the plan-time b0.
    git(['checkout', '-q', '-b', 'limb-mine', b1], repo);
    fsSync.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fsSync.writeFileSync(path.join(repo, 'src', 'mine.txt'), 'mine\n');
    git(['add', 'src/mine.txt'], repo);
    git(['commit', '-q', '-m', 'feat: mine', '-m', 'Split-Limb: done'], repo);
    git(['checkout', '-q', 'master'], repo);

    const dir = path.join(repo, '.artibot', 'split');
    fsSync.mkdirSync(dir, { recursive: true });
    planPath = path.join(dir, 'plan.json');
  });

  afterAll(() => {
    try {
      fsSync.rmSync(repo, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  it('forkPoint 미기록 → plan.base 폴백, 남의 파일이 ownership FAIL (회귀 재현)', () => {
    writePlan({});
    const r = run(['mine']);
    expect(r.code).toBe(1);
    expect(r.text).toContain('| ownership | FAIL |');
    expect(r.text).toContain('docs/other.md');
    expect(r.text).toContain('source=plan');
  });

  it('forkPoint 미기록이면 merge-base 를 정보로 보여주고 --base 를 안내한다', () => {
    writePlan({});
    const r = run(['mine']);
    // 정보일 뿐이다: base 로 쓰였다면 위 케이스가 PASS 였을 것이다.
    expect(r.text).toContain(`--base ${b1.slice(0, 12)}`);
    expect(r.text).toContain(`base ${b0}`);
  });

  it('forkPoint 기록 → 같은 줄기가 PASS, 앞선 커밋 수를 병기한다', () => {
    writePlan({ forkPoint: b1 });
    const r = run(['mine']);
    expect(r.code).toBe(0);
    expect(r.text).toContain('| ownership | PASS |');
    expect(r.text).toContain('status: PASS');
    expect(r.text).toContain('source=forkPoint');
    expect(r.text).toContain('1 commits 앞');
  });

  it('--base 명시는 forkPoint 를 이긴다 — 옛 base 를 주면 다시 FAIL', () => {
    writePlan({ forkPoint: b1 });
    const r = run(['mine', '--base', b0]);
    expect(r.code).toBe(1);
    expect(r.text).toContain('| ownership | FAIL |');
    expect(r.text).toContain('source=cli');
  });

  it('--json 은 effectiveBase 를 싣되 checks 는 7 그대로', () => {
    writePlan({ forkPoint: b1 });
    const r = run(['mine', '--json']);
    const parsed = JSON.parse(r.text);
    // 소유 밖 핀 2건(tests/git/limb-landing-check.test.js · land-pin-tests.test.js)
    // 이 같은 7 을 건다: 이 절은 checks[] 행이 아니라 별도 필드다.
    expect(parsed.checks).toHaveLength(7);
    expect(parsed.base).toBe(b1);
    expect(parsed.effectiveBase).toEqual({
      base: b1,
      source: 'forkPoint',
      planBase: b0,
      forkPoint: b1,
      aheadOfPlanBase: 1,
      mergeBase: null,
      note: expect.stringContaining('1 commits 앞'),
    });
  });

  it('빈 문자열 forkPoint 는 미기록과 같다 (기록됐다고 읽지 않는다)', () => {
    writePlan({ forkPoint: '   ' });
    const r = run(['mine']);
    expect(r.code).toBe(1);
    expect(r.text).toContain('source=plan');
  });
});

describe('effectiveBase — 순수 결정 + 문구', () => {
  const okExec = (map) => (args) => {
    const key = args.join(' ');
    const hit = Object.entries(map).find(([k]) => key.startsWith(k));
    return hit ? hit[1] : { status: 1, stdout: '', stderr: 'unexpected call\n' };
  };

  it('세 source 의 note 는 앞 12자로 서로 구분된다 (표는 잘려 읽힌다)', () => {
    const notes = [
      effectiveBase({ cliBase: 'master', planBase: 'p'.repeat(40), branch: 'b', exec: okExec({}) }).note,
      effectiveBase({
        planBase: 'p'.repeat(40),
        forkPoint: 'f'.repeat(40),
        branch: 'b',
        exec: okExec({ 'rev-list': { status: 0, stdout: '2\n', stderr: '' }, 'merge-base --is-ancestor': { status: 0, stdout: '', stderr: '' } }),
      }).note,
      effectiveBase({
        planBase: 'p'.repeat(40),
        branch: 'b',
        exec: okExec({ 'merge-base': { status: 0, stdout: `${'p'.repeat(40)}\n`, stderr: '' } }),
      }).note,
    ];
    const heads = notes.map((n) => n.slice(0, 12));
    expect(new Set(heads).size).toBe(3);
  });

  it('cli 는 forkPoint 가 있어도 이기고 git 을 부르지 않는다', () => {
    let calls = 0;
    const info = effectiveBase({
      cliBase: ' master ',
      planBase: 'p',
      forkPoint: 'f',
      branch: 'b',
      exec: () => { calls += 1; return { status: 0, stdout: '', stderr: '' }; },
    });
    expect(info).toMatchObject({ base: 'master', source: 'cli', forkPoint: 'f', aheadOfPlanBase: null, mergeBase: null });
    expect(calls).toBe(0);
  });

  it('forkPoint === plan.base 면 "같음" 이라 적고 rev-list 를 부르지 않는다', () => {
    const info = effectiveBase({ planBase: 'abc', forkPoint: 'abc', branch: 'b', exec: () => { throw new Error('should not run'); } });
    expect(info).toMatchObject({ base: 'abc', source: 'forkPoint', aheadOfPlanBase: null });
    expect(info.note).toContain('plan.base 와 같음');
  });

  it('forkPoint 가 plan.base 의 후손이 아니면 쓰되 조용히 넘기지 않는다', () => {
    const info = effectiveBase({
      planBase: 'p',
      forkPoint: 'f',
      branch: 'b',
      exec: okExec({ 'rev-list': { status: 0, stdout: '3\n', stderr: '' }, 'merge-base --is-ancestor': { status: 1, stdout: '', stderr: '' } }),
    });
    expect(info.base).toBe('f');
    expect(info.note).toContain('후손이 아님');
  });

  it('rev-list 실패는 미확인으로 적고 base 는 그대로 forkPoint', () => {
    const info = effectiveBase({
      planBase: 'p',
      forkPoint: 'f',
      branch: 'b',
      exec: okExec({ 'rev-list': { status: 128, stdout: '', stderr: 'bad revision\n' }, 'merge-base --is-ancestor': { status: 0, stdout: '', stderr: '' } }),
    });
    expect(info).toMatchObject({ base: 'f', source: 'forkPoint', aheadOfPlanBase: null });
    expect(info.note).toContain('미확인');
  });

  it('merge-base 실패는 사유를 적고 절대 base 로 쓰이지 않는다', () => {
    const info = effectiveBase({
      planBase: 'p',
      branch: 'b',
      exec: okExec({ 'merge-base': { status: 128, stdout: '', stderr: 'fatal: Not a valid object name\n' } }),
    });
    expect(info).toMatchObject({ base: 'p', source: 'plan', mergeBase: null });
    expect(info.note).toContain('fatal: Not a valid object name');
  });

  it('plan.base 도 forkPoint 도 없으면 base 는 빈 문자열 (호출자가 거부한다)', () => {
    const info = effectiveBase({ branch: 'b', exec: () => { throw new Error('should not run'); } });
    expect(info).toMatchObject({ base: '', source: 'plan', mergeBase: null });
  });

  it('formatEffectiveBase 는 base·source·note 를 한 줄로 낸다', () => {
    const line = formatEffectiveBase({ base: 'abc', source: 'cli', note: '왜' });
    expect(line).toBe('effective base: abc · source=cli — 왜');
    expect(line.split('\n')).toHaveLength(1);
    expect(formatEffectiveBase({ base: '', source: 'plan', note: '없다' })).toContain('(없음)');
  });
});
