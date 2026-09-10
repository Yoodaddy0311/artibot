import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// install.ps1 — 네이티브 마켓플레이스 설치 감지 + settings.json 비침습 (PowerShell 쪽)
//
// sh 쪽 형제 파일과 **동일한 계약**을 PowerShell 에 고정한다. 두 파일을 나란히
// 읽을 수 있게 구조·이름·단언 순서를 맞춰 두었다.
//
// 고정하는 계약 두 가지:
//
//   (1) FLAT-COPY 중복. Install-Assets 는 agents/commands 를 언제나
//       ~/.claude/{agents,commands} 로 평면 복사했다. 네이티브 플러그인이 이미
//       설치돼 있으면 같은 에이전트·커맨드가 세션 시스템 프롬프트에 **두 번**
//       실린다. 네이티브가 감지되면(= 마켓플레이스 캐시에 버전 디렉터리가 하나
//       이상) 평면 복사를 건너뛴다. `-Flat` 은 강제 복사 탈출구다.
//       감지 마커는 `lib/core/install-mode.js#detectInstallMode` 의 cacheMarker
//       (`~/.claude/plugins/cache`) 와 같은 것을 쓴다.
//
//   (2) settings.json. Set-Settings 는 기존 파일에 CLAUDE_CODE_EXPERIMENTAL_
//       AGENT_TEAMS 를 **써넣었다**. install.sh#configure_settings 는 기존
//       파일이면 경고만 하고 새로 만들 때만 심는다. ps1 을 bash 에 맞춘다.
//       `-EnableAgentTeams` 는 옛 병합 동작을 되살리는 옵트인이다.
//
// 이 파일이 보지 못하는 것 (그린을 실제보다 크게 읽지 않도록 명시):
//   - **인스톨러 전체 실행.** Test-Prerequisites / Request-InstallLock 이 진짜
//     ~/.claude 를 건드리므로 -DryRun 조차 돌리지 않는다. 함수만 추출해 temp
//     픽스처 위에서 돌린다. 그래서 main 스위치의 호출 순서는 미검증이다.
//   - **프로세스 종료코드.** install-ps1-partial-failure.test.js 와 같은 이유.
//   - **중복 제거.** 남은 평면 복사본을 경고만 하고 지우지 않는다는 것은
//     아래에서 파일이 그대로 남아 있는지로 확인하지만, uninstall 경로 자체는
//     이 파일이 아니라 Uninstall-Artibot 쪽 계약이다.
//   - **실제 세션 시스템 프롬프트의 중복 여부.** 그건 호스트 동작이고 여기서
//     검증할 수 있는 것은 "평면 복사가 일어나지 않았다" 까지다.
//   - **install.sh 와의 문자열 파리티.** 형제 파일이 sh 쪽을 본다. 여기서는
//     ps1 의 관측 동작만 본다.
//   - **네이티브 캐시의 내용물.** 감지는 버전 디렉터리 존재만 본다. 그 안이
//     비었거나 낡았는지는 검사하지 않으며, 이 테스트도 그 이상을 주장하지 않는다.
// ---------------------------------------------------------------------------

const PLUGIN_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const INSTALL_PS1 = path.join(PLUGIN_ROOT, 'install.ps1');
const installPs1Content = readFileSync(INSTALL_PS1, 'utf-8');

const canRunPwsh = process.platform === 'win32'
  && spawnSync('powershell', ['-NoProfile', '-Command', 'exit 0'], { timeout: 20_000 }).status === 0;

