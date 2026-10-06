import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { announceBashSkip, probeBash, toBashPath } from '../../scripts/utils/bash-compat.js';
import { PARITY_MATRIX } from '../../scripts/ci/validate-install.js';

// ---------------------------------------------------------------------------
// install.sh / install.ps1 — 죽은 nightly 자동학습 등록의 해제 경로 (레인 1D)
//
// 배경(감사 §6 #8): 러너 scripts/run-auto-learning.js 는 2026-07-09 커밋
// 211712e3 에서 삭제됐지만, 그 전에 등록된 스케줄 항목(schtasks
// ArtibotAutoLearning 매일 03:00 / crontab)은 계속 돌며 매번 MODULE_NOT_FOUND 로
// 죽는다. 인스톨러는 신규 등록만 막았고 기존 등록은 건드린 적이 없다 —
// setup_auto_learning 이 marker 가 있으면 조기 반환하기 때문이다.
//
// 계약:
//   1. 설치본 러너(ARTIBOT_DIR/scripts/run-auto-learning.js)가 없고 marker 가
//      있을 때만 해제한다. marker 의 method 가 schtasks | crontab 이면 그 스케줄러
//      항목을 지우고 marker 를 정리한다. hint-only | claude-schedule | none 은
//      marker 만 지운다. 읽을 수 없는 marker 는 건드리지 않는다(허용목록).
//   2. 해제는 marker 조기 반환 및 enabled 검사보다 먼저 일어난다(autoLearning
//      config 섹션은 이미 삭제돼 enabled 는 항상 false 다).
//   3. 러너가 없으면 해제 후 곧장 반환한다 — 어떤 등록 명령도 실행하지 않는다
//      (marker 가 지워진 뒤 claude schedule 전략이 죽은 파이프라인을 새로 등록하는
//      경로를 열지 않기 위해).
//   4. 러너가 있으면 기존 동작이 그대로다.
//   5. 해제 실패는 설치를 중단시키지 않고, marker 를 남겨 다음 설치에서 재시도한다.
//
// 안전: 실제 스케줄러·claude CLI·~/.claude 를 절대 건드리지 않는다.
//   - HOME/USERPROFILE 은 temp 로 덮고 ARTIBOT_DIR 이 그 안인지 사전 점검한다.
//   - sh: PATH 맨 앞에 schtasks.exe/schtasks/crontab/claude 스텁을 두고, 실행 전에
//     `command -v` 가 전부 스텁 디렉터리로 해석되는지 확인한다. 아니면 exit 97 로
//     하나도 실행하지 않는다(fail-closed). 스텁은 node 로 argv 를 기록하므로 Git
//     Bash 의 MSYS 인자 변환("/Delete" -> "C:/Program Files/Git/Delete")도 실제 네이티브
//     exe 와 똑같이 관측된다.
//   - ps1: schtasks.exe 를 PowerShell 함수로 가리고, 실행 전에 Get-Command 가 Function
//     으로 해석되는지 확인한다. 아니면 exit 97.
//
// 이 파일이 보지 못하는 것 (그린을 실제보다 크게 읽지 않도록):
//   - 진짜 schtasks.exe / crontab 의 동작. 스텁은 우리가 상상한 종료코드를 낸다.
//     실제 해제는 오너가 이 PC 에서 한 줄로 한다.
//   - MSYS 인자 변환 가드의 음성 대조는 Windows + Git Bash 에서만 RED 가 된다.
//     Linux/macOS 는 애초에 변환이 없어 가드를 지워도 그린이다.
//   - 등록 경로(_try_schtasks)의 인자 정확성. 같은 변환 문제가 있을 것으로 추정되나
//     이 레인 범위 밖이라 등록 케이스는 호출 횟수만 센다.
//   - claude schedule 로 등록된 항목의 제거. 검증된 삭제 명령이 없어 marker 만 지운다.
//   - ps1 행위 검증은 Windows 에서만 돈다(Linux CI 에서는 skip).
//   - 설치 전체(install) 흐름과의 결합. 함수 단위로 source/추출해 돌린다.
// ---------------------------------------------------------------------------

const PLUGIN_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const INSTALL_SH = path.join(PLUGIN_ROOT, 'install.sh');
const INSTALL_PS1 = path.join(PLUGIN_ROOT, 'install.ps1');
const lf = (s) => s.replace(/\r\n/g, '\n');
const installSh = lf(readFileSync(INSTALL_SH, 'utf-8'));
const installPs1 = lf(readFileSync(INSTALL_PS1, 'utf-8'));

/** 컬럼 0 에서 시작해 컬럼 0 의 `}` 로 닫히는 셸 함수 본문 */
function extractShellFn(content, name) {
  const match = content.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
  return match ? match[0] : null;
}

/** install.ps1 함수 본문: 다음 컬럼 0 function 선언 전까지 자른 뒤 마지막 컬럼 0 `}` 까지 */
function grabPsFunction(name) {
  const start = installPs1.search(new RegExp(`^function ${name} \\{`, 'm'));
  if (start < 0) return null;
  let rest = installPs1.slice(start);
  const next = rest.slice(1).search(/^function \S+ \{/m);
  if (next >= 0) rest = rest.slice(0, next + 1);
  const ends = [...rest.matchAll(/^\}/gm)];
  if (ends.length === 0) return null;
  return rest.slice(0, ends[ends.length - 1].index + 1);
}

