/**
 * Firewall — v5 Phase 0 이 `artibot.config.json` 최상위에 신설한 키 6종
 * (`topology`·`routing`·`ledger`·`stateStore`·`missions`·`review`)
 * + `agents.modelPolicy.low`. `review` 는 오너 결정 2026-09-03 으로 추가됐다.
 *
 * ── 왜 새 파일인가 ──────────────────────────────────────────────────────────
 *  `tests/firewall/split-config-firewall.test.js` 는 이름과 달리 **`config.split`
 *  하위 키만** 본다(`ALLOWED_KEYS` = EXPECTED_SPLIT ∪ ADDITIVE_OBJECT_KEYS ∪ comment).
 *  최상위 키는 그 파일의 사정권 밖이고, artibot.config.json 용 JSON 스키마는 형태만
 *  본다(비-strict — 값도, 키 추가도 못 잡는다). 그래서 최상위 신설 키는 이 파일이
 *  소유한다. `split-config-firewall.test.js` 는 무수정이다(소유 경로 충돌 제거).
 *
 * ── 무엇을 지키는가 ────────────────────────────────────────────────────────
 *  A. **키 6종의 형태와 값.** 값 표는 설계 정본(§3.1·§3.2·§3.5·§3.6·§1-2/OD-4)과
 *     오너 결정(2026-09-03: review.independent·C4)이 정한 것이다. 하위 키는 **allowlist** 다 — 알 수 없는 키가 생기면 RED.
 *  B. **`*Ref` 는 실제로 가리킨다.** §3.5 "값은 기존 키 참조, 중복 정의 금지" 는
 *     문자열을 적어두는 것만으로는 지켜지지 않는다. 여기서 모든 `*Ref` 를 같은
 *     문서에 대고 해석해 **dangling 이면 RED** 로 만든다. 그래야
 *     `autopilot.fast.*`·`split.*`·`phaseRoles.review` 를 개명하면 런타임이 아니라
 *     게이트가 깨진다. 값 자체는 단언하지 않는다 — 그건 중복 정의의 재발이다.
 *  C. **실효 라우팅 변화 0.** `low` 버킷이 `resolveModel` 결과를 바꾸지 않음을
 *     30 에이전트 전건으로 확인한다. 선언만으로 라우팅이 움직이지 않는다는 것이
 *     Phase 0 "observe/기록만" 의 전부다.
 *  D. **기존 키 무변경.** 신설 키가 참조하는 기존 값들이 이 커밋에서 바뀌지 않았음을
 *     고정한다(§3.5 는 참조를 요구했지 값 변경을 요구하지 않았다).
 *
 * ── 이 게이트가 못 보는 것 (rules §9) ───────────────────────────────────────
 *
 *  1. **의미(소비).** 이 파일이 그린이라는 것은 **"선언이 설계와 일치한다"** 이지
 *     **"기능이 동작한다"** 가 아니다. 소비 현황은 키마다 다르다(2026-09-03 실측,
 *     `lib/{topology,routing,mission,project-state}/` 는 이제 **전부 실재**한다):
 *       - `topology` — **읽는다**. `lib/topology/topology-router.js` 가
 *         `config.topology.*` 를 읽고 `*Ref` 를 해석하지만 **read-only** 로
 *         `reason[]` 에 넣을 뿐이고 `default` 를 **적용하지 않는다**(:560).
 *         `lib/routing/execution-profile.js` 도 `default` 를 참조한다.
 *         **"소비자가 생겼다" ≠ "행동이 바뀐다"** — 이 게이트는 둘 다 안 본다.
 *       - `routing`·`ledger`·`stateStore` — `lib/`·`scripts/` 소비자 **0**.
 *       - `review` — 소비자 **0**. `lib/mission/compiler.js:403` 은 호출자가
 *         boolean 을 넘길 때만 반영하고 이 config 를 읽지 않으며,
 *         `lib/runtime/artifact-lifecycle-gates.js` 는 자기 frozen 기본값을
 *         쓴다. 즉 선언 2개이고 이 게이트는 선언만 본다.
 *       - `missions` — `lib/` 런타임 소비자 **0**. 술어는
 *         `lib/mission/mission-id.js#judgeSubstantive` 가 **자체 하드코딩 표**로
 *         갖고 있고 이 config 를 읽지 않는다. 즉 config 와 코드는 **독립 선언 2개**이고,
 *         둘의 드리프트는 이 파일이 아니라
 *         `tests/evals/nl-activation-fixture.test.js:237` 이 잡는다.
 *     따라서 `ledger.path` 로 파일이 쓰이는지, `routing.observe` 로 무엇이
 *     관측되는지, `stateStore.location` 이 실제 경로로 풀리는지 — 전부 미확인이며
 *     이 게이트의 사정권 밖이다. 존재 ≠ 등록 ≠ 실행 ≠ 성공(rules §2).
 *  2. **`stateStore.location` 의 실제 값.** `git rev-parse --git-common-dir` 이
 *     junction 기반 worktree(`scripts/split/worktree-setup.mjs`)에서 무엇을
 *     반환하는지는 **설계 자체가 미확인으로 표기**한 항목(조사 I5)이다. 여기서는
 *     문자열 `'git-common-dir'` 만 본다. git 을 호출하지 않는다.
 *  3. **`low` 버킷의 미래.** C 는 "지금 무시된다" 를 증명할 뿐이다.
 *     `loadModelPolicy` 가 `low` 를 읽도록 바뀌는 순간 이 테스트는 여전히 그린인
 *     채로 의미가 달라진다(버킷이 비어 있어서 통과). 버킷을 채우는 변경은 이
 *     게이트가 아니라 `tests/core/model-policy.test.js` 가 잡아야 한다.
 *  4. **`*Ref` 의 타입.** B 는 경로가 **존재**하는지만 본다. 가리키는 값이 수인지
 *     문자열인지, 소비자가 기대하는 타입인지는 소비자가 없으므로 검사하지 않는다.
 *  5. **다른 최상위 키.** 이 파일은 6키 + `low` 만 소유한다. 나머지 최상위 키
 *     (2026-09-03 기준 31 중 25)는 여전히 **무게이트**다 — "최상위가 지켜진다" 고
 *     읽지 마라.
 *
 * @module tests/firewall/v5-config-firewall
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadModelPolicy, resolveModel } from '../../lib/core/model-policy.js';
import { validateConfig } from '../../lib/core/config-schema.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_PATH = path.join(PLUGIN_ROOT, 'artibot.config.json');
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));

/**
 * 점 경로 해석기 — 순수 함수. 자기검증 테스트가 같은 함수를 쓴다.
 * 없는 경로는 `undefined` 를 돌려준다(throw 하지 않는다).
 *
 * @param {object} root - 대상 문서.
 * @param {string} dotted - 'a.b.c' 형태의 경로.
 * @returns {*} 값, 또는 경로가 끊기면 undefined.
 */
