/**
 * Firewall — `artibot.config.json#orca`: 키 형태, 브랜치 접두와 세션 훅의 대조, `.gitignore` 규칙.
 *
 * 왜 게이트가 필요한가. /orca 는 줄기 브랜치 이름을 `<branchPrefix><limb>-<tag>` 로 정해
 * `orca worktree create --branch` 에 넘긴다. 접두는 설정값이라 한 줄 편집으로 두 사고가 난다.
 *   1) 접두에서 `/` 가 빠지면 이름 전체가 `[A-Za-z0-9_-]` 라서 SessionStart 훅
 *      (`scripts/hooks/git-autopilot-session.js#RELOCATABLE_BRANCH_NAME`)이 줄기 브랜치를
 *      `artibot/` 계열로 옮긴다. `/split` 에서는 줄기 4/4 가 이렇게 옮겨져 `land` 가 끝난 일을
 *      `no-commits` 로 읽었다(`tests/firewall/split-branch-prefix-guard.test.js` 의 네 번째 핀,
 *      2026-09-04). /orca 도 브랜치 이름으로 줄기를 읽으므로 같은 경로다(추론 — /orca 에서
 *      옮겨진 사례를 측정한 것은 아니다. P0 실측은 반대쪽이다: 실제 워커 세션에서 `orca/` 로
 *      시작하는 이름은 옮겨지지 않았다).
 *   2) 접두가 `autopilot/` 이면 `lib/autopilot/worktree-manager.js` 의 삭제 허용 목록에 걸려
 *      autopilot 정리 때 줄기 브랜치가 지워진다.
 *
 * 이 파일이 핀하는 것
 *   a. 키 allowlist·타입(모르는 키는 거부). 검증기를 먼저 자기검증하고 출하 블록에 적용한다.
 *   b. 출하 기본값(orca-command 설계안 §4.7 표). `launch.requireApproval` 의 출하값은 닫힌 쪽(true).
 *   c. `branchPrefix` 가 `/` 를 포함하고, 그 접두로 만든 브랜치 이름이 훅의 "옮길 수 있는 이름"
 *      정규식에 걸리지 않으며, git 이 유효한 이름으로 받고, autopilot 삭제 접두와 겹치지 않는다.
 *      훅의 정규식은 export 가 아니라서 **소스 텍스트에서 읽는다**(훅은 고치지 않는다).
 *   d. `.artibot/orca/run.json` 이 루트 `.gitignore` 규칙으로 무시되고, 그 아래 추적 파일이 없다.
 *   e. `orca` 는 최상위 블록이고 `split` 밖이며 원문에 한 번만 나온다.
 *
 * 이 게이트가 못 보는 것 (초록을 그 이상으로 읽지 마라)
 *   - Orca 가 `agent`·`worktreeSetup` 값을 받아들이는지. P0 영수증(2026-11-19, Orca 1.4.259)에는
 *     `--setup` 값을 보여 주는 파일이 없다 — `skip` 은 설계안의 값이지 실측값이 아니다.
 *   - 이 키를 읽는 스크립트가 있는지, 바르게 읽는지(scripts/orca/ 는 같은 P1 배치의 다른 줄기다).
 *   - 훅이 정규식 밖의 경로로 브랜치를 옮기는지. 동작은 tests/hooks/git-autopilot-session.test.js 가
 *     본다. 이 파일은 정규식 텍스트와 그 정규식이 이름을 걸러내는지만 본다.
 *   - 설치본(플러그인 캐시)·사용자 override. 저장소의 파일만 읽는다.
 *   - `/orca` 밖에서 손으로 지은 브랜치 이름.
 *   - `.artibot/orca/` 규칙이 사용자 프로젝트의 info/exclude 관리 블록에도 들어갔는지 —
 *     runtime-exclude-drift.test.js 소관이다.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(HERE, '..', '..');
const CONFIG_FILE = path.join(PLUGIN_ROOT, 'artibot.config.json');
const HOOK_FILE = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'git-autopilot-session.js');
const MANAGER_FILE = path.join(PLUGIN_ROOT, 'lib', 'autopilot', 'worktree-manager.js');

// Fail-closed: 파일이 없거나 JSON 이 깨지면 import 단계에서 던져 red 다. skip 하지 않는다.
const configText = readFileSync(CONFIG_FILE, 'utf-8');
const config = JSON.parse(configText);
const hookSource = readFileSync(HOOK_FILE, 'utf-8');
const managerSource = readFileSync(MANAGER_FILE, 'utf-8');

/**
 * 출하값(orca-command 설계안 §4.7 표). 값을 바꾸는 것은 편집이 아니라 결정이다 —
 * config 와 이 핀을 함께 고친다. `launch.requireApproval` 의 사전 위임(false)은 오너가
 * 자기 설정에 거는 값이고, 출하 기본값은 아니다.
 */
