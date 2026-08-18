/**
 * hooks/dispatch-table.json 의 핸들러 예산이 hooks/hooks.json 의 슬롯 예산 안에
 * 들어가는지 검사한다.
 *
 * ── 회귀 방지 전용 ────────────────────────────────────────────────────────────
 * 작성 시점(2026-08-18) 트리의 실측 위반은 **0건**이다. 그러니 이 파일은 처음부터
 * 끝까지 초록인 것이 정상이고, 초록이라는 사실 자체는 아무것도 새로 증명하지
 * 않는다. 이 게이트가 존재하는 이유는 하나다: 나중에 누가 핸들러를 추가하거나
 * timeoutMs 를 올려서 **디스패처(부모)가 자식보다 먼저 죽는** 조합을 만들면,
 * 그때 조용히 결과가 유실되는 대신 CI 가 빨개진다. 그 조합에서는 자식 훅이
 * 제 시간 안에 끝냈더라도 부모가 이미 죽어 있어 stdout 을 아무도 수거하지 않는다.
 *
 * ── sum 이 아니라 max 인 이유 ─────────────────────────────────────────────────
 * 디스패처는 핸들러를 `Promise.allSettled` 로 **동시에** 띄운다
 * (scripts/hooks/_sessionstart-dispatcher.js:61). 그래서 벽시계 소요는 합이
 * 아니라 최댓값에 수렴한다. sum 으로 재면 SessionStart 가 58,000ms > 30,000ms 로
 * 즉시 빨개지는데, 그건 실제 결함이 아니라 **거짓 빨강**이다. 거짓 빨강은
 * 게이트를 깎게 만들고, 깎인 게이트는 진짜 위반도 놓친다.
 *
 * ── 이 게이트가 못 보는 것 (rules §9) ────────────────────────────────────────
 *   - **여기 있는 값은 전부 선언된 예산이지 실측 소요가 아니다.** 어떤 핸들러가
 *     제 timeoutMs 를 실제로 넘기는지는 이 파일이 답할 수 없다. 답하려면 실행
 *     프로파일이 필요하다.
 *   - **HEADROOM_MS 는 실측치가 아니다** (아래 상수 주석 참조). 디스패처 자신의
 *     node 콜드스타트·테이블 로드·팬아웃·결과 병합에 드는 시간을 덮으라고 둔
 *     보수적 예산치일 뿐이다.
 *   - **Claude Code 가 hooks.json 의 `timeout` 을 실제로 어떻게 강제하는지는
 *     검증하지 않는다.** 여기서 하는 건 우리 두 JSON 사이의 정합성뿐이다.
 *   - **in-process-import 슬롯은 강제 대상이 아니다** (UserPromptSubmit).
 *     그 슬롯의 handlers[].timeoutMs 는 테이블 자신이 informational only 라고
 *     선언한 값이라, 강제하면 게이트가 강제되지 않는 값을 강제하는 척하게 된다.
 *   - max 는 **진짜 병렬**을 전제한다. 어떤 디스패처가 나중에 직렬 실행으로
 *     바뀌면 max 는 소요를 과소평가하고 이 게이트는 그 회귀를 못 본다.
 *
 * 원본 JSON 두 개는 이 스위트가 **읽기만** 한다. 변이 자기검증도 인메모리
 * 사본에서만 한다(아래에서 원본 바이트 불변을 단언한다).
 *
 * @module tests/firewall/hook-timeout-budget
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { getTablePath, listSlots } from '../../lib/dispatcher/dispatch-table-loader.js';

/**
 * 슬롯 예산에서 핸들러 몫을 뺀 나머지 — 디스패처 자신이 쓰는 시간의 상한.
 *
 * **실측치가 아니다. 보수적 예산치다.** node 콜드스타트 + dispatch-table 로드 +
 * 자식 스폰 + stdout 병합이 여기 들어간다고 보고 잡은 값이며, 프로파일로 뒷받침된
 * 숫자가 아니다. 실측이 생기면 그 수치로 교체하고 근거를 여기 적어라.
 */
