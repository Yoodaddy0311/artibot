/**
 * install.sh 가 실제로 무엇을 디스크에 놓는지 **실행해서** 단언한다.
 *
 * 정적 스캔이 아니다. 임시 HOME 을 만들고 `bash install.sh files` 를 진짜로 돌린 뒤
 * 산출물을 센다. 이전에는 설치 결과를 확인하는 유일한 수단이 install.sh 자신의
 * `verify_install` 출력이었는데, 그건 **디스크에 있는 것을 세는 것**이라 0개를
 * 복사하고도 이전 버전 트리를 세며 통과할 수 있다(그래서 INSTALL_FAILURES 회계가
 * 따로 있다). 이 스위트는 그 바깥에서 산출물의 실재를 확인한다.
 *
 * ── `files` 서브커맨드가 allowlist 인 이유 ────────────────────────────────────
 * `install)` 전체를 돌리면 crontab/schtasks 등록, MCP 설정, settings.json 수정,
 * marketplace/plugin-cache 미러처럼 **머신 스코프**인 단계가 딸려온다. 임시 HOME 은
 * 그중 아무것도 막지 못한다. 그래서 install.sh 에 파일 배치 단계만 열거한
 * 서브커맨드를 두고 여기서 그것만 돌린다. 금지 목록이 아니라 허용 목록이므로,
 * 나중에 `install)` 에 단계가 추가돼도 이 테스트로 자동 유입되지 않는다.
 *
 * ── 이 스위트가 못 보는 것 (rules §9) ────────────────────────────────────────
 *   - **install.ps1 파리티는 범위 밖이다.** Windows 사용자의 상당수는 PowerShell
 *     설치기를 타는데, 그쪽이 같은 산출물을 놓는지는 이 파일이 답하지 않는다.
 *     여기서 같이 돌리면 두 설치기를 한 스위트가 소유하게 되고, 한쪽 실패가
 *     다른 쪽 판정을 오염시킨다. 별도 스위트가 필요하다 — 현재는 없다(미확인).
 *   - **`install)` 경로 전체는 검증되지 않는다.** 위 allowlist 로 제외한 단계들이
 *     성공하는지는 여기서 아무것도 증명하지 않는다.
 *   - **파일이 있다 ≠ 그 내용이 옳다.** 여기서 세는 건 실재와 개수뿐이다. 배포
 *     콘텐츠의 정합성은 installer-distributed-content.test.js 가 본다.
 *   - **rsync 유무로 경로가 갈린다.** rsync 가 있으면 safe_copy_dir 은 rsync 를,
 *     없으면 per-file cp 루프를 탄다. 이 스위트는 실행 환경에 있는 쪽만 검사한다
 *     (실측 2026-08-18 Git Bash/Win11: rsync 없음 → cp 루프, 4분 35초).
 *   - **설치기는 워킹트리에서 복사한다 — gitignore 는 보지 않는다.** safe_copy_dir
 *     의 제외 목록은 node_modules 와 .git 뿐이라, 추적되지 않는 로컬 산출물이
 *     소스 트리에 있으면 그대로 설치본에 실린다. 실측 2026-08-18: 이 리포의
 *     `scripts/hooks/.artibot/ledger/` (gitignore:96 로 무시되는 세션 원장 2파일)
 *     가 샌드박스까지 따라왔다. 아래 node_modules/.git 단언은 **그 부류를 잡지
 *     않는다** — 잡게 만들면 개발자 트리 상태에 따라 색이 갈리는 게이트가 된다.
 *
 * @module tests/firewall/install-files-smoke
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { announceBashSkip, probeBash, toBashPath } from '../../scripts/utils/bash-compat.js';

/**
 * 존재 확인이 아니라 **능력** 확인이다. Windows 의 PowerShell 에서 `bash` 는
 * C:\WINDOWS\system32\bash.exe (WSL 런처) 로 잡히고, 그 bash 는 시작은 되지만
 * `C:/...` 경로의 스크립트를 열지 못한다. 자세한 실측은 bash-compat.js 헤더에.
 */
const BASH = probeBash();
if (!BASH.ok) announceBashSkip('install-files-smoke: install.sh files', BASH.reason);

/**
 * Windows 밖에서 bash 가 없다는 건 환경 문제가 아니라 결함이다 — CI 워크플로는
 * 전부 ubuntu-latest 라 거기서는 반드시 있어야 한다. 그래서 skip 은 win32 에서만
 * 허용하고, POSIX 에서 스킵이 일어나면 아래 방지선이 RED 로 만든다.
 */
const CAN_RUN = BASH.ok;

