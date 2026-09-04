/**
 * Tests for lib/git/conflict-detector.js — git path-output decoding.
 *
 * 후속 19 (#2·#3): `git diff --name-only` (conflict-detector.js:82) 과
 * `git ls-files --modified` (:142) 은 기본 출력이 `core.quotepath` 의 지배를
 * 받는다. 비-ASCII 경로가 `"src/\355\225\234..."` C-quote 로 나오면
 *   - `predictConflictFiles` 는 우리쪽/저쪽 집합을 **같은 C-quote 문자열로**
 *     비교하므로 교집합 자체는 성립하지만, 호출자에게 넘기는 경로가 실제
 *     파일명이 아니다.
 *   - `findFilesWithConflictMarkers` 는 그 문자열로 `readFile(join(cwd, f))`
 *     를 하므로 **ENOENT → 조용히 제외** 된다. 충돌 마커가 실재하는데도
 *     activeConflicts 가 비어 나온다(거짓 음성).
 * 그래서 두 자리 모두 `-z` + `split('\0')` 이어야 한다. `.trim()` 은 공백으로
 * 시작/끝나는 경로를 파괴하므로 쓰지 않는다.
 *
 * 이 테스트는 목이 아니라 **실제 임시 리포**를 쓴다. C-quote 는 git 이 하는
 * 일이라 목으로는 재현되지 않기 때문이다.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { detectAndPreempt, predictConflictFiles } from '../../lib/git/conflict-detector.js';

const KO_DIR = '한글폴더';
const KO_FILE = `src/${KO_DIR}/설계문서.md`;
const SPACE_FILE = 'src/with space/파일 이름.md';
const PLAIN_FILE = 'src/plain.md';

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
  repo = mkdtempSync(path.join(os.tmpdir(), 'conflict-detector-z-'));
  git(['init', '-q', '-b', 'main', '.']);
  // 이 리포 전용으로 C-quote 를 켠다. 오너 환경은 core.quotepath 미설정
  // (= 기본 true) 이므로 라이브와 같은 조건이다.
  git(['config', 'core.quotepath', 'true']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  git(['config', 'commit.gpgsign', 'false']);

  write(PLAIN_FILE, 'base\n');
  write(KO_FILE, 'base\n');
  write(SPACE_FILE, 'base\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);

  // main 쪽 변경
  git(['checkout', '-q', '-b', 'feature']);
  write(KO_FILE, 'base\nfeature\n');
  write(SPACE_FILE, 'base\nfeature\n');
  write(PLAIN_FILE, 'base\nfeature-only\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'feature']);

  // main 에도 같은 두 파일을 건드려 교집합(=likelyConflicts)을 만든다
  git(['checkout', '-q', 'main']);
  write(KO_FILE, 'base\nmain\n');
  write(SPACE_FILE, 'base\nmain\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'main-side']);
  git(['checkout', '-q', 'feature']);
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe('predictConflictFiles — diff --name-only 경로 디코딩 (:82)', () => {
  it('한글 경로를 C-quote 가 아니라 실제 경로로 돌려준다', async () => {
    const r = await predictConflictFiles('main', repo);
    expect(r.likelyConflicts).toContain(KO_FILE);
    expect(r.safe).toContain(PLAIN_FILE);
  });

  it('공백이 든 경로도 온전히 보존한다(.trim() 금지 근거)', async () => {
    const r = await predictConflictFiles('main', repo);
    expect(r.likelyConflicts).toContain(SPACE_FILE);
  });

  it('어떤 경로에도 C-quote 잔재(역슬래시 8진 이스케이프·감싼 따옴표)가 없다', async () => {
    const r = await predictConflictFiles('main', repo);
    const all = [...r.likelyConflicts, ...r.safe];
    // 자기검증: 목록이 비면 아래 단언은 공허하게 통과한다.
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (const f of all) {
      expect(f.startsWith('"')).toBe(false);
      expect(f).not.toMatch(/\\[0-7]{3}/);
    }
  });
});

describe('findFilesWithConflictMarkers — ls-files --modified 경로 디코딩 (:142)', () => {
  it('한글·공백 경로의 충돌 마커를 놓치지 않는다', async () => {
    const marker = [
      'base',
      '<<<<<<< HEAD',
      'ours',
      '=======',
      'theirs',
      '>>>>>>> other',
      '',
    ].join('\n');
    write(KO_FILE, marker);
    write(SPACE_FILE, marker);
    write(PLAIN_FILE, marker);

    const r = await detectAndPreempt('main', repo, { preemptive: false });
    expect(r.activeConflicts).toContain(KO_FILE);
    expect(r.activeConflicts).toContain(SPACE_FILE);
    expect(r.activeConflicts).toContain(PLAIN_FILE);
  });
});
