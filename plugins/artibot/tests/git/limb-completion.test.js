/**
 * `lib/git/limb-completion.js` — 부하 중 git 타임아웃은 "브랜치 없음"이 아니다
 * (2026-09-28 리더 관측).
 *
 * 예전 판독기는 git 의 모든 실패를 `{ok:false}` 하나로 뭉갰다. 부하 배치가 함께
 * 돌 때 `rev-parse --verify --quiet refs/heads/<b>` 가 5초 timeout 에 죽으면, 실재하는
 * 브랜치가 `no-branch` 로 보고됐다(직후 `git branch --list` 로 실재 확인). 지금 규칙:
 * `no-branch` 는 **exit 1 + 빈 출력**(git 자신의 "없다")일 때만. 그 밖의 실패
 * (timeout kill·signal·기타 exit)는 1회 재시도 후 `git-error`. 새 reason 어휘는 없다
 * (`commands/split.md` §status 2 의 닫힌 목록).
 *
 * 타임아웃은 가짜로 지어내지 않는다 — `beforeAll` 에서 멈춘 node 자식을 실제
 * `execFileSync` timeout(200ms)으로 죽여 Node 가 던지는 오류 객체를 그대로 받아 쓴다.
 * 주입은 `readLimbCompletion({ execFile })` 시임 하나다.
 *
 * 완료 판정 자체(no-commits·no-trailer·superseded·first-parent 머지 함정 등)의 핀은
 * `tests/firewall/split-completion-evidence.test.js` 에 있다. 이 파일은 git 실패 분류만 본다.
 *
 * 못 보는 것: 실제 부하로 git 이 느려지는 경로 자체(5000ms timeout 도달)는 재현하지
 * 않는다 — 오류 객체의 모양만 실물이고, 언제 나는지는 주입이다.
 *
 * 임시 리포 전용 — 사용자 리포를 건드리지 않는다.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readLimbCompletion,
  SPLIT_LIMB_DONE,
  SPLIT_LIMB_TRAILER,
} from '../../lib/git/limb-completion.js';

let repo = '';
let doneSha = '';

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

beforeAll(() => {
  repo = fsSync.mkdtempSync(path.join(os.tmpdir(), 'artibot-limb-timeout-'));
  git(['init', '-q', '-b', 'main', '.'], repo);
  git(['config', 'user.email', 'test@example.invalid'], repo);
  git(['config', 'user.name', 'test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  commitFile(repo, 'seed.txt', ['init']);
  // 완료된 줄기 하나 — 트레일러 없는 커밋 뒤에 done.
  git(['checkout', '-q', '-b', 'worktree-split-tt-done', 'main'], repo);
  commitFile(repo, 'c.txt', ['feat: c part 1']);
  doneSha = commitFile(repo, 'd.txt', ['feat: c part 2', `${SPLIT_LIMB_TRAILER}: ${SPLIT_LIMB_DONE}`]);
  git(['checkout', '-q', 'main'], repo);
});

afterAll(() => {
  try {
    fsSync.rmSync(repo, { recursive: true, force: true });
  } catch { /* best effort */ }
});