const HEADROOM_MS = 3000;

/**
 * 강제하지 않는 전략. 테이블이 스스로 "informational only" 라고 선언한 슬롯이다.
 * 문자열이 아니라 전략으로 거르는 이유: 슬롯 **이름** 목록으로 예외를 두면 새
 * 슬롯이 이름만 바꿔 달고 예외로 새어나갈 수 있다.
 */
const UNENFORCED_STRATEGY = 'in-process-import';

/** 디스패처가 없는 단일 훅 슬롯. 예산 부등식 대신 등호 대조를 받는다. */
const SINGLE_HOOK_STRATEGY = 'single-hook';

/**
 * 파싱 결과가 비면 이 파일의 모든 루프가 0회 돌고 전부 초록이 된다. 경로가 썩거나
 * 스키마가 바뀌었을 때 게이트가 조용히 사라지는 대신 빨개지도록 바닥을 못박는다.
 *
 * **세 상수는 모집단이 서로 다르다. 섞어 쓰면 바닥이 헐거워진다.**
 *   - MIN_SLOTS / MIN_ENFORCED_SLOTS → dispatch-table.json 의 slots (실측 7 / 5)
 *   - MIN_HOOKS_JSON_SLOTS           → hooks.json 의 최상위 이벤트 키 (실측 15)
 * 이전 판본은 hooks.json 의 15개를 dispatch-table 용 바닥 6과 비교했다. 통과는
 * 했지만 9개나 여유가 있어서 hooks.json 슬롯이 절반 사라져도 초록이었다.
 *
 * 값은 전부 **실측치와 같게** 둔다(> 가 아니라 =). 슬롯을 정당하게 줄이는 편집은
 * 이 상수도 함께 고치도록 강제하는 쪽이 fail-closed 다 — 여유를 두면 축소가
 * 조용히 통과한다. 실측 2026-08-19.
 */
const MIN_SLOTS = 7;
const MIN_ENFORCED_SLOTS = 5;
const MIN_HOOKS_JSON_SLOTS = 15;

/** 경로 썩음 방지 — 로더가 아는 정본 경로를 그대로 쓴다. */
const TABLE_PATH = getTablePath();
const HOOKS_JSON_PATH = join(dirname(TABLE_PATH), 'hooks.json');

const RAW_TABLE = readFileSync(TABLE_PATH, 'utf-8');
const RAW_HOOKS = readFileSync(HOOKS_JSON_PATH, 'utf-8');
const TABLE = JSON.parse(RAW_TABLE);
const HOOKS = JSON.parse(RAW_HOOKS);

/**
 * 슬롯을 전략별로 셋으로 가른다. 셋의 합이 전체와 같은지는 아래에서 단언한다 —
 * 새 전략이 생겼을 때 그 슬롯이 어느 쪽에도 안 들어간 채 조용히 빠지면 안 된다.
 * @param {object} table
 */
function partitionSlots(table) {
  const enforced = [];
  const unenforced = [];
  const singleHook = [];
  for (const [name, slot] of Object.entries(table?.slots ?? {})) {
    if (slot?.strategy === UNENFORCED_STRATEGY) unenforced.push(name);
    else if (slot?.strategy === SINGLE_HOOK_STRATEGY) singleHook.push(name);
    else enforced.push(name);
  }
  return { enforced, unenforced, singleHook };
}

