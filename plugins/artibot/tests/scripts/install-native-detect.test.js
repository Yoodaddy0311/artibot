import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { announceBashSkip, probeBash, toBashPath } from '../../scripts/utils/bash-compat.js';

// ---------------------------------------------------------------------------
// install.sh — 네이티브 마켓플레이스 플러그인이 있을 때 flat copy 를 건너뛴다
//
// 문제(2026-09-10 실측, install.sh 의 install_agents / install_commands):
// 두 함수는 조건 없이 `agents/*.md` → `~/.claude/agents/`,
// `commands/*.md` → `~/.claude/commands/` 로 평면 복사한다. 네이티브 플러그인
// (`~/.claude/plugins/cache/artibot/artibot/<version>/`) 이 함께 설치돼 있으면
// 같은 에이전트·커맨드가 세션 시스템 프롬프트에 **두 번** 실린다.
//
// 계약(install.ps1 형제 작업과 동일):
//   1. detect_native_plugin_install() — 캐시 루트 아래 버전 디렉터리가 하나라도
//      있으면 그 경로를 stdout 에 echo 하고 0. 마커는 lib/core/install-mode.js#
//      detectInstallMode 의 cacheMarker(`~/.claude/plugins/cache`) 와 같다.
//   2. `--flat` 플래그(argv 어디에나) → ARTIBOT_FLAT_COPY=1 → 강제 복사.
//   3. 네이티브 감지 + 플래그 없음 → 복사 안 함 + 스킵 로그 **정확히 1회** +
//      기존 잔존 복사본이 있으면 warn 1줄. 삭제는 하지 않는다.
//   4. verify_install 요약의 Agents/Commands 줄에 스킵 표기를 덧붙인다
//      (0 이 실패로 읽히지 않도록).
//
// 방식: install.sh 를 **복사하지 않는다**. 원본을 읽어 마지막 `main "$@"` 호출만
// 무력화한 뒤 하네스에서 source 한다 — 블록 추출보다 강한 형태로, 함수·전역
// 변수·log/warn 전부 현행 코드 그대로다. SCRIPT_DIR/CLAUDE_DIR 은 source 직후
// temp 픽스처로 덮어쓴다. 실제 설치(`install.sh install`)는 절대 돌리지 않는다.
//
// 이 파일이 보지 못하는 것 (rules §9 — 그린을 실제보다 크게 읽지 않도록):
//   - install.ps1 의 동일 계약. 형제 팀원 범위이며 여기서는 미확인이다.
//   - 진짜 Claude Code 세션에서 중복 등재가 실제로 사라지는지. 이 스위트는
//     디스크 산출물만 잰다 — 세션 시스템 프롬프트는 관측하지 않았다.
//   - 캐시 마커가 Claude Code 의 향후 버전에서도 같은 경로인지. install-mode.js
//     와 문자열이 일치하는지만 정적으로 본다.
//   - 픽스처는 에이전트 3 / 커맨드 2 개다. 실제는 28 / 79 규모라 성능·대량
//     경로는 이 크기로 증명되지 않는다.
//   - `install.sh install` 전 경로(락·미러·캐시 동기화)와의 상호작용.
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
if (!hasBash) announceBashSkip('install-native-detect/behavioral');

// ---------------------------------------------------------------------------
// 1. 정적 계약 — bash 없이도 항상 실행
// ---------------------------------------------------------------------------