describe('git 타임아웃 ≠ no-branch — 재시도 1회 후 git-error', () => {
  /** @type {Error & {status?: number|null, signal?: string, code?: string}} */
  let timeoutError;

  beforeAll(() => {
    try {
      execFileSync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 200, windowsHide: true,
      });
    } catch (err) {
      timeoutError = err;
    }
    // 픽스처 자기검증: 이것이 진짜 timeout 오류가 아니면 아래 케이스는 아무것도 증명하지 않는다.
    expect(timeoutError?.code).toBe('ETIMEDOUT');
    expect(timeoutError?.status).toBeNull();
  });

  const isBranchProbe = (args) => args[0] === 'rev-parse' && String(args.at(-1)).startsWith('refs/heads/');

  /** `failures` 번째까지의 브랜치 probe 만 timeout 으로 던지고, 나머지는 실제 git. */
  function flakyExec(failures, box) {
    return (file, args, opts) => {
      if (isBranchProbe(args)) {
        box.probes += 1;
        if (box.probes <= failures) throw timeoutError;
      }
      return execFileSync(file, args, opts);
    };
  }

  it('브랜치 실재 + 첫 probe timeout → 재시도 성공, done (no-branch 아님)', () => {
    const box = { probes: 0 };
    const r = readLimbCompletion({ cwd: repo, branch: 'worktree-split-tt-done', base: 'main', execFile: flakyExec(1, box) });
    expect(r.reason).toBe('done');
    expect(r.doneCommit?.sha).toBe(doneSha);
    expect(box.probes).toBe(2);
  });

  it('브랜치 실재 + probe 가 두 번 다 timeout → git-error (no-branch 아님), 재시도는 1회뿐', () => {
    const box = { probes: 0 };
    const r = readLimbCompletion({ cwd: repo, branch: 'worktree-split-tt-done', base: 'main', execFile: flakyExec(2, box) });
    expect(r.complete).toBe(false);
    expect(r.reason).toBe('git-error');
    expect(box.probes).toBe(2);
  });

  it('브랜치 부재 → 여전히 no-branch, 재시도 없음 (exit 1 + 빈 출력은 git 자신의 "없다")', () => {
    const box = { probes: 0 };
    const r = readLimbCompletion({ cwd: repo, branch: 'worktree-split-tt-missing', base: 'main', execFile: flakyExec(0, box) });
    expect(r.reason).toBe('no-branch');
    expect(box.probes).toBe(1);
  });

  it('log 가 한 번 timeout 나도 재시도로 done — base·log 도 같은 규칙', () => {
    let logs = 0;
    const r = readLimbCompletion({
      cwd: repo,
      branch: 'worktree-split-tt-done',
      base: 'main',
      execFile: (file, args, opts) => {
        if (args[0] === 'log' && (logs += 1) === 1) throw timeoutError;
        return execFileSync(file, args, opts);
      },
    });
    expect(r.reason).toBe('done');
    expect(logs).toBe(2);
  });
});

/**
 * 저장소가 아닌 cwd 에서 git 은 exit 128(fatal: not a git repository)로 끝난다 —
 * git 자신의 "브랜치 없음"(exit 1)이 아니므로 `git-error` 다. 예전에는 `no-branch` 였다.
 * (`split-completion-evidence.test.js` 의 비리포 케이스는 두 값을 다 받는다 — 여기서 좁힌다.)
 *
 * 임시 디렉터리가 우연히 상위 리포 안에 있으면 git 이 그 리포를 찾아 exit 1 을 낸다.
 * 그래서 `GIT_CEILING_DIRECTORIES` 로 탐색을 임시 디렉터리의 부모에서 멈추고, 실제 git 이
 * 128 을 내는지 먼저 잰다(픽스처 자기검증).
 */
describe('저장소가 아닌 cwd → git-error (exit 128 은 "없다"가 아니다)', () => {
  let notRepo = '';
  let savedCeiling;

  beforeAll(() => {
    notRepo = fsSync.mkdtempSync(path.join(os.tmpdir(), 'artibot-limb-notrepo-'));
    savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(notRepo);
  });

  afterAll(() => {
    if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
    try {
      fsSync.rmSync(notRepo, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  it('비리포 cwd 는 no-branch 가 아니라 git-error', () => {
    let status = null;
    try {
      git(['rev-parse', '--verify', '--quiet', 'refs/heads/worktree-split-tt-done'], notRepo);
    } catch (err) {
      status = err.status;
    }
    expect(status).toBe(128);

    const r = readLimbCompletion({ cwd: notRepo, branch: 'worktree-split-tt-done', base: 'main' });
    expect(r.complete).toBe(false);
    expect(r.reason).toBe('git-error');
  });
});