/**
 * hooks.json 에서 이 디스패처를 실제로 등록한 훅 항목을 찾는다.
 *
 * 슬롯 이름만으로 첫 항목을 집지 않는 이유: 한 슬롯에 matcher 그룹이 여럿 달릴 수
 * 있고(PreToolUse 가 실제로 그렇다), 그때 "첫 번째" 는 디스패처가 아닐 수 있다.
 * 커맨드 문자열에 디스패처 경로가 들어있는 항목이 **정확히 하나** 여야 한다.
 *
 * 못 찾은 경우를 스킵이 아니라 **위반**으로 돌려준다. 스킵이면 디스패처 파일명을
 * 바꾸는 것만으로 그 슬롯이 게이트에서 조용히 빠진다.
 *
 * @param {object} hooks
 * @param {string} slotName
 * @param {string|undefined} dispatcher
 * @returns {{ timeout: number } | { error: string }}
 */
function findSlotTimeout(hooks, slotName, dispatcher) {
  const groups = hooks?.hooks?.[slotName];
  if (!Array.isArray(groups) || groups.length === 0) {
    return { error: `hooks.json 에 "${slotName}" 등록이 없다` };
  }
  if (typeof dispatcher !== 'string' || dispatcher.length === 0) {
    return { error: `dispatch-table 의 "${slotName}" 에 dispatcher 경로가 없다` };
  }

  const matched = [];
  for (const group of groups) {
    for (const hook of group?.hooks ?? []) {
      if (typeof hook?.command === 'string' && hook.command.includes(dispatcher)) {
        matched.push(hook);
      }
    }
  }
  if (matched.length !== 1) {
    return {
      error: `hooks.json 의 "${slotName}" 에서 "${dispatcher}" 를 등록한 항목이 ${matched.length}건 (1건이어야 한다)`,
    };
  }
  if (typeof matched[0].timeout !== 'number') {
    return { error: `hooks.json 의 "${slotName}" 디스패처 항목에 숫자 timeout 이 없다` };
  }
  return { timeout: matched[0].timeout };
}

/**
 * single-hook 슬롯의 hooks.json 대조. 테이블이 자기 note 에서 요구하는
 * "양쪽을 같은 PR 에서 함께 고쳐라" 를 기계화한 것이다(수기 tripwire → 게이트).
 * @param {object} table
 * @param {object} hooks
 * @param {string} slotName
 * @returns {string[]} 위반 문구
 */
function singleHookDrift(table, hooks, slotName) {
  const slot = table.slots[slotName];
  const groups = hooks?.hooks?.[slotName];
  if (!Array.isArray(groups) || groups.length !== 1) {
    return [`${slotName}: hooks.json 에 matcher 그룹이 ${groups?.length ?? 0}개 (1개여야 한다)`];
  }
  const entries = groups[0]?.hooks ?? [];
  if (entries.length !== 1) {
    return [`${slotName}: hooks.json 훅 항목이 ${entries.length}개 (1개여야 한다)`];
  }

  const out = [];
  if (entries[0].timeout !== slot.singleHookTimeoutMs) {
    out.push(
      `${slotName}: singleHookTimeoutMs=${slot.singleHookTimeoutMs} != hooks.json timeout=${entries[0].timeout}`,
    );
  }
  if (entries[0].command !== slot.singleHookCommand) {
    out.push(
      `${slotName}: singleHookCommand="${slot.singleHookCommand}" != hooks.json command="${entries[0].command}"`,
    );
  }
  return out;
}

/**
 * 두 파일을 대조해 위반 문구를 모은다. **순수 함수** — 디스크를 읽지 않으므로
 * 변이 자기검증이 인메모리 사본을 그대로 먹일 수 있다. 실검사와 자기검증이 같은
 * 코드를 타야 자기검증이 의미가 있다.
 * @param {object} table
 * @param {object} hooks
 * @returns {string[]}
 */
