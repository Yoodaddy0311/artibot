/**
 * 검사 목적: `/split` 의 완료 판정이 **git 커밋 트레일러**에서 나오는가 —
 * 세션 생존·메시지 도달과 무관하게.
 *
 * ── 왜 트레일러인가 ──────────────────────────────────────────────────────
 * 2026-08-26 라이브 세션(autopilot `--fast`)에서 보고 계약을 도입한 **뒤에도**
 * 팀원 보고가 일반 텍스트로 유실된 것이 5건이었다(PRD 통증 ③). 계약은 이미
 * 실패가 측정된 대책이다. 그래서 `/split` 의 완료는 "메시지가 왔다"가 아니라
 * "줄기 브랜치에 `Split-Limb: done` 트레일러를 단 커밋이 있다"로 정의한다
 * (PRD §설계 완료 판정). 이 파일은 그 판독기 `lib/git/limb-completion.js` 를
 * **임시 리포**에서 실제 git 으로 구동해 다음을 고정한다:
 *
 *   - 브랜치 없음        → 완료 아님 (`no-branch`)
 *   - 커밋 없음(base 와 동일) → 완료 아님 (`no-commits`)  ← "커밋 없으면 완료 아님"
 *   - 커밋은 있으나 트레일러 없음 → 완료 아님 (`no-trailer`)
 *   - 트레일러가 **base 쪽**에만 있음 → 완료 아님 (범위 `base..branch` 가 걸러낸다)
 *   - 값이 `done` 이 아님(`wip`) → 완료 아님 (`superseded`, `lastTrailer: 'wip'`)
 *   - `Split-Limb: done` 커밋 → 완료 + 그 SHA
 *
 * ── 머지 커밋 함정 (2026-09 라이브 런에서 3회 실측) ────────────────────────
 * 줄기 창이 `git merge origin/main` 을 하면 tip 은 트레일러 없는 머지 커밋이 되고,
 * `plan.json` 의 base(계획 시점 `git rev-parse HEAD` — SHA) 는 머지된 main 보다
 * 뒤에 남는다. 예전 판독기는 `<base>..<branch>` 의 **모든** 커밋을 훑었으므로
 * 다른 줄기가 이미 랜딩한 `Split-Limb: done` 이 범위에 들어와 **트레일러를 한 번도
 * 안 쓴 줄기가 done 으로 새는** 것을 임시 리포에서 재현했다(HEAD 519e2529 판독기,
 * 계획 시점 SHA base: `complete:true, doneCommit:"b done"` — 남의 커밋).
 * 지금 규칙: `git log --first-parent <base>..<branch>` 를 최신부터 훑어 **`Split-Limb`
 * 트레일러를 가진 첫 커밋이 결정**한다 — `done` → 완료, 그 외(`wip`) → `superseded`,
 * 하나도 없음 → `no-trailer`. 머지된 main 쪽 커밋은 second-parent 라 보이지 않고,
 * 줄기 자신이 만든 머지 커밋은 first-parent 라 거기 단 트레일러도 그대로 센다.
 *
 * 모든 실패 경로가 `complete:false` 로 수렴한다 — 판독기가 "못 봤다"를 "됐다"로
 * 보고하는 경로가 없다는 것이 이 게이트의 내용이다.
 *
 * ── 이 게이트가 못 보는 것 (rules §9 — 게이트 옆에 적어라) ─────────────────
 *  1. **모델이 트레일러를 실제로 쓰는지는 검증하지 못한다.** 여기서 만든 커밋은
 *     테스트가 쓴 것이다. 줄기 창의 모델이 규약대로 트레일러를 다는지는 라이브
 *     관측(`/split status`)으로만 잡힌다. 문서 존재 ≠ 준수.
 *  2. **트레일러 ≠ 품질.** `done` 은 "창이 끝났다고 선언했다"이지 테스트가
 *     그린이라는 뜻이 아니다. 그 판정은 integrate 의 CI 가 한다.
 *  3. **git 2.22 미만은 `%(trailers:key=…)` 를 모른다.** 그 경우 판독기는
 *     `git-error` → 완료 아님(fail-closed)으로 떨어지지만, 이 테스트는 로컬
 *     git(2.54 실측)으로만 돌아 그 경로를 실제로 밟지 않는다.
 *  4. **픽스처 규모**: 줄기당 커밋 ≤4, 머지 1회. 수백 커밋·`maxCount` 캡 도달·
 *     옥토퍼스 머지(부모 ≥3)는 안 본다.
 *  5. **base 가 살아 있는 ref 일 때의 diff 범위**는 이 판독기의 관심이 아니다 —
 *     소유권 diff 는 `lib/git/limb-landing-check.js` 의 몫이다.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  decideFromTrailers,
  parseLimbLog,
  readLimbCompletion,
  readPlanCompletion,
  SPLIT_LIMB_DONE,
  SPLIT_LIMB_TRAILER,
} from '../../lib/git/limb-completion.js';

let repo = '';

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim();
}

function commitFile(cwd, name, messages) {
  fsSync.writeFileSync(path.join(cwd, name), `${name}\n`, 'utf-8');
  git(['add', name], cwd);
  git(['commit', '-q', ...messages.flatMap((m) => ['-m', m])], cwd);
  return git(['rev-parse', 'HEAD'], cwd);
}

const DONE_LINE = `${SPLIT_LIMB_TRAILER}: ${SPLIT_LIMB_DONE}`;
let doneSha = '';

beforeAll(() => {
  // 임시 디렉터리 전용 — 사용자 리포를 건드리지 않는다.
  repo = fsSync.mkdtempSync(path.join(os.tmpdir(), 'artibot-limb-'));
  git(['init', '-q', '-b', 'main', '.'], repo);
  git(['config', 'user.email', 'test@example.invalid'], repo);
  git(['config', 'user.name', 'test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  commitFile(repo, 'seed.txt', ['init']);

  // base 쪽에 트레일러를 심어 둔다 — 범위 밖 트레일러가 새는지 보기 위해.
  commitFile(repo, 'base-done.txt', ['chore: earlier limb landed', DONE_LINE]);

  // 줄기 1: 커밋 0 (base 와 동일)
  git(['branch', 'worktree-split-tt-empty', 'main'], repo);
  // 줄기 2: 커밋은 있으나 트레일러 없음
  git(['checkout', '-q', '-b', 'worktree-split-tt-notrailer', 'main'], repo);
  commitFile(repo, 'a.txt', ['feat: partial']);
  // 줄기 3: 트레일러 값이 done 이 아님
  git(['checkout', '-q', '-b', 'worktree-split-tt-wip', 'main'], repo);
  commitFile(repo, 'b.txt', ['feat: still going', `${SPLIT_LIMB_TRAILER}: wip`]);
  // 줄기 4: 완료 — 첫 커밋은 트레일러 없음, 둘째가 done
  git(['checkout', '-q', '-b', 'worktree-split-tt-done', 'main'], repo);
  commitFile(repo, 'c.txt', ['feat: c part 1']);
  doneSha = commitFile(repo, 'd.txt', ['feat: c part 2', DONE_LINE]);
  git(['checkout', '-q', 'main'], repo);
});

afterAll(() => {
  try {
    fsSync.rmSync(repo, { recursive: true, force: true });
  } catch { /* best effort */ }
});