describe('install-native-detect/static contract', () => {
  it('detect_native_plugin_install 이 존재하고 추출 가능 (공허한 통과 방지)', () => {
    expect(extractShellFn(installShContent, 'detect_native_plugin_install')).not.toBeNull();
  });

  it('캐시 루트 상수가 최상위에 한 번 선언되고 install-mode.js 마커와 같다', () => {
    // 리터럴을 함수 안에 두면 install_plugin_cache 의 사본과 갈라진다. 선언은
    // 최상위 1회, 함수들은 그 상수를 읽는다.
    // (tests/ci/validate-install.test.js 의 sh↔ps1 패리티 게이트와 같은 계약)
    const decl = installShContent.match(/^ARTIBOT_PLUGIN_CACHE_ROOT="\$\{CLAUDE_DIR\}\/([^"]+)"/m);
    expect(decl, 'ARTIBOT_PLUGIN_CACHE_ROOT 최상위 선언이 없다').not.toBeNull();
    expect(decl[1]).toBe('plugins/cache/artibot/artibot');
    // 파일 전체에서 그 리터럴은 선언 한 곳뿐이어야 한다(주석 포함).
    expect(installShContent.split(decl[1]).length - 1).toBe(1);
  });

  it('감지 함수와 캐시 미러가 같은 상수를 읽는다', () => {
    for (const name of ['detect_native_plugin_install', 'install_plugin_cache']) {
      const fn = extractShellFn(installShContent, name);
      expect(fn, `${name} 추출 실패`).not.toBeNull();
      expect(fn).toMatch(/ARTIBOT_PLUGIN_CACHE_ROOT/);
    }
  });

  it('감지 함수가 install-mode.js 를 근거로 인용한다', () => {
    // 두 곳이 같은 마커를 쓴다는 사실이 주석으로 남아야 한 쪽만 바뀌는 드리프트를
    // 다음 독자가 알아챈다.
    const fn = extractShellFn(installShContent, 'detect_native_plugin_install');
    expect(fn).toMatch(/install-mode\.js/);
  });

  it('감지 함수는 순수 조회다 — 쓰기/삭제 명령이 없다', () => {
    const fn = extractShellFn(installShContent, 'detect_native_plugin_install');
    expect(fn).not.toMatch(/\b(rm|mkdir|cp|mv|touch)\b/);
  });

  it('main 이 --flat 을 파싱하고 ARTIBOT_FLAT_COPY 를 세운다', () => {
    const fn = extractShellFn(installShContent, 'main');
    expect(fn).not.toBeNull();
    expect(fn).toMatch(/--flat/);
    expect(fn).toMatch(/ARTIBOT_FLAT_COPY=1/);
  });

  it('usage 문구가 --flat 을 안내한다', () => {
    const fn = extractShellFn(installShContent, 'main');
    expect(fn).toMatch(/Usage: \.\/install\.sh \[install\|uninstall\|files\] \[--flat\]/);
  });

  it('files 서브커맨드가 여전히 install_agents/install_commands 를 호출한다', () => {
    // 스킵은 그 함수 안에서 결정돼야 한다. 호출 자체를 빼면 --flat 이 files 에서
    // 동작하지 않는다.
    const fn = extractShellFn(installShContent, 'main');
    const filesBranch = fn.slice(fn.indexOf('    files)'), fn.indexOf('    uninstall)'));
    expect(filesBranch).toMatch(/install_agents/);
    expect(filesBranch).toMatch(/install_commands/);
  });

  it('ARTIBOT_FLAT_COPY 참조가 set -u 안전한 기본값 형태다', () => {
    // 함수들은 테스트에서 단독 추출·실행된다(install-partial-failure.test.js 의
    // ${INSTALL_FAILURES:-0} 와 같은 이유). 맨 참조는 set -u 에서 치명적이다.
    const bare = installShContent
      .split('\n')
      .filter((l) => /\$\{ARTIBOT_FLAT_COPY\}/.test(l));
    expect(bare).toEqual([]);
  });

  it('uninstall 과 마켓플레이스 미러는 스킵 로직을 타지 않는다', () => {
    // 스킵은 flat copy 에만 적용된다. uninstall 은 잔존본을 지우는 유일한 경로라
    // 여기서 조건부가 되면 사용자가 중복을 제거할 방법이 사라진다.
    for (const name of ['uninstall', 'install_marketplace_mirror']) {
      const fn = extractShellFn(installShContent, name);
      expect(fn).not.toBeNull();
      expect(fn).not.toMatch(/ARTIBOT_FLAT_COPY|flat_copy_skipped|detect_native_plugin_install/);
    }
    // install_plugin_cache 는 캐시 루트 상수만 공유한다 — 스킵 분기는 없다.
    const cacheFn = extractShellFn(installShContent, 'install_plugin_cache');
    expect(cacheFn).not.toMatch(/ARTIBOT_FLAT_COPY|flat_copy_skipped/);
  });

  it('verify_install 이 스킵 표기를 Agents/Commands 줄에 붙인다', () => {
    const fn = extractShellFn(installShContent, 'verify_install');
    expect(fn).toMatch(/flat copy skipped/);
  });
});

