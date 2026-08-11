import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { announceBashSkip, probeBash, toBashPath } from '../../scripts/utils/bash-compat.js';

// ---------------------------------------------------------------------------
// install.sh atomic_replace_dir — 캐시 미러 비원자성 회귀방지 (이월 백로그 #15)
//
// 고치기 전 코드는 `rm -rf "${dst}"` 후 safe_copy_dir 였다. 그 사이 구간 동안
// 디렉터리가 없거나 반만 차 있고, 그 시점에 뜬 훅은 ERR_MODULE_NOT_FOUND 로 죽는다.
// 순간이 아니다 — rsync 부재(Windows Git Bash 기본) 시 safe_copy_dir 는 파일당
// cp 루프로 폴백하며 lib/(293파일) 한 곳에 54.6초가 걸린다(2026-08-11 실측).
//
// install-lock.test.js 와 같은 방식: 함수 블록을 install.sh 원본에서 그대로
// 추출해 하네스에서 실행한다 — 복사본이 아니라 현행 코드가 테스트 대상.
// 라이브 캐시(~/.claude/plugins/cache)는 절대 건드리지 않는다. 전부 temp 픽스처.
// ---------------------------------------------------------------------------

const PLUGIN_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const INSTALL_SH = path.join(PLUGIN_ROOT, 'install.sh');
const INSTALL_PS1 = path.join(PLUGIN_ROOT, 'install.ps1');
const installShContent = readFileSync(INSTALL_SH, 'utf-8');
const installPs1Content = readFileSync(INSTALL_PS1, 'utf-8');

/** 컬럼 0에서 시작해 컬럼 0의 `}` 로 닫히는 셸 함수 본문을 추출 */
function extractShellFn(content, name) {
  const match = content.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
  return match ? match[0] : null;
}

const hasBash = probeBash().ok;
if (!hasBash) announceBashSkip('install-atomic-replace/behavioral');

// ---------------------------------------------------------------------------
// 1. 정적 계약 — bash 없이도 항상 실행
// ---------------------------------------------------------------------------