describe('완료 판정 — 실패 경로는 전부 complete:false 로 수렴한다', () => {
  it('브랜치가 없으면 완료 아님 (no-branch)', () => {
    const r = readLimbCompletion({ cwd: repo, branch: 'worktree-split-tt-missing', base: 'main' });
    expect(r.complete).toBe(false);
    expect(r.reason).toBe('no-branch');
    expect(r.doneCommit).toBeNull();
  });

  it('커밋이 없으면 완료 아님 (no-commits) — base 와 같은 SHA', () => {
    const r = readLimbCompletion({ cwd: repo, branch: 'worktree-split-tt-empty', base: 'main' });
    expect(r.complete).toBe(false);
    expect(r.reason).toBe('no-commits');
    expect(r.commitCount).toBe(0);
  });

  it('커밋은 있으나 트레일러가 없으면 완료 아님 (no-trailer)', () => {
    const r = readLimbCompletion({ cwd: repo, branch: 'worktree-split-tt-notrailer', base: 'main' });
    expect(r.complete).toBe(false);
    expect(r.reason).toBe('no-trailer');
    expect(r.commitCount).toBe(1);
  });

  it('트레일러 값이 done 이 아니면 완료 아님 (superseded + lastTrailer)', () => {
    const r = readLimbCompletion({ cwd: repo, branch: 'worktree-split-tt-wip', base: 'main' });
    expect(r.complete).toBe(false);
    expect(r.reason).toBe('superseded');
    expect(r.lastTrailer).toBe('wip');
    expect(r.doneCommit).toBeNull();
  });

  it('base 쪽에만 있는 트레일러는 세지 않는다 (범위 base..branch)', () => {
    // main 자체에는 DONE 트레일러 커밋이 있다 — 그것이 줄기 판정에 새면 안 된다.
    expect(git(['log', '-1', '--format=%(trailers:key=Split-Limb,valueonly)', 'main'], repo)).toBe('done');
    const r = readLimbCompletion({ cwd: repo, branch: 'worktree-split-tt-empty', base: 'main' });
    expect(r.complete).toBe(false);
  });

  it('base 를 생략하면 브랜치 전체를 보므로 base 의 트레일러가 샌다 — 그래서 base 를 넘겨야 한다', () => {
    // 이 케이스는 "왜 base 인자가 있는가"를 고정한다. 결함이 아니라 계약이다.
    const r = readLimbCompletion({ cwd: repo, branch: 'worktree-split-tt-empty' });
    expect(r.complete).toBe(true);
  });

  it('잘못된 입력·비리포 cwd 는 던지지 않고 완료 아님', () => {
    expect(readLimbCompletion({ cwd: repo, branch: '', base: 'main' }).reason).toBe('bad-input');
    expect(readLimbCompletion({ cwd: '', branch: 'x' }).reason).toBe('bad-input');
    const notRepo = fsSync.mkdtempSync(path.join(os.tmpdir(), 'artibot-notrepo-'));
    try {
      const r = readLimbCompletion({ cwd: notRepo, branch: 'worktree-split-tt-done', base: 'main' });
      expect(r.complete).toBe(false);
      expect(['no-branch', 'git-error']).toContain(r.reason);
    } finally {
      fsSync.rmSync(notRepo, { recursive: true, force: true });
    }
  });

  it('base 가 해소되지 않으면 완료 아님 (git-error, fail-closed)', () => {
    const r = readLimbCompletion({ cwd: repo, branch: 'worktree-split-tt-done', base: 'no-such-base' });
    expect(r.complete).toBe(false);
    expect(r.reason).toBe('git-error');
  });
});

