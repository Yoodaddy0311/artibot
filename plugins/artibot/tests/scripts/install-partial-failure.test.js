import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { announceBashSkip, probeBash, toBashPath } from '../../scripts/utils/bash-compat.js';

// ---------------------------------------------------------------------------
// install.sh — 부분 설치가 성공으로 보고되는 문제 (M6)
//
// 두 지점이 합쳐져 "설치 실패를 성공으로 보고"가 된다:
//
//   1. install_hooks (:353-357) 가 hooks/scripts/lib/output-styles 네 개의
//      atomic_replace_dir 를 전부 `|| true` 로 감싼다. 이 함수는 잠긴 목적지·
//      rename 거부·빈 스테이징에서 실제로 비영으로 끝나도록 설계돼 있는데
//      (install-atomic-replace.test.js 가 그 실패 경로들을 단언한다), 호출부가
//      그 신호를 통째로 버린다.
//   2. verify_install (:1142-1172) 은 find | wc -l 로 개수만 세어 출력하고,
//      본문 어디에도 exit/return 이 없다. :1165 의 "Installation complete!" 는
//      개수가 전부 0 이어도 무조건 찍힌다.
//
// 결과: lib/ 복사가 실패해 훅이 ERR_MODULE_NOT_FOUND 로 죽는 설치본이 화면상
// 정상 완료로 끝난다. 실패 사실을 아는 유일한 주체는 사용자 자신이 된다.
//
// 방식은 install-atomic-replace.test.js / install-lock.test.js 와 동일 —
// install.sh 원본에서 함수 블록을 추출해 하네스에서 실행한다. 복사본이 아니라
// 현행 코드가 대상이다. 인스톨러 자체는 절대 실행하지 않는다: 실제 설치는
// ~/.claude 를 덮어쓰는 부작용이 있다. 전부 temp 픽스처.
//
// 이 파일이 보지 못하는 것 (그린을 실제보다 크게 읽지 않도록 명시):
//   - install.ps1 의 같은 결함. 다른 팀원이 동시 편집 중이라 범위 밖이다.
//   - main() 이 install_hooks 의 반환값을 실제로 소비하는지. 여기서는 함수
//     단위 계약만 고정한다.
//   - 설치가 "성공"했을 때 그 트리가 실제로 동작하는지. 개수는 동작이 아니다.
// ---------------------------------------------------------------------------

const PLUGIN_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const INSTALL_SH = path.join(PLUGIN_ROOT, 'install.sh');
const installShContent = readFileSync(INSTALL_SH, 'utf-8');

/** 컬럼 0에서 시작해 컬럼 0의 `}` 로 닫히는 셸 함수 본문을 추출 */
function extractShellFn(content, name) {
  const match = content.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
  return match ? match[0] : null;
}

const hasBash = probeBash().ok;
if (!hasBash) announceBashSkip('install-partial-failure/behavioral');

// ---------------------------------------------------------------------------
// 1. 정적 계약 — bash 없이도 항상 실행
// ---------------------------------------------------------------------------

