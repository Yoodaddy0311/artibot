import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetCounter,
  addBoundary,
  addCriterion,
  addTestable,
  agreeContract,
  createSprintContract,
  evaluateContract,
  startContract,
  VALID_TRANSITIONS,
} from '../../lib/runtime/sprint-contract.js';
import { getLastEvent, reset as resetEventBus } from '../../lib/core/event-bus.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idSeq = 0;
const testIdGen = () => `test-${++idSeq}`;
const fixedNow = () => '2026-03-27T00:00:00.000Z';

function makeContract(desc = 'Implement feature X', opts = {}) {
  return createSprintContract(desc, {
    idGenerator: testIdGen,
    now: fixedNow,
    ...opts,
  });
}

function makeAgreedContract() {
  let c = makeContract();
  c = addCriterion(c, { description: 'Tests pass' }, { idGenerator: testIdGen });
  return agreeContract(c, { now: fixedNow });
}

function makeInProgressContract() {
  const c = makeAgreedContract();
  return startContract(c, { now: fixedNow });
}

beforeEach(() => {
  idSeq = 0;
  _resetCounter();
});

afterEach(() => {
  resetEventBus();
});

// ---------------------------------------------------------------------------
// createSprintContract
// ---------------------------------------------------------------------------

describe('sprint-contract/createSprintContract', () => {
  it('기본 필드가 올바르게 생성됨', () => {
    const c = makeContract('Build auth module');
    expect(c.taskId).toBe('test-1');
    expect(c.description).toBe('Build auth module');
    expect(c.status).toBe('draft');
    expect(c.createdAt).toBe('2026-03-27T00:00:00.000Z');
    expect(c.criteria).toEqual([]);
    expect(c.testable).toEqual([]);
    expect(c.boundaries).toEqual([]);
  });

  it('반환 객체는 frozen (불변)', () => {
    const c = makeContract();
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.criteria)).toBe(true);
  });

  it('빈 설명도 허용', () => {
    const c = makeContract('');
    expect(c.description).toBe('');
  });

  it('null/undefined 설명은 빈 문자열로', () => {
    const c = createSprintContract(null, { idGenerator: testIdGen, now: fixedNow });
    expect(c.description).toBe('');
  });

  it('event-bus에 created 이벤트 발행', () => {
    makeContract();
    const event = getLastEvent('feature:sprint-contract');
    expect(event.action).toBe('created');
  });
});

// ---------------------------------------------------------------------------
// addCriterion
// ---------------------------------------------------------------------------