export function resolveDotPath(root, dotted) {
  if (typeof dotted !== 'string' || dotted === '') return undefined;
  let cur = root;
  for (const seg of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, seg)) {
      return undefined;
    }
    cur = cur[seg];
  }
  return cur;
}

/**
 * `*Ref` 로 끝나는 모든 문자열 키를 재귀 수집한다. 부정 목록이 아니라 접미사
 * 규약이므로, 새 참조가 생기면 자동으로 검사 대상에 들어온다(fail-closed 방향).
 *
 * @param {*} node - 훑을 서브트리.
 * @param {string} base - 지금까지의 경로(오류 메시지용).
 * @returns {Array<{ at: string, target: string }>}
 */
export function collectRefs(node, base = '') {
  const out = [];
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return out;
  for (const [key, value] of Object.entries(node)) {
    const at = base === '' ? key : `${base}.${key}`;
    if (typeof value === 'string' && key.endsWith('Ref')) out.push({ at, target: value });
    else if (value !== null && typeof value === 'object') out.push(...collectRefs(value, at));
  }
  return out;
}

/** 설계 정본이 정한 값. 바꾸려면 설계와 이 표를 함께 고쳐라. */
const EXPECTED = Object.freeze({
  // §3.5 — default 는 run-ledger topology.mode enum 6 중 하나. 'solo' = 현행
  // 기본(팀 트리거 미발화 시 inline)을 기록한 것이지 변경한 것이 아니다.
  topology: Object.freeze({ default: 'solo', reviewTierRef: 'agents.modelPolicy.phaseRoles.review' }),
  // §3.2 OD-2 stage 3 — 기록만. canary allowlist 는 비어 있어야 observe-only 다.
  routing: Object.freeze({ observe: true }),
  // §3.6 — 물리 정본 1개. path 는 <projectRoot> 상대(pluginRoot 에도 runtime/ 이 있다).
  ledger: Object.freeze({ path: '.artibot/runtime/ledger.jsonl', maxLineBytes: 4096 }),
  // §1-2 / OD-4 — F1 백엔드, F3 위치.
  stateStore: Object.freeze({ backend: 'jsonl', location: 'git-common-dir' }),
  // §3.1 — allowlist S1~S6, 부정 목록 금지.
  missions: Object.freeze({ idFormat: 'M-YYYYMMDD-NNN' }),
  // 오너 결정 2026-09-03 — review.independent 기본 필수(fail-closed) + C4.
  // C4 는 `deterministic` 만 필수이고, unmeasuredBlocksOutcome 은 코드가 이미
  // 출하 중인 값(artifact-lifecycle-gates.js#DEFAULT_POLICY)을 기록한 것이다.
  review: Object.freeze({ independent: true }),
});

