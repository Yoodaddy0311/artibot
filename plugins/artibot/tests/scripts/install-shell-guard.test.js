import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { announceBashSkip, probeBash, probeBashCandidate, toBashPath } from '../../scripts/utils/bash-compat.js';
import { findBash } from '../../scripts/update-platform.js';

// ---------------------------------------------------------------------------
// 셸 선택 함정 회귀방지 (2026-08-11)
//
// 맨이름 `bash` 는 무엇이 실행했느냐에 따라 다른 바이너리로 해석된다. Git Bash
// 세션에서는 /usr/bin/bash 가 1순위지만 PowerShell/cmd 에서는 첫 히트가
// C:\WINDOWS\system32\bash.exe — WSL 런처다. npm 의 윈도 기본 스크립트 셸이 cmd
// 이므로 `npm run sync:local` 은 윈도 체크아웃인데도 WSL 에 도달한다.
//
// 두 지점을 잠근다:
//   1. install.sh#assert_supported_shell — WSL + /mnt 소스트리를 정확한 메시지로 차단
//   2. update-platform.js#findBash — 후보를 `--version` 이 아니라 "네이티브 경로
//      스크립트를 실행할 수 있는가"라는 능력으로 채택 (부정목록 아님)
//
// 라이브 설치는 건드리지 않는다. 함수만 추출해 하네스에서 돌린다.
// ---------------------------------------------------------------------------

const PLUGIN_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const installShContent = readFileSync(path.join(PLUGIN_ROOT, 'install.sh'), 'utf-8');
const syncLocalContent = readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'sync-local.sh'), 'utf-8');
const updatePlatformContent = readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'update-platform.js'), 'utf-8');

function extractShellFn(content, name) {
  const match = content.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
  return match ? match[0] : null;
}

/** findBash 본문만 (다른 함수의 --version 사용과 섞이지 않게) */
function extractFindBash() {
  const m = updatePlatformContent.match(/export function findBash\(\) \{[\s\S]*?\n\}/);
  return m ? m[0] : null;
}

const hasBash = probeBash().ok;
if (!hasBash) announceBashSkip('install-shell-guard/behavioral');

// ---------------------------------------------------------------------------
// 1. install.sh 가드 — 정적 계약
// ---------------------------------------------------------------------------