describe('완료 판정 — 트레일러 커밋이 있으면 완료 + 증거 SHA', () => {
  it('`Split-Limb: done` 커밋을 찾고 그 SHA 를 돌려준다', () => {
    const r = readLimbCompletion({ cwd: repo, branch: 'worktree-split-tt-done', base: 'main' });
    expect(r.complete).toBe(true);
    expect(r.reason).toBe('done');
    expect(r.commitCount).toBe(2);
    expect(r.doneCommit?.sha).toBe(doneSha);
    expect(r.doneCommit?.subject).toBe('feat: c part 2');
    expect(r.lastTrailer).toBe('done');
  });

  it('worktree 안에서 읽어도 같은 답이다 (git-dir 관례 — cwd 는 어느 체크아웃이든 된다)', () => {
    const wt = path.join(repo, 'wt-done');
    git(['worktree', 'add', '-q', wt, 'worktree-split-tt-done'], repo);
    try {
      const r = readLimbCompletion({ cwd: wt, branch: 'worktree-split-tt-done', base: 'main' });
      expect(r.complete).toBe(true);
      expect(r.doneCommit?.sha).toBe(doneSha);
    } finally {
      git(['worktree', 'remove', '--force', wt], repo);
    }
  });

  it('readPlanCompletion 은 줄기별로 독립 판정하고 순서를 지킨다', () => {
    const rows = readPlanCompletion({
      cwd: repo,
      base: 'main',
      limbs: [
        { limb: 'done', branch: 'worktree-split-tt-done' },
        { limb: 'missing', branch: 'worktree-split-tt-missing' },
        { limb: 'wip', branch: 'worktree-split-tt-wip' },
      ],
    });
    expect(rows.map((r) => [r.limb, r.complete, r.reason])).toEqual([
      ['done', true, 'done'],
      ['missing', false, 'no-branch'],
      ['wip', false, 'superseded'],
    ]);
  });
});