/** 각 신설 키 아래 있어도 되는 키 — allowlist. `comment` 는 이 config 의 관례다. */
const ALLOWED_SUBKEYS = Object.freeze({
  topology: ['default', 'autopilot_fast', 'split', 'reviewTierRef', 'comment'],
  routing: ['observe', 'canary', 'comment'],
  ledger: ['path', 'maxLineBytes', 'comment'],
  stateStore: ['backend', 'location', 'comment'],
  missions: ['substantiveSignals', 'idFormat', 'comment'],
  review: ['independent', 'verify', 'comment'],
});

/** run-ledger 스키마의 topology.mode enum 6값(라우터 출력 어휘 정본). */
const TOPOLOGY_MODES = Object.freeze(['solo', 'subagent', 'team', 'autopilot', 'autopilot_fast', 'split']);

/**
 * 2026-09-03 실측. 신설 6키(topology·routing·ledger·stateStore·missions·review)를
 * 더한 뒤의 최상위 키 수 — 무단 추가/삭제 탐지용. 2026-09-02 의 30 에서 오너 결정
 * `review` 1건이 더해져 31 이다.
 */
const EXPECTED_TOP_LEVEL_COUNT = 31;

/** 정책 버킷이 결정하는 30 에이전트 전건 + 티어 기대값(현행 = 변화 0 기준선). */
const FABLE_AGENTS = Object.freeze([
  'orchestrator', 'architect', 'planner', 'code-reviewer',
  'spec-reviewer', 'quality-reviewer', 'llm-architect', 'repo-benchmarker',
  'investigator', 'auditor',
]);
const OPUS_AGENTS = Object.freeze([
  'security-reviewer', 'frontend-developer', 'backend-developer', 'tdd-guide',
  'database-reviewer', 'mcp-developer', 'typescript-pro', 'refactor-cleaner',
  'build-error-resolver', 'devops-engineer', 'performance-engineer', 'e2e-runner',
  'marketing-strategist', 'doc-updater', 'content-marketer', 'data-analyst',
  'presentation-designer', 'seo-specialist', 'cro-specialist', 'ad-specialist',
]);

