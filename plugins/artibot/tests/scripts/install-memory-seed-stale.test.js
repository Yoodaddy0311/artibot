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
// 기존 설치본 MEMORY.md 유령 도구명 — 비파괴 파킹
//
// auto-memory 시드는 write-once 다. v1.7.0~ 시절 인스톨러가 써 넣은
// `use \`Task()\` to delegate` 는 재설치·업데이트로도 고쳐지지 않고 영구 잔존한다
// (`Task` 는 하네스에서 `Agent` 로 개명됐다). 그렇다고 덮어쓸 수도 없다 — 그 파일은
// 이미 사용자 문서다. 그래서 install.sh park_stale_memory_seed /
// install.ps1 Save-StaleMemorySeed 는 **원본을 그대로 두고** 최신 시드를
// MEMORY.md.artibot-new 로 옆에 park 한다 (install_rules 의 .artibot-new 관례).
//
// install-rules-nondestructive.test.js 와 같은 방식: 복사본이 아니라 현행 소스에서
// 함수 블록을 추출해 임시 디렉터리에서 실제 셸로 실행한다. 실제 ~/.claude 는
// 건드리지 않는다.
//
// ── 이 게이트가 못 보는 것 (rules §9 — 게이트 옆에 적어라) ──────────────────
//
//  1. **인스톨러 전체를 실행하지 않는다.** 함수 블록만 떼어 하네스에서 돌린다.
//     seed_auto_memory 가 계산하는 project_hash 경로 해석(한글·공백 경로)이
//     틀리면 park 는 애초에 호출되지 않는데, 그 결함은 여기서 안 보인다.
//  2. **실제 사용자 머신의 MEMORY.md 분포는 모른다.** 픽스처는 v1.7.0 시드
//     원문에서 가져왔지만, 사용자가 그 뒤 어떻게 편집했는지는 CI 가 알 수 없다.
//     "유령이 남은 설치본이 몇 대인가"는 미측정이다.
//  3. **탐지어는 `Task(` 하나뿐이고, 시드 서명이 있는 파일에서만 본다.**
//     `Task()` 는 이 시드가 실제로 내보낸 유일한 유령 이름이다(git log -S 로 전
//     이력 확인: d778e739 sh / 545b21fe ps1). 하네스가 또 개명하면 같이 낡는다.
//     TeamCreate/TeamDelete/TodoWrite 는 똑같이 죽은 이름이지만 **이 시드에는
//     없었으므로** 일부러 안 본다 — 넣으면 사용자 본인 산문에 오탐하고, 파킹된
//     시드가 그 줄을 고쳐주지도 못한다. 즉 **시드 밖에서 낡은 도구명을 쓰는
//     메모리 파일은 이 게이트가 잡지 않는다.** 그건 다른 표면의 문제다.
//  3b. **서명을 지운 낡은 시드는 놓친다.** 사용자가 헤더 줄을 지우고 낡은
//     불릿만 남겼으면 탐지되지 않는다. 의도적 트레이드오프다 — 놓침의 비용은
//     현상 유지지만, 오탐의 비용은 남의 디스크에 파일을 만드는 것이다.
//  4. **파킹 이후는 사람의 몫이다.** .artibot-new 를 사용자가 실제로 열어
//     병합하는지는 강제할 수 없다. 원본은 낡은 채로 남아 있을 수 있다.
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

/**
 * 히어독/히어스트링 **사이의 본문만** 잘라낸다. 못 찾으면 던진다 — null 을
 * 흘리면 아래 ASCII 검사가 빈 문자열을 재며 조용히 통과한다.
 *
 * @param {string} text
 * @param {RegExp} start
 * @param {RegExp} end
 * @param {string} label
 */
function seedBody(text, start, end, label) {
  const lines = text.split(/\r?\n/);
  const from = lines.findIndex((l) => start.test(l));
  if (from === -1) throw new Error(`${label}: 시드 시작 마커를 찾지 못했다`);
  const rel = lines.slice(from + 1).findIndex((l) => end.test(l));
  if (rel === -1) throw new Error(`${label}: 시드 종결 마커를 찾지 못했다`);
  const body = lines.slice(from + 1, from + 1 + rel).join('\n');
  if (body.length < 200) throw new Error(`${label}: 시드 본문이 너무 짧다 (${body.length}B)`);
  return body;
}