const EXPECTED_ORCA = Object.freeze({
  enabled: true,
  agent: 'claude',
  branchPrefix: 'orca/',
  worktreeSetup: 'skip',
  launch: Object.freeze({ requireApproval: true }),
  stallCheckMinutes: 30,
});

/** `orca` 아래에 있어도 되는 키 — allowlist. `comment` 는 이 config 의 관례다. */
const ORCA_KEYS = Object.freeze([...Object.keys(EXPECTED_ORCA), 'comment']);

/** `orca.launch` 아래에 있어도 되는 키 — allowlist. */
const LAUNCH_KEYS = Object.freeze(['requireApproval']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isPositiveInteger = (v) => Number.isInteger(v) && v > 0;

/**
 * `orca.launch` 의 오류 목록.
 *
 * @param {unknown} launch
 * @returns {string[]}
 */
function validateLaunch(launch) {
  if (!isPlainObject(launch)) return ['orca.launch 가 객체가 아니다'];
  const errors = Object.keys(launch)
    .filter((key) => !LAUNCH_KEYS.includes(key))
    .map((key) => `알 수 없는 키: orca.launch.${key}`);
  if (typeof launch.requireApproval !== 'boolean') {
    errors.push('orca.launch.requireApproval 는 boolean 이어야 한다');
  }
  return errors;
}

/**
 * `orca` 블록의 형태 오류 목록 — 비어 있으면 유효. 던지지 않는다. 키가 빠진 것도 오류다
 * (`stallCheckMinutes` 를 빼고 출하하는 결정이 나면 이 줄과 위 값 핀을 함께 고친다).
 *
 * @param {unknown} block
 * @returns {string[]}
 */
function validateOrcaBlock(block) {
  if (!isPlainObject(block)) return ['orca 가 객체가 아니다'];
  const errors = Object.keys(block)
    .filter((key) => !ORCA_KEYS.includes(key))
    .map((key) => `알 수 없는 키: orca.${key}`);
  if (typeof block.enabled !== 'boolean') errors.push('orca.enabled 는 boolean 이어야 한다');
  if (!isNonEmptyString(block.agent)) errors.push('orca.agent 는 비어 있지 않은 문자열이어야 한다');
  if (!isNonEmptyString(block.branchPrefix) || !block.branchPrefix.includes('/')) {
    errors.push('orca.branchPrefix 는 `/` 를 포함한 문자열이어야 한다');
  }
  if (!isNonEmptyString(block.worktreeSetup)) {
    errors.push('orca.worktreeSetup 은 비어 있지 않은 문자열이어야 한다');
  }
  errors.push(...validateLaunch(block.launch));
  const stall = block.stallCheckMinutes;
  if (stall !== null && !isPositiveInteger(stall)) {
    errors.push('orca.stallCheckMinutes 는 양의 정수 또는 null 이어야 한다');
  }
  if (!isNonEmptyString(block.comment)) errors.push('orca.comment 가 없다');
  return errors;
}

/**
 * 세션 훅 소스에서 `RELOCATABLE_BRANCH_NAME` 정규식 리터럴을 꺼낸다. export 가 아니라 import 할
 * 수 없으므로 소스 텍스트를 읽는다. 선언 줄(`const … = /…/flags;`)만 인정한다 — 주석 속 언급은
 * 줄 머리가 달라 걸리지 않는다. `g`·`y` 플래그는 `.test` 에 상태를 남기므로 뗀다.
 *
 * @param {string} source
 * @returns {RegExp | null} 못 찾으면 null (호출 쪽이 red 로 만든다)
 */
function extractRelocatableBranchName(source) {
  const match = /^const RELOCATABLE_BRANCH_NAME = \/((?:[^\\/\r\n]|\\.)+)\/([a-z]*);/m.exec(source);
  return match ? new RegExp(match[1], match[2].replace(/[gy]/g, '')) : null;
}

/** 못 찾으면 이유를 말하고 던진다 — 정규식이 없으면 이 게이트는 아무것도 증명하지 못한다. */
function hookRegexOrThrow() {
  const re = extractRelocatableBranchName(hookSource);
  if (re === null) {
    throw new Error(
      'git-autopilot-session.js 에서 `const RELOCATABLE_BRANCH_NAME = /…/;` 선언을 찾지 못했다 — '
      + '이름이 바뀌었거나 선언 형태가 달라졌다. 이 게이트는 그 정규식을 읽어야만 의미가 있다.',
    );
  }
  return re;
}

/** 줄기 슬러그 모양 — `^[a-z0-9][a-z0-9-]{1,30}$`(2~31자)의 양 끝과 P0 에서 실제로 쓴 `p0-a`. */
const LIMB_EXAMPLES = Object.freeze(['p0-a', 'orca-core-lib', 'hg14', 'ab', `a${'b'.repeat(30)}`]);

/** 6자 태그 — 설계는 6자리 hex 이고, P0 에서 실제로 쓴 값 `fcb0gj` 는 hex 가 아니라 둘 다 싣는다. */
const TAG_EXAMPLES = Object.freeze(['a1b2c3', '0f9e8d', 'fcb0gj']);

/**
 * 접두로 만든 줄기 브랜치 이름 예시 — `<prefix><limb>-<tag>`.
 *
 * @param {string} prefix
 * @returns {string[]}
 */
function exampleBranchNames(prefix) {
  return LIMB_EXAMPLES.flatMap((limb) => TAG_EXAMPLES.map((tag) => `${prefix}${limb}-${tag}`));
}

/**
 * 이 접두로 만든 이름 중 훅이 `artibot/` 쪽으로 옮길 이름.
 *
 * @param {string} prefix
 * @param {RegExp} relocatable
 * @returns {string[]}
 */
function namesTheHookWouldMove(prefix, relocatable) {
  return exampleBranchNames(prefix).filter((name) => relocatable.test(name));
}

let repoRootCache = null;

/** 저장소 루트. 워크트리에서도 그 워크트리의 루트를 돌려준다. */
function repoRoot() {
  if (repoRootCache === null) {
    repoRootCache = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: HERE,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }
  return repoRootCache;
}

/**
 * `git check-ref-format refs/heads/<name>` — exit 0 유효, 1 무효, 그 외는 도구 오류(그대로 던진다.
 * 오류를 "무효"로 삼키면 이 게이트가 거짓 그린이 된다).
 *
 * @param {string} name
 * @returns {boolean}
 */
function isValidBranchName(name) {
  try {
    execFileSync('git', ['check-ref-format', `refs/heads/${name}`], {
      cwd: repoRoot(),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return true;
  } catch (err) {
    if (err.status === 1) return false;
    throw new Error(`git check-ref-format 가 예상 밖 종료(${err.status}) — name=${name}: ${err.stderr ?? ''}`, {
      cause: err,
    });
  }
}

/**
 * `git check-ignore -v --no-index` 로 "어느 규칙이 이 경로를 막는가"를 묻는다. `--no-index` 는
 * 추적 여부와 무관하게 규칙만 대조한다. 출력은 `<source>:<line>:<pattern>\t<path>`, 막히지
 * 않으면 exit 1. 그 외 종료는 도구 오류라 던진다.
 *
 * @param {string} relPath
 * @returns {{source: string, line: number, pattern: string} | null} 막히지 않으면 null
 */
function whichRuleIgnores(relPath) {
  let out;
  try {
    out = execFileSync('git', ['check-ignore', '-v', '--no-index', '--', relPath], {
      cwd: repoRoot(),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (err.status === 1) return null;
    throw new Error(`git check-ignore 가 예상 밖 종료(${err.status}) — path=${relPath}: ${err.stderr ?? ''}`, {
      cause: err,
    });
  }
  const match = /^(.+):(\d+):([^\t]*)\t/.exec(out.split('\n')[0]);
  if (match === null) throw new Error(`git check-ignore -v 출력을 해석하지 못했다: ${JSON.stringify(out)}`);
  return { source: match[1], line: Number(match[2]), pattern: match[3] };
}

/** 키 하나를 뺀 복사본. */
function without(block, key) {
  const copy = structuredClone(block);
  delete copy[key];
  return copy;
}

/** 키 몇 개를 바꾼 복사본. */
function patched(block, patch) {
  return { ...structuredClone(block), ...patch };
}

describe('artibot.config.json#orca — 형태', () => {
  it('orca 블록이 있다', () => {
    expect(config.orca, 'config.orca 가 없다').toBeDefined();
  });

  it('출하 블록이 검증기를 통과한다 (키 allowlist·타입)', () => {
    expect(validateOrcaBlock(config.orca)).toEqual([]);
  });

  it.each(Object.entries(EXPECTED_ORCA))('orca.%s === %j', (key, value) => {
    expect(config.orca[key]).toEqual(value);
  });

  it('launch.requireApproval 의 출하값은 boolean true 다 — 승인 게이트는 닫힌 채 출하한다', () => {
    expect(typeof config.orca.launch.requireApproval).toBe('boolean');
    expect(
      config.orca.launch.requireApproval,
      'launch 승인이 꺼진 채 출하된다 — 오너 사전 위임은 사용자 값이지 출하값이 아니다',
    ).toBe(true);
  });

  it('comment 는 이 config 의 관례대로 있고, 접두에 `/` 가 필요한 이유(세션 훅)를 말한다', () => {
    const { comment } = config.orca;
    expect(typeof comment).toBe('string');
    expect(comment.length).toBeGreaterThan(200);
    expect(comment).toContain('git-autopilot-session.js');
  });
});

describe('orca 블록 위치 — 최상위, split 밖', () => {
  it('최상위 키 orca 가 있고 split 블록 안에는 없다', () => {
    expect(config.split, 'config.split 이 없다').toBeDefined();
    expect(Object.hasOwn(config, 'orca')).toBe(true);
    expect(Object.hasOwn(config.split, 'orca')).toBe(false);
  });

  it('원문에 `"orca":` 키가 정확히 한 번 나온다 (JSON.parse 는 중복 키의 앞쪽을 조용히 버린다)', () => {
    expect(configText.match(/^\s*"orca"\s*:/gm) ?? []).toHaveLength(1);
  });
});

describe('검증기 자기검증 — 이 게이트가 실제로 빨개질 수 있다', () => {
  const REJECTED = [
    ['모르는 최상위 하위 키', (b) => patched(b, { unknownKey: 1 })],
    ['모르는 launch 하위 키', (b) => patched(b, { launch: { ...b.launch, extra: true } })],
    ['enabled 누락', (b) => without(b, 'enabled')],
    ['enabled 가 문자열 "true"', (b) => patched(b, { enabled: 'true' })],
    ['enabled 가 숫자 1', (b) => patched(b, { enabled: 1 })],
    ['agent 가 빈 문자열', (b) => patched(b, { agent: '' })],
    ['agent 가 공백뿐', (b) => patched(b, { agent: '   ' })],
    ['agent 가 숫자', (b) => patched(b, { agent: 5 })],
    ['branchPrefix 에 슬래시가 없다', (b) => patched(b, { branchPrefix: 'orca-' })],
    ['branchPrefix 가 빈 문자열', (b) => patched(b, { branchPrefix: '' })],
    ['branchPrefix 가 문자열이 아니다', (b) => patched(b, { branchPrefix: ['orca/'] })],
    ['worktreeSetup 누락', (b) => without(b, 'worktreeSetup')],
    ['worktreeSetup 이 빈 문자열', (b) => patched(b, { worktreeSetup: '' })],
    ['launch 누락', (b) => without(b, 'launch')],
    ['launch 가 null', (b) => patched(b, { launch: null })],
    ['launch 가 배열', (b) => patched(b, { launch: [] })],
    ['launch.requireApproval 누락', (b) => patched(b, { launch: {} })],
    ['launch.requireApproval 이 문자열', (b) => patched(b, { launch: { requireApproval: 'yes' } })],
    ['stallCheckMinutes 누락', (b) => without(b, 'stallCheckMinutes')],
    ['stallCheckMinutes 가 0', (b) => patched(b, { stallCheckMinutes: 0 })],
    ['stallCheckMinutes 가 음수', (b) => patched(b, { stallCheckMinutes: -1 })],
    ['stallCheckMinutes 가 소수', (b) => patched(b, { stallCheckMinutes: 1.5 })],
    ['stallCheckMinutes 가 문자열 "30"', (b) => patched(b, { stallCheckMinutes: '30' })],
    ['stallCheckMinutes 가 NaN', (b) => patched(b, { stallCheckMinutes: Number.NaN })],
    ['stallCheckMinutes 가 Infinity', (b) => patched(b, { stallCheckMinutes: Number.POSITIVE_INFINITY })],
    ['comment 누락', (b) => without(b, 'comment')],
  ];

  const ACCEPTED = [
    ['stallCheckMinutes null (끔)', (b) => patched(b, { stallCheckMinutes: null })],
    ['stallCheckMinutes 1', (b) => patched(b, { stallCheckMinutes: 1 })],
    ['stallCheckMinutes 720', (b) => patched(b, { stallCheckMinutes: 720 })],
    ['enabled false (킬스위치)', (b) => patched(b, { enabled: false })],
    ['launch.requireApproval false (오너 사전 위임 — 모양은 유효)', (b) => patched(b, { launch: { requireApproval: false } })],
    ['다른 agent id', (b) => patched(b, { agent: 'codex' })],
    ['여러 단계 접두', (b) => patched(b, { branchPrefix: 'team/orca-' })],
  ];

  it.each(REJECTED)('거부: %s', (name, mutate) => {
    const errors = validateOrcaBlock(mutate(config.orca));
    expect(errors.length, `${name} 인데 검증기가 통과시켰다`).toBeGreaterThan(0);
  });

  it.each(ACCEPTED)('통과: %s', (name, mutate) => {
    expect(validateOrcaBlock(mutate(config.orca)), name).toEqual([]);
  });

  it.each([[null], [undefined], [[]], ['orca'], [42]])('블록이 객체가 아니면(%j) 거부한다', (value) => {
    expect(validateOrcaBlock(value)).toEqual(['orca 가 객체가 아니다']);
  });
});

describe('branchPrefix 와 세션 훅의 대조 (정규식은 훅 소스 텍스트에서 읽는다)', () => {
  it('훅 소스에서 RELOCATABLE_BRANCH_NAME 선언을 찾는다 (fail-closed)', () => {
    expect(hookRegexOrThrow()).toBeInstanceOf(RegExp);
  });

  it('양성 대조: 추출한 정규식은 평범한 이름을 "옮길 수 있는 이름"으로 읽는다 — 아니면 아래 단언이 공허하다', () => {
    const relocatable = hookRegexOrThrow();
    // 마지막 값은 접두에서 `/` 가 빠졌을 때의 줄기 이름이다 — 훅이 옮기는 바로 그 사고.
    for (const plain of ['master', 'feature_x-1', 'orca-hg14-a1b2c3']) {
      expect(relocatable.test(plain), plain).toBe(true);
    }
  });

  it('branchPrefix 는 `/` 를 포함한다', () => {
    expect(config.orca.branchPrefix).toContain('/');
  });

  it('branchPrefix 로 만든 줄기 브랜치 이름은 훅이 옮기는 이름 모양에 하나도 걸리지 않는다', () => {
    expect(namesTheHookWouldMove(config.orca.branchPrefix, hookRegexOrThrow())).toEqual([]);
  });

  it('자기검증: `/` 가 없는 접두는 걸린다 — 이 단언은 실제로 빨개질 수 있다', () => {
    const relocatable = hookRegexOrThrow();
    for (const bad of ['orca-', 'orca_', 'orca']) {
      expect(namesTheHookWouldMove(bad, relocatable).length, `접두 ${JSON.stringify(bad)}`).toBeGreaterThan(0);
    }
  });

  it('예시 이름 목록이 비어 있지 않고 P0 실측 이름 `orca/p0-a-fcb0gj` 를 만든다 (분모)', () => {
    const names = exampleBranchNames('orca/');
    expect(names.length).toBe(LIMB_EXAMPLES.length * TAG_EXAMPLES.length);
    expect(names).toContain('orca/p0-a-fcb0gj');
  });

  it('추출기 자기검증: 합성 소스에서 정규식을 복원하고 g·y 플래그를 뗀다', () => {
    const re = extractRelocatableBranchName('x\nconst RELOCATABLE_BRANCH_NAME = /^[a-z]+$/gi;\ny');
    expect(re.source).toBe('^[a-z]+$');
    expect(re.flags).toBe('i');
  });

  it('추출기 자기검증: 선언이 없거나 주석 속 언급뿐이면 null 이다 (조용한 통과 없음)', () => {
    expect(extractRelocatableBranchName('const OTHER = /x/;')).toBeNull();
    expect(extractRelocatableBranchName(' * {@link RELOCATABLE_BRANCH_NAME} = /x/;')).toBeNull();
  });
});

describe('branchPrefix 로 만든 이름은 git 브랜치로 유효하다', () => {
  it('하네스 자기검증: 판정기가 양쪽 답을 모두 낼 수 있다', () => {
    expect(isValidBranchName('orca/ok-a1b2c3')).toBe(true);
    expect(isValidBranchName('orca/a..b')).toBe(false);
    expect(isValidBranchName('orca//x')).toBe(false);
  });

  it('예시 이름 전부를 git check-ref-format 이 받는다', () => {
    const invalid = exampleBranchNames(config.orca.branchPrefix).filter((name) => !isValidBranchName(name));
    expect(invalid).toEqual([]);
  });
});

describe('branchPrefix 는 autopilot 의 브랜치 삭제 허용 접두와 겹치지 않는다 (worktree-manager 소스에서 읽는다)', () => {
  const autopilotPrefix = /const AUTOPILOT_BRANCH_PREFIX = '([^']+)';/.exec(managerSource)?.[1] ?? null;

  it('manager 소스에서 접두 상수를 찾는다 (fail-closed)', () => {
    expect(autopilotPrefix, 'worktree-manager.js 에서 AUTOPILOT_BRANCH_PREFIX 를 찾지 못했다').not.toBeNull();
  });

  it('서로의 접두가 아니다', () => {
    const { branchPrefix } = config.orca;
    expect(branchPrefix.startsWith(autopilotPrefix)).toBe(false);
    expect(autopilotPrefix.startsWith(branchPrefix)).toBe(false);
  });
});

describe('.gitignore 가 /orca 상태 파일을 막는다', () => {
  it('하네스 자기검증: 판정기가 양쪽 답을 모두 낼 수 있다', () => {
    // 한쪽만 낼 수 있는 판정기는 그쪽으로 전부 통과시킨다.
    expect(whichRuleIgnores('node_modules/anything.js')).not.toBeNull();
    expect(whichRuleIgnores('README.md')).toBeNull();
  });

  it('.artibot/orca/run.json 은 루트 .gitignore 의 `.artibot/orca/` 규칙으로 무시된다', () => {
    const hit = whichRuleIgnores('.artibot/orca/run.json');
    expect(hit, '무시되지 않는다 — 루트 .gitignore 에 `.artibot/orca/` 규칙이 없다').not.toBeNull();
    // 근거가 전역 gitignore·info/exclude 일 수도 있다 — 결정한 규칙의 출처가 루트 파일인지 본다.
    expect(hit.source).toBe('.gitignore');
    expect(hit.pattern).toContain('.artibot/orca/');
  });

  it('.artibot/orca/ 아래 추적 중인 파일이 없다 (ignore 는 이미 추적 중인 파일에 힘이 없다)', () => {
    const tracked = execFileSync('git', ['ls-files', '-z', '--', '.artibot/orca/'], {
      cwd: repoRoot(),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).split('\0').filter(Boolean);
    expect(tracked).toEqual([]);
  });
});
