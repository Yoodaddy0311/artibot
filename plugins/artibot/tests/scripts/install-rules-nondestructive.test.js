import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { announceBashSkip, probeBash, toBashPath } from '../../scripts/utils/bash-compat.js';

// ---------------------------------------------------------------------------
// 인스톨러 rules 비파괴 설치 — install.sh install_rules / install.ps1 Copy-MdFiles
//
// rules/*.md 는 사용자가 직접 손으로 키우는 개인 상시지침이다. 설치가 그걸
// 조용히 덮어쓰면 안 된다. 설치본이 리포 사본과 다르면 원본을 남기고 리포
// 버전을 <name>.md.artibot-new 로 파킹한다.
//
// install-lock.test.js 와 같은 방식: 복사본이 아니라 현행 소스에서 함수 블록을
// 추출해 임시 디렉터리에서 실제 셸로 실행한다. 실제 ~/.claude 는 건드리지 않는다.
// ---------------------------------------------------------------------------

const PLUGIN_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const INSTALL_SH = path.join(PLUGIN_ROOT, 'install.sh');
const INSTALL_PS1 = path.join(PLUGIN_ROOT, 'install.ps1');
const installShContent = readFileSync(INSTALL_SH, 'utf-8');
const installPs1Content = readFileSync(INSTALL_PS1, 'utf-8');

/** 컬럼 0의 여는 토큰부터 컬럼 0의 닫는 `}` 까지 추출 (중첩 블록은 들여쓰기됨) */
function extractBlock(content, header) {
  const re = new RegExp(`^${header}[\\s\\S]*?^\\}`, 'm');
  const match = content.match(re);
  return match ? match[0] : null;
}

// `bash -c 'echo ok'` 로 가드하던 자리. WSL bash 는 그 프로브를 통과하면서도
// toBashPath 가 만드는 `C:/...` 경로를 열지 못해 하네스가 127 로 죽는다.
// 존재가 아니라 경로 호환성을 재는 프로브로 교체.
const hasBash = probeBash().ok;
if (!hasBash) announceBashSkip('install-rules/install.sh behavior');

const psProbe = spawnSync(
  'powershell',
  ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output psok'],
  { encoding: 'utf8' },
);
const hasPowerShell = psProbe.status === 0 && (psProbe.stdout || '').includes('psok');

// ---------------------------------------------------------------------------
// 1. 정적 계약 — 셸 없이도 항상 실행
// ---------------------------------------------------------------------------