// ---------------------------------------------------------------------------
// 2. 실행형 — 정적 정규식은 형태만 본다. 계약은 디스크 산출물이다.
// ---------------------------------------------------------------------------

const SKIP_LOG_RE = /skipping flat copy of agents\/commands/g;
const LEFTOVER_RE = /previously flat-copied agent\/command files remain/g;

describe.skipIf(!hasBash)('install-native-detect/behavioral', () => {
  let workDir;
  let libPath;
  let srcDir;
  let claudeDir;

  const AGENTS = ['alpha.md', 'beta.md', 'gamma.md'];
  const COMMANDS = ['one.md', 'two.md'];

  beforeEach(() => {
    workDir = mkdtempSync(path.join(os.tmpdir(), 'artibot-native-'));

    // install.sh 원본에서 마지막 `main "$@"` 만 무력화 — 나머지는 한 글자도
    // 바꾸지 않는다. source 해도 아무것도 실행되지 않고 정의만 로드된다.
    libPath = path.join(workDir, 'install-lib.sh');
    const lib = installShContent.replace(/^main "\$@"\s*$/m, '# main() disabled by test harness');
    expect(lib).not.toBe(installShContent); // 치환이 실제로 일어났는지
    writeFileSync(libPath, lib, 'utf8');

    srcDir = path.join(workDir, 'src');
    mkdirSync(path.join(srcDir, 'agents'), { recursive: true });
    mkdirSync(path.join(srcDir, 'commands'), { recursive: true });
    for (const name of AGENTS) {
      writeFileSync(path.join(srcDir, 'agents', name), `# ${name}\n`, 'utf8');
    }
    for (const name of COMMANDS) {
      writeFileSync(path.join(srcDir, 'commands', name), `# ${name}\n`, 'utf8');
    }

    claudeDir = path.join(workDir, 'claude');
    mkdirSync(path.join(claudeDir, 'agents'), { recursive: true });
    mkdirSync(path.join(claudeDir, 'commands'), { recursive: true });
  });

  afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

  /** 네이티브 플러그인 캐시(버전 디렉터리 1개)를 픽스처에 만든다 */
  function seedNativeCache(version = '4.40.0') {
    const dir = path.join(claudeDir, 'plugins', 'cache', 'artibot', 'artibot', version);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** install_agents + install_commands + verify_install 을 한 셸에서 실행 */
  function run({ flat = false } = {}) {
    const harness = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      '# shellcheck disable=SC1090',
      'source "$1"',
      'SCRIPT_DIR="$2"',
      'CLAUDE_DIR="$3"',
      // CLAUDE_DIR 파생 전역은 source 시점 값으로 굳는다. install.sh 최상위와
      // 같은 식으로 다시 유도한다 — 값이 아니라 유도 방식을 베끼므로, 상수의
      // 경로가 바뀌면 위 정적 테스트가 잡는다.
      'ARTIBOT_DIR="${CLAUDE_DIR}/artibot"',
      'ARTIBOT_PLUGIN_CACHE_ROOT="${CLAUDE_DIR}/plugins/cache/artibot/artibot"',
      'install_agents',
      'install_commands',
      'verify_install || true',
      '',
    ].join('\n');
    const harnessPath = path.join(workDir, 'harness.sh');
    writeFileSync(harnessPath, harness, 'utf8');

    const env = { ...process.env, HOME: workDir, USERPROFILE: workDir };
    if (flat) env.ARTIBOT_FLAT_COPY = '1';
    else delete env.ARTIBOT_FLAT_COPY;

    return spawnSync(
      'bash',
      [toBashPath(harnessPath), toBashPath(libPath), toBashPath(srcDir), toBashPath(claudeDir)],
      { encoding: 'utf8', cwd: workDir, timeout: 60_000, env },
    );
  }

  const listed = (sub) => readdirSync(path.join(claudeDir, sub)).sort();

  it('(b) 캐시 없음 → 평소대로 전부 복사된다', () => {
    const res = run();
    expect(res.status).toBe(0);
    expect(listed('agents')).toEqual([...AGENTS].sort());
    expect(listed('commands')).toEqual([...COMMANDS].sort());
    expect(res.stdout).not.toMatch(SKIP_LOG_RE);
  });

  it('(a) 캐시 버전 디렉터리 있음 + 플래그 없음 → 한 파일도 복사되지 않는다', () => {
    seedNativeCache();
    const res = run();
    expect(res.status).toBe(0);
    expect(listed('agents')).toEqual([]);
    expect(listed('commands')).toEqual([]);
  });

  it('(a) 스킵 로그가 감지 경로와 함께 정확히 1회 찍힌다', () => {
    const versionDir = seedNativeCache('9.9.9');
    const res = run();
    expect((res.stdout.match(SKIP_LOG_RE) || []).length).toBe(1);
    expect(res.stdout).toMatch(/native plugin detected at /);
    expect(res.stdout).toMatch(/9\.9\.9/);
    expect(res.stdout).toMatch(/use --flat to force/);
    expect(existsSync(versionDir)).toBe(true); // 감지는 순수 조회다
  });

  it('(a) 잔존 평면 복사본이 있으면 개수와 함께 1회 warn 한다', () => {
    seedNativeCache();
    writeFileSync(path.join(claudeDir, 'agents', 'alpha.md'), 'old\n', 'utf8');
    writeFileSync(path.join(claudeDir, 'agents', 'beta.md'), 'old\n', 'utf8');
    writeFileSync(path.join(claudeDir, 'commands', 'one.md'), 'old\n', 'utf8');

    const res = run();
    const all = res.stdout + res.stderr;
    expect((all.match(LEFTOVER_RE) || []).length).toBe(1);
    expect(all).toMatch(/\b3 previously flat-copied/);
    expect(all).toMatch(/uninstall/);
    // 삭제하지 않는다 — 경고만.
    expect(listed('agents')).toEqual(['alpha.md', 'beta.md']);
    expect(listed('commands')).toEqual(['one.md']);
    expect(readFileSync(path.join(claudeDir, 'agents', 'alpha.md'), 'utf8')).toBe('old\n');
  });

  it('(a) 잔존본이 없으면 warn 을 찍지 않는다', () => {
    seedNativeCache();
    const res = run();
    expect(res.stdout + res.stderr).not.toMatch(LEFTOVER_RE);
  });

  it('(c) 캐시 있음 + ARTIBOT_FLAT_COPY=1 → 강제 복사된다', () => {
    seedNativeCache();
    const res = run({ flat: true });
    expect(res.status).toBe(0);
    expect(listed('agents')).toEqual([...AGENTS].sort());
    expect(listed('commands')).toEqual([...COMMANDS].sort());
    expect(res.stdout).not.toMatch(SKIP_LOG_RE);
  });

  it('캐시 루트만 있고 버전 디렉터리가 없으면 네이티브가 아니다', () => {
    mkdirSync(path.join(claudeDir, 'plugins', 'cache', 'artibot', 'artibot'), { recursive: true });
    const res = run();
    expect(res.status).toBe(0);
    expect(listed('agents')).toEqual([...AGENTS].sort());
  });

  it('(4) 스킵했을 때 verify_install 요약이 0 을 실패로 읽히지 않게 표기한다', () => {
    seedNativeCache();
    const res = run();
    const agentsLine = res.stdout.split('\n').find((l) => /Agents:/.test(l));
    const commandsLine = res.stdout.split('\n').find((l) => /Commands:/.test(l));
    expect(agentsLine).toMatch(/flat copy skipped — native plugin/);
    expect(commandsLine).toMatch(/flat copy skipped — native plugin/);
  });

  it('(4) 복사가 일어난 실행에는 스킵 표기가 붙지 않는다', () => {
    const res = run();
    const agentsLine = res.stdout.split('\n').find((l) => /Agents:/.test(l));
    expect(agentsLine).not.toMatch(/flat copy skipped/);
  });
});