describe('install-atomic-replace/static contract', () => {
  it('atomic_replace_dir 가 install.sh 에 존재하고 추출 가능', () => {
    expect(extractShellFn(installShContent, 'atomic_replace_dir')).not.toBeNull();
  });

  it('스테이징은 목적지 형제 경로 — 같은 볼륨이어야 rename 이 rename 으로 남는다', () => {
    const fn = extractShellFn(installShContent, 'atomic_replace_dir');
    expect(fn).toMatch(/staging="\$\{dst\}\.artibot-new"/);
    expect(fn).toMatch(/retired="\$\{dst\}\.artibot-old"/);
  });

  it('스왑은 2단계 — 살아있는 경로 위로 단일 mv 를 하지 않는다', () => {
    // Windows(및 coreutils mv 전반): 목적지가 존재하면 mv 는 그 "안으로" 넣는다.
    // 교체가 아니라 중첩이 되므로 단일 mv 는 금지.
    const fn = extractShellFn(installShContent, 'atomic_replace_dir');
    expect(fn).toMatch(/mv "\$\{dst\}" "\$\{retired\}"/);
    expect(fn).toMatch(/mv "\$\{staging\}" "\$\{dst\}"/);
    // 단일 mv 는 목적지 부재(`! -d`) 분기 안에서만 허용된다
    expect(fn).toMatch(/if \[ ! -d "\$\{dst\}" \]/);
  });

  it('2번째 mv 실패 시 롤백 경로가 있다 (목적지가 사라진 채 남지 않는다)', () => {
    const fn = extractShellFn(installShContent, 'atomic_replace_dir');
    expect(fn).toMatch(/mv "\$\{retired\}" "\$\{dst\}"/);
  });

  it('빈 스테이징이 정상 트리를 대체하지 못한다 (fail-safe)', () => {
    const fn = extractShellFn(installShContent, 'atomic_replace_dir');
    expect(fn).toMatch(/ls -A "\$\{staging\}"/);
    expect(fn).toMatch(/previous copy left in place/);
  });

  it('잠긴 목적지 폴백은 삭제 없이 덮어쓴다 (rm -rf "${dst}" 가 없다)', () => {
    const fn = extractShellFn(installShContent, 'atomic_replace_dir');
    expect(fn).toMatch(/cp -r "\$\{staging\}\/\." "\$\{dst\}\/"/);
    // 목적지 트리 전체를 통째로 지우는 구문이 함수 어디에도 없어야 한다
    expect(fn).not.toMatch(/rm -rf "\$\{dst\}"(\s|$)/m);
  });

  it('세 미러 호출부 모두 atomic_replace_dir 를 쓰고 rm-rf-후-복사가 남아있지 않다', () => {
    for (const fnName of ['install_hooks', 'install_marketplace_mirror', 'install_plugin_cache']) {
      const fn = extractShellFn(installShContent, fnName);
      expect(fn, `${fnName} 추출 실패`).not.toBeNull();
      expect(fn, `${fnName} 가 atomic_replace_dir 를 쓰지 않음`).toMatch(/atomic_replace_dir/);
      expect(fn, `${fnName} 에 rm -rf 후 복사가 남아있음`).not.toMatch(/rm -rf/);
    }
  });

  it('install.ps1 파리티 — Copy-DirAtomic 존재 + 두 래퍼가 위임', () => {
    expect(installPs1Content).toMatch(/function Copy-DirAtomic/);
    // Copy-DirClean / Copy-Tree 는 이름만 유지하고 실제 동작은 위임한다
    const clean = installPs1Content.match(/function Copy-DirClean \{[\s\S]*?\n\}/);
    const tree = installPs1Content.match(/function Copy-Tree \{[\s\S]*?\n\}/);
    expect(clean?.[0]).toMatch(/Copy-DirAtomic/);
    expect(clean?.[0]).not.toMatch(/Remove-Item/);
    expect(tree?.[0]).toMatch(/Copy-DirAtomic/);
    expect(tree?.[0]).not.toMatch(/Remove-Item/);
  });

  it('install.ps1 스왑도 2단계 + 롤백', () => {
    // install.ps1 은 CRLF — 함수 끝은 `}\r\n` 이라 `\n\}\n` 로는 안 잡힌다
    const fn = installPs1Content.match(/function Copy-DirAtomic \{[\s\S]*?\r?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn[0]).toMatch(/\[System\.IO\.Directory\]::Move\(\$dst, \$retired\)/);
    expect(fn[0]).toMatch(/\[System\.IO\.Directory\]::Move\(\$staging, \$dst\)/);
    expect(fn[0]).toMatch(/\[System\.IO\.Directory\]::Move\(\$retired, \$dst\)/);
  });
});

// ---------------------------------------------------------------------------
// 2. 실행형 — bash 가용 환경에서만
// ---------------------------------------------------------------------------

describe.skipIf(!hasBash)('install-atomic-replace/behavioral', () => {
  let workDir;
  let srcDir;
  let dstDir;
  let harnessPath;

  /** 실제 install.sh 함수 2개를 그대로 담은 하네스. SLOW_COPY=1 이면 스테이징을 지연 */
  function writeHarness(extra = '') {
    const safeCopy = extractShellFn(installShContent, 'safe_copy_dir');
    const atomic = extractShellFn(installShContent, 'atomic_replace_dir');
    expect(safeCopy).not.toBeNull();
    expect(atomic).not.toBeNull();
    const harness = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'warn() { echo "[warn] $1"; }',
      '# --- extracted verbatim from install.sh ---',
      safeCopy,
      atomic,
      '# --- end extracted block ---',
      extra,
      'atomic_replace_dir "$1" "$2" && echo "REPLACE_OK" || echo "REPLACE_RC=$?"',
      '',
    ].join('\n');
    harnessPath = path.join(workDir, 'harness.sh');
    writeFileSync(harnessPath, harness);
  }

  const run = (extraArgs = []) => spawnSync(
    'bash',
    [toBashPath(harnessPath), toBashPath(srcDir), toBashPath(dstDir), ...extraArgs],
    { encoding: 'utf8', timeout: 60_000 },
  );

  const readIf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

  beforeEach(() => {
    workDir = mkdtempSync(path.join(os.tmpdir(), 'artibot-atomic-'));
    srcDir = path.join(workDir, 'src');
    dstDir = path.join(workDir, 'dst');

    // 새 버전(src): 3파일 + 중첩 디렉터리
    mkdirSync(path.join(srcDir, 'core'), { recursive: true });
    writeFileSync(path.join(srcDir, 'index.js'), 'export const v = "new";\n');
    writeFileSync(path.join(srcDir, 'core', 'config.js'), 'export const c = "new";\n');
    writeFileSync(path.join(srcDir, 'core', 'added.js'), 'export const a = 1;\n');

    // 기존 버전(dst): 겹치는 2파일 + 신버전에 없는 stale 1파일
    mkdirSync(path.join(dstDir, 'core'), { recursive: true });
    writeFileSync(path.join(dstDir, 'index.js'), 'export const v = "old";\n');
    writeFileSync(path.join(dstDir, 'core', 'config.js'), 'export const c = "old";\n');
    writeFileSync(path.join(dstDir, 'core', 'stale.js'), 'export const s = "gone";\n');
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('정상 교체: 새 내용으로 바뀌고 stale 파일이 제거되며 잔여물이 남지 않는다', () => {
    writeHarness();
    const res = run();
    expect(res.stdout).toContain('REPLACE_OK');
    expect(readIf(path.join(dstDir, 'index.js'))).toContain('"new"');
    expect(readIf(path.join(dstDir, 'core', 'added.js'))).toContain('export const a');
    expect(existsSync(path.join(dstDir, 'core', 'stale.js'))).toBe(false);
    // .artibot-new / .artibot-old 잔여물 없음
    const siblings = readdirSync(workDir);
    expect(siblings.filter((n) => n.includes('.artibot-'))).toEqual([]);
  });

  it('목적지가 없으면 새로 만든다 (창 자체가 없는 단일 rename 경로)', () => {
    rmSync(dstDir, { recursive: true, force: true });
    writeHarness();
    const res = run();
    expect(res.stdout).toContain('REPLACE_OK');
    expect(readIf(path.join(dstDir, 'index.js'))).toContain('"new"');
  });

  // 핵심 회귀 테스트 (리더 요구사항 #4)
  it('복사 도중 죽어도 기존 lib 가 살아있다', async () => {
    // 스테이징 복사를 느리게 만든 뒤 그 한복판에서 SIGKILL 한다. 고치기 전 코드는
    // 이 시점에 이미 rm -rf 를 마친 상태라 dst 가 통째로 없어져 있었다.
    writeHarness([
      'if [ "${SLOW_COPY:-}" = "1" ]; then',
      '  safe_copy_dir() { mkdir -p "$2"; : > "${WORKDIR}/copy-started"; sleep 20; }',
      'fi',
    ].join('\n'));

    const child = spawn(
      'bash',
      [toBashPath(harnessPath), toBashPath(srcDir), toBashPath(dstDir)],
      { env: { ...process.env, SLOW_COPY: '1', WORKDIR: toBashPath(workDir) }, stdio: 'ignore' },
    );

    const started = path.join(workDir, 'copy-started');
    const deadline = Date.now() + 10_000;
    while (!existsSync(started) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(existsSync(started), '느린 복사가 시작되지 않음').toBe(true);

    child.kill('SIGKILL');
    await new Promise((resolve) => { child.on('close', resolve); });

    // 기존 트리가 원본 그대로 살아있어야 한다 — 이것이 이 변경의 전부다
    expect(existsSync(dstDir)).toBe(true);
    expect(readIf(path.join(dstDir, 'index.js'))).toContain('"old"');
    expect(readIf(path.join(dstDir, 'core', 'config.js'))).toContain('"old"');
    expect(readIf(path.join(dstDir, 'core', 'stale.js'))).toContain('"gone"');
  }, 30_000);

  it('스테이징 복사가 실패하면 기존 트리를 건드리지 않는다', () => {
    writeHarness('safe_copy_dir() { return 1; }');
    const res = run();
    expect(res.stdout).toContain('previous copy left in place');
    expect(readIf(path.join(dstDir, 'index.js'))).toContain('"old"');
    expect(existsSync(path.join(dstDir, 'core', 'stale.js'))).toBe(true);
  });

  it('스테이징이 비어 나오면 정상 트리를 대체하지 않는다', () => {
    writeHarness('safe_copy_dir() { mkdir -p "$2"; return 0; }');
    const res = run();
    expect(res.stdout).toContain('came out empty');
    expect(readIf(path.join(dstDir, 'index.js'))).toContain('"old"');
  });

  it('rename 이 거부돼도(잠긴 목적지) 교체가 완료되고 목적지가 사라지지 않는다', () => {
    // mv 를 강제로 실패시켜 in-place 폴백 경로를 탄다. Windows 에서 열린 핸들이
    // 있을 때 실제로 발생하는 상황(2026-08-11 실측: EACCES)의 결정론적 재현.
    writeHarness('mv() { return 1; }');
    const res = run();
    expect(res.stdout).toContain('REPLACE_OK');
    // 폴백은 삭제 없이 덮어쓴다 → 목적지는 한 순간도 사라지지 않고 최종 내용은 새 버전
    expect(readIf(path.join(dstDir, 'index.js'))).toContain('"new"');
    expect(readIf(path.join(dstDir, 'core', 'added.js'))).toContain('export const a');
    expect(existsSync(path.join(dstDir, 'core', 'stale.js'))).toBe(false);
  });

  it('교체 내내 목적지는 "없거나 완전" — 반쯤 찬 상태로 관측되지 않는다', async () => {
    writeHarness();
    const child = spawn(
      'bash',
      [toBashPath(harnessPath), toBashPath(srcDir), toBashPath(dstDir)],
      { stdio: 'ignore' },
    );

    // close 리스너는 폴링 "전에" 건다 — 뒤에 걸면 이미 발화한 이벤트를 영원히 기다린다
    let done = false;
    const closed = new Promise((resolve) => {
      child.on('close', () => { done = true; resolve(); });
    });

    // 교체가 도는 동안 목적지를 계속 샘플링한다. 고치기 전 코드에서는 index.js 는
    // 있는데 core/config.js 는 아직 없는 중간 상태가 관측된다.
    const partial = [];
    let samples = 0;
    while (!done) {
      const hasIndex = existsSync(path.join(dstDir, 'index.js'));
      const hasConfig = existsSync(path.join(dstDir, 'core', 'config.js'));
      const exists = existsSync(dstDir);
      samples += 1;
      if (exists && hasIndex !== hasConfig) partial.push({ hasIndex, hasConfig });
      await new Promise((r) => setTimeout(r, 2));
    }
    await closed;

    expect(samples).toBeGreaterThan(0);
    expect(partial).toEqual([]);
    expect(readIf(path.join(dstDir, 'index.js'))).toContain('"new"');
  }, 30_000);
});
