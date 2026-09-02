/**
 * 검사 목적: 자동 커밋이 **실패했을 때 인덱스를 오염시킨 채 남기지 않는다**.
 *
 * ── 결함 (레인 C, C-1) ────────────────────────────────────────────────────────
 * 자동 커밋 4곳이 전부 `git add -A` → `git commit` 을 `try` 로 감싸고 실패를
 * `catch { return false }` 로 삼켰다. 커밋이 실패해도 **`add -A` 로 스테이징된
 * 인덱스는 그대로 남는다.** v4.7.2 이후 `bypassPreCommitHooks` 기본값이 false 라
 * pre-commit 훅의 거부는 예외가 아니라 **설계된 정상 경로**이고, 그 정상 경로가
 * 곧 오염 경로였다.
 *
 * 실제 피해: 사용자가 이후 `git commit -m "..."` 만 쳐도 `-A` 가 쓸어담은 전부가
 * 함께 나간다 — 설계문서·스크래치·`.artibot/`·범위 밖 파일. 리포 자신의 규율
 * (rules/verification-discipline.md, RELEASE.md)이 사람에게 금지한 패턴을
 * 자동화가 무인으로 실행하고 있었다.
 *
 * ── 왜 `git reset` 이 아니라 write-tree/read-tree 인가 ────────────────────────
 * `git reset`(mixed)은 **사용자가 직접 스테이징해 둔 것까지** 되돌린다. 실측
 * 2026-08-30(scratch): `A manual.txt` + `?? other.txt` 상태에서 `add -A` 후
 * `read-tree <snapshot>` 하면 정확히 `A manual.txt` + `?? other.txt` 로 돌아오고
 * 워킹트리 파일은 손대지 않는다. `git reset` 이었다면 `manual.txt` 의 스테이징도
 * 사라졌을 것이다. 그래서 복원은 **인덱스 트리 스냅샷**으로 한다.
 *
 * ── 이 테스트가 못 보는 것 (rules §9 — 게이트 옆에 적어라) ────────────────────
 *  - **커밋이 성공하는 경로는 검증하지 않는다.** 여기서 재는 것은 실패 경로의
 *    복원뿐이다. 성공 시 인덱스가 비는 것은 git 의 계약이지 이 코드의 것이 아니다.
 *  - **4개 호출부가 실제로 이 헬퍼를 통과하는지는 정적 스캔으로만 본다.**
 *    아래 배선 게이트는 문자열을 읽을 뿐, 런타임에 그 경로가 실행되는지는
 *    증명하지 못한다. "파일에 있다 ≠ 실행된다".
 *  - **동시 실행은 보지 않는다.** 두 자동화가 같은 리포에서 겹치면
 *    스냅샷–복원 사이에 남이 스테이징한 것이 복원으로 사라질 수 있다. 현재
 *    설계상 save/close 는 같은 세션에서 직렬이지만 그것을 여기서 단언하지 않는다.
 *  - **pre-commit 훅이 인덱스를 스스로 고치는 경우**(포매터가 스테이징을 추가하는
 *    류)는 복원이 그 수정까지 되돌린다. 실패 경로에서만 복원하므로 실무상
 *    문제되지 않지만, 훅이 실패하면서 인덱스를 남기는 설계라면 충돌한다.
 *
 * @module tests/hooks/autocommit-index-restore
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureIndexTree, restoreIndexTree } from '../../lib/git/index-snapshot.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');

let repo = '';

/** Run git in the scratch repo. Throws on non-zero, like the production wrappers. */
function git(args, cwd = repo) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

/**
 * `git status --porcelain` with ONLY trailing whitespace removed.
 *
 * `.trim()` would eat the leading column, and that column is the whole point:
 * ` D f` (deleted in the worktree) and `D  f` (deletion staged) differ by it.
 * Trimming made a staged/unstaged assertion pass for the wrong reason.
 */
