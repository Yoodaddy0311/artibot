/**
 * 검사 목적: `pre-push` 배치 계약 — 복사본이 **올바른 .git/hooks 에** byte-단위로 들어가고,
 * `core.hooksPath` 가 설정돼 있으면 설치를 거부한다.
 *
 * 이 스위트는 실제 임시 git 리포를 만들어서 설치기를 돌린다. 정적 스캔이 아니다.
 *
 * ── 회귀 가드 (실제로 났던 버그) ──────────────────────────────────────────────
 * `git rev-parse --git-path hooks` 는 **git 을 호출한 cwd 기준 상대경로**를 준다.
 * 이걸 `--show-toplevel` 기준으로 resolve 하면 리포 밖으로 걸어나가서, 개발 중
 * 실측으로 조상 디렉터리의 `.git/hooks/` 에 훅을 설치했다. 아래
 * "설치 경로가 그 리포 안이다" 테스트가 그 재발을 잡는다.
 *
 * ── 이 게이트가 못 보는 것 (rules §9) ────────────────────────────────────────
 *   - **개발자가 설치기를 실제로 돌렸는지는 알 수 없다.** `.git/` 은 커밋되지 않으므로
 *     CI 도, 이 테스트도, 남의 클론의 설치 상태를 볼 수 없다. 설치 여부의 유일한
 *     확인 수단은 각자 `npm run hooks:install -- --check` 다.
 *   - **훅이 실행하는 `scripts/ci/validate-*.js` 는 여전히 워크트리 공급이다.**
 *     복사 설치는 "훅 자체가 공격자 통제" 와 "게이트 자기무력화" 를 닫을 뿐,
 *     적대적 브랜치를 체크아웃한 채 push 하는 것을 안전하게 만들지 않는다.
 *   - push 시 훅이 실제로 차단하는지는 여기서 재현하지 않는다(원격·의존성 필요).
 *
 * @module tests/firewall/git-hooks-install
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** 플러그인 루트 (`plugins/artibot/`) */
const PLUGIN_ROOT = join(__dirname, '..', '..');
const HOOKS_SRC = join(PLUGIN_ROOT, 'scripts', 'git-hooks');

/** @type {string} */
let repo;
/** 임시 리포 안의 설치기 경로 */
let installer;

/**
 * 설치기를 돌리고 결과를 돌려준다. throw 하지 않는다 — exit code 를 단언하기 위해.
 * @param {string[]} args
 */
