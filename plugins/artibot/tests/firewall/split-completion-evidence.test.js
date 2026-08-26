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
 *   - 값이 `done` 이 아님(`wip`) → 완료 아님
 *   - `Split-Limb: done` 커밋 → 완료 + 그 SHA
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
 *  4. **픽스처 규모**: 줄기 1개·커밋 ≤3. 수백 커밋·`maxCount` 캡 도달은 안 본다.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
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

  it('트레일러 값이 done 이 아니면 완료 아님', () => {
    const r = readLimbCompletion({ cwd: repo, branch: 'worktree-split-tt-wip', base: 'main' });
    expect(r.complete).toBe(false);
    expect(r.reason).toBe('no-trailer');
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
      ['wip', false, 'no-trailer'],
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
});