describe('install-rules/static contract', () => {
  it('install.sh install_rules 블록이 존재하고 추출 가능', () => {
    expect(extractBlock(installShContent, 'install_rules\\(\\) \\{')).not.toBeNull();
  });

  it('install.sh: 대상이 다르면 덮어쓰지 않고 .artibot-new 로 파킹', () => {
    const block = extractBlock(installShContent, 'install_rules\\(\\) \\{');
    expect(block).toMatch(/cmp -s/);
    expect(block).toMatch(/\.artibot-new/);
  });

  it('install.ps1: rules 호출부만 -Preserve, agents/commands 는 무조건 갱신', () => {
    const rulesCall = installPs1Content.match(/Copy-MdFiles[^\n]*-Label 'Rules'[^\n]*/);
    const agentsCall = installPs1Content.match(/Copy-MdFiles[^\n]*-Label 'Agents'[^\n]*/);
    const commandsCall = installPs1Content.match(/Copy-MdFiles[^\n]*-Label 'Commands'[^\n]*/);
    expect(rulesCall?.[0]).toMatch(/-Preserve/);
    expect(agentsCall?.[0]).not.toMatch(/-Preserve/);
    expect(commandsCall?.[0]).not.toMatch(/-Preserve/);
  });

  it('.artibot-new 접미사는 *.md 로 끝나지 않는다 (rules 로더·verify 카운트가 무시)', () => {
    // verify_install 의 rule_count 는 -name "*.md" 로 센다 (install.sh)
    expect(installShContent).toMatch(/-name "\*\.md"/);
    expect('verification-discipline.md.artibot-new'.endsWith('.md')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. install.sh 실행형 — bash 가용 환경에서만
// ---------------------------------------------------------------------------

describe.skipIf(!hasBash)('install-rules/install.sh behavior', () => {
  let workDir;
  let srcRules;
  let dstRules;
  let harnessPath;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(os.tmpdir(), 'artibot-rules-sh-'));
    srcRules = path.join(workDir, 'src', 'rules');
    dstRules = path.join(workDir, 'claude', 'rules', 'artibot');
    mkdirSync(srcRules, { recursive: true });
    mkdirSync(dstRules, { recursive: true });

    const block = extractBlock(installShContent, 'install_rules\\(\\) \\{');
    expect(block).not.toBeNull();
    const harness = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'SCRIPT_DIR="$1"',
      'CLAUDE_DIR="$2"',
      'log()  { echo "[log] $1"; }',
      'warn() { echo "[warn] $1"; }',
      '# --- extracted verbatim from install.sh ---',
      block,
      '# --- end extracted block ---',
      'install_rules',
      '',
    ].join('\n');
    harnessPath = path.join(workDir, 'rules-harness.sh');
    writeFileSync(harnessPath, harness);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const run = () => spawnSync(
    'bash',
    [
      toBashPath(harnessPath),
      toBashPath(path.join(workDir, 'src')),
      toBashPath(path.join(workDir, 'claude')),
    ],
    { encoding: 'utf8', timeout: 15_000 },
  );

  it('손편집본이 있으면 보존하고 리포 버전을 .artibot-new 로 저장', () => {
    writeFileSync(path.join(srcRules, 'verification-discipline.md'), '# repo version\n');
    writeFileSync(path.join(dstRules, 'verification-discipline.md'), '# MY HAND EDITS\n');

    const res = run();
    expect(res.status).toBe(0);

    const kept = readFileSync(path.join(dstRules, 'verification-discipline.md'), 'utf8');
    expect(kept).toBe('# MY HAND EDITS\n');

    const parked = path.join(dstRules, 'verification-discipline.md.artibot-new');
    expect(existsSync(parked)).toBe(true);
    expect(readFileSync(parked, 'utf8')).toBe('# repo version\n');
    expect(res.stdout).toContain('Kept your edited verification-discipline.md');
    expect(res.stdout).toContain('Locally edited rules kept as-is: 1');
  });

  it('내용이 같으면 .artibot-new 를 만들지 않는다', () => {
    writeFileSync(path.join(srcRules, 'dev-protocol.md'), '# same\n');
    writeFileSync(path.join(dstRules, 'dev-protocol.md'), '# same\n');

    const res = run();
    expect(res.status).toBe(0);
    expect(existsSync(path.join(dstRules, 'dev-protocol.md.artibot-new'))).toBe(false);
    expect(res.stdout).toContain('Rules installed: 1 files');
    expect(res.stdout).not.toContain('Locally edited rules kept');
  });

  it('신규 설치(빈 대상 디렉터리)는 정상 복사', () => {
    writeFileSync(path.join(srcRules, 'a.md'), '# a\n');
    writeFileSync(path.join(srcRules, 'b.md'), '# b\n');

    const res = run();
    expect(res.status).toBe(0);
    expect(readFileSync(path.join(dstRules, 'a.md'), 'utf8')).toBe('# a\n');
    expect(readFileSync(path.join(dstRules, 'b.md'), 'utf8')).toBe('# b\n');
    expect(existsSync(path.join(dstRules, 'a.md.artibot-new'))).toBe(false);
    expect(res.stdout).toContain('Rules installed: 2 files');
  });

  it('혼합 상태: 손편집 1건 + 신규 1건 + 동일 1건', () => {
    writeFileSync(path.join(srcRules, 'edited.md'), '# repo\n');
    writeFileSync(path.join(dstRules, 'edited.md'), '# mine\n');
    writeFileSync(path.join(srcRules, 'fresh.md'), '# fresh\n');
    writeFileSync(path.join(srcRules, 'same.md'), '# same\n');
    writeFileSync(path.join(dstRules, 'same.md'), '# same\n');

    const res = run();
    expect(res.status).toBe(0);
    expect(readFileSync(path.join(dstRules, 'edited.md'), 'utf8')).toBe('# mine\n');
    expect(readFileSync(path.join(dstRules, 'fresh.md'), 'utf8')).toBe('# fresh\n');
    expect(res.stdout).toContain('Rules installed: 2 files');
    expect(res.stdout).toContain('Locally edited rules kept as-is: 1');
  });

  it('재실행 멱등: 두 번 돌려도 손편집본은 그대로', () => {
    writeFileSync(path.join(srcRules, 'x.md'), '# repo\n');
    writeFileSync(path.join(dstRules, 'x.md'), '# mine\n');

    expect(run().status).toBe(0);
    expect(run().status).toBe(0);
    expect(readFileSync(path.join(dstRules, 'x.md'), 'utf8')).toBe('# mine\n');
    expect(readFileSync(path.join(dstRules, 'x.md.artibot-new'), 'utf8')).toBe('# repo\n');
  });
});

// ---------------------------------------------------------------------------
// 3. install.ps1 실행형 — PowerShell 가용 환경에서만
// ---------------------------------------------------------------------------

describe.skipIf(!hasPowerShell)('install-rules/install.ps1 behavior', () => {
  let workDir;
  let srcDir;
  let dstDir;
  let harnessPath;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(os.tmpdir(), 'artibot-rules-ps-'));
    srcDir = path.join(workDir, 'src');
    dstDir = path.join(workDir, 'dst');
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(dstDir, { recursive: true });

    const cmpFn = extractBlock(installPs1Content, 'function Test-FileContentEqual \\{');
    const copyFn = extractBlock(installPs1Content, 'function Copy-MdFiles \\{');
    expect(cmpFn).not.toBeNull();
    expect(copyFn).not.toBeNull();

    const harness = [
      'param([string]$SrcDir, [string]$DstDir, [switch]$UsePreserve)',
      'Set-StrictMode -Version Latest',
      "$ErrorActionPreference = 'Stop'",
      '$DryRun = $false',
      'function Write-Log   { param($msg) Write-Host "[log] $msg" }',
      'function Write-Warn2 { param($msg) Write-Host "[warn] $msg" }',
      '# --- extracted verbatim from install.ps1 ---',
      cmpFn,
      copyFn,
      '# --- end extracted block ---',
      'if ($UsePreserve) {',
      "  Copy-MdFiles -SrcDir $SrcDir -DstDir $DstDir -Label 'Rules' -Preserve",
      '} else {',
      "  Copy-MdFiles -SrcDir $SrcDir -DstDir $DstDir -Label 'Agents'",
      '}',
      '',
    ].join('\n');
    harnessPath = path.join(workDir, 'rules-harness.ps1');
    writeFileSync(harnessPath, harness);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const run = (preserve) => spawnSync(
    'powershell',
    [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', harnessPath,
      '-SrcDir', srcDir,
      '-DstDir', dstDir,
      ...(preserve ? ['-UsePreserve'] : []),
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );

  it('-Preserve: 손편집본 보존 + .artibot-new 생성', () => {
    writeFileSync(path.join(srcDir, 'verification-discipline.md'), '# repo version\n');
    writeFileSync(path.join(dstDir, 'verification-discipline.md'), '# MY HAND EDITS\n');

    const res = run(true);
    expect(res.status).toBe(0);
    expect(readFileSync(path.join(dstDir, 'verification-discipline.md'), 'utf8'))
      .toBe('# MY HAND EDITS\n');
    const parked = path.join(dstDir, 'verification-discipline.md.artibot-new');
    expect(existsSync(parked)).toBe(true);
    expect(readFileSync(parked, 'utf8')).toBe('# repo version\n');
    expect(res.stdout).toContain('Kept your edited verification-discipline.md');
  });

  it('-Preserve 미지정(agents/commands 경로): 종전대로 무조건 덮어쓴다 — 회귀 방지', () => {
    writeFileSync(path.join(srcDir, 'architect.md'), '# new plugin version\n');
    writeFileSync(path.join(dstDir, 'architect.md'), '# stale old version\n');

    const res = run(false);
    expect(res.status).toBe(0);
    expect(readFileSync(path.join(dstDir, 'architect.md'), 'utf8'))
      .toBe('# new plugin version\n');
    expect(existsSync(path.join(dstDir, 'architect.md.artibot-new'))).toBe(false);
    expect(res.stdout).toContain('Agents installed: 1 files');
  });

  it('-Preserve + 동일 내용: .artibot-new 없음', () => {
    writeFileSync(path.join(srcDir, 'same.md'), '# same\n');
    writeFileSync(path.join(dstDir, 'same.md'), '# same\n');

    const res = run(true);
    expect(res.status).toBe(0);
    expect(existsSync(path.join(dstDir, 'same.md.artibot-new'))).toBe(false);
    expect(res.stdout).toContain('Rules installed: 1 files');
  });

  it('-Preserve + 신규 설치(빈 대상): 정상 복사', () => {
    writeFileSync(path.join(srcDir, 'a.md'), '# a\n');
    writeFileSync(path.join(srcDir, 'b.md'), '# b\n');

    const res = run(true);
    expect(res.status).toBe(0);
    expect(readFileSync(path.join(dstDir, 'a.md'), 'utf8')).toBe('# a\n');
    expect(readFileSync(path.join(dstDir, 'b.md'), 'utf8')).toBe('# b\n');
    expect(res.stdout).toContain('Rules installed: 2 files');
  });

  it('파킹된 .artibot-new 는 다음 실행에서 *.md 소스로 잡히지 않는다', () => {
    // Windows 의 -Filter '*.md' 가 .md.artibot-new 를 매치하면 파킹 파일이
    // 재설치 대상으로 되돌아온다. 실제 동작으로 확인.
    writeFileSync(path.join(srcDir, 'x.md'), '# repo\n');
    writeFileSync(path.join(srcDir, 'x.md.artibot-new'), '# parked\n');

    const res = run(true);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Rules installed: 1 files');
    expect(existsSync(path.join(dstDir, 'x.md.artibot-new'))).toBe(false);
  });
});