describe('v5 신설 최상위 키 6종 — 형태와 값', () => {
  it.each(Object.keys(ALLOWED_SUBKEYS))('%s 키가 객체로 존재한다', (key) => {
    expect(config[key], `config.${key} 가 없다`).toBeDefined();
    expect(typeof config[key]).toBe('object');
    expect(Array.isArray(config[key])).toBe(false);
  });

  it.each(Object.entries(ALLOWED_SUBKEYS))('%s 에 알 수 없는 하위 키가 없다 (allowlist)', (key, allowed) => {
    const unknown = Object.keys(config[key]).filter((k) => !allowed.includes(k));
    expect(unknown).toEqual([]);
  });

  it.each(
    Object.entries(EXPECTED).flatMap(([top, pairs]) =>
      Object.entries(pairs).map(([sub, value]) => [`${top}.${sub}`, value]),
    ),
  )('%s === %j', (dotted, value) => {
    expect(resolveDotPath(config, dotted)).toEqual(value);
  });

  it('topology.default 는 run-ledger topology.mode enum 6 중 하나다', () => {
    expect(TOPOLOGY_MODES).toContain(config.topology.default);
  });

  it('routing.canary.actionClasses 는 빈 배열이다 (observe-only 의 정의)', () => {
    // 비어 있지 않으면 그 클래스의 추천이 실제로 적용된다 = 더 이상 기록만이 아니다.
    expect(config.routing.canary.actionClasses).toEqual([]);
  });

  it('missions.substantiveSignals 는 S1~S6 allowlist 다', () => {
    expect(config.missions.substantiveSignals).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
  });

  it('review.verify 는 C4 결정 그대로다 (deterministic 만 필수, 차단은 유지)', () => {
    // requiredLayers 는 allowlist 다 — 아무도 올리지 않은 레이어는 선택이고,
    // 새 레이어가 생겨도 조용히 필수가 되지 않는다(rules §8).
    expect(config.review.verify.requiredLayers).toEqual(['deterministic']);
    // 코드가 이미 출하 중인 값. 이 키는 그 값을 기록할 뿐 바꾸지 않는다 —
    // artifact-lifecycle-gates.js 는 이 config 를 읽지 않는다.
    expect(config.review.verify.unmeasuredBlocksOutcome).toBe(true);
  });

  it('ledger.path 는 <projectRoot> 상대이고 .artibot/ 로 시작한다', () => {
    // pluginRoot 에도 runtime/ 이 있어 앞의 '.artibot/' 이 load-bearing 이다(§3.6).
    expect(config.ledger.path.startsWith('.artibot/')).toBe(true);
    expect(path.isAbsolute(config.ledger.path)).toBe(false);
  });

  it('신설 키를 더한 config 가 JSON 스키마를 통과한다', () => {
    const { valid, errors } = validateConfig(config);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it('최상위 키 수가 실측 기준선과 같다 (무단 추가/삭제 탐지)', () => {
    expect(Object.keys(config).length).toBe(EXPECTED_TOP_LEVEL_COUNT);
  });
});

describe('*Ref 는 기존 키를 실제로 가리킨다 (중복 정의 금지 §3.5)', () => {
  it('해석기는 있는 경로를 찾고 없는 경로에 undefined 를 준다 (자기검증)', () => {
    const doc = { a: { b: { c: 1 } }, z: null };
    expect(resolveDotPath(doc, 'a.b.c')).toBe(1);
    expect(resolveDotPath(doc, 'a.b')).toEqual({ c: 1 });
    expect(resolveDotPath(doc, 'a.b.nope')).toBeUndefined();
    expect(resolveDotPath(doc, 'z.deep')).toBeUndefined();
    expect(resolveDotPath(doc, '')).toBeUndefined();
    expect(resolveDotPath(doc, 'toString')).toBeUndefined(); // 상속 prop 누출 금지
  });

  it('수집기는 *Ref 만, 중첩까지 모은다 (자기검증)', () => {
    const found = collectRefs({ aRef: 'x', keep: 1, deep: { bRef: 'y', arr: ['zRef'] } });
    expect(found).toEqual([{ at: 'aRef', target: 'x' }, { at: 'deep.bRef', target: 'y' }]);
  });

  it('topology 아래 *Ref 가 최소 8개다 (0개를 통과로 읽지 않기 위한 분모)', () => {
    // 분모를 단언하지 않으면, 참조를 전부 지운 config 가 "위반 0" 으로 통과한다.
    expect(collectRefs(config.topology, 'topology').length).toBeGreaterThanOrEqual(8);
  });

  it('모든 *Ref 가 이 config 안의 실재 경로를 가리킨다 (dangling 0)', () => {
    const dangling = collectRefs(config.topology, 'topology')
      .filter((r) => resolveDotPath(config, r.target) === undefined)
      .map((r) => `${r.at} -> ${r.target}`);
    expect(dangling).toEqual([]);
  });

  it('*Ref 는 값을 복사하지 않는다 — 형제 키로 값이 중복 정의되지 않았다', () => {
    // 'fooRef' 옆에 'foo' 가 생기면 그것이 곧 중복 정의(§3.5 가 금지한 것)다.
    const dupes = [];
    for (const { at } of collectRefs(config.topology, 'topology')) {
      const parentPath = at.split('.').slice(0, -1).join('.');
      const bare = at.split('.').pop().replace(/Ref$/, '');
      const parent = parentPath === '' ? config.topology : resolveDotPath(config, parentPath);
      if (parent && Object.prototype.hasOwnProperty.call(parent, bare)) dupes.push(at);
    }
    expect(dupes).toEqual([]);
  });
});

describe('agents.modelPolicy.low — 선언만, 실효 라우팅 변화 0', () => {
  it('low 버킷이 sonnet 이고 agents 는 비어 있다', () => {
    expect(config.agents.modelPolicy.low.model).toBe('sonnet');
    expect(config.agents.modelPolicy.low.agents).toEqual([]);
  });

  it('loadModelPolicy 가 low 를 무시한다 (unknown 버킷은 정규화 결과에 없다)', () => {
    const policy = loadModelPolicy(config);
    expect(Object.keys(policy).sort()).toEqual(['advisorStrategy', 'defaultModel', 'high', 'medium']);
    expect(policy).not.toHaveProperty('low');
  });

  it('low 를 지워도 30 에이전트 전건의 해석 결과가 같다 (실효 0 의 직접 증명)', () => {
    const withoutLow = structuredClone(config);
    delete withoutLow.agents.modelPolicy.low;
    const all = [...FABLE_AGENTS, ...OPUS_AGENTS];
    const withIt = all.map((a) => resolveModel(a, {}, config));
    const withoutIt = all.map((a) => resolveModel(a, {}, withoutLow));
    expect(withIt).toEqual(withoutIt);
  });

  it.each(FABLE_AGENTS)('%s 는 여전히 fable 이다', (agent) => {
    expect(resolveModel(agent, {}, config)).toBe('fable');
  });

  it.each(OPUS_AGENTS)('%s 는 여전히 opus 이다', (agent) => {
    expect(resolveModel(agent, {}, config)).toBe('opus');
  });

  it('sonnet 로 해석되는 에이전트는 0명이다 (버킷 선언이 로스터를 만들지 않는다)', () => {
    const all = [...FABLE_AGENTS, ...OPUS_AGENTS];
    expect(all.filter((a) => resolveModel(a, {}, config) === 'sonnet')).toEqual([]);
  });
});

describe('신설 키가 참조하는 기존 값은 이번 변경에서 건드리지 않았다', () => {
  it.each([
    ['autopilot.fast.hardMaxAgents', 16],
    ['autopilot.fast.agentsPerCpu', 2],
    ['autopilot.fast.maxWorktrees', 12],
    ['autopilot.fast.maxRisk', 'medium'],
    ['split.maxWindows', 4],
    ['split.minStems', 2],
    ['split.dispatch.budget', 600000],
    ['agents.modelPolicy.phaseRoles.review', 'fable'],
    ['agents.modelPolicy.phaseRoles.build', 'opus'],
    ['agents.modelPolicy.fable.enabled', true],
    ['agents.modelPolicy.high.model', 'fable'],
    ['agents.modelPolicy.medium.model', 'opus'],
  ])('%s === %j (무변경)', (dotted, value) => {
    expect(resolveDotPath(config, dotted)).toEqual(value);
  });

  it('fable allowlist 는 10종이다 (MP-3: investigator·auditor 2종 추가)', () => {
    expect(config.agents.modelPolicy.fable.allowlist).toEqual([...FABLE_AGENTS]);
  });
});