const shSeedBody = () => seedBody(installShContent, /<<SEED_MEMORY\s*$/, /^SEED_MEMORY\s*$/, 'install.sh');
const ps1SeedBody = () => seedBody(installPs1Content, /\$seed = @"/, /^"@\s*$/, 'install.ps1');

/** 두 인스톨러가 공유하는 시드 서명. 이게 없으면 우리가 쓴 파일이 아니다. */
const SEED_SIGNATURE = '# Project Memory (Seeded by Artibot)';

/**
 * v1.7.0 인스톨러가 실제로 써 넣었던 MEMORY.md 원문 (d778e739 에서 인용).
 * 픽스처가 실패 영역에 **실제로 도달**하는지는 아래 자기검증 describe 가 따로
 * 단언한다 — 픽스처가 경계를 못 건드려 공허하게 green 이 된 선례가 있다.
 */
const LEGACY_SEED = [
  '# Project Memory (Seeded by Artibot)',
  '',
  '## Artibot Quick Reference',
  '- **Agents**: 26 specialized agents — use `Task()` to delegate',
  '',
  '## Workflow Tips',
  '- Parallel work: launch multiple agents with `Task()` for independent tasks',
  '',
  '## My own notes',
  '- 이 줄은 사용자가 직접 추가한 것이다. 절대 사라지면 안 된다.',
  '',
].join('\n');

/**
 * 유령 이름이 **없는** MEMORY.md. 네거티브 컨트롤.
 * 실재 도구 `TaskCreate(`/`TaskUpdate(` 를 일부러 넣어, 부분일치 오탐이 나면
 * 이 픽스처가 RED 가 되게 한다.
 */
const CLEAN_MEMORY = [
  '# Project Memory (Seeded by Artibot)',
  '',
  '- **Agents**: use `Agent()` to delegate',
  '- 작업 추적은 TaskCreate() / TaskUpdate() / TaskList() 로 한다.',
  '- 이 파일에는 유령 도구명이 없다.',
  '',
].join('\n');

/**
 * **시드가 아닌** 사용자 메모리 파일인데 산문에서 `Task()` 를 언급한다.
 *
 * 가공한 픽스처가 아니라 이 리포의 실제 auto-memory 에서 인용했다
 * (`~/.claude/projects/<hash>/memory/MEMORY.md`, 2026-08-15 18:5x 실측):
 * 27행에 "백로그 1순위 = 인스톨러 유령 Task() 문자열", 74행에 "Agent Teams API:
 * TeamCreate, ..." 가 있고 **시드 헤더는 없다**. 즉 인스톨러가 쓴 파일이 아니다.
 *
 * 유령 이름만 보고 파킹하면 이 사용자에게 "당신 시드가 낡았다"고 알리게 되는데
 * 그는 애초에 시드를 받은 적이 없다. 그래서 탐지는 헤더까지 두 조건이다.
 */
const USER_AUTHORED_MEMORY = [
  '# Artibot Project Memory',
  '',
  '## Project History',
  '- 백로그 1순위 = 인스톨러 유령 Task() 문자열.',
  '',
  '## Architecture Notes',
  '- Agent Teams API: TeamCreate, SendMessage, TaskCreate/Update for orchestration',
  '',
].join('\n');

const hasBash = probeBash().ok;
if (!hasBash) announceBashSkip('install-memory-seed-stale/install.sh behavior');

const psProbe = spawnSync(
  'powershell',
  ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output psok'],
  { encoding: 'utf8' },
);
const hasPowerShell = psProbe.status === 0 && (psProbe.stdout || '').includes('psok');

// ---------------------------------------------------------------------------
// 0. 픽스처 자기검증 — 셸 없이도 항상 실행
// ---------------------------------------------------------------------------