/**
 * 함수 본문을 뽑는다. 형제 파일들이 쓰는 `^function X \{[\s\S]*?^\}` 비탐욕
 * 정규식은 **Set-Settings 에서 틀린 답을 준다** — 그 함수의 here-string 안에
 * 있는 node 스니펫과 JSON 이 컬럼 0 에 `}` 를 갖고 있어서 함수가 중간에서
 * 잘린다(실측 2026-09-10: 잘린 조각은 `'@` 종결자가 없어 PowerShell 파서가
 * 거부한다). 그래서 "다음 컬럼 0 function 선언 전까지" 자른 뒤 그 안의
 * **마지막** 컬럼 0 `}` 를 끝으로 삼는다. PowerShell 하네스의 Grab 도 같은
 * 규칙을 쓴다 — 두 곳이 같은 조각을 봐야 정적 단언과 실행형 단언이 정합적이다.
 *
 * @param {string} name 함수 이름
 * @returns {string|null} 함수 본문, 못 찾으면 null
 */
function grabFunction(name) {
  const start = installPs1Content.search(new RegExp(`^function ${name} \\{`, 'm'));
  if (start < 0) return null;
  let rest = installPs1Content.slice(start);
  const next = rest.slice(1).search(/^function \S+ \{/m);
  if (next >= 0) rest = rest.slice(0, next + 1);
  const ends = [...rest.matchAll(/^\}/gm)];
  if (ends.length === 0) return null;
  return rest.slice(0, ends[ends.length - 1].index + 1);
}

/**
 * 함수 바로 위에 붙은 컬럼 0 주석 블록. install.ps1 은 근거·인용을 본문이
 * 아니라 이 블록에 적는 것이 관례라, 주석 계약은 여기서 봐야 한다.
 *
 * @param {string} name 함수 이름
 * @returns {string} 연속된 `#` 주석 줄들, 없으면 빈 문자열
 */
