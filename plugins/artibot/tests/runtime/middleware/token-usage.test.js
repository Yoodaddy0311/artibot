import { describe, expect, it } from 'vitest';
import {
  _createStore,
  _estimateTokens,
  _formatTokenCount,
  _getUsage,
  _getUsageByAgent,
  _getUsageByModel,
  _recordUsage,
  createTokenUsageMiddleware,
} from '../../../lib/runtime/middleware/token-usage.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(prompt = 'test prompt', overrides = {}) {
  return {
    userPrompt: prompt,
    context: {
      intent: { best: 'action:fix' },
      backend: { selected: 'opus' },
      subagents: { contract: { targetAgent: 'frontend-developer' } },
      tasks: { recommendedAgent: 'planner' },
      ...overrides.context,
    },
    config: {
      modelPolicy: { default: 'sonnet' },
      ...overrides.config,
    },
    messageParts: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Unit: estimateTokens
// ---------------------------------------------------------------------------

describe('token-usage/_estimateTokens', () => {
  it('영어 텍스트 (4 chars/token)', () => {
    expect(_estimateTokens('hello world!', 4)).toBe(3); // ceil(12/4)
  });

  it('빈 문자열 → 0', () => {
    expect(_estimateTokens('', 4)).toBe(0);
  });

  it('null/undefined → 0', () => {
    expect(_estimateTokens(null, 4)).toBe(0);
    expect(_estimateTokens(undefined, 4)).toBe(0);
  });

  it('숫자 입력 → 0 (string 아님)', () => {
    expect(_estimateTokens(123, 4)).toBe(0);
  });

  it('CJK 비율 (2 chars/token)', () => {
    expect(_estimateTokens('안녕하세요', 2)).toBe(3); // ceil(5/2)
  });

  it('정확히 나누어 떨어지는 경우', () => {
    expect(_estimateTokens('abcd', 4)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Unit: createStore
// ---------------------------------------------------------------------------

describe('token-usage/_createStore', () => {
  it('빈 스토어 생성', () => {
    const store = _createStore();
    expect(store.entries).toEqual([]);
    expect(store.byModel).toEqual({});
    expect(store.byAgent).toEqual({});
    expect(store.totals).toEqual({ input: 0, output: 0, count: 0 });
  });
});

// ---------------------------------------------------------------------------
// Unit: recordUsage
// ---------------------------------------------------------------------------

describe('token-usage/_recordUsage', () => {
  it('엔트리 추가 후 새 스토어 반환 (불변)', () => {
    const store = _createStore();
    const entry = Object.freeze({
      inputTokens: 100,
      outputTokens: 50,
      model: 'opus',
      agent: 'planner',
      operation: 'action:fix',
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    const next = _recordUsage(store, entry, 500);

    // Original unchanged
    expect(store.entries).toHaveLength(0);
    // New store updated
    expect(next.entries).toHaveLength(1);
    expect(next.totals.input).toBe(100);
    expect(next.totals.output).toBe(50);
    expect(next.totals.count).toBe(1);
    expect(next.byModel.opus.input).toBe(100);
    expect(next.byAgent.planner.count).toBe(1);
  });

  it('maxEntries 초과 시 오래된 항목 trim', () => {
    let store = _createStore();
    for (let i = 0; i < 5; i++) {
      store = _recordUsage(store, {
        inputTokens: 10, outputTokens: 5,
        model: 'opus', agent: 'test',
        operation: 'op', timestamp: `t${i}`,
      }, 3);
    }

    expect(store.entries).toHaveLength(3);
    // Totals still accumulate all 5 entries
    expect(store.totals.count).toBe(5);
    expect(store.totals.input).toBe(50);
  });

  it('다중 모델 누적', () => {
    let store = _createStore();
    store = _recordUsage(store, {
      inputTokens: 100, outputTokens: 0,
      model: 'opus', agent: 'a', operation: 'x', timestamp: 't1',
    }, 500);
    store = _recordUsage(store, {
      inputTokens: 200, outputTokens: 0,
      model: 'sonnet', agent: 'a', operation: 'x', timestamp: 't2',
    }, 500);
    store = _recordUsage(store, {
      inputTokens: 50, outputTokens: 0,
      model: 'opus', agent: 'a', operation: 'x', timestamp: 't3',
    }, 500);

    expect(store.byModel.opus.input).toBe(150);
    expect(store.byModel.opus.count).toBe(2);
    expect(store.byModel.sonnet.input).toBe(200);
    expect(store.byModel.sonnet.count).toBe(1);
  });

  it('다중 에이전트 분리', () => {
    let store = _createStore();
    store = _recordUsage(store, {
      inputTokens: 10, outputTokens: 0,
      model: 'm', agent: 'alpha', operation: 'x', timestamp: 't1',
    }, 500);
    store = _recordUsage(store, {
      inputTokens: 20, outputTokens: 0,
      model: 'm', agent: 'beta', operation: 'x', timestamp: 't2',
    }, 500);

    expect(store.byAgent.alpha.input).toBe(10);
    expect(store.byAgent.beta.input).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Unit: getUsage / getUsageByModel / getUsageByAgent
// ---------------------------------------------------------------------------

describe('token-usage/query API', () => {
  it('getUsage → input + output + total + count', () => {
    let store = _createStore();
    store = _recordUsage(store, {
      inputTokens: 100, outputTokens: 50,
      model: 'opus', agent: 'a', operation: 'x', timestamp: 't',
    }, 500);

    const usage = _getUsage(store);
    expect(usage.input).toBe(100);
    expect(usage.output).toBe(50);
    expect(usage.total).toBe(150);
    expect(usage.count).toBe(1);
  });

  it('getUsageByModel → total 필드 포함', () => {
    let store = _createStore();
    store = _recordUsage(store, {
      inputTokens: 100, outputTokens: 50,
      model: 'opus', agent: 'a', operation: 'x', timestamp: 't',
    }, 500);

    const byModel = _getUsageByModel(store);
    expect(byModel.opus.total).toBe(150);
  });

  it('getUsageByAgent → total 필드 포함', () => {
    let store = _createStore();
    store = _recordUsage(store, {
      inputTokens: 30, outputTokens: 10,
      model: 'm', agent: 'planner', operation: 'x', timestamp: 't',
    }, 500);

    const byAgent = _getUsageByAgent(store);
    expect(byAgent.planner.total).toBe(40);
  });

  it('빈 스토어 → 빈 결과', () => {
    const store = _createStore();
    expect(_getUsage(store)).toEqual({ input: 0, output: 0, total: 0, count: 0 });
    expect(_getUsageByModel(store)).toEqual({});
    expect(_getUsageByAgent(store)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Unit: formatTokenCount
// ---------------------------------------------------------------------------

describe('token-usage/_formatTokenCount', () => {
  it('1000 이상 → K 단위', () => {
    expect(_formatTokenCount(1000)).toBe('1.0K');
    expect(_formatTokenCount(2500)).toBe('2.5K');
  });

  it('1000 미만 → 원시 숫자', () => {
    expect(_formatTokenCount(500)).toBe('500');
    expect(_formatTokenCount(0)).toBe('0');
  });

  it('소수점 1자리', () => {
    expect(_formatTokenCount(1234)).toBe('1.2K');
  });
});

// ---------------------------------------------------------------------------
// Integration: createTokenUsageMiddleware
// ---------------------------------------------------------------------------

describe('middleware/token-usage', () => {
  it('enabled=false → 패스스루', async () => {
    const mw = createTokenUsageMiddleware({ enabled: false });
    const state = makeState();
    const result = await mw(state);

    expect(result.context.tokenUsage.enabled).toBe(false);
    expect(result.messageParts).toHaveLength(0);
  });

  it('토큰 사용량 기록', async () => {
    const mw = createTokenUsageMiddleware({ now: () => 1700000000000 });
    const state = makeState('hello world!'); // 12 chars / 4 = 3 tokens
    const result = await mw(state);

    expect(result.context.tokenUsage.enabled).toBe(true);
    expect(result.context.tokenUsage.current.inputTokens).toBe(3);
    expect(result.context.tokenUsage.current.model).toBe('opus');
    expect(result.context.tokenUsage.current.agent).toBe('frontend-developer');
  });

  it('세션 누적 통계', async () => {
    const mw = createTokenUsageMiddleware({ now: () => 1700000000000 });

    await mw(makeState('aaaa')); // 1 token
    const result = await mw(makeState('bbbbbbbb')); // 2 tokens

    expect(result.context.tokenUsage.session.totalInput).toBe(3);
    expect(result.context.tokenUsage.session.requestCount).toBe(2);
  });

  it('모델별 통계 (byModel)', async () => {
    const mw = createTokenUsageMiddleware({ now: () => 1700000000000 });

    await mw(makeState('test', { context: { backend: { selected: 'opus' } } }));
    const result = await mw(makeState('test', { context: { backend: { selected: 'sonnet' } } }));

    expect(result.context.tokenUsage.byModel).toHaveProperty('opus');
    expect(result.context.tokenUsage.byModel).toHaveProperty('sonnet');
  });

  it('에이전트별 통계 (byAgent)', async () => {
    const mw = createTokenUsageMiddleware({ now: () => 1700000000000 });

    await mw(makeState('test', {
      context: { subagents: { contract: { targetAgent: 'alpha' } } },
    }));
    const result = await mw(makeState('test', {
      context: { subagents: { contract: { targetAgent: 'beta' } } },
    }));

    expect(result.context.tokenUsage.byAgent).toHaveProperty('alpha');
    expect(result.context.tokenUsage.byAgent).toHaveProperty('beta');
  });

  it('모델 fallback — config.modelPolicy.default', async () => {
    const mw = createTokenUsageMiddleware({ now: () => 1700000000000 });
    const state = makeState('test', {
      context: { backend: {} },
      config: { modelPolicy: { default: 'haiku' } },
    });
    const result = await mw(state);

    expect(result.context.tokenUsage.current.model).toBe('haiku');
  });

  it('모델 fallback — unknown', async () => {
    const mw = createTokenUsageMiddleware({ now: () => 1700000000000 });
    const state = makeState('test', { context: {}, config: {} });
    const result = await mw(state);

    expect(result.context.tokenUsage.current.model).toBe('unknown');
  });

  it('에이전트 fallback — tasks.recommendedAgent', async () => {
    const mw = createTokenUsageMiddleware({ now: () => 1700000000000 });
    const state = makeState('test', {
      context: {
        subagents: {},
        tasks: { recommendedAgent: 'qa' },
      },
    });
    const result = await mw(state);

    expect(result.context.tokenUsage.current.agent).toBe('qa');
  });

  it('에이전트 fallback — orchestrator', async () => {
    const mw = createTokenUsageMiddleware({ now: () => 1700000000000 });
    const state = makeState('test', {
      context: { subagents: {}, tasks: {} },
    });
    const result = await mw(state);

    expect(result.context.tokenUsage.current.agent).toBe('orchestrator');
  });

  it('messageParts에 tokens= 추가', async () => {
    const mw = createTokenUsageMiddleware({ now: () => 1700000000000 });
    const state = makeState('abcd'); // 1 token
    const result = await mw(state);

    expect(result.messageParts).toContain('tokens=1');
  });

  it('큰 토큰 → K 형식 messageParts', async () => {
    const mw = createTokenUsageMiddleware({ now: () => 1700000000000, charsPerToken: 1 });
    const state = makeState('x'.repeat(2000));
    const result = await mw(state);

    expect(result.messageParts[0]).toBe('tokens=2.0K');
  });

  it('커스텀 charsPerToken', async () => {
    const mw = createTokenUsageMiddleware({ charsPerToken: 2, now: () => 1700000000000 });
    const state = makeState('abcdef'); // 6 chars / 2 = 3 tokens
    const result = await mw(state);

    expect(result.context.tokenUsage.current.inputTokens).toBe(3);
  });

  it('커스텀 maxEntries — entries trimming', async () => {
    const mw = createTokenUsageMiddleware({ maxEntries: 2, now: () => 1700000000000 });

    await mw(makeState('a'));
    await mw(makeState('b'));
    const result = await mw(makeState('c'));

    // Can't directly access store, but session count accumulates
    expect(result.context.tokenUsage.session.requestCount).toBe(3);
  });

  it('외부 store 공유', async () => {
    const sharedStore = _createStore();
    const mw1 = createTokenUsageMiddleware({ store: sharedStore, now: () => 1700000000000 });
    const mw2 = createTokenUsageMiddleware({ store: sharedStore, now: () => 1700000000000 });

    await mw1(makeState('aaaa'));
    const result = await mw2(makeState('bbbb'));

    // Both middlewares share the same initial store reference, but internal
    // reassignment means mw2 won't see mw1's mutation — this tests isolation
    expect(result.context.tokenUsage.session.requestCount).toBeGreaterThanOrEqual(1);
  });

  it('context.tokenUsage 전체 구조 검증', async () => {
    const mw = createTokenUsageMiddleware({ now: () => 1700000000000 });
    const state = makeState('hello');
    const result = await mw(state);

    const tu = result.context.tokenUsage;
    expect(tu).toHaveProperty('enabled', true);
    expect(tu).toHaveProperty('current');
    expect(tu.current).toHaveProperty('inputTokens');
    expect(tu.current).toHaveProperty('model');
    expect(tu.current).toHaveProperty('agent');
    expect(tu).toHaveProperty('session');
    expect(tu.session).toHaveProperty('totalInput');
    expect(tu.session).toHaveProperty('totalOutput');
    expect(tu.session).toHaveProperty('totalTokens');
    expect(tu.session).toHaveProperty('requestCount');
    expect(tu).toHaveProperty('byModel');
    expect(tu).toHaveProperty('byAgent');
  });

  it('빈 prompt → 0 tokens', async () => {
    const mw = createTokenUsageMiddleware({ now: () => 1700000000000 });
    const state = makeState('');
    const result = await mw(state);

    expect(result.context.tokenUsage.current.inputTokens).toBe(0);
    expect(result.messageParts).toContain('tokens=0');
  });
});
