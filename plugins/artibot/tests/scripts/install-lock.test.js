import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { announceBashSkip, probeBash, toBashPath } from '../../scripts/utils/bash-compat.js';

// ---------------------------------------------------------------------------
// install.sh acquire_install_lock — 동시성 뮤텍스 스모크 테스트 (v4.31.1)
//
// 2026-07-09 캐시 반파 사고의 재발방지 장치. install.sh 전체를 실행하지 않고
// 락 블록(INSTALL_LOCK_DIR= ~ acquire_install_lock 닫는 중괄호)만 실제 소스에서
// 추출해 하네스 셸에서 실행한다 — 복사본이 아니라 현행 코드가 테스트 대상.
// ---------------------------------------------------------------------------

const PLUGIN_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const INSTALL_SH = path.join(PLUGIN_ROOT, 'install.sh');
const installShContent = readFileSync(INSTALL_SH, 'utf-8');

/** INSTALL_LOCK_DIR 선언부터 acquire_install_lock 함수 끝(컬럼 0의 `}`)까지 추출 */
function extractLockBlock(content) {
  const match = content.match(/^INSTALL_LOCK_DIR=[\s\S]*?^\}/m);
  return match ? match[0] : null;
}

// `bash -c 'echo ok'` 로 가드하던 자리. 그 프로브는 WSL bash 에서도 성공하는데
// WSL 은 toBashPath 가 만드는 `C:/...` 경로를 열지 못해 하네스가 127 로 죽었다.
// 존재가 아니라 경로 호환성을 재는 프로브로 교체한다.
const hasBash = probeBash().ok;
if (!hasBash) announceBashSkip('install-lock/behavioral smoke');

// ---------------------------------------------------------------------------
// 1. 정적 검증 — bash 없이도 항상 실행
// ---------------------------------------------------------------------------

describe('install-lock/static contract', () => {
  it('락 블록이 install.sh에 존재하고 추출 가능', () => {
    expect(extractLockBlock(installShContent)).not.toBeNull();
  });

  it('mkdir 기반 원자적 락 + EXIT trap 해제', () => {
    const block = extractLockBlock(installShContent);
    expect(block).toMatch(/mkdir "\$\{INSTALL_LOCK_DIR\}"/);
    expect(block).toMatch(/trap 'rmdir "\$\{INSTALL_LOCK_DIR\}".*' EXIT/);
  });

  it('GNU stat(-c %Y) 우선 + BSD stat(-f %m) 폴백 + 최종 echo 0 fail-open', () => {
    const block = extractLockBlock(installShContent);
    expect(block).toMatch(/stat -c %Y .* \|\| stat -f %m .* \|\| echo 0/);
  });

  it('stale 임계값 600초(10분)', () => {
    const block = extractLockBlock(installShContent);
    expect(block).toMatch(/-gt 600/);
  });

  it('main에서 락 획득이 install_marketplace_mirror/install_plugin_cache 이전', () => {
    // 정의부가 아닌 호출부(파일 후반 main 블록)끼리 순서 비교
    const lockCall = installShContent.lastIndexOf('acquire_install_lock');
    const mirrorCall = installShContent.lastIndexOf('install_marketplace_mirror');
    const cacheCall = installShContent.lastIndexOf('install_plugin_cache');
    expect(lockCall).toBeGreaterThan(0);
    expect(lockCall).toBeLessThan(mirrorCall);
    expect(lockCall).toBeLessThan(cacheCall);
  });
});

// ---------------------------------------------------------------------------
// 2. 실행형 스모크 — bash 가용 환경에서만 (없으면 skip)
// ---------------------------------------------------------------------------