function leadingComment(name) {
  const start = installPs1Content.search(new RegExp(`^function ${name} \\{`, 'm'));
  if (start < 0) return '';
  const before = installPs1Content.slice(0, start).split(/\r?\n/);
  const out = [];
  for (let i = before.length - 2; i >= 0 && before[i].startsWith('#'); i--) out.unshift(before[i]);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// 1. 정적 계약 — PowerShell 없이도 항상 실행
// ---------------------------------------------------------------------------

describe('install-ps1-native-detect/static contract', () => {
  it('param() 이 -Flat 과 -EnableAgentTeams 스위치를 선언한다', () => {
    const paramBlock = installPs1Content.match(/^param\(([\s\S]*?)^\)/m);
    expect(paramBlock, 'param(...) 블록 추출 실패 — 아래 단언이 공허해진다').not.toBeNull();
    expect(paramBlock[1]).toMatch(/\[switch\]\$Flat\b/);
    expect(paramBlock[1]).toMatch(/\[switch\]\$EnableAgentTeams\b/);
  });

  it('주석 기반 도움말이 -Flat 과 -EnableAgentTeams 를 설명한다', () => {
    const help = installPs1Content.match(/^<#[\s\S]*?^#>/m);
    expect(help, '주석 기반 도움말 블록 추출 실패').not.toBeNull();
    expect(help[0]).toMatch(/\.PARAMETER Flat\b/);
    expect(help[0]).toMatch(/\.PARAMETER EnableAgentTeams\b/);
    expect(help[0]).toMatch(/-Flat/);
  });

  it('Test-NativePluginInstall 이 컬럼 0 함수로 존재하고 캐시 마커를 쓴다', () => {
    const fn = grabFunction('Test-NativePluginInstall');
    expect(fn, 'Test-NativePluginInstall 추출 실패').not.toBeNull();
    // 경로 리터럴은 최상위 $PluginCacheRoot 한 곳에만 있다 — 이 함수는 그것을
    // 읽는다. 상수 값 자체와 install.sh 와의 일치는 tests/ci/validate-install
    // .test.js 의 native-skip 파리티 블록이 본다(중복 단언하지 않는다).
    expect(fn).toMatch(/\$PluginCacheRoot/);
    expect(fn, '경로 리터럴이 두 번째로 등장하면 두 소비처가 갈라진다')
      .not.toMatch(/plugins\\cache/);
    // 순수 검사 — 쓰기 계열 cmdlet 이 있으면 안 된다.
    expect(fn).not.toMatch(/New-Item|Copy-Item|Remove-Item|Set-Content/);
    // 감지 마커의 출처를 주석에 인용해 둔다. 같은 마커를 쓰는 두 곳이 말없이
    // 갈라지면 한쪽만 고치게 된다.
    expect(leadingComment('Test-NativePluginInstall')).toMatch(/install-mode\.js/);
    expect(leadingComment('Test-NativePluginInstall')).toMatch(/detectInstallMode/);
  });

  it('Install-Assets 가 Test-NativePluginInstall 과 $Flat 을 참조한다', () => {
    const fn = grabFunction('Install-Assets');
    expect(fn, 'Install-Assets 추출 실패').not.toBeNull();
    expect(fn).toMatch(/Test-NativePluginInstall/);
    expect(fn).toMatch(/\$Flat\b/);
    // agents/commands 호출부는 여전히 한 줄로 남아 있어야 한다
    // (install-rules-nondestructive.test.js 가 -Preserve 없음을 한 줄 정규식으로 본다).
    expect(fn).toMatch(/Copy-MdFiles[^\n]*-Label 'Agents'/);
    expect(fn).toMatch(/Copy-MdFiles[^\n]*-Label 'Commands'/);
  });

  it('Show-Summary 가 평면 복사 스킵을 표시한다', () => {
    const fn = grabFunction('Show-Summary');
    expect(fn, 'Show-Summary 추출 실패').not.toBeNull();
    expect(fn).toMatch(/FlatCopySkipped/);
    expect(fn).toMatch(/flat copy skipped/);
  });

  it('Set-Settings 의 기존파일 분기가 env 키를 무조건 쓰지 않는다', () => {
    const fn = grabFunction('Set-Settings');
    expect(fn, 'Set-Settings 추출 실패').not.toBeNull();
    // 옛 코드: `if (!cfg.env.CLAUDE_..._AGENT_TEAMS) cfg.env.CLAUDE_..._AGENT_TEAMS = '1';`
    // 이제는 옵트인 플래그(ARTIBOT_ENABLE_AGENT_TEAMS) 뒤에 있어야 한다.
    expect(fn).toMatch(/ARTIBOT_ENABLE_AGENT_TEAMS/);
    expect(fn).toMatch(/Agent Teams already enabled in settings\.json/);
    expect(fn).toMatch(/Add this to ~\/\.claude\/settings\.json manually:/);
  });

  it('.DESCRIPTION 이 "기존 파일에도 Agent Teams 를 켠다" 고 말하지 않는다', () => {
    const help = installPs1Content.match(/^<#[\s\S]*?^#>/m);
    expect(help[0]).not.toMatch(/Also enables Agent Teams/);
  });
});

// ---------------------------------------------------------------------------
// 2. 실행형 — 계약은 소스 모양이 아니라 실제 파일시스템 결과다
//
// install-ps1-partial-failure.test.js 와 같은 방식: 실제 install.ps1 에서
// 함수를 그대로 끌어와(복사본이 아니다) temp 픽스처 위에서 돌린다. 인스톨러는
// 실행하지 않는다. 실제 ~/.claude 는 절대 건드리지 않는다.
//
// 경로는 본문에 박지 않고 환경변수로 넘긴다 — PS 5.1 은 BOM 없는 .ps1 을
// ANSI(이 머신 chcp 949)로 읽어 한글 경로가 깨진다. BOM 도 함께 붙여 이중으로 막는다.
// ---------------------------------------------------------------------------

const STUBS = [
  'function Write-Warn2 { param($msg) Write-Host "[warn] $msg" }',
  'function Write-Err2  { param($msg) Write-Host "[err] $msg" }',
  'function Write-Log   { param($msg) Write-Host "[log] $msg" }',
  'function Write-Tip   { param($msg) Write-Host "[tip] $msg" }',
];

const stubLines = STUBS.map((s) => `  '${s.replace(/'/g, "''")}',`).join('\n');

const GRAB = `
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$text = [System.IO.File]::ReadAllText($env:ARTIBOT_INSTALL_PS1)
# grabFunction() (이 파일 상단) 과 같은 규칙: 다음 컬럼 0 function 선언 전까지
# 자른 뒤 그 안의 마지막 컬럼 0 '}' 를 끝으로 본다. 비탐욕 매칭은 Set-Settings
# 의 here-string 안 컬럼 0 '}' 에 걸려 함수를 반토막 낸다.
function Grab([string]$name) {
  $start = [regex]::Match($text, "(?m)^function $name \\{")
  if (-not $start.Success) { throw "cannot extract $name" }
  $rest = $text.Substring($start.Index)
  $next = [regex]::Match($rest.Substring(1), "(?m)^function \\S+ \\{")
  if ($next.Success) { $rest = $rest.Substring(0, $next.Index + 1) }
  $ends = [regex]::Matches($rest, "(?m)^\\}")
  if ($ends.Count -eq 0) { throw "cannot find end of $name" }
  return $rest.Substring(0, $ends[$ends.Count - 1].Index + 1)
}
# 최상위 선언문을 원문 그대로 끌어온다. 상수를 하네스가 다시 적으면 install.ps1
# 이 틀린 경로를 봐도 프로브는 통과한다 — 그건 검증이 아니라 재현이다.
function GrabDecl([string]$pattern) {
  $m = [regex]::Match($text, $pattern)
  if (-not $m.Success) { throw "cannot extract declaration: $pattern" }
  return $m.Value
}
`;

describe.skipIf(!canRunPwsh)('install-ps1-native-detect/behavioral', () => {
  let workDir;

  beforeEach(() => { workDir = mkdtempSync(path.join(os.tmpdir(), 'artibot-ps1native-')); });
  afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

  function runPs(script) {
    const psPath = path.join(workDir, `probe-${Math.random().toString(36).slice(2)}.ps1`);
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
    expect(
      res.stdout,
      `프로브가 완주하지 못했다 (status=${res.status}). stderr: ${(res.stderr || '(없음)').slice(0, 800)}`,
    ).toContain('PROBE-END');
    return res.stdout;
  }

  // ---- Install-Assets 픽스처 -----------------------------------------------
  function seedAssets({ cache, preExisting }) {
    const src = path.join(workDir, 'src');
    const claude = path.join(workDir, 'claude');
    mkdirSync(path.join(src, 'agents'), { recursive: true });
    mkdirSync(path.join(src, 'commands'), { recursive: true });
    mkdirSync(path.join(claude, 'agents'), { recursive: true });
    mkdirSync(path.join(claude, 'commands'), { recursive: true });
    mkdirSync(path.join(claude, 'rules', 'artibot'), { recursive: true });
    mkdirSync(path.join(claude, 'artibot'), { recursive: true });
    writeFileSync(path.join(src, 'agents', 'alpha.md'), 'alpha\n');
    writeFileSync(path.join(src, 'agents', 'beta.md'), 'beta\n');
    writeFileSync(path.join(src, 'commands', 'gamma.md'), 'gamma\n');
    writeFileSync(path.join(src, 'artibot.config.json'), '{}\n');
    writeFileSync(path.join(src, 'package.json'), '{}\n');
    writeFileSync(path.join(src, 'install.sh'), '#!/usr/bin/env bash\n');
    if (cache) {
      // 버전 디렉터리가 하나 이상 = 네이티브 설치.
      mkdirSync(path.join(claude, 'plugins', 'cache', 'artibot', 'artibot', '9.9.9'), { recursive: true });
    }
    if (preExisting) {
      writeFileSync(path.join(claude, 'agents', 'alpha.md'), 'old alpha\n');
      writeFileSync(path.join(claude, 'commands', 'gamma.md'), 'old gamma\n');
    }
  }

  function runInstallAssets({ cache = false, flat = false, preExisting = false } = {}) {
    seedAssets({ cache, preExisting });
    const script = `${GRAB}
Invoke-Expression (@(
${stubLines}
  (Grab 'Test-FileContentEqual'),
  (Grab 'Copy-MdFiles'),
  (Grab 'Copy-TreeContents'),
  (Grab 'Copy-DirAtomic'),
  (Grab 'Copy-Tree'),
  (Grab 'Test-NativePluginInstall'),
  (Grab 'Install-Assets'),
  (Grab 'Show-Summary')
) -join "\`n")

$DryRun = $false
$Flat = $${flat}
$script:FlatCopySkipped = $false
$script:InstallFailures = 0
$root = $env:ARTIBOT_PROBE_ROOT
$ScriptDir  = Join-Path $root 'src'
$ClaudeDir  = Join-Path $root 'claude'
$ArtibotDir = Join-Path $ClaudeDir 'artibot'
# install.ps1 의 선언문 그대로 (하네스가 경로를 다시 적지 않는다).
Invoke-Expression (GrabDecl '(?m)^\\$PluginCacheRoot = .*$')

Install-Assets
$a = @(Get-ChildItem -LiteralPath (Join-Path $ClaudeDir 'agents')   -Filter '*.md' -File -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
$c = @(Get-ChildItem -LiteralPath (Join-Path $ClaudeDir 'commands') -Filter '*.md' -File -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
Write-Host ("AGENTS=" + ($a -join ','))
Write-Host ("COMMANDS=" + ($c -join ','))
Show-Summary
Write-Host "PROBE-END"
`;
    return runPs(script);
  }

  it('(a) 네이티브 캐시가 있으면 agents/commands 를 평면 복사하지 않는다', () => {
    const out = runInstallAssets({ cache: true });
    expect(out).toMatch(/^AGENTS=\s*$/m);
    expect(out).toMatch(/^COMMANDS=\s*$/m);
    expect(out).toContain('native plugin detected at');
    expect(out).toContain('use -Flat to force');
  }, 120_000);

  it('(a) 스킵 로그는 정확히 한 번만 찍는다', () => {
    const out = runInstallAssets({ cache: true });
    const hits = out.match(/skipping flat copy of agents\/commands/g) || [];
    expect(hits.length).toBe(1);
  }, 120_000);

  it('(a) 이미 평면 복사된 파일이 남아 있으면 개수와 함께 경고한다 (삭제는 하지 않는다)', () => {
    const out = runInstallAssets({ cache: true, preExisting: true });
    // alpha.md + gamma.md = 2
    expect(out).toMatch(/\[warn\] 2 previously flat-copied/);
    // 삭제하지 않는다 — 그대로 남아 있어야 한다.
    expect(out).toMatch(/^AGENTS=alpha\.md\s*$/m);
    expect(out).toMatch(/^COMMANDS=gamma\.md\s*$/m);
  }, 120_000);

  it('(a) Show-Summary 가 스킵을 Agents/Commands 줄에 덧붙인다', () => {
    const out = runInstallAssets({ cache: true });
    const lines = out.split(/\r?\n/);
    const agentsLine = lines.find((l) => l.trim().startsWith('Agents:'));
    const cmdLine = lines.find((l) => l.trim().startsWith('Commands:'));
    expect(agentsLine, 'Show-Summary 의 Agents 줄을 찾지 못했다').toBeTruthy();
    expect(agentsLine).toContain('(flat copy skipped - native plugin)');
    expect(cmdLine).toContain('(flat copy skipped - native plugin)');
  }, 120_000);

  it('(b) 캐시가 없으면 종전대로 평면 복사한다', () => {
    const out = runInstallAssets({ cache: false });
    expect(out).toMatch(/^AGENTS=.*alpha\.md/m);
    expect(out).toMatch(/^AGENTS=.*beta\.md/m);
    expect(out).toMatch(/^COMMANDS=.*gamma\.md/m);
    expect(out).not.toContain('native plugin detected at');
  }, 120_000);

  it('(c) 캐시가 있어도 -Flat 이면 복사한다', () => {
    const out = runInstallAssets({ cache: true, flat: true });
    expect(out).toMatch(/^AGENTS=.*alpha\.md/m);
    expect(out).toMatch(/^AGENTS=.*beta\.md/m);
    expect(out).toMatch(/^COMMANDS=.*gamma\.md/m);
    expect(out).not.toContain('skipping flat copy');
  }, 120_000);

  // ---- Set-Settings --------------------------------------------------------
  const AGENT_TEAMS_KEY = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS';

  function runSetSettings({ existing = null, enableAgentTeams = false } = {}) {
    const claude = path.join(workDir, 'claude');
    mkdirSync(path.join(claude, 'artibot'), { recursive: true });
    if (existing !== null) {
      writeFileSync(path.join(claude, 'settings.json'), JSON.stringify(existing, null, 2));
    }
    const script = `${GRAB}
Invoke-Expression (@(
${stubLines}
  (Grab 'Set-Settings')
) -join "\`n")

$DryRun = $false
$EnableAgentTeams = $${enableAgentTeams}
$SafeAllow = @('Read', 'Glob', 'Grep')
$ClaudeDir = Join-Path $env:ARTIBOT_PROBE_ROOT 'claude'

Set-Settings
Write-Host "SETTINGS-BEGIN"
Write-Host (Get-Content -LiteralPath (Join-Path $ClaudeDir 'settings.json') -Raw)
Write-Host "SETTINGS-END"
Write-Host "PROBE-END"
`;
    const out = runPs(script);
    const body = out.split('SETTINGS-BEGIN')[1].split('SETTINGS-END')[0];
    return { out, settings: JSON.parse(body) };
  }

  it('(d) 기존 settings.json 에 env 키가 없으면 쓰지 않고 안내만 한다', () => {
    const { out, settings } = runSetSettings({
      existing: { env: { FOO: 'bar' }, permissions: { allow: ['Bash'] } },
    });
    expect(settings.env).toEqual({ FOO: 'bar' });
    // 권한 allowlist 와 statusLine 은 그대로 병합된다.
    expect(settings.permissions.allow).toEqual(['Bash', 'Read', 'Glob', 'Grep']);
    expect(settings.statusLine.type).toBe('command');
    expect(out).toContain('Add this to ~/.claude/settings.json manually:');
    expect(out).toContain(AGENT_TEAMS_KEY);
  }, 120_000);

  it('(d) 기존 settings.json 에 env 키가 이미 있으면 already-enabled 로 로그한다', () => {
    const { out, settings } = runSetSettings({
      existing: { env: { [AGENT_TEAMS_KEY]: '1' } },
    });
    expect(settings.env[AGENT_TEAMS_KEY]).toBe('1');
    expect(out).toContain('Agent Teams already enabled in settings.json');
    expect(out).not.toContain('Add this to ~/.claude/settings.json manually:');
  }, 120_000);

  it('(d) -EnableAgentTeams 면 기존 파일에도 env 키를 쓴다', () => {
    const { settings } = runSetSettings({
      existing: { env: { FOO: 'bar' } },
      enableAgentTeams: true,
    });
    expect(settings.env[AGENT_TEAMS_KEY]).toBe('1');
    expect(settings.env.FOO).toBe('bar');
  }, 120_000);

  it('(d) settings.json 이 없으면 종전대로 env 키를 심어 생성한다', () => {
    const { settings } = runSetSettings({ existing: null });
    expect(settings.env[AGENT_TEAMS_KEY]).toBe('1');
    expect(settings.permissions.allow).toEqual(['Read', 'Glob', 'Grep']);
    expect(settings.statusLine.padding).toBe(2);
  }, 120_000);
});