// ---------------------------------------------------------------------------
// 3. argv 파싱 — 실제 install.sh 를 돌리되 복사 단계에 절대 도달하지 않는 경로만
//
// `--flat bogus` 는 알 수 없는 액션이라 usage + exit 1 로 끝난다. HOME 을 temp
// 로 덮어 CLAUDE_DIR 이 실제 홈을 가리킬 여지도 없앤다.
// ---------------------------------------------------------------------------

describe.skipIf(!hasBash)('install-native-detect/argv', () => {
  let sandbox;

  beforeEach(() => { sandbox = mkdtempSync(path.join(os.tmpdir(), 'artibot-argv-')); });
  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }); });

  it('(e) 알 수 없는 액션은 usage 를 찍고 1 로 끝난다 (--flat 이 앞서도)', () => {
    const res = spawnSync('bash', [toBashPath(INSTALL_SH), '--flat', 'bogus'], {
      encoding: 'utf8',
      cwd: sandbox,
      timeout: 60_000,
      env: { ...process.env, HOME: sandbox, USERPROFILE: sandbox },
    });
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/Usage: \.\/install\.sh \[install\|uninstall\|files\] \[--flat\]/);
    // 어떤 것도 설치되지 않았다.
    expect(existsSync(path.join(sandbox, '.claude', 'agents'))).toBe(false);
  });

  // 위의 하네스는 함수를 직접 부른다 — main 의 argv 파싱과 install_agents 사이가
  // 실제로 이어져 있는지는 증명하지 않는다. 여기서만 그 사슬 전체를 잰다.
  // `files` 는 파일 배치 단계만 도는 allowlist 서브커맨드라 임시 HOME 밖으로
  // 나가지 않는다(tests/firewall/install-files-smoke.test.js 와 같은 근거).
  // 캐시 없는 복사 경로는 그 스모크가 이미 커버하므로 여기서는 스킵 쪽만 잰다.
  it('files 서브커맨드가 네이티브 감지 시 실제로 복사를 건너뛴다 (main → install_agents)', () => {
    mkdirSync(path.join(sandbox, '.claude', 'plugins', 'cache', 'artibot', 'artibot', '4.57.0'), {
      recursive: true,
    });
    const res = spawnSync('bash', [toBashPath(INSTALL_SH), 'files'], {
      encoding: 'utf8',
      cwd: sandbox,
      timeout: 300_000,
      env: { ...process.env, HOME: sandbox, USERPROFILE: sandbox },
    });
    expect(res.status).toBe(0);
    expect((res.stdout.match(SKIP_LOG_RE) || []).length).toBe(1);
    expect(readdirSync(path.join(sandbox, '.claude', 'agents'))).toEqual([]);
    expect(readdirSync(path.join(sandbox, '.claude', 'commands'))).toEqual([]);
    // 스킵은 agents/commands 에만 적용된다 — 나머지 배치 단계는 그대로 돈다.
    expect(existsSync(path.join(sandbox, '.claude', 'artibot', 'lib'))).toBe(true);
  }, 320_000);
});