const TASK = 'ArtibotAutoLearning';
const DELETE_ARGS = ['/Delete', '/TN', TASK, '/F'];
const LOG_REMOVED = 'Removed dead auto-learning schedule (Task Scheduler: ArtibotAutoLearning) - its runner no longer ships';
const LOG_CLEARED = 'Cleared stale auto-learning marker (method: ';
const LOG_MANUAL = 'Could not remove the dead auto-learning schedule. Run (cmd or PowerShell): schtasks /Delete /TN ArtibotAutoLearning /F';

/** install.sh#_write_auto_learning_marker 와 같은 모양 (JSON.stringify, 들여쓰기 2) */
function markerNode(method) {
  return `${JSON.stringify({ registeredAt: '2026-04-08T00:00:00Z', schedule: '0 3 * * *', method }, null, 2)}\n`;
}

/** install.ps1#Set-AutoLearning 이 쓰는 모양 (Windows PowerShell 5.1 ConvertTo-Json: CRLF + 콜론 뒤 공백 둘) */
function markerPs(method) {
  return `${[
    '{',
    '    "registeredAt":  "2026-04-08T00:00:00Z",',
    '    "schedule":  "0 3 * * *",',
    `    "method":  "${method}"`,
    '}',
  ].join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// 1. 정적 계약 — bash/PowerShell 없이도 항상 실행
// ---------------------------------------------------------------------------

describe('install-auto-learning-unregister/static contract', () => {
  it('sh: 해제 함수들이 컬럼 0 에 존재한다 (공허한 통과 방지)', () => {
    for (const name of [
      '_schtasks_cli',
      '_auto_learning_marker_method',
      '_unregister_schtasks_entry',
      '_unregister_crontab_entry',
      '_unregister_dead_auto_learning',
      'setup_auto_learning',
    ]) {
      expect(extractShellFn(installSh, name), `${name} 추출 실패`).not.toBeNull();
    }
  });

  it('ps1: Remove-DeadAutoLearning 과 Set-AutoLearning 이 존재한다', () => {
    expect(grabPsFunction('Remove-DeadAutoLearning')).not.toBeNull();
    expect(grabPsFunction('Set-AutoLearning')).not.toBeNull();
  });

  it('sh: setup_auto_learning 은 러너 게이트 -> 해제 호출 -> marker 조기 반환 -> enabled 검사 순서다', () => {
    const fn = extractShellFn(installSh, 'setup_auto_learning');
    const gate = fn.indexOf('run-auto-learning.js');
    const call = fn.indexOf('_unregister_dead_auto_learning "$marker"');
    const early = fn.indexOf('if [ -f "$marker" ]');
    const enabled = fn.indexOf('_is_auto_learning_enabled');
    for (const [label, idx] of Object.entries({ gate, call, early, enabled })) {
      expect(idx, `${label} 를 찾지 못했다`).toBeGreaterThan(-1);
    }
    expect(gate).toBeLessThan(call);
    expect(call).toBeLessThan(early);
    expect(early).toBeLessThan(enabled);
    // 해제 호출 직후 곧장 반환한다 — 등록 전략으로 떨어지지 않는다.
    expect(fn.slice(call, early)).toMatch(/return 0/);
  });

  it('ps1: Set-AutoLearning 도 같은 순서다 (러너 게이트 -> 해제 -> marker 조기 반환 -> config 읽기)', () => {
    const fn = grabPsFunction('Set-AutoLearning');
    const gate = fn.indexOf('Test-Path -LiteralPath $runner');
    const call = fn.indexOf('Remove-DeadAutoLearning -Marker $marker');
    const early = fn.indexOf('already registered');
    const cfg = fn.indexOf('$cfgFile');
    for (const [label, idx] of Object.entries({ gate, call, early, cfg })) {
      expect(idx, `${label} 를 찾지 못했다`).toBeGreaterThan(-1);
    }
    expect(gate).toBeLessThan(call);
    expect(call).toBeLessThan(early);
    expect(early).toBeLessThan(cfg);
    expect(fn.slice(call, early)).toMatch(/return/);
    // 러너 경로 선언은 하나다 (게이트와 등록 분기가 같은 변수를 읽는다)
    expect(fn.match(/\$runner = Join-Path/g)).toHaveLength(1);
  });

  it('sh: schtasks 해제 호출은 전부 MSYS 인자 변환 가드(_schtasks_cli)를 거친다', () => {
    const cli = extractShellFn(installSh, '_schtasks_cli');
    expect(cli).toContain("MSYS2_ARG_CONV_EXCL='*'");
    const fn = extractShellFn(installSh, '_unregister_schtasks_entry');
    expect(fn).toMatch(/_schtasks_cli \/Delete /);
    expect(fn).toMatch(/_schtasks_cli \/Query /);
    // 가드 없는 맨 호출이 한 줄도 없다
    expect(fn).not.toMatch(/^\s*(if\s+(!\s*)?)?schtasks(\.exe)?\s+\//m);
  });

  it('sh/ps1 공통 계약 문자열을 둘 다 가진다', () => {
    for (const needle of [TASK, '/Delete', '/Query', LOG_REMOVED, LOG_CLEARED, LOG_MANUAL]) {
      expect(installSh, `install.sh 에 없음: ${needle}`).toContain(needle);
      expect(installPs1, `install.ps1 에 없음: ${needle}`).toContain(needle);
    }
    // marker 정리 (sh: rm -f, ps1: Remove-Item)
    expect(extractShellFn(installSh, '_unregister_dead_auto_learning')).toMatch(/rm -f "\$marker"/);
    expect(grabPsFunction('Remove-DeadAutoLearning')).toMatch(/Remove-Item -LiteralPath \$Marker/);
  });

  it('PARITY_MATRIX 가 해제 쌍을 고정하고 기존 쌍도 유지한다', () => {
    const row = PARITY_MATRIX.find((c) => c.sh === '_unregister_dead_auto_learning');
    expect(row, 'PARITY_MATRIX 에 해제 쌍이 없다').toBeTruthy();
    expect(row.ps1).toBe('Remove-DeadAutoLearning');
    expect(installSh).toMatch(/^_unregister_dead_auto_learning\(\) \{/m);
    expect(installPs1).toMatch(/^function Remove-DeadAutoLearning \{/m);
    expect(PARITY_MATRIX.some((c) => c.sh === 'setup_auto_learning' && c.ps1 === 'Set-AutoLearning')).toBe(true);
  });

  it('ps1 해제 함수는 ASCII 만 쓴다 (BOM 없는 파일을 PS 5.1 이 ANSI 로 읽는다)', () => {
    const body = grabPsFunction('Remove-DeadAutoLearning');
    // eslint-disable-next-line no-control-regex
    expect(body).not.toMatch(/[^\x00-\x7F]/);
  });
});

// ---------------------------------------------------------------------------
// 2. sh 행위 검증 — install.sh 를 source 해 setup_auto_learning 을 실제로 돌린다
// ---------------------------------------------------------------------------

const hasBash = probeBash().ok;
if (!hasBash) announceBashSkip('install-auto-learning-unregister/sh');

// 스텁 본체. 백슬래시·템플릿 치환이 없는 평문 JS 다.
const STUB_MAIN_JS = [
  "const fs = require('node:fs');",
  'const tool = process.argv[2];',
  'const args = process.argv.slice(3);',
  'const stateFile = process.env.STUB_STATE;',
  'const logFile = process.env.STUB_LOG;',
  "const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));",
  'const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));',
  'const log = (extra) => fs.appendFileSync(logFile, JSON.stringify(Object.assign({ tool, args }, extra || {})) + String.fromCharCode(10));',
  "const op = String(args[0] || '').toLowerCase();",
  "if (tool === 'schtasks.exe' || tool === 'schtasks') {",
  '  log();',
  "  if (op === '/query') process.exit(state.schtasks.registered ? 0 : 1);",
  "  if (op === '/delete') {",
  '    if (!state.schtasks.registered || state.schtasks.failDelete) process.exit(1);',
  '    state.schtasks.registered = false; save(); process.exit(0);',
  '  }',
  "  if (op === '/create') { state.schtasks.registered = true; save(); process.exit(0); }",
  '  process.exit(2);',
  '}',
  "if (tool === 'crontab') {",
  "  if (op === '-l') { log(); if (state.crontab === null) process.exit(1); process.stdout.write(state.crontab); process.exit(0); }",
  "  if (op === '-') {",
  "    const input = fs.readFileSync(0, 'utf8'); log({ stdin: input });",
  '    if (state.failCrontabInstall) process.exit(1);',
  '    state.crontab = input; save(); process.exit(0);',
  '  }',
  "  if (op === '-r') { log(); state.crontab = null; save(); process.exit(0); }",
  '  log(); process.exit(2);',
  '}',
  'log(); process.exit(1);', // claude 와 그 밖: 사용 불가
].join(String.fromCharCode(10));

const STUB_NAMES = ['schtasks.exe', 'schtasks', 'crontab', 'claude'];

// sh 행위 케이스는 Windows 에서 케이스당 5~25초가 걸린다(스텁 호출마다 bash + node 기동).
// 기본 30초 한도에 걸려 간헐 실패하지 않도록 명시한다.
const SH_TIMEOUT = 180_000;
const itSh = (name, fn) => it(name, fn, SH_TIMEOUT);
itSh.each = (cases) => (name, fn) => it.each(cases)(name, fn, SH_TIMEOUT);

const HARNESS = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  '# install.sh 원본(마지막 main 호출만 무력화)을 source — 함수·log/warn 전부 현행 코드',
  'source "$1"',
  'STUB_DIR="$(cd "$2" && pwd)"',
  'FAKE_HOME="$(cd "$3" && pwd)"',
  'export PATH="$STUB_DIR:$PATH"',
  '# fail-closed 사전 점검: 실제 스케줄러/claude 에 닿을 수 있으면 아무것도 실행하지 않는다',
  `for n in ${STUB_NAMES.join(' ')}; do`,
  '  case "$(command -v "$n" 2>/dev/null || true)" in',
  '    "$STUB_DIR"/*) ;;',
  '    *) echo "PREFLIGHT-FAIL: $n does not resolve into the stub dir"; exit 97 ;;',
  '  esac',
  'done',
  'CLAUDE_DIR="${FAKE_HOME}/.claude"',
  'ARTIBOT_DIR="${CLAUDE_DIR}/artibot"',
  'case "$ARTIBOT_DIR" in',
  '  "$FAKE_HOME"/*) ;;',
  '  *) echo "PREFLIGHT-FAIL: ARTIBOT_DIR outside the fake HOME"; exit 98 ;;',
  'esac',
  'setup_auto_learning',
  'echo HARNESS-END',
  '',
].join('\n');

describe.skipIf(!hasBash)('install-auto-learning-unregister/sh behavioral', () => {
  let workDir;
  let home;
  let artibotDir;
  let stubDir;
  let libPath;
  let harnessPath;
  let stateFile;
  let logFile;
  let markerPath;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(os.tmpdir(), 'artibot-unreg-'));
    home = path.join(workDir, 'home');
    artibotDir = path.join(home, '.claude', 'artibot');
    stubDir = path.join(workDir, 'stubs');
    mkdirSync(path.join(artibotDir, 'scripts'), { recursive: true });
    mkdirSync(stubDir, { recursive: true });
    markerPath = path.join(artibotDir, 'auto-learning-registered.json');
    stateFile = path.join(workDir, 'stub-state.json');
    logFile = path.join(workDir, 'stub-calls.ndjson');

    libPath = path.join(workDir, 'install-lib.sh');
    const lib = installSh.replace(/^main "\$@"\s*$/m, '# main() disabled by test harness');
    expect(lib).not.toBe(installSh); // 치환이 실제로 일어났는지
    writeFileSync(libPath, lib, 'utf8');

    harnessPath = path.join(workDir, 'harness.sh');
    writeFileSync(harnessPath, HARNESS, 'utf8');

    const stubMain = path.join(stubDir, 'stub-main.js');
    writeFileSync(stubMain, STUB_MAIN_JS, 'utf8');
    for (const name of STUB_NAMES) {
      const wrapper = path.join(stubDir, name);
      // 네이티브 node 를 한 번 더 거쳐 MSYS 인자 변환을 실제 exe 와 똑같이 관측한다.
      // 스크립트 경로는 C:/ 형태라 MSYS2_ARG_CONV_EXCL 아래서도 그대로 통한다.
      writeFileSync(wrapper, `#!/usr/bin/env bash\nexec node "${toBashPath(stubMain)}" ${name} "$@"\n`, 'utf8');
      chmodSync(wrapper, 0o755);
    }
  });

  afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

  /** 픽스처를 깔고 하네스를 돌린다 */
  function run({
    runner = false, marker = null, config = null, state = {}, removeStubs = [],
  } = {}) {
    if (runner) writeFileSync(path.join(artibotDir, 'scripts', 'run-auto-learning.js'), '// fixture runner\n');
    if (marker !== null) writeFileSync(markerPath, marker);
    if (config !== null) writeFileSync(path.join(artibotDir, 'artibot.config.json'), JSON.stringify(config));
    writeFileSync(stateFile, JSON.stringify({
      schtasks: { registered: false, failDelete: false },
      crontab: null,
      failCrontabInstall: false,
      ...state,
    }));
    writeFileSync(logFile, '');
    for (const name of removeStubs) rmSync(path.join(stubDir, name), { force: true });

    const res = spawnSync(
      'bash',
      [toBashPath(harnessPath), toBashPath(libPath), toBashPath(stubDir), toBashPath(home)],
      {
        encoding: 'utf8',
        cwd: workDir,
        timeout: 60_000,
        env: {
          ...process.env, HOME: home, USERPROFILE: home, STUB_STATE: stateFile, STUB_LOG: logFile,
        },
      },
    );
    const calls = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => {
      const c = JSON.parse(l);
      return { ...c, tool: c.tool.replace(/[.]exe$/, ''), op: String(c.args[0] || '').toLowerCase() };
    });
    const after = JSON.parse(readFileSync(stateFile, 'utf8'));
    const out = `${res.stdout}${res.stderr}`;
    return {
      res, out, calls, after,
      of: (tool) => calls.filter((c) => c.tool === tool),
      ops: (tool) => calls.filter((c) => c.tool === tool).map((c) => c.op),
    };
  }

  const ENABLED = { autoLearning: { enabled: true, schedule: '0 3 * * *' } };
  const OUR_LINE = '0 3 * * * cd "/home/u/.claude/artibot" && mkdir -p logs && node scripts/run-auto-learning.js >> logs/auto-learning.log 2>&1 # artibot-auto-learning';

  // ---- 사전 점검 자기검증 --------------------------------------------------

  itSh('사전 점검이 비어 있지 않다 — 스텁이 해석되지 않으면 하나도 실행하지 않고 97 로 끝난다', () => {
    const r = run({ marker: markerNode('schtasks'), state: { schtasks: { registered: true, failDelete: false } }, removeStubs: ['schtasks.exe'] });
    expect(r.res.status).toBe(97);
    expect(r.out).toContain('PREFLIGHT-FAIL');
    expect(r.out).not.toContain('HARNESS-END');
    expect(r.calls).toEqual([]);
    expect(existsSync(markerPath)).toBe(true);
  });

  // ---- 해제 (러너 부재 + marker) -------------------------------------------

  itSh('(1) schtasks marker + 등록돼 있음 -> /Delete 정확히 1회, 등록 명령 0회, marker 정리', () => {
    // config 가 enabled 여도 등록 명령은 0 이어야 한다(조기 반환 설계의 증거).
    const r = run({
      marker: markerNode('schtasks'),
      config: ENABLED,
      state: { schtasks: { registered: true, failDelete: false } },
    });
    expect(r.res.status).toBe(0);
    expect(r.out).toContain('HARNESS-END');
    // 네이티브 경계에서 관측한 argv — MSYS 가드가 없으면 /Delete 가 C:/Program Files/Git/Delete 로 온다.
    expect(r.of('schtasks').map((c) => c.args)).toEqual([DELETE_ARGS]);
    expect(r.ops('schtasks')).not.toContain('/create');
    expect(r.of('claude')).toEqual([]);
    expect(r.of('crontab')).toEqual([]);
    expect(r.after.schtasks.registered).toBe(false);
    expect(existsSync(markerPath)).toBe(false);
    expect(r.out).toContain(LOG_REMOVED);
  });

  itSh('(2) Windows PowerShell 이 쓴 marker(CRLF, 콜론 뒤 공백 둘)도 method 를 읽는다', () => {
    const r = run({
      marker: markerPs('schtasks'),
      state: { schtasks: { registered: true, failDelete: false } },
    });
    expect(r.of('schtasks').map((c) => c.args)).toEqual([DELETE_ARGS]);
    expect(existsSync(markerPath)).toBe(false);
  });

  itSh('(3) 이미 사라진 작업 -> /Delete 실패 후 /Query 로 확인, marker 만 정리', () => {
    const r = run({ marker: markerNode('schtasks'), state: { schtasks: { registered: false, failDelete: false } } });
    expect(r.res.status).toBe(0);
    expect(r.ops('schtasks')).toEqual(['/delete', '/query']);
    expect(existsSync(markerPath)).toBe(false);
    expect(r.out).toContain(LOG_REMOVED);
  });

  itSh('(4) 삭제 실패 + 여전히 조회됨 -> 설치는 계속되고 marker 는 남아 다음에 재시도한다', () => {
    const r = run({ marker: markerNode('schtasks'), state: { schtasks: { registered: true, failDelete: true } } });
    expect(r.res.status).toBe(0);
    expect(r.out).toContain('HARNESS-END');
    expect(r.ops('schtasks')).toEqual(['/delete', '/query']);
    expect(existsSync(markerPath)).toBe(true);
    expect(r.out).toContain(LOG_MANUAL);
    expect(r.out).not.toContain(LOG_REMOVED);
  });

  itSh('(5) crontab marker -> 우리 줄만 빠지고 남의 줄·손으로 쓴 줄은 그대로다', () => {
    const unrelated = '30 4 * * * /usr/bin/backup';
    const handWritten = '0 6 * * * echo hand-written # artibot-auto-learning'; // 러너 경로가 없다 -> 우리 줄이 아니다
    const before = `MAILTO=me\n${OUR_LINE}\n${unrelated}\n${handWritten}\n`;
    const r = run({ marker: markerNode('crontab'), state: { crontab: before } });
    expect(r.res.status).toBe(0);
    const installs = r.of('crontab').filter((c) => c.op === '-');
    expect(installs).toHaveLength(1);
    expect(installs[0].stdin).toBe(`MAILTO=me\n${unrelated}\n${handWritten}\n`);
    expect(r.after.crontab).toBe(`MAILTO=me\n${unrelated}\n${handWritten}\n`);
    expect(r.of('schtasks')).toEqual([]);
    expect(existsSync(markerPath)).toBe(false);
    expect(r.out).toContain('Removed dead auto-learning schedule (crontab line');
  });

  itSh('(6) crontab 에 우리 줄뿐이면 빈 파일을 설치하지 않고 crontab -r 로 지운다', () => {
    const r = run({ marker: markerNode('crontab'), state: { crontab: `${OUR_LINE}\n` } });
    expect(r.ops('crontab')).toEqual(['-l', '-r']);
    expect(r.after.crontab).toBeNull();
    expect(existsSync(markerPath)).toBe(false);
  });

  itSh('(7) crontab 에 우리 줄이 이미 없으면 쓰기 없이 marker 만 정리한다', () => {
    const r = run({ marker: markerNode('crontab'), state: { crontab: '30 4 * * * /usr/bin/backup\n' } });
    expect(r.ops('crontab')).toEqual(['-l']);
    expect(r.after.crontab).toBe('30 4 * * * /usr/bin/backup\n');
    expect(existsSync(markerPath)).toBe(false);
  });

  itSh('(8) crontab 설치가 실패하면 설치는 계속되고 marker 가 남는다', () => {
    const r = run({ marker: markerNode('crontab'), state: { crontab: `${OUR_LINE}\n30 4 * * * /usr/bin/backup\n`, failCrontabInstall: true } });
    expect(r.res.status).toBe(0);
    expect(r.out).toContain('HARNESS-END');
    expect(existsSync(markerPath)).toBe(true);
    expect(r.out).toContain("delete the line ending in '# artibot-auto-learning'");
  });

  itSh.each(['hint-only', 'claude-schedule', 'none'])('(9) %s marker -> 스케줄러 호출 0, marker 만 정리', (method) => {
    const r = run({ marker: markerNode(method), config: ENABLED });
    expect(r.res.status).toBe(0);
    expect(r.calls).toEqual([]);
    expect(existsSync(markerPath)).toBe(false);
    expect(r.out).toContain(`${LOG_CLEARED}${method})`);
  });

  itSh('(10) 읽을 수 없는 marker 는 건드리지 않는다 (허용목록)', () => {
    const r = run({ marker: 'this is not json\n', state: { schtasks: { registered: true, failDelete: false } } });
    expect(r.res.status).toBe(0);
    expect(r.calls).toEqual([]);
    expect(readFileSync(markerPath, 'utf8')).toBe('this is not json\n');
  });

  itSh('(10b) 모르는 method 도 건드리지 않는다', () => {
    const marker = markerNode('some-future-scheduler');
    const r = run({ marker, state: { schtasks: { registered: true, failDelete: false } } });
    expect(r.calls).toEqual([]);
    expect(readFileSync(markerPath, 'utf8')).toBe(marker);
  });

  itSh('(11) marker 가 없으면 스케줄러 호출 0, marker 도 새로 만들지 않는다', () => {
    const r = run({ config: ENABLED, state: { schtasks: { registered: true, failDelete: false } } });
    expect(r.res.status).toBe(0);
    expect(r.out).toContain('HARNESS-END');
    expect(r.calls).toEqual([]);
    expect(existsSync(markerPath)).toBe(false);
  });

  // ---- 러너 존재 -> 기존 동작 불변 -----------------------------------------

  itSh('(12) 러너가 있고 marker 도 있으면 호출 0 이고 marker 는 바이트 그대로다', () => {
    const marker = markerNode('schtasks');
    const r = run({ runner: true, marker, state: { schtasks: { registered: true, failDelete: false } } });
    expect(r.res.status).toBe(0);
    expect(r.calls).toEqual([]);
    expect(readFileSync(markerPath, 'utf8')).toBe(marker);
    expect(r.out).toContain('Auto-learning schedule already registered');
  });

  itSh('(13) 러너가 있고 marker 없음 + enabled -> 종전대로 crontab 에 등록한다 (해제 0)', () => {
    const r = run({ runner: true, config: ENABLED });
    expect(r.res.status).toBe(0);
    const installs = r.of('crontab').filter((c) => c.op === '-');
    expect(installs).toHaveLength(1);
    expect(installs[0].stdin).toContain('node scripts/run-auto-learning.js');
    expect(installs[0].stdin).toContain('# artibot-auto-learning');
    expect(r.ops('schtasks')).not.toContain('/delete');
    expect(JSON.parse(readFileSync(markerPath, 'utf8')).method).toBe('crontab');
  });

  itSh('(14) 러너가 있고 crontab 이 실패하면 종전대로 schtasks 등록을 시도한다 (Create 1, Delete 0)', () => {
    // 등록 경로의 인자 정확성은 이 레인 범위 밖이라 op 이름만 본다(헤더 참조).
    const r = run({ runner: true, config: ENABLED, state: { failCrontabInstall: true } });
    expect(r.res.status).toBe(0);
    const creates = r.of('schtasks').filter((c) => /create$/i.test(c.args[0]));
    const deletes = r.of('schtasks').filter((c) => /delete$/i.test(c.args[0]));
    expect(creates).toHaveLength(1);
    expect(deletes).toHaveLength(0);
    // marker 의 method 는 단언하지 않는다. Git Bash 에서는 기존 _try_schtasks 의 /Create 가
    // MSYS 변환을 거쳐 네이티브 경계에서 C:/Program Files/Git/Create 로 도착하고 스텁(실제 exe 와
    // 같다)이 거부해 hint-only 가 기록된다. 그 결과를 굳히면 사전 존재 결함을 고칠 때 이 테스트가
    // 깨진다. 별도 보고 사항이다.
    expect(existsSync(markerPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. ps1 행위 검증 — install.ps1 에서 함수를 그대로 끌어와 temp 픽스처 위에서 돌린다
// ---------------------------------------------------------------------------

const canRunPwsh = process.platform === 'win32'
  && spawnSync('powershell', ['-NoProfile', '-Command', 'exit 0'], { timeout: 20_000 }).status === 0;

const PS_PROBE = (dryRun) => String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$global:LASTEXITCODE = 0
$text = [System.IO.File]::ReadAllText($env:ARTIBOT_INSTALL_PS1)
# 다음 컬럼 0 function 선언 전까지 자른 뒤 그 안의 마지막 컬럼 0 '}' 를 끝으로 본다.
function Grab([string]$name) {
  $start = [regex]::Match($text, "(?m)^function $name [{]")
  if (-not $start.Success) { throw "cannot extract $name" }
  $rest = $text.Substring($start.Index)
  $next = [regex]::Match($rest.Substring(1), "(?m)^function [^ ]+ [{]")
  if ($next.Success) { $rest = $rest.Substring(0, $next.Index + 1) }
  $ends = [regex]::Matches($rest, "(?m)^[}]")
  if ($ends.Count -eq 0) { throw "cannot find end of $name" }
  return $rest.Substring(0, $ends[$ends.Count - 1].Index + 1)
}
function Write-Warn2 { param($msg) Write-Host "[warn] $msg" }
function Write-Err2  { param($msg) Write-Host "[err] $msg" }
function Write-Log   { param($msg) Write-Host "[log] $msg" }
function Write-Tip   { param($msg) Write-Host "[tip] $msg" }

# schtasks.exe 를 함수로 가린다 (함수가 외부 exe 보다 먼저 해석된다). 함수는
# $LASTEXITCODE 를 스스로 세우지 않으므로 여기서 명시한다.
$script:taskRegistered = ($env:STUB_TASK_REGISTERED -eq '1')
function schtasks.exe {
  Add-Content -LiteralPath $env:STUB_LOG_PS -Value ('schtasks ' + ($args -join ' '))
  $op = ''
  if ($args.Count -gt 0) { $op = ([string]$args[0]).ToLower() }
  switch ($op) {
    '/query'  { if ($script:taskRegistered) { $global:LASTEXITCODE = 0 } else { $global:LASTEXITCODE = 1 } }
    '/delete' {
      if ($script:taskRegistered -and $env:STUB_FAIL_DELETE -ne '1') { $script:taskRegistered = $false; $global:LASTEXITCODE = 0 }
      else { $global:LASTEXITCODE = 1 }
    }
    '/create' { $script:taskRegistered = $true; $global:LASTEXITCODE = 0 }
    default   { $global:LASTEXITCODE = 2 }
  }
}
# fail-closed 사전 점검: 함수로 해석되지 않으면 아무것도 실행하지 않는다.
$cmd = Get-Command schtasks.exe -ErrorAction SilentlyContinue
if ((-not $cmd) -or ($cmd.CommandType -ne 'Function')) { Write-Host 'PREFLIGHT-FAIL'; exit 97 }

Invoke-Expression (Grab 'Remove-DeadAutoLearning')
Invoke-Expression (Grab 'Set-AutoLearning')

$DryRun = ${dryRun ? '$true' : '$false'}
$root = $env:ARTIBOT_PROBE_ROOT
$ArtibotDir = Join-Path (Join-Path $root 'claude') 'artibot'
Set-AutoLearning
Write-Host 'PROBE-END'
`;

describe.skipIf(!canRunPwsh)('install-auto-learning-unregister/ps1 behavioral', () => {
  let workDir;
  let artibotDir;
  let markerPath;
  let psLog;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(os.tmpdir(), 'artibot-unreg-ps-'));
    artibotDir = path.join(workDir, 'claude', 'artibot');
    mkdirSync(path.join(artibotDir, 'scripts'), { recursive: true });
    markerPath = path.join(artibotDir, 'auto-learning-registered.json');
    psLog = path.join(workDir, 'ps-stub.log');
    writeFileSync(psLog, '');
  });

  afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

  function runPs({
    runner = false, marker = null, config = null, registered = false, failDelete = false, dryRun = false,
  } = {}) {
    if (runner) writeFileSync(path.join(artibotDir, 'scripts', 'run-auto-learning.js'), '// fixture runner\n');
    if (marker !== null) writeFileSync(markerPath, marker);
    if (config !== null) writeFileSync(path.join(artibotDir, 'artibot.config.json'), JSON.stringify(config));

    const psPath = path.join(workDir, `probe-${Math.random().toString(36).slice(2)}.ps1`);
    // BOM 은 이스케이프로 — PS 5.1 은 BOM 없는 .ps1 을 ANSI 로 읽는다.
    writeFileSync(psPath, `\ufeff${PS_PROBE(dryRun)}`, 'utf8');
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
          STUB_LOG_PS: psLog,
          STUB_TASK_REGISTERED: registered ? '1' : '0',
          STUB_FAIL_DELETE: failDelete ? '1' : '0',
        },
      },
    );
    const out = `${res.stdout}${res.stderr}`;
    const calls = readFileSync(psLog, 'utf8').split(/\r?\n/).filter(Boolean);
    return {
      res, out, calls, hasEnd: out.includes('PROBE-END'),
      count: (needle) => calls.filter((c) => c.includes(needle)).length,
    };
  }

  const ENABLED = { autoLearning: { enabled: true, schedule: '0 3 * * *' } };
  const DELETE_LINE = `schtasks ${DELETE_ARGS.join(' ')}`;

  it('사전 점검이 비어 있지 않다 — 함수 스텁이 안 보이면 97 (프로브 자기검증)', () => {
    // 하네스 본문에서 스텁 정의를 지우는 대신, 사전 점검 문자열이 실제로 있는지와
    // 정상 실행에서 PREFLIGHT-FAIL 이 나오지 않는지를 함께 본다.
    expect(PS_PROBE(false)).toContain("$cmd.CommandType -ne 'Function'");
    const r = runPs({ marker: markerPs('schtasks'), registered: true });
    expect(r.out).not.toContain('PREFLIGHT-FAIL');
    expect(r.hasEnd, `프로브가 완주하지 못했다: ${r.out.slice(0, 600)}`).toBe(true);
  }, 120_000);

  it('(P1) schtasks marker + 등록됨 -> /Delete 정확히 1회, 등록 명령 0회, marker 정리', () => {
    const r = runPs({ marker: markerPs('schtasks'), config: ENABLED, registered: true });
    expect(r.hasEnd, r.out.slice(0, 600)).toBe(true);
    expect(r.calls).toEqual([DELETE_LINE]);
    expect(r.count('/Create')).toBe(0);
    expect(existsSync(markerPath)).toBe(false);
    expect(r.out).toContain(`[log] ${LOG_REMOVED}`);
  }, 120_000);

  it('(P1b) install.sh 가 쓴 marker(LF, 들여쓰기 2)도 읽는다', () => {
    const r = runPs({ marker: markerNode('schtasks'), registered: true });
    expect(r.calls).toEqual([DELETE_LINE]);
    expect(existsSync(markerPath)).toBe(false);
  }, 120_000);

  it('(P2) 삭제 실패 + 여전히 조회됨 -> 설치는 계속되고 marker 가 남는다', () => {
    const r = runPs({ marker: markerPs('schtasks'), registered: true, failDelete: true });
    expect(r.hasEnd, r.out.slice(0, 600)).toBe(true);
    expect(r.calls).toEqual([DELETE_LINE, `schtasks /Query /TN ${TASK}`]);
    expect(existsSync(markerPath)).toBe(true);
    expect(r.out).toContain(`[warn] ${LOG_MANUAL}`);
    expect(r.out).not.toContain(LOG_REMOVED);
  }, 120_000);

  it('(P3) 이미 사라진 작업 -> /Delete 실패 후 /Query 로 확인, marker 만 정리', () => {
    const r = runPs({ marker: markerPs('schtasks'), registered: false });
    expect(r.calls).toEqual([DELETE_LINE, `schtasks /Query /TN ${TASK}`]);
    expect(existsSync(markerPath)).toBe(false);
  }, 120_000);

  it('(P4) marker 가 없으면 호출 0, marker 도 새로 만들지 않는다', () => {
    const r = runPs({ config: ENABLED, registered: true });
    expect(r.hasEnd, r.out.slice(0, 600)).toBe(true);
    expect(r.calls).toEqual([]);
    expect(existsSync(markerPath)).toBe(false);
  }, 120_000);

  it.each(['hint-only', 'claude-schedule', 'none'])('(P5) %s marker -> 호출 0, marker 만 정리', (method) => {
    const r = runPs({ marker: markerPs(method), registered: true });
    expect(r.calls).toEqual([]);
    expect(existsSync(markerPath)).toBe(false);
    expect(r.out).toContain(`[log] ${LOG_CLEARED}${method})`);
  }, 120_000);

  it('(P6) 읽을 수 없는 marker 는 건드리지 않는다 (허용목록)', () => {
    const r = runPs({ marker: 'this is not json\n', registered: true });
    expect(r.hasEnd, r.out.slice(0, 600)).toBe(true);
    expect(r.calls).toEqual([]);
    expect(readFileSync(markerPath, 'utf8')).toBe('this is not json\n');
  }, 120_000);

  it('(P7) -DryRun 이면 호출 0 이고 marker 는 남는다', () => {
    const r = runPs({ marker: markerPs('schtasks'), registered: true, dryRun: true });
    expect(r.hasEnd, r.out.slice(0, 600)).toBe(true);
    expect(r.calls).toEqual([]);
    expect(existsSync(markerPath)).toBe(true);
    expect(r.out).toContain('[log] [dry-run] would remove dead auto-learning schedule');
  }, 120_000);

  it('(P8) 러너가 있고 marker 도 있으면 호출 0 이고 marker 는 그대로다', () => {
    const marker = markerPs('schtasks');
    const r = runPs({ runner: true, marker, registered: true });
    expect(r.hasEnd, r.out.slice(0, 600)).toBe(true);
    expect(r.calls).toEqual([]);
    expect(readFileSync(markerPath, 'utf8')).toBe(marker);
    expect(r.out).toContain('Auto-learning schedule already registered');
  }, 120_000);

  it('(P9) 러너가 있고 marker 없음 + enabled -> 종전대로 등록한다 (Create 1, Delete 0)', () => {
    const r = runPs({ runner: true, config: ENABLED, registered: false });
    expect(r.hasEnd, r.out.slice(0, 600)).toBe(true);
    expect(r.count('/Create')).toBe(1);
    expect(r.count('/Delete')).toBe(0);
    expect(existsSync(markerPath)).toBe(true);
    expect(JSON.parse(readFileSync(markerPath, 'utf8').replace(/^\ufeff/, '')).method).toBe('schtasks');
  }, 120_000);
});
