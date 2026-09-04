/**
 * Tests for lib/git/merge-preflight.js — merge-tree path decoding.
 *
 * 후속 19 (#4): `git merge-tree --write-tree --name-only`(merge-preflight.js:207)
 * 의 충돌 파일 목록도 `core.quotepath` 의 지배를 받는다. 이 목록은
 * `/split integrate` 의 배치 랜딩과 `/git check` 충돌 행렬에 그대로 실려
 * 사용자에게 표시되므로, C-quote 가 새면 "어느 파일이 충돌인지"가
 * `"src/\355\225\234..."` 로 보인다.
 *
 * `-z` 지원 실측: git 2.54.0.windows.1 `git merge-tree -h` 에 `-z  separate
 * paths with the NUL character` 존재. 출력 형태는 개행 형태와 **구조가 다르다**:
 *   clean    : <oid> NUL
 *   conflict : <oid> NUL <path> NUL ... NUL '' NUL           ← 빈 필드가 절 구분
 *              그 뒤 정보 메시지가 <n> NUL <path>×n NUL <type> NUL <message> NUL
 * 그래서 이 자리는 단순 `split('\0')` 이 아니라 절 인식 파서가 필요하다.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { mergeTreePair, parseMergeTreeOutput } from '../../lib/git/merge-preflight.js';

const KO_FILE = 'src/한글폴더/설계문서.md';
const SPACE_FILE = 'src/with space/파일 이름.md';

let repo;

function git(args) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function write(rel, body) {
  const abs = path.join(repo, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, 'utf8');
}

beforeAll(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'merge-preflight-z-'));
  git(['init', '-q', '-b', 'main', '.']);
  git(['config', 'core.quotepath', 'true']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  git(['config', 'commit.gpgsign', 'false']);

  write(KO_FILE, 'base\n');
  write(SPACE_FILE, 'base\n');
  write('plain.md', 'base\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);

  git(['checkout', '-q', '-b', 'other']);
  write(KO_FILE, 'other\n');
  write(SPACE_FILE, 'other\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'other-side']);

  git(['checkout', '-q', 'main']);
  write(KO_FILE, 'mine\n');
  write(SPACE_FILE, 'mine\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'main-side']);
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe('mergeTreePair — 충돌 파일 경로 디코딩 (:207)', () => {
  it('한글·공백 경로를 실제 경로로 보고한다', () => {
    const r = mergeTreePair('main', 'other', { cwd: repo });
    expect(r.kind).toBe('conflict');
    expect(r.conflictFiles).toContain(KO_FILE);
    expect(r.conflictFiles).toContain(SPACE_FILE);
  });

  it('충돌 목록에 C-quote 잔재가 없다', () => {
    const r = mergeTreePair('main', 'other', { cwd: repo });
    // 자기검증: 목록이 비면 아래 루프는 공허하게 통과한다.
    expect(r.conflictFiles.length).toBe(2);
    for (const f of r.conflictFiles) {
      expect(f.startsWith('"')).toBe(false);
      expect(f).not.toMatch(/\\[0-7]{3}/);
    }
  });

  it('정보 메시지 절이 충돌 파일 목록으로 새지 않는다', () => {
    const r = mergeTreePair('main', 'other', { cwd: repo });
    for (const f of r.conflictFiles) {
      expect(f).not.toMatch(/^(Auto-merging|CONFLICT)/);
    }
    expect(r.messages.join('\n')).toMatch(/CONFLICT/);
    // 메시지에도 실제 경로가 실린다
    expect(r.messages.some((m) => m.includes(KO_FILE))).toBe(true);
  });

  it('깨끗한 머지는 tree 만 돌려준다', () => {
    const r = mergeTreePair('main', 'main', { cwd: repo });
    expect(r.kind).toBe('clean');
    expect(r.tree).toMatch(/^[0-9a-f]{40,64}$/);
    expect(r.conflictFiles).toEqual([]);
  });
});

describe('parseMergeTreeOutput — -z 절 구분 파서', () => {
  const OID = 'f'.repeat(40);

  it('clean: <oid> NUL', () => {
    expect(parseMergeTreeOutput(`${OID}\0`, 0)).toEqual({
      kind: 'clean', tree: OID, conflictFiles: [], messages: [],
    });
  });

  it('conflict: 빈 필드 앞이 경로, 뒤는 <n>/paths/type/message 4중주', () => {
    const out = [
      OID, 'a b.md', 'src/한글.md', '',
      '1', 'a b.md', 'Auto-merging', 'Auto-merging a b.md\n',
      '1', 'src/한글.md', 'CONFLICT (contents)', 'CONFLICT (content): Merge conflict in src/한글.md\n',
      '',
    ].join('\0');
    const r = parseMergeTreeOutput(out, 1);
    expect(r.kind).toBe('conflict');
    expect(r.conflictFiles).toEqual(['a b.md', 'src/한글.md']);
    expect(r.messages).toEqual([
      'Auto-merging a b.md',
      'CONFLICT (content): Merge conflict in src/한글.md',
    ]);
  });

  it('경로가 여럿인 메시지(n>1)도 필드 수를 맞춰 건너뛴다', () => {
    const out = [
      OID, 'x.md', '',
      '2', 'old.md', 'new.md', 'CONFLICT (rename/rename)', 'CONFLICT (rename/rename): x\n',
      '',
    ].join('\0');
    const r = parseMergeTreeOutput(out, 1);
    expect(r.conflictFiles).toEqual(['x.md']);
    expect(r.messages).toEqual(['CONFLICT (rename/rename): x']);
  });

  it('oid 가 아니거나 status 가 0·1 이 아니면 error', () => {
    expect(parseMergeTreeOutput('not-an-oid\0', 1).kind).toBe('error');
    expect(parseMergeTreeOutput(`${OID}\0`, 128).kind).toBe('error');
  });

  it('메시지 절이 잘려도 던지지 않는다', () => {
    const r = parseMergeTreeOutput([OID, 'x.md', '', '3', 'only-one.md'].join('\0'), 1);
    expect(r.kind).toBe('conflict');
    expect(r.conflictFiles).toEqual(['x.md']);
    expect(r.messages).toEqual([]);
  });
});