/** 실측 2026-08-18 (Git Bash / Win 11 / rsync 없음): 4분 35초. 3배 여유. */
const INSTALL_TIMEOUT_MS = 900_000;

const PLUGIN_ROOT = resolve(import.meta.dirname, '..', '..');
const INSTALL_SH = join(PLUGIN_ROOT, 'install.sh');

/**
 * install.sh 가 실제로 쓰는 목적지 (install.sh:7-8 에서 실측).
 *   CLAUDE_DIR  = $HOME/.claude
 *   ARTIBOT_DIR = $CLAUDE_DIR/artibot
 * agents/commands/rules 는 **CLAUDE_DIR 바로 아래**이고, artibot/ 아래가 아니다
 * (install_agents:404, install_commands:417, install_rules:607). skills/hooks/
 * scripts/lib 만 ARTIBOT_DIR 아래로 간다(install_skills:429, install_hooks:446-448).
 * 이 구분을 틀리면 "설치됐다" 는 단언이 빈 디렉터리를 세게 된다.
 */
const EXPECTED_DIRS = [
  '.claude/agents',
  '.claude/commands',
  '.claude/rules/artibot',
  '.claude/artibot/skills',
  '.claude/artibot/hooks',
  '.claude/artibot/scripts',
  '.claude/artibot/lib',
];

/** 디스패처가 이 둘 없이는 아예 뜨지 못한다. 개수가 아니라 이름으로 못박는다. */
const EXPECTED_FILES = [
  '.claude/artibot/hooks/hooks.json',
  '.claude/artibot/hooks/dispatch-table.json',
];

/** @type {string} */
let sandbox;
/** @type {{status: number|null, stdout: string, stderr: string}} */
let run;

/**
 * 디렉터리 아래 파일 수를 센다. `readdirSync(..., {recursive:true})` 대신 직접
 * 도는 이유는 심링크·권한 오류에서 조용히 0 을 돌려주지 않기 위해서다.
 * @param {string} dir
 * @returns {number}
 */
function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += countFiles(full);
    else if (entry.isFile()) total += 1;
  }
  return total;
}

/**
 * 이름이 일치하는 디렉터리를 전부 찾는다 (node_modules/.git 누출 검사용).
 * @param {string} dir
 * @param {Set<string>} names
 * @returns {string[]}
 */
function findDirsNamed(dir, names) {
  if (!existsSync(dir)) return [];
  const hits = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    if (names.has(entry.name)) hits.push(full);
    else hits.push(...findDirsNamed(full, names));
  }
  return hits;
}

/**
 * R4 — 진짜 `~/.claude` 오염 방지선.
 *
 * 리더 지시는 "임시 경로가 os.homedir() 하위면 fail" 이었는데 그대로는 쓸 수 없다:
 * Windows 의 os.tmpdir() 는 `C:\Users\<user>\AppData\Local\Temp` 로 **홈 하위**라
 * 그 규칙이면 Windows 에서 항상 fail 이다(실측 2026-08-18). 홈 하위인지가 아니라
 * **진짜 ~/.claude 에 손이 닿는지**가 지켜야 할 성질이므로 그걸 직접 단언한다.
 *
 * @param {string} dir
 */
function assertSandboxIsolated(dir) {
  const real = resolve(homedir());
  const box = resolve(dir);
  if (box === real) throw new Error(`sandbox 가 실제 홈이다: ${box}`);

  // 진짜 ~/.claude 가 샌드박스 밖이어야 한다 — 안이면 설치가 그걸 덮어쓴다.
  const realClaude = resolve(join(real, '.claude'));
  const rel = relative(box, realClaude);
  if (!rel.startsWith('..')) {
    throw new Error(`실제 ~/.claude 가 sandbox 안에 있다 (${realClaude} ⊂ ${box})`);
  }
}

beforeAll(() => {
  if (!CAN_RUN) return;

  sandbox = mkdtempSync(join(tmpdir(), 'artibot-install-smoke-'));
  assertSandboxIsolated(sandbox);

  const result = spawnSync(BASH.bash, [toBashPath(INSTALL_SH), 'files'], {
    // HOME 과 USERPROFILE 둘 다. install.sh:7 은 `${HOME:-${USERPROFILE:-…}}` 라
    // HOME 만으로 충분하지만, 한쪽만 덮으면 그 폴백 순서가 바뀌는 순간 실제 홈으로
    // 새어나간다. 둘 다 덮는 건 그 변경에 대한 보험이다.
    env: { ...process.env, HOME: sandbox, USERPROFILE: sandbox },
    // 저장소가 아니라 샌드박스에서 돌린다. SCRIPT_DIR 은 BASH_SOURCE 로 잡히므로
    // cwd 와 무관해야 하고, 그게 사실인지도 여기서 같이 검증된다.
    cwd: sandbox,
    encoding: 'utf-8',
    timeout: INSTALL_TIMEOUT_MS,
  });

  run = {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: (result.error ? String(result.error.message) : '') + (result.stderr ?? ''),
  };
}, INSTALL_TIMEOUT_MS);

