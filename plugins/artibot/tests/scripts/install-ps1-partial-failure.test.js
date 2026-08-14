import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// install.ps1 — 부분 설치가 성공으로 보고되는 문제 (M6, PowerShell 쪽)
//
// sh 쪽은 install-partial-failure.test.js 가 `install_hooks -> verify_install`
// 연쇄를 고정한다. **이 파일은 그 파일의 PowerShell 대응이다.** 두 파일을
// 나란히 읽을 수 있게 구조·이름·단언 순서를 맞춰 두었다.
//
// 고정하는 계약 (install.ps1:498-501 이 스스로 문서화한 것):
//   Copy-DirAtomic 은 목적지가 새 트리를 갖게 되면 $true, 이전 복사본이
//   유지되거나 일부만 덮인 경우 $false 를 반환한다. 모든 $false 는
//   $script:InstallFailures 도 올리므로, 반환값을 무시하는 호출자라도
//   깨끗한 설치라고 보고할 수 없다 — 그 게이트가 Show-Summary 다.
//
// **주 단언은 반환값이 아니라 관측 결과다.** 부분 실패했으면 사용자 화면에
// "Installation complete!" 가 뜨면 안 된다. 반환값 형태나 집계 변수명이 아니라
// 이것이 계약이다. (sh 쪽에서 이걸 거꾸로 했다가 실패했다: install_hooks 의
// 비영 반환을 단언했는데 실제 구현은 집계 변수였고, 옳은 구현에 red 가 났다.)
// bool 반환은 install.ps1 이 주석으로 명시한 공개 계약이라 함께 고정하되,
// 별도 단언으로 둔다 — 나중에 어느 쪽이 움직였는지 구분되도록.
//
// 실측 (2026-08-15, PS 5.1.26100.9168, 잠긴 목적지 파일로 실제 부분 실패 유발):
//
//   현재 install.ps1     부분실패 -> RETURN=False, 배너 없음, PARTIAL INSTALL 표시
//                        정상    -> RETURN=True,  배너 있음
//   구 850b5682          부분실패 -> RETURN=null,  **배너 있음**, PARTIAL 없음
//                        정상    -> RETURN=null,  배너 있음
//
// 구 코드의 부분실패 줄이 이 파일이 존재하는 이유다: 진짜로 실패한 설치가
// "Installation complete!" 로 끝났다.
//
// 이 파일이 보지 못하는 것 (그린을 실제보다 크게 읽지 않도록 명시):
//   - **프로세스 종료코드.** ps1 은 sh 와 구조가 다르다: verify_install 은
//     함수가 직접 `return 1` 하지만, ps1 의 Show-Summary 는 그냥 `return` 하고
//     비영 종료는 최상위 라인(install.ps1:1189)이 낸다. 최상위는 인스톨러를
//     통째로 실행해야 닿는데 그건 ~/.claude 를 덮어쓰는 부작용이 있어 금지다.
//     그래서 종료코드는 아래 정적 계약으로만 고정한다.
//   - 실패가 아닌 다른 이유로 트리가 낡은 경우. 개수는 동작이 아니다.
//   - Copy-DirAtomic 의 나머지 실패 경로(빈 스테이징·rename 거부 등). 그쪽은
//     install-atomic-replace.test.js 가 본다. 여기서는 "실패가 사용자에게
//     도달하는가" 한 가지만 본다.
// ---------------------------------------------------------------------------

const PLUGIN_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const INSTALL_PS1 = path.join(PLUGIN_ROOT, 'install.ps1');
const installPs1Content = readFileSync(INSTALL_PS1, 'utf-8');

const canRunPwsh = process.platform === 'win32'
  && spawnSync('powershell', ['-NoProfile', '-Command', 'exit 0'], { timeout: 20_000 }).status === 0;

// ---------------------------------------------------------------------------
// 1. 정적 계약 — PowerShell 없이도 항상 실행
// ---------------------------------------------------------------------------