function collectViolations(table, hooks) {
  const violations = [];
  const { enforced, singleHook } = partitionSlots(table);

  for (const name of enforced) {
    const slot = table.slots[name];
    const found = findSlotTimeout(hooks, name, slot.dispatcher);
    if ('error' in found) {
      violations.push(`${name}: ${found.error}`);
      continue;
    }
    const handlers = Array.isArray(slot.handlers) ? slot.handlers : [];
    if (handlers.length === 0) {
      violations.push(`${name}: parallel-spawn 슬롯인데 handlers 가 비었다`);
      continue;
    }
    const worst = handlers.reduce((a, b) => ((b?.timeoutMs ?? 0) > (a?.timeoutMs ?? 0) ? b : a));
    const needed = (worst?.timeoutMs ?? 0) + HEADROOM_MS;
    if (needed > found.timeout) {
      violations.push(
        `${name}: 최대 핸들러 ${worst.name}=${worst.timeoutMs}ms + 헤드룸 ${HEADROOM_MS}ms `
        + `= ${needed}ms > 슬롯 예산 ${found.timeout}ms`,
      );
    }
  }

  for (const name of singleHook) violations.push(...singleHookDrift(table, hooks, name));

  return violations;
}

/**
 * 위반이 하나라도 있으면 throw 한다. 변이 사본이 반드시 throw 하는지를 아래에서
 * 이 함수로 확인한다.
 * @param {object} table
 * @param {object} hooks
 */
function assertNoViolations(table, hooks) {
  const violations = collectViolations(table, hooks);
  if (violations.length > 0) {
    throw new Error(`hook timeout budget violated:\n  ${violations.join('\n  ')}`);
  }
}

const PARTITION = partitionSlots(TABLE);

describe('훅 타임아웃 예산 정합 (dispatch-table ↔ hooks.json)', () => {
  it('현재 트리에 위반이 없다 (회귀 방지 전용 — 초록이 정상)', () => {
    expect(collectViolations(TABLE, HOOKS)).toEqual([]);
    expect(() => assertNoViolations(TABLE, HOOKS)).not.toThrow();
  });

  for (const name of PARTITION.enforced) {
    const slot = TABLE.slots[name];
    it(`${name}: max(handler) + ${HEADROOM_MS}ms 헤드룸이 슬롯 예산 안에 들어간다`, () => {
      const found = findSlotTimeout(HOOKS, name, slot.dispatcher);
      expect(found, `hooks.json 에서 ${slot.dispatcher} 를 찾지 못했다`).not.toHaveProperty('error');

      const handlers = slot.handlers ?? [];
      expect(handlers.length).toBeGreaterThan(0);
      const worst = handlers.reduce((a, b) => (b.timeoutMs > a.timeoutMs ? b : a));

      expect(
        worst.timeoutMs + HEADROOM_MS,
        `${name} 의 최대 핸들러는 ${worst.name}(${worst.timeoutMs}ms)`,
      ).toBeLessThanOrEqual(found.timeout);
    });
  }

  it('PreCompact(single-hook): singleHookTimeoutMs·singleHookCommand 가 hooks.json 과 등호로 일치한다', () => {
    // 테이블 note 가 "양쪽을 같은 PR 에서 고쳐라" 라고 수기로 부탁하던 것을 기계로
    // 옮긴 것이다. 디스패처가 없는 슬롯이라 부등식 예산이 성립하지 않으므로 등호다.
    expect(PARTITION.singleHook).toContain('PreCompact');

    const slot = TABLE.slots.PreCompact;
    const entry = HOOKS.hooks.PreCompact[0].hooks[0];
    expect(entry.timeout).toBe(slot.singleHookTimeoutMs);
    expect(entry.command).toBe(slot.singleHookCommand);
    expect(singleHookDrift(TABLE, HOOKS, 'PreCompact')).toEqual([]);
  });

  it(
    'in-process-import 슬롯은 예산 강제 대상이 아니다 '
    + '— 그 handlers[].timeoutMs 는 테이블이 informational only 라고 선언한 값이고, '
    + '강제되지 않는 값을 게이트에 넣으면 게이트가 거짓말을 한다',
    () => {
      expect(PARTITION.unenforced).toContain('UserPromptSubmit');
      // 사유를 데이터에 붙들어 맨다. 누가 다른 슬롯을 이 전략으로 옮겨 예외로
      // 빼내려 하면, 그 슬롯도 "informational only" 를 스스로 선언해야 한다.
      for (const name of PARTITION.unenforced) {
        expect(TABLE.slots[name].note ?? '').toContain('informational only');
      }
    },
  );
});