describe('sprint-contract/addCriterion', () => {
  it('criterion 추가 시 새 객체 반환 (불변성)', () => {
    const c1 = makeContract();
    const c2 = addCriterion(c1, { description: 'All tests pass' }, { idGenerator: testIdGen });
    expect(c2).not.toBe(c1);
    expect(c2.criteria.length).toBe(1);
    expect(c1.criteria.length).toBe(0);
  });

  it('criterion에 기본 type과 weight 설정', () => {
    const c = makeContract();
    const c2 = addCriterion(c, { description: 'Coverage > 80%' }, { idGenerator: testIdGen });
    expect(c2.criteria[0].type).toBe('functional');
    expect(c2.criteria[0].weight).toBe(1);
  });

  it('커스텀 type과 weight 지원', () => {
    const c = makeContract();
    const c2 = addCriterion(c, {
      description: 'No XSS',
      type: 'security',
      weight: 2,
    }, { idGenerator: testIdGen });
    expect(c2.criteria[0].type).toBe('security');
    expect(c2.criteria[0].weight).toBe(2);
  });

  it('여러 criterion 누적 추가', () => {
    let c = makeContract();
    c = addCriterion(c, { description: 'A' }, { idGenerator: testIdGen });
    c = addCriterion(c, { description: 'B' }, { idGenerator: testIdGen });
    c = addCriterion(c, { description: 'C' }, { idGenerator: testIdGen });
    expect(c.criteria.length).toBe(3);
  });

  it('description 없으면 에러', () => {
    const c = makeContract();
    expect(() => addCriterion(c, {})).toThrow('description');
    expect(() => addCriterion(c, null)).toThrow();
  });

  it('반환 객체도 frozen', () => {
    const c = makeContract();
    const c2 = addCriterion(c, { description: 'Test' }, { idGenerator: testIdGen });
    expect(Object.isFrozen(c2)).toBe(true);
    expect(Object.isFrozen(c2.criteria[0])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// addTestable
// ---------------------------------------------------------------------------

describe('sprint-contract/addTestable', () => {
  it('testable 행동 추가 (불변)', () => {
    const c1 = makeContract();
    const c2 = addTestable(c1, 'Login redirects to dashboard');
    expect(c2.testable.length).toBe(1);
    expect(c1.testable.length).toBe(0);
  });

  it('빈 문자열이면 에러', () => {
    const c = makeContract();
    expect(() => addTestable(c, '')).toThrow('non-empty string');
  });

  it('문자열이 아니면 에러', () => {
    const c = makeContract();
    expect(() => addTestable(c, 123)).toThrow('non-empty string');
  });
});

// ---------------------------------------------------------------------------
// addBoundary
// ---------------------------------------------------------------------------

describe('sprint-contract/addBoundary', () => {
  it('boundary 추가 (불변)', () => {
    const c1 = makeContract();
    const c2 = addBoundary(c1, 'Do not modify auth module');
    expect(c2.boundaries.length).toBe(1);
    expect(c1.boundaries.length).toBe(0);
  });

  it('빈 문자열이면 에러', () => {
    const c = makeContract();
    expect(() => addBoundary(c, '')).toThrow('non-empty string');
  });
});

// ---------------------------------------------------------------------------
// agreeContract
// ---------------------------------------------------------------------------

describe('sprint-contract/agreeContract', () => {
  it('draft → agreed 전환', () => {
    let c = makeContract();
    c = addCriterion(c, { description: 'Tests pass' }, { idGenerator: testIdGen });
    const agreed = agreeContract(c, { now: fixedNow });
    expect(agreed.status).toBe('agreed');
    expect(agreed.agreedAt).toBe('2026-03-27T00:00:00.000Z');
  });

  it('criteria가 없으면 에러', () => {
    const c = makeContract();
    expect(() => agreeContract(c)).toThrow('no criteria');
  });

  it('agreed에서 agreed는 불가', () => {
    const agreed = makeAgreedContract();
    expect(() => agreeContract(agreed)).toThrow('Invalid transition');
  });

  it('event-bus에 agreed 이벤트 발행', () => {
    let c = makeContract();
    c = addCriterion(c, { description: 'Done' }, { idGenerator: testIdGen });
    agreeContract(c, { now: fixedNow });
    const event = getLastEvent('feature:sprint-contract');
    expect(event.action).toBe('agreed');
  });

  it('반환 객체는 frozen', () => {
    const agreed = makeAgreedContract();
    expect(Object.isFrozen(agreed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// startContract
// ---------------------------------------------------------------------------

describe('sprint-contract/startContract', () => {
  it('agreed → in_progress 전환', () => {
    const agreed = makeAgreedContract();
    const started = startContract(agreed, { now: fixedNow });
    expect(started.status).toBe('in_progress');
    expect(started.startedAt).toBe('2026-03-27T00:00:00.000Z');
  });

  it('draft에서 시작 불가', () => {
    const c = makeContract();
    expect(() => startContract(c)).toThrow('Invalid transition');
  });

  it('event-bus에 started 이벤트 발행', () => {
    const agreed = makeAgreedContract();
    startContract(agreed, { now: fixedNow });
    const event = getLastEvent('feature:sprint-contract');
    expect(event.action).toBe('started');
  });
});

// ---------------------------------------------------------------------------
// evaluateContract
// ---------------------------------------------------------------------------

describe('sprint-contract/evaluateContract', () => {
  it('in_progress → evaluated 전환', () => {
    const inProgress = makeInProgressContract();
    const results = [{ criterionId: 'test-2', passed: true, evidence: 'all green' }];
    const evaluated = evaluateContract(inProgress, results, { now: fixedNow });
    expect(evaluated.status).toBe('evaluated');
    expect(evaluated.passRate).toBe(1);
    expect(evaluated.passCount).toBe(1);
    expect(evaluated.failCount).toBe(0);
  });

  it('부분 통과 시 passRate 계산', () => {
    const inProgress = makeInProgressContract();
    const results = [
      { criterionId: '1', passed: true },
      { criterionId: '2', passed: false },
      { criterionId: '3', passed: true },
    ];
    const evaluated = evaluateContract(inProgress, results, { now: fixedNow });
    expect(evaluated.passRate).toBeCloseTo(2 / 3);
    expect(evaluated.passCount).toBe(2);
    expect(evaluated.failCount).toBe(1);
  });

  it('전체 실패 시 passRate=0', () => {
    const inProgress = makeInProgressContract();
    const results = [{ criterionId: '1', passed: false }];
    const evaluated = evaluateContract(inProgress, results, { now: fixedNow });
    expect(evaluated.passRate).toBe(0);
  });

  it('빈 results면 에러', () => {
    const inProgress = makeInProgressContract();
    expect(() => evaluateContract(inProgress, [])).toThrow('non-empty array');
    expect(() => evaluateContract(inProgress, null)).toThrow('non-empty array');
  });

  it('draft에서 평가 불가', () => {
    const c = makeContract();
    expect(() => evaluateContract(c, [{ criterionId: '1', passed: true }])).toThrow('Invalid transition');
  });

  it('event-bus에 evaluated 이벤트 발행', () => {
    const inProgress = makeInProgressContract();
    evaluateContract(inProgress, [{ criterionId: '1', passed: true }], { now: fixedNow });
    const event = getLastEvent('feature:sprint-contract');
    expect(event.action).toBe('evaluated');
    expect(event.passRate).toBe(1);
  });

  it('results 객체도 frozen', () => {
    const inProgress = makeInProgressContract();
    const evaluated = evaluateContract(
      inProgress,
      [{ criterionId: '1', passed: true }],
      { now: fixedNow },
    );
    expect(Object.isFrozen(evaluated)).toBe(true);
    expect(Object.isFrozen(evaluated.results[0])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VALID_TRANSITIONS
// ---------------------------------------------------------------------------

describe('sprint-contract/VALID_TRANSITIONS', () => {
  it('draft → agreed만 허용', () => {
    expect(VALID_TRANSITIONS.draft).toEqual(['agreed']);
  });

  it('agreed → in_progress만 허용', () => {
    expect(VALID_TRANSITIONS.agreed).toEqual(['in_progress']);
  });

  it('in_progress → evaluated만 허용', () => {
    expect(VALID_TRANSITIONS.in_progress).toEqual(['evaluated']);
  });

  it('evaluated는 종료 상태', () => {
    expect(VALID_TRANSITIONS.evaluated).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle
// ---------------------------------------------------------------------------

describe('sprint-contract/lifecycle', () => {
  it('전체 라이프사이클: draft → agreed → in_progress → evaluated', () => {
    let c = makeContract('Build login');
    expect(c.status).toBe('draft');

    c = addCriterion(c, { description: 'Unit tests pass' }, { idGenerator: testIdGen });
    c = addCriterion(c, { description: 'No XSS vulns' }, { idGenerator: testIdGen });
    c = addTestable(c, 'Login form submits correctly');
    c = addBoundary(c, 'Do not modify user model');

    c = agreeContract(c, { now: fixedNow });
    expect(c.status).toBe('agreed');

    c = startContract(c, { now: fixedNow });
    expect(c.status).toBe('in_progress');

    c = evaluateContract(c, [
      { criterionId: 'test-2', passed: true, evidence: 'vitest green' },
      { criterionId: 'test-3', passed: true, evidence: 'no XSS found' },
    ], { now: fixedNow });

    expect(c.status).toBe('evaluated');
    expect(c.passRate).toBe(1);
    expect(c.criteria.length).toBe(2);
    expect(c.testable.length).toBe(1);
    expect(c.boundaries.length).toBe(1);
  });
});