function runInstaller(args = []) {
  try {
    const stdout = execFileSync(process.execPath, [installer, ...args], {
      cwd: join(repo, 'plugins', 'artibot'),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? '',
    };
  }
}

/** @param {string[]} args */
function git(args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'artibot-hooks-'));
  const dest = join(repo, 'plugins', 'artibot', 'scripts', 'git-hooks');
  mkdirSync(dest, { recursive: true });
  cpSync(join(HOOKS_SRC, 'pre-push'), join(dest, 'pre-push'));
  cpSync(join(HOOKS_SRC, 'install.js'), join(dest, 'install.js'));
  installer = join(dest, 'install.js');
  git(['init', '-q', '.']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('git hooks 설치기', () => {
  it('훅을 .git/hooks 에 byte-단위로 동일하게 설치한다', () => {
    const result = runInstaller();
    expect(result.code, result.stderr).toBe(0);

    const installed = join(repo, '.git', 'hooks', 'pre-push');
    expect(existsSync(installed)).toBe(true);
    // byte-단위 동일성은 훅의 drift 자기검사(raw hash 비교)가 성립하기 위한 전제다.
    // 여기서 개행이 바뀌면 설치 직후부터 모든 push 가 drift FAIL 로 막힌다.
    expect(readFileSync(installed)).toEqual(
      readFileSync(join(repo, 'plugins', 'artibot', 'scripts', 'git-hooks', 'pre-push')),
    );
  });

  it('설치 경로가 그 리포 안이다 (조상 리포로 새지 않는다)', () => {
    // 회귀 가드: --git-path 를 toplevel 기준으로 resolve 하던 버그가 조상 디렉터리의
    // .git/hooks 에 설치했다. 설치 경로는 반드시 이 임시 리포 하위여야 한다.
    runInstaller();
    const installed = resolve(repo, '.git', 'hooks', 'pre-push');
    expect(existsSync(installed)).toBe(true);

    const rel = relative(repo, installed);
    expect(rel.startsWith('..')).toBe(false);
  });

  it('core.hooksPath 가 설정돼 있으면 설치를 거부한다', () => {
    // hooksPath 는 .git/hooks 를 덮으므로, 이때 설치하면 "설치된 것처럼 보이지만
    // 절대 실행되지 않는" 복사본이 남는다. 그건 훅이 없는 것보다 나쁘다.
    git(['config', 'core.hooksPath', 'plugins/artibot/scripts/git-hooks']);
    const result = runInstaller();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('core.hooksPath');
    expect(existsSync(join(repo, '.git', 'hooks', 'pre-push'))).toBe(false);
  });

  it('--check 는 미설치를 stale 로 보고하고 exit 1 이다', () => {
    const result = runInstaller(['--check']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('STALE');
    // --check 는 아무것도 쓰지 않는다.
    expect(existsSync(join(repo, '.git', 'hooks', 'pre-push'))).toBe(false);
  });

  it('--check 는 설치 후 exit 0 이다', () => {
    runInstaller();
    const result = runInstaller(['--check']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('up to date');
  });

  it('--check 는 소스가 바뀌면 stale 을 잡는다 (drift 감지)', () => {
    runInstaller();
    const source = join(repo, 'plugins', 'artibot', 'scripts', 'git-hooks', 'pre-push');
    writeFileSync(source, `${readFileSync(source, 'utf-8')}\n# changed\n`);

    const result = runInstaller(['--check']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('differs from source');
  });

  it('남의 pre-push 훅을 파괴하지 않고 백업한다', () => {
    const target = join(repo, '.git', 'hooks', 'pre-push');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '#!/bin/sh\necho someone-elses-hook\n');

    const result = runInstaller();
    expect(result.code).toBe(0);
    expect(readFileSync(`${target}.backup`, 'utf-8')).toContain('someone-elses-hook');
    expect(readFileSync(target, 'utf-8')).toContain('Artibot pre-push gate.');
  });
});

describe('pre-push 훅 소스 계약', () => {
  const hook = readFileSync(join(HOOKS_SRC, 'pre-push'), 'utf-8');

  it('drift 자기검사를 포함한다', () => {
    // 이게 없으면 복사 설치는 stale gate 를 조용히 실행하고, 적대적 브랜치가
    // 훅을 바꿔도 아무 신호가 없다.
    expect(hook).toContain('git hash-object --no-filters');
    expect(hook).toContain('installed hook differs from the source file in the work tree');
  });

  it('work tree 를 가리키는 core.hooksPath 를 권하지 않는다', () => {
    // 과거 안내문이 이 설정을 권장했고, 그것이 신뢰경계 결함의 원인이었다.
    //
    // 음성 단언만으로는 약하다: 이 정규식은 백틱 없는 주석 한 형태만 잡는데, 훅 헤더는
    // 같은 명령을 **금지문 안에서 백틱을 달고** 인용하고 있어서 정규식을 넓히면 그
    // 금지문 자체가 걸려 오탐이 된다. "권장"과 "금지"를 정규식으로 가르는 건 취약하다.
    // 그래서 금지문이 실제로 존재한다는 **양성 단언**을 함께 건다. 이쪽은 오탐이 없고,
    // 누가 헤더를 다시 권장문으로 되돌리면 이 단언이 RED 가 된다.
    expect(hook).not.toMatch(/^#\s+git config core\.hooksPath/m);
    expect(hook).toContain('Do NOT use');
    expect(hook).toContain('core.hooksPath');
  });

  it('전제조건 실패는 전부 exit 1 이다 (fail-closed)', () => {
    for (const marker of [
      'not inside a git work tree',
      'node not on PATH',
      'node_modules missing',
    ]) {
      expect(hook).toContain(marker);
    }
  });
});