describe('install-partial-failure/static contract', () => {
  it('install_hooks 와 verify_install 이 추출 가능 (공허한 통과 방지)', () => {
    // 함수명이 바뀌면 아래 단언들이 전부 null 을 훑으며 통과할 수 있다.
    expect(extractShellFn(installShContent, 'install_hooks')).not.toBeNull();
    expect(extractShellFn(installShContent, 'verify_install')).not.toBeNull();
  });

  it('install_hooks 가 atomic_replace_dir 실패를 `|| true` 로 삼키지 않는다', () => {
    // 결함의 정확한 형태. 어떤 수정안을 택하든(집계 변수·set -e·즉시 return)
    // `|| true` 는 사라져야 하므로 설계를 앞질러 고정하지 않는다.
    const fn = extractShellFn(installShContent, 'install_hooks');
    const swallowed = fn
      .split('\n')
      .filter((l) => /atomic_replace_dir/.test(l) && /\|\|\s*true/.test(l));
    expect(swallowed).toEqual([]);
  });

  it('verify_install 에 비영 종료 경로가 있다 (완료 배너가 무조건이 아니다)', () => {
    // 지금은 본문에 exit 도 return 도 하나 없다 — 실패를 표현할 수단 자체가
    // 없다는 뜻이다. 세 가지 형태 중 아무거나 허용한다.
    const fn = extractShellFn(installShContent, 'verify_install');
    expect(fn).toMatch(/\b(exit|return)\s+(1\b|"?\$)/);
  });
});

// ---------------------------------------------------------------------------
// 2. 실행형 — 정적 정규식은 형태만 본다. 계약은 반환값이다.
// ---------------------------------------------------------------------------

describe.skipIf(!hasBash)('install-partial-failure/behavioral', () => {
  let workDir;

  beforeEach(() => { workDir = mkdtempSync(path.join(os.tmpdir(), 'artibot-partial-')); });
  afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

  /** install.sh 의 함수를 그대로 끌어와 스텁 위에서 실행한다. */
  function runHarness(script) {
    const file = path.join(workDir, 'harness.sh');
    writeFileSync(file, script, 'utf8');
    return spawnSync('bash', [toBashPath(file)], {
      encoding: 'utf8',
      cwd: workDir,
      timeout: 60_000,
    });
  }

  /** install_hooks 가 필요로 하는 최소 소스 트리 */
  function seedSourceDir() {
    const src = path.join(workDir, 'src');
    mkdirSync(path.join(src, 'hooks'), { recursive: true });
    mkdirSync(path.join(src, 'scripts'), { recursive: true });
    mkdirSync(path.join(src, 'lib'), { recursive: true });
    writeFileSync(path.join(src, 'artibot.config.json'), '{}', 'utf8');
    writeFileSync(path.join(src, 'install.sh'), '# stub\n', 'utf8');
    return src;
  }

  /**
   * install_hooks 와 verify_install 을 **같은 셸에서 연달아** 돌린다.
   *
   * 두 함수를 따로 재는 것은 설계를 앞지른다. 첫 초안이 그 실수를 했다:
   * "install_hooks 가 비영으로 끝난다"고 단언했는데, 실제 수정은 반환값이
   * 아니라 INSTALL_FAILURES 집계 변수를 택했다 — 옳은 수정인데 내 단언이
   * red 였다. 계약은 반환 규약이 아니라 **관측 가능한 결과**다: 교체가
   * 실패했는데 "Installation complete!" 가 찍히면 안 된다. 집계 변수든
   * 반환값이든 즉시 exit 든, 그 결과를 내면 통과한다.
   *
   * 집계 변수를 하네스가 미리 초기화하지 않는 것도 같은 이유다 — 그러면
   * 특정 메커니즘을 전제하게 된다.
   */
  function runInstallThenVerify(failGlob) {
    const src = seedSourceDir();
    const dst = path.join(workDir, 'artibot');
    mkdirSync(path.join(dst, 'scripts', 'hooks'), { recursive: true });

    return runHarness([
      `SCRIPT_DIR="${toBashPath(src)}"`,
      `ARTIBOT_DIR="${toBashPath(dst)}"`,
      `CLAUDE_DIR="${toBashPath(dst)}"`,
      'GREEN=""; NC=""',
      'log() { echo "$@"; }',
      'err() { echo "ERR: $@"; }',
      'safe_copy_dir() { :; }',
      failGlob
        ? `atomic_replace_dir() { case "$1" in ${failGlob}) return 1;; esac; return 0; }`
        : 'atomic_replace_dir() { return 0; }',
      extractShellFn(installShContent, 'install_hooks'),
      extractShellFn(installShContent, 'verify_install'),
      'install_hooks',
      'verify_install',
      'echo "STATUS=$?"',
    ].join('\n'));
  }

  it('lib/ 교체가 실패하면 완료로 보고하지 않는다', () => {
    // atomic_replace_dir 는 잠긴 목적지·rename 거부·빈 스테이징에서 실제로 1 을
    // 반환한다(install-atomic-replace.test.js 가 그 경로들을 단언한다). 여기서
    // 보는 것은 그 신호가 사용자에게 도달하는가 하나뿐이다.
    //
    // 하필 lib/ 인 이유: 이게 실패한 설치본은 훅이 ERR_MODULE_NOT_FOUND 로
    // 죽는다. 부분 설치 중 가장 조용하고 가장 치명적인 형태다.
    const out = runInstallThenVerify('*/lib');
    expect(out.stdout).not.toMatch(/Installation complete/);
    expect(out.stdout).not.toMatch(/STATUS=0/);
  });

  it('hooks/ 교체가 실패해도 완료로 보고하지 않는다', () => {
    // lib/ 하나만 특별 취급하는 수정으로는 통과하지 못하도록 두 번째 축을 건다.
    const out = runInstallThenVerify('*/hooks');
    expect(out.stdout).not.toMatch(/Installation complete/);
    expect(out.stdout).not.toMatch(/STATUS=0/);
  });

  it('전부 성공하면 완료로 보고하고 0 으로 끝난다', () => {
    // 반대 방향. 수정이 "항상 실패"로 뒤집히면 여기서 잡힌다 — 실패를 보고하는
    // 게이트는 성공도 보고할 수 있어야 쓸모가 있다.
    const out = runInstallThenVerify(null);
    expect(out.stdout).toMatch(/Installation complete/);
    expect(out.stdout).toMatch(/STATUS=0/);
  });
});