describe('머지 커밋 함정 — first-parent 최신 트레일러가 결정한다', () => {
  let mrepo = '';
  let planBase = '';
  let ownDoneSha = '';
  let mergeDoneSha = '';

  beforeAll(() => {
    mrepo = fsSync.mkdtempSync(path.join(os.tmpdir(), 'artibot-limb-merge-'));
    git(['init', '-q', '-b', 'main', '.'], mrepo);
    git(['config', 'user.email', 'test@example.invalid'], mrepo);
    git(['config', 'user.name', 'test'], mrepo);
    git(['config', 'commit.gpgsign', 'false'], mrepo);
    commitFile(mrepo, 'seed.txt', ['init']);
    // 계획 시점 base — plan.json 은 `git rev-parse HEAD` 의 SHA 를 저장한다(split.md §plan 7).
    planBase = git(['rev-parse', 'HEAD'], mrepo);

    // (a) 줄기 A: done 을 쓴 뒤 main 이 전진한 것을 머지한다.
    git(['checkout', '-q', '-b', 'limb-a', 'main'], mrepo);
    ownDoneSha = commitFile(mrepo, 'a.txt', ['feat: a', DONE_LINE]);
    // (b) 줄기 B: 트레일러 없이 작업만.
    git(['checkout', '-q', '-b', 'limb-b', 'main'], mrepo);
    commitFile(mrepo, 'b.txt', ['feat: b partial']);
    // (c) 줄기 C: done 뒤에 wip.
    git(['checkout', '-q', '-b', 'limb-c', 'main'], mrepo);
    commitFile(mrepo, 'c.txt', ['feat: c', DONE_LINE]);
    commitFile(mrepo, 'c2.txt', ['feat: c reopened', `${SPLIT_LIMB_TRAILER}: wip`]);
    // (d) 줄기 D: 트레일러 없는 커밋 뒤, 자신이 만든 머지 커밋에 done.
    git(['checkout', '-q', '-b', 'limb-d', 'main'], mrepo);
    commitFile(mrepo, 'd.txt', ['feat: d']);

    // 다른 줄기 X 가 done 을 쓰고 main 에 랜딩한다 → main 전진.
    git(['checkout', '-q', '-b', 'limb-x', 'main'], mrepo);
    commitFile(mrepo, 'x.txt', ['feat: x landed', DONE_LINE]);
    git(['checkout', '-q', 'main'], mrepo);
    git(['merge', '-q', '--no-ff', 'limb-x', '-m', 'land x'], mrepo);

    // A·B·D 가 전진한 main 을 머지한다(창에서 `git merge origin/main` 한 것과 동형).
    for (const b of ['limb-a', 'limb-b']) {
      git(['checkout', '-q', b], mrepo);
      git(['merge', '-q', '--no-ff', 'main', '-m', `merge main into ${b}`], mrepo);
    }
    git(['checkout', '-q', 'limb-d'], mrepo);
    git(['merge', '-q', '--no-ff', 'main', '-m', 'merge main into limb-d', '-m', DONE_LINE], mrepo);
    mergeDoneSha = git(['rev-parse', 'HEAD'], mrepo);
    git(['checkout', '-q', 'main'], mrepo);
  });

  afterAll(() => {
    try {
      fsSync.rmSync(mrepo, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  it('시나리오가 진짜다: 계획 시점 SHA base 로 전 커밋을 훑으면 남의 done 이 범위에 들어온다', () => {
    // 이 assert 가 깨지면 아래 (b) 는 아무것도 증명하지 않는다 — 픽스처 자기검증.
    const all = git(['log', '--format=%s|%(trailers:key=Split-Limb,valueonly)', `${planBase}..limb-b`], mrepo);
    expect(all).toContain('feat: x landed|done');
    const fp = git(['log', '--first-parent', '--format=%s|%(trailers:key=Split-Limb,valueonly)', `${planBase}..limb-b`], mrepo);
    expect(fp).not.toContain('feat: x landed');
  });

  it('(a) done 뒤에 전진한 main 을 머지해도 여전히 done — tip 이 머지 커밋이어도 amend 불필요', () => {
    for (const base of [planBase, 'main']) {
      const r = readLimbCompletion({ cwd: mrepo, branch: 'limb-a', base });
      expect(r.complete).toBe(true);
      expect(r.reason).toBe('done');
      expect(r.doneCommit?.sha).toBe(ownDoneSha);
    }
  });

  it('(b) 남의 done 이 머지돼 들어와도 트레일러 없는 줄기는 no-trailer — 누수 없음', () => {
    const r = readLimbCompletion({ cwd: mrepo, branch: 'limb-b', base: planBase });
    expect(r.complete).toBe(false);
    expect(r.reason).toBe('no-trailer');
    expect(r.doneCommit).toBeNull();
    // first-parent 커밋 수: 'feat: b partial' + 머지 커밋 = 2 (x 의 커밋은 세지 않는다)
    expect(r.commitCount).toBe(2);
  });

  it('(c) done 뒤 wip 은 superseded — 최신 트레일러가 결정한다', () => {
    const r = readLimbCompletion({ cwd: mrepo, branch: 'limb-c', base: planBase });
    expect(r.complete).toBe(false);
    expect(r.reason).toBe('superseded');
    expect(r.lastTrailer).toBe('wip');
  });

  it('(d) 줄기 자신의 머지 커밋에 단 done 도 센다 (예전 amend 우회와 호환)', () => {
    const r = readLimbCompletion({ cwd: mrepo, branch: 'limb-d', base: planBase });
    expect(r.complete).toBe(true);
    expect(r.doneCommit?.sha).toBe(mergeDoneSha);
    expect(r.doneCommit?.subject).toBe('merge main into limb-d');
  });

  it('readPlanCompletion 도 같은 규칙 — 줄기별 reason 이 섞이지 않는다', () => {
    const rows = readPlanCompletion({
      cwd: mrepo,
      base: planBase,
      limbs: [
        { limb: 'a', branch: 'limb-a' },
        { limb: 'b', branch: 'limb-b' },
        { limb: 'c', branch: 'limb-c' },
        { limb: 'd', branch: 'limb-d' },
      ],
    });
    expect(rows.map((r) => [r.limb, r.complete, r.reason, r.lastTrailer])).toEqual([
      ['a', true, 'done', 'done'],
      ['b', false, 'no-trailer', null],
      ['c', false, 'superseded', 'wip'],
      ['d', true, 'done', 'done'],
    ]);
  });
});

describe('파서 — git 없이 형식만', () => {
  it('레코드/필드 구분자를 따라 sha·트레일러·subject 를 나눈다', () => {
    const raw = 'abc\x1fdone\x1ffeat: x\x1e\ndef\x1f\x1ffeat: y\x1e\n';
    const rows = parseLimbLog(raw);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ sha: 'abc', subject: 'feat: x', trailers: ['done'] });
    expect(rows[1].trailers).toEqual([]);
  });

  it('빈 입력은 빈 배열', () => {
    expect(parseLimbLog('')).toEqual([]);
    expect(parseLimbLog(undefined)).toEqual([]);
  });

  it('decideFromTrailers — 최신(첫) 트레일러 커밋이 결정하고 트레일러 없는 커밋은 건너뛴다', () => {
    const c = (sha, trailers) => ({ sha, subject: sha, trailers });
    expect(decideFromTrailers([c('m', []), c('d', ['done'])])).toMatchObject({ reason: 'done', lastTrailer: 'done' });
    expect(decideFromTrailers([c('w', ['wip']), c('d', ['done'])])).toMatchObject({ reason: 'superseded', lastTrailer: 'wip' });
    expect(decideFromTrailers([c('m', []), c('p', [])])).toEqual({ reason: 'no-trailer', decisive: null, lastTrailer: null });
    // Within one commit the LAST Split-Limb value decides (review finding
    // 2026-09-02: `.some()` let a commit carrying both wip and done pass).
    expect(decideFromTrailers([c('x', ['done', 'wip'])])).toMatchObject({ reason: 'superseded', lastTrailer: 'wip' });
    expect(decideFromTrailers([c('x', ['wip', 'done'])])).toMatchObject({ reason: 'done', lastTrailer: 'done' });
    expect(decideFromTrailers([c('x', ['DONE'])])).toMatchObject({ reason: 'done' });
    expect(decideFromTrailers([c('u', ['Done'])]).reason).toBe('done');
    expect(decideFromTrailers(undefined).reason).toBe('no-trailer');
  });
});