describe('install-shell-guard/static', () => {
  it('assert_supported_shell 이 존재한다', () => {
    expect(extractShellFn(installShContent, 'assert_supported_shell')).not.toBeNull();
  });

  it('WSL 을 긍정 식별한다 — 런처 경로 부정목록이 아니다', () => {
    const fn = extractShellFn(installShContent, 'assert_supported_shell');
    // 부정목록(System32\bash.exe 차단)은 다음 런처 경로에 fail-open 이다.
    expect(fn).toMatch(/WSL_DISTRO_NAME/);
    expect(fn).toMatch(/microsoft \/proc\/version/);
    expect(fn).not.toMatch(/[Ss]ystem32/);
  });

  it('check_prerequisites 의 첫 동작이다 — claude 존재 확인보다 먼저', () => {
    const fn = extractShellFn(installShContent, 'check_prerequisites');
    expect(fn).not.toBeNull();
    const guardAt = fn.indexOf('assert_supported_shell');
    const claudeAt = fn.indexOf('command -v claude');
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(claudeAt).toBeGreaterThan(guardAt);
  });

  it('sync-local.sh 는 맨이름 bash 가 아니라 현재 인터프리터를 재사용한다', () => {
    expect(syncLocalContent).toMatch(/"\$\{BASH:-bash\}" "\$\{PLUGIN_ROOT\}\/install\.sh"/);
    expect(syncLocalContent).not.toMatch(/^bash "\$\{PLUGIN_ROOT\}/m);
  });
});

// ---------------------------------------------------------------------------
// 2. install.sh 가드 — 실행형 (환경을 주입해 분기를 전수)
// ---------------------------------------------------------------------------

describe.skipIf(!hasBash)('install-shell-guard/behavioral', () => {
  let workDir;
  let harnessPath;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(os.tmpdir(), 'artibot-shellguard-'));
    const fn = extractShellFn(installShContent, 'assert_supported_shell');
    expect(fn).not.toBeNull();
    const harness = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'err() { echo "[err] $1" >&2; }',
      // uname 만 주입한다. /proc/version 은 실제 값을 쓰되, 그 값이 판정에
      // 끼어들었는지 진단으로 흘려 테스트가 환경 가정을 눈으로 확인하게 한다.
      'uname() { echo "${FAKE_UNAME}"; }',
      'SCRIPT_DIR="${FAKE_SCRIPT_DIR}"',
      'if grep -qi microsoft /proc/version 2>/dev/null; then echo "PROCVER_WSL=yes"; else echo "PROCVER_WSL=no"; fi',
      '# --- extracted verbatim from install.sh ---',
      fn,
      '# --- end extracted block ---',
      'assert_supported_shell',
      'echo "GUARD_PASSED"',
      '',
    ].join('\n');
    harnessPath = path.join(workDir, 'guard-harness.sh');
    writeFileSync(harnessPath, harness);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  /** 시나리오(커널/소스경로/배포판)를 하네스 환경변수로 변환해 실행 */
  const run = ({ kernel, source, wslDistro = '' }) => spawnSync(
    'bash',
    [toBashPath(harnessPath)],
    {
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        FAKE_UNAME: kernel,
        FAKE_SCRIPT_DIR: source,
        WSL_DISTRO_NAME: wslDistro,
      },
    },
  );

  it('Git Bash(Msys)는 통과한다', () => {
    const res = run({ kernel: 'MINGW64_NT-10.0', source: '/c/repo/plugins/artibot' });
    expect(res.stdout).toContain('GUARD_PASSED');
    expect(res.status).toBe(0);
  });

  it('진짜 리눅스(WSL 아님)는 통과한다', () => {
    const res = run({ kernel: 'Linux', source: '/srv/ci/ab/plugins/artibot' });
    // 이 케이스가 유효하려면 테스트 호스트 자체가 WSL 이 아니어야 한다
    expect(res.stdout).toContain('PROCVER_WSL=no');
    expect(res.stdout).toContain('GUARD_PASSED');
  });

  it('WSL 이지만 리눅스쪽 체크아웃이면 통과한다 (정당한 리눅스 설치)', () => {
    const res = run({ kernel: 'Linux', source: '/srv/dev/ab/plugins/artibot', wslDistro: 'Ubuntu' });
    expect(res.stdout).toContain('GUARD_PASSED');
  });

  it('WSL + 윈도 마운트 체크아웃이면 정확한 메시지로 차단한다', () => {
    const res = run({ kernel: 'Linux', source: '/mnt/c/work/ab/plugins/artibot', wslDistro: 'Ubuntu' });
    expect(res.stdout).not.toContain('GUARD_PASSED');
    expect(res.status).toBe(1);
    // "Claude Code CLI not found" 로 오진하던 자리 — 진짜 원인을 말해야 한다
    expect(res.stderr).toContain('Running under WSL');
    expect(res.stderr).toContain('install.ps1');
    expect(res.stderr).toContain('Git Bash');
  });

  it('macOS 는 통과한다', () => {
    const res = run({ kernel: 'Darwin', source: '/opt/dev/ab/plugins/artibot' });
    expect(res.stdout).toContain('GUARD_PASSED');
  });
});

// ---------------------------------------------------------------------------
// 3. findBash — 능력 기반 채택
// ---------------------------------------------------------------------------

describe('findBash/capability-based selection', () => {
  it('후보를 --version 으로 채택하지 않는다 (WSL 에서도 통과하는 프로브)', () => {
    const fn = extractFindBash();
    expect(fn).not.toBeNull();
    expect(fn).toMatch(/probeBashCandidate/);
    expect(fn).not.toMatch(/--version/);
  });

  it('부정목록이 아니다 — 경로 이름으로 거르지 않는다', () => {
    const fn = extractFindBash();
    expect(fn).not.toMatch(/[Ss]ystem32/);
  });

  it('never-throw 계약 유지 + string|null 반환', () => {
    let result;
    expect(() => { result = findBash(); }).not.toThrow();
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('non-Windows 에서는 bash 를 그대로 반환 (프로브 비용 없음)', () => {
    if (process.platform === 'win32') return;
    expect(findBash()).toBe('bash');
  });

  it('윈도에서 고른 bash 는 네이티브 경로 스크립트를 실제로 실행할 수 있다', () => {
    if (process.platform !== 'win32') return;
    const chosen = findBash();
    expect(chosen).not.toBeNull();
    expect(probeBashCandidate(chosen).ok).toBe(true);
  });
});

describe('probeBashCandidate', () => {
  it('없는 바이너리는 던지지 않고 ok:false', () => {
    let res;
    expect(() => { res = probeBashCandidate('artibot-no-such-shell-xyz'); }).not.toThrow();
    expect(res.ok).toBe(false);
    expect(res.reason).not.toBe('');
  });

  it('빈 입력도 던지지 않는다', () => {
    expect(probeBashCandidate('').ok).toBe(false);
    expect(probeBashCandidate(undefined).ok).toBe(false);
  });

  it('probeBash 가 ok 인 환경에서는 bash 후보도 ok (같은 판정 기준)', () => {
    if (!hasBash) return;
    expect(probeBashCandidate('bash').ok).toBe(true);
  });
});