describe('install-memory-seed-stale/fixture reach', () => {
  it('STALE 픽스처가 실제로 탐지 대상 리터럴을 포함한다', () => {
    // 이게 깨지면 아래 "파킹된다" 테스트는 아무것도 증명하지 않는다.
    expect(LEGACY_SEED).toContain('Task(');
  });

  it('CLEAN 픽스처는 탐지 리터럴을 포함하지 않으면서 실재 Task* 도구는 쓴다', () => {
    expect(CLEAN_MEMORY).not.toContain('Task(');
    expect(CLEAN_MEMORY).toContain('TaskCreate(');
    expect(CLEAN_MEMORY).toContain('TaskUpdate(');
  });

  it('세 픽스처 모두 시드 서명 조건을 의도대로 갖거나 갖지 않는다', () => {
    // 두 조건 중 어느 쪽이 판정을 갈랐는지 픽스처만 봐도 알 수 있어야 한다.
    expect(LEGACY_SEED).toContain(SEED_SIGNATURE); // 서명 O + 유령 O → park
    expect(CLEAN_MEMORY).toContain(SEED_SIGNATURE); // 서명 O + 유령 X → skip
    expect(USER_AUTHORED_MEMORY).not.toContain(SEED_SIGNATURE); // 서명 X → skip
  });

  it('USER_AUTHORED 픽스처가 유령 이름을 실제로 품고 있다 (오탐 유인이 살아있다)', () => {
    // 이게 깨지면 "오탐하지 않는다" 테스트가 아무 압력도 주지 못한다.
    expect(USER_AUTHORED_MEMORY).toContain('Task(');
    expect(USER_AUTHORED_MEMORY).toContain('TeamCreate');
  });

  it('픽스처들이 서로 다르다 (같은 값이면 대조가 공허하다)', () => {
    expect(new Set([LEGACY_SEED, CLEAN_MEMORY, USER_AUTHORED_MEMORY]).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 1. 정적 계약 — 셸 없이도 항상 실행
// ---------------------------------------------------------------------------

describe('install-memory-seed-stale/static contract', () => {
  it('install.sh 의 두 함수 블록이 추출 가능하다', () => {
    expect(extractBlock(installShContent, 'render_memory_seed\\(\\) \\{')).not.toBeNull();
    expect(extractBlock(installShContent, 'park_stale_memory_seed\\(\\) \\{')).not.toBeNull();
  });

  it('install.ps1 의 두 함수 블록이 추출 가능하다', () => {
    expect(extractBlock(installPs1Content, 'function Get-MemorySeed \\{')).not.toBeNull();
    expect(extractBlock(installPs1Content, 'function Save-StaleMemorySeed \\{')).not.toBeNull();
  });

  it('write-once 가드가 조기 return 전에 park 를 호출한다', () => {
    // 가드가 park 호출보다 먼저 return 해버리면 이 기능은 죽은 코드가 된다.
    const shSeed = extractBlock(installShContent, 'seed_auto_memory\\(\\) \\{');
    expect(shSeed).toMatch(/park_stale_memory_seed[\s\S]*?skipping seed[\s\S]*?return/);

    const psSeed = extractBlock(installPs1Content, 'function Initialize-AutoMemory \\{');
    expect(psSeed).toMatch(/Save-StaleMemorySeed[\s\S]*?skipping seed[\s\S]*?return/);
  });

  it('양쪽 인스톨러가 같은 탐지 리터럴을 쓴다 (sh ↔ ps1 파리티)', () => {
    expect(installShContent).toMatch(/STALE_SEED_PATTERN='Task\('/);
    expect(installPs1Content).toMatch(/\$script:StaleSeedPattern = 'Task\('/);
  });

  it('양쪽 인스톨러가 같은 시드 서명을 쓰고, 그 서명이 실제 시드에 들어 있다', () => {
    // 서명 문자열과 시드 본문이 갈라지면 탐지는 영원히 조용해진다 — fail-open.
    expect(installShContent).toContain(`SEED_SIGNATURE='${SEED_SIGNATURE}'`);
    expect(installPs1Content).toContain(`$script:SeedSignature = '${SEED_SIGNATURE}'`);
    expect(shSeedBody()).toContain(SEED_SIGNATURE);
    expect(ps1SeedBody()).toContain(SEED_SIGNATURE);
  });

  it('탐지는 서명과 유령 이름 두 조건을 모두 요구한다', () => {
    const shPark = extractBlock(installShContent, 'park_stale_memory_seed\\(\\) \\{');
    expect(shPark).toMatch(/SEED_SIGNATURE/);
    expect(shPark).toMatch(/STALE_SEED_PATTERN/);

    const psSave = extractBlock(installPs1Content, 'function Save-StaleMemorySeed \\{');
    expect(psSave).toMatch(/SeedSignature/);
    expect(psSave).toMatch(/StaleSeedPattern/);
  });
});

// ---------------------------------------------------------------------------
// 1b. install.ps1 시드는 순수 ASCII 여야 한다 (모지바케 방지)
// ---------------------------------------------------------------------------
// install.ps1 에는 BOM 이 없고(첫 바이트 23 52 65), Windows PowerShell 5.1 은
// BOM 없는 .ps1 을 ANSI 코드페이지로 읽는다. 그래서 here-string 안의 비-ASCII 는
// 사용자 디스크에 `??` 로 떨어진다. PowerShell 5.1.26100.9168 실측:
//   "- Agents — use ..."  ->  "- Agents ??use ..."
// install.sh 쪽 히어독은 em dash/화살표를 그대로 쓴다. 이 비대칭은 **의도**이며
// "파리티 복원"이라며 되돌리면 Windows 사용자 MEMORY.md 가 깨진다.
//
// 주석의 비-ASCII 는 무해하다(디스크로 안 나감). 그래서 파일 전체가 아니라
// **렌더되는 시드 본문만** 잰다.

describe('install-memory-seed-stale/ps1 seed ASCII-only', () => {
  it('install.ps1 시드 본문에 비-ASCII 문자가 없다', () => {
    const body = ps1SeedBody();
    const offenders = [...body].filter((ch) => ch.codePointAt(0) > 0x7f);
    expect(
      offenders,
      `비-ASCII 발견: ${JSON.stringify(offenders)} — install.ps1 는 BOM 이 없어 `
      + 'PS 5.1 이 ANSI 로 읽는다. 이 문자는 사용자 MEMORY.md 에 ?? 로 떨어진다.',
    ).toEqual([]);
  });

  it('install.ps1 에 BOM 이 없다는 전제 자체를 확인한다', () => {
    // BOM 이 생기면 위 제약의 근거가 사라진다. 그때 이 테스트가 먼저 RED 가 되어
    // "왜 ASCII 여야 하는가"를 다시 판단하게 만든다.
    const head = readFileSync(INSTALL_PS1).subarray(0, 3);
    expect([...head]).not.toEqual([0xef, 0xbb, 0xbf]);
  });

  it('install.sh 시드는 이 제약을 받지 않는다 (비대칭이 의도임을 고정)', () => {
    // sh 쪽이 조용히 ASCII 로 평탄화되면 이 테스트가 알려준다. 양쪽이 우연히
    // 같아져서 "제약이 없었네" 로 오해되는 걸 막는다.
    const nonAscii = [...shSeedBody()].filter((ch) => ch.codePointAt(0) > 0x7f);
    expect(nonAscii.length, 'install.sh 시드가 ASCII 로 평탄화됐다').toBeGreaterThan(0);
  });

  it('ps1 은 -DryRun 에서 파킹하지 않는다', () => {
    // 파킹은 디스크 쓰기다. dry-run 이 파일을 만들면 계약 위반.
    const psSeed = extractBlock(installPs1Content, 'function Initialize-AutoMemory \\{');
    expect(psSeed).toMatch(/if \(-not \$DryRun\) \{ Save-StaleMemorySeed/);
  });

  it('.artibot-new 접미사는 *.md 로 끝나지 않는다', () => {
    expect('MEMORY.md.artibot-new'.endsWith('.md')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. install.sh 실행형 — bash 가용 환경에서만
// ---------------------------------------------------------------------------

describe.skipIf(!hasBash)('install-memory-seed-stale/install.sh behavior', () => {
  let workDir;
  let memoryDir;
  let harnessPath;

  const MEMORY_MD = () => path.join(memoryDir, 'MEMORY.md');
  const PARKED = () => path.join(memoryDir, 'MEMORY.md.artibot-new');

  beforeEach(() => {
    workDir = mkdtempSync(path.join(os.tmpdir(), 'artibot-memseed-sh-'));
    memoryDir = path.join(workDir, 'memory');
    mkdirSync(memoryDir, { recursive: true });
    // render_memory_seed 의 find 가 도는 대상. `set -o pipefail` 아래에서
    // 없는 디렉터리를 세면 파이프라인이 실패하므로 실재하게 만든다.
    mkdirSync(path.join(workDir, 'claude', 'agents'), { recursive: true });
    mkdirSync(path.join(workDir, 'claude', 'commands'), { recursive: true });
    mkdirSync(path.join(workDir, 'claude', 'artibot', 'skills'), { recursive: true });

    const signatureLine = installShContent.match(/^SEED_SIGNATURE=.*$/m);
    const patternLine = installShContent.match(/^STALE_SEED_PATTERN=.*$/m);
    const renderFn = extractBlock(installShContent, 'render_memory_seed\\(\\) \\{');
    const parkFn = extractBlock(installShContent, 'park_stale_memory_seed\\(\\) \\{');
    expect(signatureLine).not.toBeNull();
    expect(patternLine).not.toBeNull();
    expect(renderFn).not.toBeNull();
    expect(parkFn).not.toBeNull();

    const harness = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'CLAUDE_DIR="$1"',
      'ARTIBOT_DIR="${CLAUDE_DIR}/artibot"',
      'TARGET="$2"',
      'log()  { echo "[log] $1"; }',
      'warn() { echo "[warn] $1"; }',
      '# --- extracted verbatim from install.sh ---',
      signatureLine[0],
      patternLine[0],
      renderFn,
      parkFn,
      '# --- end extracted block ---',
      'park_stale_memory_seed "$TARGET"',
      '',
    ].join('\n');
    harnessPath = path.join(workDir, 'memseed-harness.sh');
    writeFileSync(harnessPath, harness);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const run = () => spawnSync(
    'bash',
    [
      toBashPath(harnessPath),
      toBashPath(path.join(workDir, 'claude')),
      toBashPath(MEMORY_MD()),
    ],
    { encoding: 'utf8', timeout: 15_000 },
  );

  it('유령 문자열이 있으면 원본을 보존하고 최신 시드를 파킹한다', () => {
    writeFileSync(MEMORY_MD(), LEGACY_SEED);

    const res = run();
    expect(res.status).toBe(0);

    // 원본은 바이트 단위로 그대로. 사용자가 쓴 줄도 살아 있다.
    expect(readFileSync(MEMORY_MD(), 'utf8')).toBe(LEGACY_SEED);
    expect(readFileSync(MEMORY_MD(), 'utf8')).toContain('절대 사라지면 안 된다');

    expect(existsSync(PARKED())).toBe(true);
    const parked = readFileSync(PARKED(), 'utf8');
    expect(parked).toContain('Agent()');
    expect(parked).not.toContain('Task(');
    expect(res.stdout).toContain('Task()');
    expect(res.stdout).toContain('MEMORY.md.artibot-new');
  });

  it('네거티브 컨트롤: 유령이 없으면 파킹도 경고도 없다', () => {
    writeFileSync(MEMORY_MD(), CLEAN_MEMORY);

    const res = run();
    expect(res.status).toBe(0);
    expect(readFileSync(MEMORY_MD(), 'utf8')).toBe(CLEAN_MEMORY);
    expect(existsSync(PARKED()), '깨끗한 파일에 .artibot-new 가 생겼다').toBe(false);
    // 정상 경로는 무신호여야 한다 — 잡음을 추가하면 경고가 무시된다.
    expect(res.stdout).not.toContain('[warn]');
  });

  it('실재 Task* 도구만 쓰는 파일을 오탐하지 않는다', () => {
    writeFileSync(MEMORY_MD(), 'TaskCreate( TaskUpdate( TaskList( TaskGet( TaskStop(\n');

    const res = run();
    expect(res.status).toBe(0);
    expect(existsSync(PARKED())).toBe(false);
  });

  it('시드가 아닌 사용자 메모리는 Task() 를 언급해도 건드리지 않는다', () => {
    // 실제 라이브 MEMORY.md 에서 인용한 픽스처. 서명 조건이 없으면 여기서 파킹이
    // 일어나고, 시드를 받은 적 없는 사용자에게 "시드가 낡았다"고 알리게 된다.
    writeFileSync(MEMORY_MD(), USER_AUTHORED_MEMORY);

    const res = run();
    expect(res.status).toBe(0);
    expect(readFileSync(MEMORY_MD(), 'utf8')).toBe(USER_AUTHORED_MEMORY);
    expect(existsSync(PARKED()), '시드가 아닌 파일에 .artibot-new 가 생겼다').toBe(false);
    expect(res.stdout).not.toContain('[warn]');
  });

  it('재실행 멱등: 원본은 계속 그대로, 파킹본은 최신으로 갱신된다', () => {
    writeFileSync(MEMORY_MD(), LEGACY_SEED);

    expect(run().status).toBe(0);
    // 낡은 파킹본을 심어두고 다시 돌린다 → 최신으로 덮여야 한다.
    writeFileSync(PARKED(), '# 낡은 파킹본\n');
    expect(run().status).toBe(0);

    expect(readFileSync(MEMORY_MD(), 'utf8')).toBe(LEGACY_SEED);
    const parked = readFileSync(PARKED(), 'utf8');
    expect(parked).not.toContain('낡은 파킹본');
    expect(parked).toContain('Agent()');
  });

  it('render_memory_seed 자체가 유령 이름을 내보내지 않는다', () => {
    // park 경로와 신규 설치 경로가 같은 렌더러를 쓴다는 것의 직접 확인.
    const probe = spawnSync(
      'bash',
      ['-c', [
        'set -euo pipefail',
        `CLAUDE_DIR="${toBashPath(path.join(workDir, 'claude'))}"`,
        'ARTIBOT_DIR="${CLAUDE_DIR}/artibot"',
        extractBlock(installShContent, 'render_memory_seed\\(\\) \\{'),
        'render_memory_seed',
      ].join('\n')],
      { encoding: 'utf8', timeout: 15_000 },
    );
    expect(probe.status).toBe(0);
    expect(probe.stdout).toContain('Agent()');
    expect(probe.stdout).not.toContain('Task(');
    expect(probe.stdout.length).toBeGreaterThan(200);
  });
});

// ---------------------------------------------------------------------------
// 3. install.ps1 실행형 — PowerShell 가용 환경에서만
// ---------------------------------------------------------------------------

describe.skipIf(!hasPowerShell)('install-memory-seed-stale/install.ps1 behavior', () => {
  let workDir;
  let memoryDir;
  let harnessPath;

  const MEMORY_MD = () => path.join(memoryDir, 'MEMORY.md');
  const PARKED = () => path.join(memoryDir, 'MEMORY.md.artibot-new');

  beforeEach(() => {
    workDir = mkdtempSync(path.join(os.tmpdir(), 'artibot-memseed-ps-'));
    memoryDir = path.join(workDir, 'memory');
    mkdirSync(memoryDir, { recursive: true });
    mkdirSync(path.join(workDir, 'claude', 'agents'), { recursive: true });
    mkdirSync(path.join(workDir, 'claude', 'commands'), { recursive: true });
    mkdirSync(path.join(workDir, 'claude', 'artibot', 'skills'), { recursive: true });

    const signatureLine = installPs1Content.match(/^\$script:SeedSignature = .*$/m);
    const patternLine = installPs1Content.match(/^\$script:StaleSeedPattern = .*$/m);
    const getFn = extractBlock(installPs1Content, 'function Get-MemorySeed \\{');
    const saveFn = extractBlock(installPs1Content, 'function Save-StaleMemorySeed \\{');
    expect(signatureLine).not.toBeNull();
    expect(patternLine).not.toBeNull();
    expect(getFn).not.toBeNull();
    expect(saveFn).not.toBeNull();

    const harness = [
      'param([string]$ClaudeDir, [string]$Target)',
      'Set-StrictMode -Version Latest',
      "$ErrorActionPreference = 'Stop'",
      '$ArtibotDir = Join-Path $ClaudeDir "artibot"',
      'function Write-Log   { param($msg) Write-Host "[log] $msg" }',
      'function Write-Warn2 { param($msg) Write-Host "[warn] $msg" }',
      '# --- extracted verbatim from install.ps1 ---',
      signatureLine[0],
      patternLine[0],
      getFn,
      saveFn,
      '# --- end extracted block ---',
      'Save-StaleMemorySeed $Target',
      '',
    ].join('\n');
    harnessPath = path.join(workDir, 'memseed-harness.ps1');
    writeFileSync(harnessPath, harness);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const run = () => spawnSync(
    'powershell',
    [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', harnessPath,
      '-ClaudeDir', path.join(workDir, 'claude'),
      '-Target', MEMORY_MD(),
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );

  it('유령 문자열이 있으면 원본을 보존하고 최신 시드를 파킹한다', () => {
    writeFileSync(MEMORY_MD(), LEGACY_SEED);

    const res = run();
    expect(res.status).toBe(0);
    expect(readFileSync(MEMORY_MD(), 'utf8')).toBe(LEGACY_SEED);
    expect(existsSync(PARKED())).toBe(true);

    const parked = readFileSync(PARKED(), 'utf8');
    expect(parked).toContain('Agent()');
    expect(parked).not.toContain('Task(');
    expect(res.stdout).toContain('MEMORY.md.artibot-new');
  });

  it('네거티브 컨트롤: 유령이 없으면 파킹도 경고도 없다', () => {
    writeFileSync(MEMORY_MD(), CLEAN_MEMORY);

    const res = run();
    expect(res.status).toBe(0);
    expect(readFileSync(MEMORY_MD(), 'utf8')).toBe(CLEAN_MEMORY);
    expect(existsSync(PARKED()), '깨끗한 파일에 .artibot-new 가 생겼다').toBe(false);
    expect(res.stdout).not.toContain('[warn]');
  });

  it('실재 Task* 도구만 쓰는 파일을 오탐하지 않는다', () => {
    writeFileSync(MEMORY_MD(), 'TaskCreate( TaskUpdate( TaskList( TaskGet( TaskStop(\n');

    const res = run();
    expect(res.status).toBe(0);
    expect(existsSync(PARKED())).toBe(false);
  });

  it('시드가 아닌 사용자 메모리는 Task() 를 언급해도 건드리지 않는다', () => {
    writeFileSync(MEMORY_MD(), USER_AUTHORED_MEMORY);

    const res = run();
    expect(res.status).toBe(0);
    expect(readFileSync(MEMORY_MD(), 'utf8')).toBe(USER_AUTHORED_MEMORY);
    expect(existsSync(PARKED()), '시드가 아닌 파일에 .artibot-new 가 생겼다').toBe(false);
    expect(res.stdout).not.toContain('[warn]');
  });

  it('재실행 멱등: 원본은 계속 그대로, 파킹본은 최신으로 갱신된다', () => {
    writeFileSync(MEMORY_MD(), LEGACY_SEED);

    expect(run().status).toBe(0);
    writeFileSync(PARKED(), '# 낡은 파킹본\n');
    expect(run().status).toBe(0);

    expect(readFileSync(MEMORY_MD(), 'utf8')).toBe(LEGACY_SEED);
    const parked = readFileSync(PARKED(), 'utf8');
    expect(parked).not.toContain('낡은 파킹본');
    expect(parked).toContain('Agent()');
  });
});

// sh ↔ ps1 실동작 파리티를 위한 별도 describe 는 두지 않는다. 두 구현의 판정은
// 각자의 실행형 describe 가 **같은 두 픽스처**(LEGACY_SEED / CLEAN_MEMORY)로
// 이미 대조하고 있고, 탐지 리터럴이 같다는 것은 정적 계약이 단언한다. 그 위에
// JS 로 `includes` 를 한 번 더 재는 테스트는 어느 셸도 실행하지 않으므로 공허한
// green 이 된다.