describe.skipIf(!hasBash)('install-lock/behavioral smoke', () => {
  let workDir;
  let claudeDir;
  let lockDir;
  let harnessPath;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(os.tmpdir(), 'artibot-lock-'));
    claudeDir = path.join(workDir, 'claude');
    mkdirSync(claudeDir, { recursive: true });
    lockDir = path.join(claudeDir, '.artibot-install.lock');

    const block = extractLockBlock(installShContent);
    expect(block).not.toBeNull();
    const harness = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'CLAUDE_DIR="$1"',
      'MODE="${2:-acquire}"',
      'warn() { echo "[warn] $1"; }',
      'err()  { echo "[err] $1" >&2; }',
      '# --- extracted verbatim from install.sh ---',
      block,
      '# --- end extracted block ---',
      'case "$MODE" in',
      '  acquire)',
      '    acquire_install_lock',
      '    echo "LOCK_ACQUIRED"',
      '    ;;',
      '  crash)',
      '    acquire_install_lock',
      '    echo "LOCK_ACQUIRED"',
      '    exit 3',
      '    ;;',
      '  hold)',
      '    acquire_install_lock',
      '    echo "LOCK_ACQUIRED"',
      '    : > "${CLAUDE_DIR}/holder-ready"',
      '    i=0',
      '    while [ ! -e "${CLAUDE_DIR}/release" ] && [ "$i" -lt 100 ]; do',
      '      sleep 0.1',
      '      i=$((i + 1))',
      '    done',
      '    echo "HOLDER_DONE"',
      '    ;;',
      'esac',
      '',
    ].join('\n');
    harnessPath = path.join(workDir, 'lock-harness.sh');
    writeFileSync(harnessPath, harness);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const runHarness = (mode) => spawnSync(
    'bash',
    [toBashPath(harnessPath), toBashPath(claudeDir), mode],
    { encoding: 'utf8', timeout: 15_000 },
  );

  it('깨끗한 상태에서 획득 성공 + 종료 시 EXIT trap이 락 해제', () => {
    const res = runHarness('acquire');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('LOCK_ACQUIRED');
    expect(existsSync(lockDir)).toBe(false);
  });

  it('신선한 락이 있으면 즉시 실패하고, 남의 락을 지우지 않는다', () => {
    mkdirSync(lockDir);
    const res = runHarness('acquire');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Another install is already running');
    // 패자는 trap을 설치하지 않으므로 보유자의 락이 살아있어야 한다
    expect(existsSync(lockDir)).toBe(true);
  });

  it('10분 넘은 stale 락은 회수 후 획득 성공', () => {
    mkdirSync(lockDir);
    const staleEpoch = (Date.now() - 700_000) / 1000; // 700초 전 > 600초 임계
    utimesSync(lockDir, staleEpoch, staleEpoch);
    const res = runHarness('acquire');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Reclaiming stale install lock');
    expect(res.stdout).toContain('LOCK_ACQUIRED');
    expect(existsSync(lockDir)).toBe(false);
  });

  it('획득 후 비정상 종료(crash)해도 EXIT trap이 락을 해제한다', () => {
    const res = runHarness('crash');
    expect(res.status).toBe(3);
    expect(res.stdout).toContain('LOCK_ACQUIRED');
    expect(existsSync(lockDir)).toBe(false);
  });

  it('실제 동시 실행: 보유 중인 프로세스가 있으면 두 번째는 차단된다', async () => {
    const holder = spawn(
      'bash',
      [toBashPath(harnessPath), toBashPath(claudeDir), 'hold'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let holderOut = '';
    holder.stdout.on('data', (d) => { holderOut += d; });

    // 보유자가 락을 잡을 때까지 대기 (sentinel 파일 폴링, 최대 5초)
    const readyFile = path.join(claudeDir, 'holder-ready');
    const deadline = Date.now() + 5_000;
    while (!existsSync(readyFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(existsSync(readyFile)).toBe(true);

    try {
      const contender = runHarness('acquire');
      expect(contender.status).toBe(1);
      expect(contender.stderr).toContain('Another install is already running');
    } finally {
      // 보유자 해제 신호 → 정상 종료 대기
      writeFileSync(path.join(claudeDir, 'release'), '');
      const holderExit = await new Promise((resolve) => {
        holder.on('close', resolve);
        setTimeout(() => { holder.kill(); resolve(-1); }, 12_000);
      });
      expect(holderExit).toBe(0);
    }

    expect(holderOut).toContain('HOLDER_DONE');
    // 보유자 종료 후 락은 해제되어 있어야 한다
    expect(existsSync(lockDir)).toBe(false);
  }, 20_000);
});
