import { describe, expect, it, vi } from 'vitest';
import { createMemoryMiddleware } from '../../../lib/runtime/middleware/memory.js';

vi.mock('../../../lib/learning/memory-manager.js', () => ({
  getRelevantContext: vi.fn(),
}));

const { getRelevantContext } = await import('../../../lib/learning/memory-manager.js');

function makeState(overrides = {}) {
  return {
    input: { hookData: { cwd: '/tmp/test', project: 'artibot' } },
    context: {
      routing: { system: 'system2', score: 0.8 },
      intent: { intents: ['action:implement'], commands: ['/implement'] },
      ...overrides.context,
    },
    messageParts: [],
    userPrompt: 'build a dashboard',
    ...overrides,
  };
}

describe('middleware/memory', () => {
  it('enabled=false 시 즉시 반환 (hitCount=0)', async () => {
    const mw = createMemoryMiddleware({ enabled: false });
    const state = makeState();
    const result = await mw(state);

    expect(result.context.memory.enabled).toBe(false);
    expect(result.context.memory.hitCount).toBe(0);
    expect(getRelevantContext).not.toHaveBeenCalled();
  });

  it('정상적으로 메모리 컨텍스트 조회 (hit 있음)', async () => {
    getRelevantContext.mockResolvedValue({
      preferences: [{ key: 'lang', value: 'ko' }],
      projectContext: [{ name: 'artibot' }],
      errorPatterns: [],
      recentCommands: ['/build'],
    });

    const mw = createMemoryMiddleware({ enabled: true });
    const state = makeState();
    const result = await mw(state);

    expect(result.context.memory.enabled).toBe(true);
    expect(result.context.memory.hitCount).toBe(3);
    expect(result.messageParts).toContain('memory=3');
  });

  it('system2 라우팅 시 프롬프트에 메모리 컨텍스트 추가', async () => {
    getRelevantContext.mockResolvedValue({
      preferences: [{ key: 'lang', value: 'ko' }],
      projectContext: [],
      errorPatterns: [],
      recentCommands: [],
    });

    const mw = createMemoryMiddleware();
    const state = makeState({
      context: {
        routing: { system: 'system2' },
        intent: { intents: [] },
      },
    });
    const result = await mw(state);

    expect(result.userPrompt).toContain('Relevant memory context:');
    expect(result.userPrompt).toContain('Preference hint:');
  });

  it('system1 라우팅 시 프롬프트에 메모리 컨텍스트 추가하지 않음', async () => {
    getRelevantContext.mockResolvedValue({
      preferences: [{ key: 'lang', value: 'ko' }],
      projectContext: [],
      errorPatterns: [],
      recentCommands: [],
    });

    const mw = createMemoryMiddleware();
    const state = makeState({
      context: {
        routing: { system: 'system1' },
        intent: { intents: [] },
      },
    });
    const result = await mw(state);

    expect(result.userPrompt).not.toContain('Relevant memory context:');
  });

  it('hit 0개일 때 프롬프트 변경 없음', async () => {
    getRelevantContext.mockResolvedValue({
      preferences: [],
      projectContext: [],
      errorPatterns: [],
      recentCommands: [],
    });

    const mw = createMemoryMiddleware();
    const state = makeState();
    const originalPrompt = state.userPrompt;
    const result = await mw(state);

    expect(result.userPrompt).toBe(originalPrompt);
    expect(result.context.memory.hitCount).toBe(0);
    expect(result.messageParts).toContain('memory=0');
  });

  it('getRelevantContext 에러 시 graceful 처리', async () => {
    getRelevantContext.mockRejectedValue(new Error('DB connection failed'));

    const mw = createMemoryMiddleware();
    const state = makeState();
    const result = await mw(state);

    expect(result.context.memory.enabled).toBe(true);
    expect(result.context.memory.hitCount).toBe(0);
    expect(result.context.memory.error).toBe('DB connection failed');
    expect(result.messageParts).toContain('memory=0');
  });

  it('hookData 없을 때 빈 queryContext 생성', async () => {
    getRelevantContext.mockResolvedValue({
      preferences: [],
      projectContext: [],
      errorPatterns: [],
      recentCommands: [],
    });

    const mw = createMemoryMiddleware();
    const state = {
      input: {},
      context: {
        routing: { system: 'system1' },
        intent: {},
      },
      messageParts: [],
      userPrompt: 'test',
    };
    await mw(state);

    expect(getRelevantContext).toHaveBeenLastCalledWith({
      cwd: '',
      command: '',
      project: '',
      keywords: [],
    });
  });
});