function status() {
  return git(['status', '--porcelain']).replace(/\s+$/, '');
}

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'artibot-index-restore-'));
  git(['init', '-q', '.']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'test']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(repo, 'tracked.txt'), 'v1\n');
  git(['add', 'tracked.txt']);
  git(['commit', '-qm', 'init']);

  // A pre-commit hook that ALWAYS rejects — this is the designed-normal path
  // the defect lived on, not an exotic failure.
  const hookPath = path.join(repo, '.git', 'hooks', 'pre-commit');
  writeFileSync(hookPath, '#!/bin/sh\necho "rejected by test hook" >&2\nexit 1\n');
  chmodSync(hookPath, 0o755);
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe('자동 커밋 실패 시 인덱스 복원 (C-1)', () => {
  it('거부하는 pre-commit 훅이 실재한다 (음성 대조의 전제)', () => {
    // NEGATIVE CONTROL PREMISE. 훅이 실제로 커밋을 막지 못하면 아래 테스트는
    // "실패 경로"를 한 번도 밟지 않고 공허하게 통과한다.
    writeFileSync(path.join(repo, 'probe.txt'), 'x\n');
    git(['add', 'probe.txt']);
    let rejected = false;
    try {
      git(['commit', '-qm', 'should be rejected']);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    // 정리: 인덱스와 워킹트리를 원상 복구
    git(['reset', '-q', 'HEAD']);
    rmSync(path.join(repo, 'probe.txt'), { force: true });
    expect(status()).toBe('');
  });

  it('사용자의 수동 스테이징을 보존한 채, add -A 가 더한 것만 되돌린다', () => {
    // 사용자가 직접 하나만 스테이징해 둔 상태.
    writeFileSync(path.join(repo, 'manual.txt'), 'user staged this\n');
    writeFileSync(path.join(repo, 'stray.txt'), 'unrelated scratch\n');
    git(['add', 'manual.txt']);
    const before = status();
    expect(before).toContain('A  manual.txt');
    expect(before).toContain('?? stray.txt');

    // 자동화가 하는 일: 스냅샷 → add -A → 커밋 시도(훅이 거부) → 복원.
    const snapshot = captureIndexTree((args) => git(args));
    expect(snapshot).toBeTruthy();

    git(['add', '-A']);
    // 오염이 실제로 일어났음을 확인 — 이게 없으면 복원 단언이 공허하다.
    expect(status()).toContain('A  stray.txt');

    let committed = true;
    try {
      git(['commit', '-qm', 'auto']);
    } catch {
      committed = false;
    }
    expect(committed).toBe(false);

    const restored = restoreIndexTree((args) => git(args), snapshot);
    expect(restored).toBe(true);

    // 핵심 단언: 인덱스가 add 이전과 바이트 동일한 상태로 돌아왔다.
    expect(status()).toBe(before);
    // 그리고 워킹트리 파일은 하나도 사라지지 않았다.
    expect(existsSync(path.join(repo, 'stray.txt'))).toBe(true);
    expect(readFileSync(path.join(repo, 'stray.txt'), 'utf-8')).toBe('unrelated scratch\n');

    // 정리
    git(['reset', '-q', 'HEAD']);
    rmSync(path.join(repo, 'manual.txt'), { force: true });
    rmSync(path.join(repo, 'stray.txt'), { force: true });
  });

  it('삭제도 복원 대상에 포함된다', () => {
    rmSync(path.join(repo, 'tracked.txt'), { force: true });
    const before = status();
    expect(before).toContain(' D tracked.txt');

    const snapshot = captureIndexTree((args) => git(args));
    git(['add', '-A']);
    expect(status()).toContain('D  tracked.txt'); // 스테이징된 삭제
    restoreIndexTree((args) => git(args), snapshot);
    expect(status()).toBe(before);

    git(['checkout', '--', 'tracked.txt']);
  });

  it('스냅샷을 못 뜬 경우 복원은 조용히 no-op 이다 (fail-safe)', () => {
    // 병합 충돌 인덱스 등에서 write-tree 는 실패한다. 그때 복원이 엉뚱한
    // 트리를 읽어 인덱스를 파괴하면 결함을 더 키운다 — null 이면 손대지 않는다.
    expect(restoreIndexTree((args) => git(args), null)).toBe(false);
    expect(restoreIndexTree((args) => git(args), '')).toBe(false);
  });

  it('captureIndexTree 는 git 실패를 삼키고 null 을 낸다', () => {
    const nonRepo = mkdtempSync(path.join(tmpdir(), 'artibot-not-a-repo-'));
    try {
      expect(captureIndexTree((args) => execFileSync('git', args, {
        cwd: nonRepo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
      }))).toBeNull();
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});

describe('배선 게이트 — 자동 커밋 4곳이 복원 헬퍼를 통과한다', () => {
  // 정적 스캔이다. 런타임 실행은 증명하지 못한다(위 "못 보는 것" 참조).
  // `restores` = how many failure exits the function has. Counting matters:
  // `executeCommit` returns early on BOTH a failed `add` and a failed `commit`,
  // and a gate that only asked for "at least one restore" stayed GREEN when the
  // commit-failure restore was deleted (measured 2026-08-30 by mutating this
  // very file). One-per-exit is the contract, so count instead of existence.
  const SITES = [
    { file: 'scripts/hooks/git-autopilot-save.js', fn: 'createWipCommit', restores: 1 },
    { file: 'scripts/hooks/git-autopilot-close.js', fn: 'commitSemantic', restores: 1 },
    { file: 'scripts/hooks/git-autopilot-close.js', fn: 'commitClose', restores: 1 },
    { file: 'scripts/cron/auto-commit-runner.js', fn: 'executeCommit', restores: 2 },
  ];

  it.each(SITES)('$file#$fn 이 스냅샷과 복원을 모두 부른다', ({ file, fn, restores }) => {
    const src = readFileSync(path.join(PLUGIN_ROOT, file), 'utf-8');
    // 함수 본문만 잘라 본다 — 파일 어딘가에 문자열이 있다는 것과 이 함수가
    // 쓴다는 것은 다른 진술이다.
    const start = src.indexOf(`function ${fn}(`);
    expect(start, `${fn} 을 ${file} 에서 찾지 못했다`).toBeGreaterThan(-1);
    // 다음 함수 선언까지만 자른다. `async function` 도 경계로 인정하지 않으면
    // 본문이 뒤 함수까지 넘어가 그쪽 문자열로 통과하는 과대허용이 된다.
    const rest = src.slice(start + 1);
    const nextFn = rest.search(/\n(?:async\s+)?function\s/);
    const body = src.slice(start, nextFn === -1 ? undefined : start + 1 + nextFn);
    const exec = body.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

    const captures = (exec.match(/captureIndexTree(?:Async)?\s*\(/g) || []).length;
    const restoreCalls = (exec.match(/restoreIndexTree(?:Async)?\s*\(/g) || []).length;
    expect(captures, `${fn}: 스냅샷 호출 수`).toBe(1);
    expect(restoreCalls, `${fn}: 실패 출구마다 복원이 있어야 한다`).toBe(restores);

    // 스냅샷이 스테이징보다 먼저여야 한다. 순서가 뒤집히면 이미 오염된
    // 인덱스를 "원본"으로 찍어 복원이 오염을 고착시킨다.
    const capturedAt = exec.search(/captureIndexTree(?:Async)?\s*\(/);
    const stagedAt = exec.search(/add['"\s,\]]+-A|add -A/);
    expect(stagedAt, `${fn}: add -A 를 찾지 못했다`).toBeGreaterThan(-1);
    expect(capturedAt, `${fn}: 스냅샷이 add -A 보다 뒤에 있다`).toBeLessThan(stagedAt);
  });

  it('4곳 모두 헬퍼를 import 한다', () => {
    for (const file of [...new Set(SITES.map((s) => s.file))]) {
      const src = readFileSync(path.join(PLUGIN_ROOT, file), 'utf-8');
      expect(src, `${file}: index-snapshot import 없음`).toMatch(/index-snapshot\.js/);
    }
  });
});