afterAll(() => {
  if (!sandbox) return;
  // Windows 는 방금 끝난 bash 가 놓은 핸들이 잠깐 남아 rmdir 이 EPERM 으로 튕긴다
  // (실측 2026-08-18: 옵션 없는 rmSync 는 803개 중 325개를 남긴 채 EPERM 이었고,
  // 같은 경로에 maxRetries 를 주자 첫 시도에 지워졌다). 재시도가 그 창을 덮는다.
  //
  // 그래도 실패하면 **조용히 넘어간다**. 여기서 throw 하면 일시적인 파일 핸들
  // 하나가 게이트를 빨갛게 만드는데, 그 빨강은 이 스위트가 검사하는 것과 아무
  // 관계가 없다. 대가는 OS 임시 디렉터리에 남는 잔여물이고 그건 OS 가 회수한다.
  try {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // 위 주석 참조 — 임시 디렉터리 잔여물은 판정 대상이 아니다.
  }
}, 120_000);

describe.skipIf(!CAN_RUN)('install.sh files — 실설치 스모크', () => {
  it('exit 0 으로 끝난다', () => {
    expect(run.status, `stderr: ${run.stderr}\nstdout tail: ${run.stdout.slice(-2000)}`).toBe(0);
    // PARTIAL INSTALL 은 verify_install 이 exit 1 로 만들지만, 배너 자체가 나오면
    // 위 단언이 통과해도 뭔가 복사되지 않은 것이다.
    expect(run.stdout + run.stderr).not.toContain('PARTIAL INSTALL');
  });

  it.each(EXPECTED_DIRS)('%s 에 파일이 들어갔다', (rel) => {
    // 개수 하한만 본다. 정확한 개수를 박으면 스킬/에이전트를 하나 추가할 때마다
    // 이 게이트가 무관한 이유로 빨개지고, 그러면 사람이 게이트를 깎는다.
    expect(countFiles(join(sandbox, rel))).toBeGreaterThan(0);
  });

  it.each(EXPECTED_FILES)('%s 가 실재한다', (rel) => {
    const full = join(sandbox, rel);
    expect(existsSync(full)).toBe(true);
    expect(statSync(full).size).toBeGreaterThan(0);
  });

  it('node_modules 와 .git 은 따라오지 않는다', () => {
    // safe_copy_dir 의 --exclude 가 실제로 먹었는지. 여기 새면 설치본이 수만 개
    // 파일로 부풀고, `.git` 이 섞이면 설치 디렉터리가 리포처럼 보이기 시작한다.
    const leaked = findDirsNamed(join(sandbox, '.claude'), new Set(['node_modules', '.git']));
    expect(leaked).toEqual([]);
  });

  it('샌드박스 밖으로는 아무것도 쓰지 않는다', () => {
    // 사후 재확인 — 설치가 끝난 뒤에도 격리 조건이 여전히 참인지.
    expect(() => assertSandboxIsolated(sandbox)).not.toThrow();
    expect(existsSync(join(sandbox, '.claude'))).toBe(true);
  });
});

/**
 * 이 스위트의 fail-open 방지선.
 *
 * 위 describe 는 bash 가 없으면 통째로 사라지는데, **사라진 것과 통과한 것은 요약
 * 출력에서 구분되지 않는다**. CI 워크플로는 전부 ubuntu-latest 라 거기에는 bash 가
 * 반드시 있으므로, POSIX 에서 스킵이 일어났다면 환경 탓이 아니라 프로브가 깨진
 * 것이다. 그때 조용히 검사를 잃는 대신 여기서 RED 가 된다. Windows 만 면제인
 * 이유는 그쪽 판정이 "어느 셸이 띄웠는가" 에 정당하게 의존하기 때문이다
 * (Git Bash → ok, PowerShell → WSL bash 로 잡혀 거부).
 */
describe.skipIf(process.platform === 'win32')('bash 프로브 (CI 스킵 방지선)', () => {
  it('POSIX 에서는 ok 여서 실설치 스모크가 스킵되지 않는다', () => {
    expect(BASH.ok, `probeBash failed on POSIX: ${BASH.reason}`).toBe(true);
  });
});