describe('install-ps1-partial-failure/static contract', () => {
  it('Show-Summary 가 완료 배너를 조건 뒤에 둔다 (무조건이 아니다)', () => {
    const fn = installPs1Content.match(/^function Show-Summary \{[\s\S]*?^\}/m);
    expect(fn, 'Show-Summary 추출 실패 — 아래 단언이 공허해진다').not.toBeNull();
    // 배너보다 앞에 부분설치 분기가 있어야 한다. 순서가 뒤집히면 배너가 먼저
    // 찍히고 경고가 뒤따르는, 사용자가 성공으로 읽는 출력이 된다.
    const partialAt = fn[0].indexOf('PARTIAL INSTALL');
    const bannerAt = fn[0].indexOf('Installation complete!');
    expect(partialAt).toBeGreaterThanOrEqual(0);
    expect(bannerAt).toBeGreaterThanOrEqual(0);
    expect(partialAt).toBeLessThan(bannerAt);
  });

  it('부분 설치는 비영 종료로도 이어진다 (배너와 같은 조건)', () => {
    // 종료코드는 실행형으로 못 잡는다(헤더 참조). 대신 **조건식을 소스에서
    // 끌어내** 같은 조건이 최상위 exit 게이트에도 걸려 있는지 본다.
    // 변수명을 하드코딩하지 않으므로, 집계 방식을 바꿔도 두 곳을 함께 고치면
    // 통과하고, 한 곳만 고치면 red 가 된다.
    const fn = installPs1Content.match(/^function Show-Summary \{[\s\S]*?^\}/m);
    const gate = fn[0].match(/if \(([^)]+)\) \{[^}]*?\r?\n[^\r\n]*PARTIAL INSTALL/);
    expect(gate, 'Show-Summary 의 부분설치 조건식을 찾지 못했다').not.toBeNull();

    const condition = gate[1].trim();
    // 같은 조건식이 최상위(컬럼 0) exit 게이트에도 있어야 한다.
    const escaped = condition.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(installPs1Content).toMatch(
      new RegExp(`^if \\(${escaped}\\) \\{[^}]*exit [1-9]`, 'm'),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. 실행형 — 계약은 소스 모양이 아니라 실제 출력이다
//
// install-atomic-replace.test.js 의 잠긴-목적지 프로브와 같은 방식으로 **진짜
// 부분 실패**를 만든다. 집계 변수를 하네스가 직접 세팅하지 않는 것이 요점이다 —
// 그러면 특정 메커니즘을 전제하게 된다. 실패를 실제로 일으키고 화면만 본다.
// 인스톨러는 실행하지 않는다. 전부 temp 픽스처.
// ---------------------------------------------------------------------------

describe.skipIf(!canRunPwsh)('install-ps1-partial-failure/behavioral', () => {
  let workDir;

  beforeEach(() => { workDir = mkdtempSync(path.join(os.tmpdir(), 'artibot-ps1partial-')); });
  afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

  /**
   * 실제 install.ps1 에서 함수를 그대로 끌어와(복사본이 아니다) 돌린다.
   *
   * `lock=true` 면 목적지 파일 하나를 FileShare.None 으로 쥐어 Copy-DirAtomic 을
   * 진짜 부분 실패로 몰아넣는다. 그 다음 Show-Summary 를 같은 세션에서 호출해
   * 사용자가 보는 출력을 그대로 캡처한다.
   *
   * 경로는 본문에 박지 않고 환경변수로 넘긴다 — PS 5.1 은 BOM 없는 .ps1 을
   * ANSI(이 머신 chcp 949)로 읽어 한글 경로가 깨진다. install-atomic-replace
   * .test.js 의 인코딩 주석에 실측표가 있다. BOM 도 함께 붙여 이중으로 막는다.
   *
   * Write-Warn2/Err2/Log 스텁은 Write-Host 로 쓴다. Write-Output 이면 성공
   * 스트림에 섞여 `$ret = Copy-DirAtomic ...` 이 bool 이 아니라 배열이 된다.
   */
  function runProbe(lock) {
    const script = `
$ErrorActionPreference = 'Stop'
$text = [System.IO.File]::ReadAllText($env:ARTIBOT_INSTALL_PS1)
function Grab([string]$name) {
  $m = [regex]::Match($text, "(?ms)^function $name \\{.*?^\\}")
  if (-not $m.Success) { throw "cannot extract $name" }
  return $m.Value
}
Invoke-Expression (@(
  'function Write-Warn2 { param($msg) Write-Host "[warn] $msg" }',
  'function Write-Err2  { param($msg) Write-Host "[err] $msg" }',
  'function Write-Log   { param($msg) Write-Host $msg }',
  '$DryRun = $false',
  (Grab 'Copy-TreeContents'),
  (Grab 'Copy-DirAtomic'),
  (Grab 'Show-Summary')
) -join "\`n")

$root = $env:ARTIBOT_PROBE_ROOT
$dst = Join-Path $root 'dst'
$src = Join-Path $root 'src'
New-Item -ItemType Directory -Path (Join-Path $dst 'core') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $src 'core') -Force | Out-Null
Set-Content (Join-Path $dst 'index.js')       'v=old' -Encoding utf8
Set-Content (Join-Path $dst 'core\\config.js') 'c=old' -Encoding utf8
Set-Content (Join-Path $src 'index.js')       'v=new' -Encoding utf8
Set-Content (Join-Path $src 'core\\config.js') 'c=new' -Encoding utf8

# Show-Summary 가 세는 트리. 개수 자체는 계약이 아니라 배너 여부가 계약이다.
$ClaudeDir  = Join-Path $root 'claude'
$ArtibotDir = Join-Path $root 'artibot'
New-Item -ItemType Directory -Path $ClaudeDir  -Force | Out-Null
New-Item -ItemType Directory -Path $ArtibotDir -Force | Out-Null

${lock ? `$fs = [System.IO.File]::Open((Join-Path $dst 'index.js'), [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)` : ''}
$ret = Copy-DirAtomic -SrcDir $src -DstDir $dst
${lock ? '$fs.Close()' : ''}

Write-Host ("RETURN=" + $ret)
Write-Host ("RETURNTYPE=" + $(if ($null -eq $ret) { 'null' } else { $ret.GetType().Name }))
Show-Summary
Write-Host "PROBE-END"
`;
    const psPath = path.join(workDir, 'probe.ps1');
    // BOM 은 이스케이프로 — 리터럴 문자는 eslint no-irregular-whitespace 가 잡는다.
    writeFileSync(psPath, `\ufeff${script}`, 'utf8');

    const res = spawnSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath],
      {
        encoding: 'utf8',
        timeout: 90_000,
        env: {
          ...process.env,
          ARTIBOT_INSTALL_PS1: INSTALL_PS1,
          ARTIBOT_PROBE_ROOT: workDir,
        },
      },
    );

    // 프로브가 끝까지 갔는지 먼저 확인한다. 하네스가 죽은 것과 계약이 깨진
    // 것은 다른 사건이고, 다른 메시지를 줘야 한다.
    expect(
      res.stdout,
      `프로브가 완주하지 못했다 (status=${res.status}). stderr: ${(res.stderr || '(없음)').slice(0, 500)}`,
    ).toContain('PROBE-END');

    return res.stdout;
  }

  it('부분 실패하면 완료 배너를 찍지 않고 부분 설치라고 알린다', () => {
    // 주 계약. 구 850b5682 는 여기서 배너를 찍었다 — 진짜로 실패한 설치가
    // "Installation complete!" 로 끝났다는 뜻이다.
    const out = runProbe(true);
    expect(out).not.toContain('Installation complete!');
    expect(out).toContain('PARTIAL INSTALL');
  }, 120_000);

  it('부분 실패를 $false 로 반환한다 (install.ps1:498-501 의 명시 계약)', () => {
    // 부 계약. 집계 변수와 중복이지만 install.ps1 이 주석으로 공개 계약이라고
    // 못박았으므로 함께 고정한다. 구 코드는 아무것도 반환하지 않았다($null).
    const out = runProbe(true);
    expect(out).toContain('RETURNTYPE=Boolean');
    expect(out).toContain('RETURN=False');
  }, 120_000);

  it('정상 교체면 완료 배너를 찍고 $true 를 반환한다', () => {
    // 반대 방향. 게이트가 "항상 부분실패"로 뒤집히면 여기서 잡힌다 — 실패를
    // 보고하는 게이트는 성공도 보고할 수 있어야 쓸모가 있다.
    const out = runProbe(false);
    expect(out).toContain('Installation complete!');
    expect(out).not.toContain('PARTIAL INSTALL');
    expect(out).toContain('RETURN=True');
  }, 120_000);
});