/**
 * 이 게이트 자신의 자기검증.
 *
 * rules §10: 게이트를 만들면 그 게이트가 거짓 그린이 되지 않는지도 함께 넣어라.
 * 위 describe 는 파싱 결과를 루프로 돌기 때문에, 파싱이 비면 단언 0건으로 전부
 * 통과한다 — 통과와 소멸이 요약 출력에서 구분되지 않는다.
 */
describe('게이트 자기검증', () => {
  it('슬롯을 실제로 파싱했다 (0개면 이 게이트 전체가 거짓 그린이다)', () => {
    const names = Object.keys(TABLE.slots ?? {});
    expect(names.length).toBeGreaterThanOrEqual(MIN_SLOTS);
    expect(PARTITION.enforced.length).toBeGreaterThanOrEqual(MIN_ENFORCED_SLOTS);
    // hooks.json 은 dispatch-table 보다 넓다 (PreToolUse·Notification 처럼 디스패처가
    // 없는 이벤트까지 등록한다). 그래서 자기 모집단의 바닥으로 잰다.
    expect(Object.keys(HOOKS.hooks ?? {}).length).toBeGreaterThanOrEqual(MIN_HOOKS_JSON_SLOTS);

    // 내가 읽은 파일이 프로덕션 로더가 읽는 그 파일인지. 경로가 갈리면 이 게이트는
    // 아무도 안 쓰는 사본을 검사하며 초록이 된다.
    expect(names).toEqual(listSlots());

    // 전략 셋으로 전수 분할된다 — 새 전략이 생겨도 어느 쪽에도 안 들어간 채
    // 조용히 빠지지 않는다.
    expect(
      PARTITION.enforced.length + PARTITION.unenforced.length + PARTITION.singleHook.length,
    ).toBe(names.length);
  });

  it('예산을 초과한 인메모리 변이 사본에서는 반드시 throw 한다', () => {
    const mutated = structuredClone(TABLE);
    const slot = mutated.slots[PARTITION.enforced[0]];
    const budget = findSlotTimeout(HOOKS, PARTITION.enforced[0], slot.dispatcher);
    slot.handlers[0].timeoutMs = budget.timeout + 1;

    expect(() => assertNoViolations(mutated, HOOKS)).toThrow(/hook timeout budget violated/);
  });

  it('single-hook 등호가 어긋난 변이 사본에서도 throw 한다', () => {
    const mutated = structuredClone(TABLE);
    mutated.slots.PreCompact.singleHookTimeoutMs += 1;
    expect(() => assertNoViolations(mutated, HOOKS)).toThrow(/singleHookTimeoutMs/);
  });

  it('디스패처 경로가 hooks.json 과 어긋나면 스킵이 아니라 throw 다 (fail-closed)', () => {
    // 이름만 바꿔서 슬롯 하나를 게이트 밖으로 빼낼 수 없어야 한다.
    const mutated = structuredClone(TABLE);
    mutated.slots[PARTITION.enforced[0]].dispatcher = 'scripts/hooks/_does-not-exist.js';
    expect(() => assertNoViolations(mutated, HOOKS)).toThrow(/등록한 항목이 0건/);
  });

  it('원본 JSON 두 개를 수정하지 않는다', () => {
    // 변이는 전부 structuredClone 사본에서만 일어나야 한다. 디스크의 원본이 바뀌면
    // 이 스위트가 프로덕션 설정을 망가뜨린 것이다.
    expect(readFileSync(TABLE_PATH, 'utf-8')).toBe(RAW_TABLE);
    expect(readFileSync(HOOKS_JSON_PATH, 'utf-8')).toBe(RAW_HOOKS);
  });
});
