/**
 * `scripts/split/restore-blob.mjs` — 한글·공백 경로 (후속 19 #14: `ls-files` 를 `-z` 로).
 *
 * `core.quotepath=true`(git 기본값) 에서 `git ls-files --full-name` 은 비ASCII 경로를
 * C-quote 로 내보낸다("src/\355\225\234…"). 그 문자열을 `cat-file -p <ref>:<path>` 에
 * 그대로 넘기면 없는 경로라 `failed` 가 된다 — 한글 경로 파일은 복원할 수 없었다.
 * `-z` 출력은 인용을 하지 않는다.
 *
 * RED 증거: 변경 전(7cbb37b9) 코드에서 첫 케이스는 `repoPath` 가 C-quote 문자열이고
 * `status === 'failed'` 였다.
 *
 * 못 보는 것: 한 리포에 파일 2~3개. `git update-index --refresh` 의 부수효과는 `restoreAll`
 * 의 `refreshed` 플래그만 본다. Windows 에서 파일명이 실제로 UTF-8 로 저장되는지는 git
 * 이 답한다(여기서는 git 이 준 경로와 fs 경로가 같은 파일을 가리키는지까지만 본다).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { restoreAll, restoreBlob } from '../../scripts/split/restore-blob.mjs';

const KO = 'src/한글폴더/설계문서.md';
const SP = 'src/with space.md';
const KO_BYTES = Buffer.from('# 설계\r\n원문 바이트\n', 'utf-8');
const SP_BYTES = Buffer.from('a b\n', 'utf-8');

let repo = '';

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  }).trim();
}

function commitBytes(cwd, name, bytes, message) {
  const full = path.join(cwd, name);
  fsSync.mkdirSync(path.dirname(full), { recursive: true });
  fsSync.writeFileSync(full, bytes);
  git(['add', name], cwd);
  git(['commit', '-q', '-m', message], cwd);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

beforeAll(() => {
  repo = fsSync.mkdtempSync(path.join(os.tmpdir(), 'artibot-restore-blob-ko-'));
  git(['init', '-q', '-b', 'main', '.'], repo);
  git(['config', 'user.email', 'test@example.invalid'], repo);
  git(['config', 'user.name', 'test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  // autocrlf 를 꺼야 "블롭 바이트 == 복원 바이트" 를 픽스처 그대로 잴 수 있다.
  git(['config', 'core.autocrlf', 'false'], repo);
  git(['config', 'core.quotepath', 'true'], repo);
  commitBytes(repo, KO, KO_BYTES, 'docs: 한글 경로');
  commitBytes(repo, SP, SP_BYTES, 'docs: 공백 경로');
});

afterAll(() => {
  try {
    fsSync.rmSync(repo, { recursive: true, force: true });
  } catch { /* best effort */ }
});

describe('restoreBlob — 한글·공백 경로', () => {
  it('한글 경로: repoPath 가 원문이고 바이트가 블롭과 같아진다', () => {
    const abs = path.join(repo, KO);
    fsSync.writeFileSync(abs, 'dirty\n');
    const row = restoreBlob({ cwd: repo, file: KO });
    expect(row.repoPath).toBe(KO);
    expect(row.repoPath).not.toMatch(/["\\]/);
    expect(row.status).toBe('restored');
    expect(row.status).not.toBe('refused');
    expect(row.blob).toBe(sha256(KO_BYTES));
    expect(row.after).toBe(row.blob);
    expect(row.changed).toBe(true);
    expect(fsSync.readFileSync(abs).equals(KO_BYTES)).toBe(true);
  });

  it('내부 공백 경로: 그대로 복원된다 (변경 전에도 GREEN — 회귀 방어용)', () => {
    // 끝 공백 경로(`.trim()` 제거의 진짜 회귀면)는 Windows 가 파일명으로 만들 수 없어
    // 이 호스트에서 검증 불가. Linux 에서의 동작은 미확인.
    const abs = path.join(repo, SP);
    fsSync.writeFileSync(abs, 'dirty\n');
    const row = restoreBlob({ cwd: repo, file: SP });
    expect(row.repoPath).toBe(SP);
    expect(row.status).toBe('restored');
    expect(fsSync.readFileSync(abs).equals(SP_BYTES)).toBe(true);
  });

  it('미추적 한글 경로는 refused 이고 아무것도 쓰지 않는다', () => {
    const untracked = 'src/한글폴더/미추적.md';
    const abs = path.join(repo, untracked);
    fsSync.writeFileSync(abs, 'x\n');
    const row = restoreBlob({ cwd: repo, file: untracked });
    expect(row.status).toBe('refused');
    expect(row.repoPath).toBeNull();
    expect(fsSync.readFileSync(abs, 'utf-8')).toBe('x\n');
    fsSync.rmSync(abs, { force: true });
  });

  it('restoreAll 은 한글·공백 두 파일을 복원하고 인덱스를 한 번 새로고침한다', () => {
    fsSync.writeFileSync(path.join(repo, KO), 'dirty2\n');
    fsSync.writeFileSync(path.join(repo, SP), 'dirty2\n');
    const out = restoreAll({ cwd: repo, files: [KO, SP] });
    expect(out.rows.map((r) => [r.repoPath, r.status])).toEqual([[KO, 'restored'], [SP, 'restored']]);
    expect(out.refreshed).toBe(true);
    // 복원 뒤 워킹트리가 HEAD 와 같다 — `-z` 로 읽어 한글 경로도 원문 비교.
    expect(git(['status', '--porcelain', '-z', '--', KO, SP], repo)).toBe('');
  });
});
