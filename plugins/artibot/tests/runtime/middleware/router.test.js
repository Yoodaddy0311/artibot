import { describe, expect, it, vi } from 'vitest';
import { createRouterMiddleware } from '../../../lib/runtime/middleware/router.js';

vi.mock('../../../lib/cognitive/router.js', () => ({
  classifyComplexity: vi.fn(),
}));

vi.mock('../../../lib/intent/index.js', () => ({
  detectIntent: vi.fn(),
}));

const { classifyComplexity } = await import('../../../lib/cognitive/router.js');
const { detectIntent } = await import('../../../lib/intent/index.js');

function makeState(prompt = 'fix typo', overrides = {}) {
  return {
    userPrompt: prompt,
    config: {
      automation: {
        supportedLanguages: ['en', 'ko'],
        ambiguityThreshold: 50,
      },
      ...overrides.config,
    },
    context: {
      runtime: { sessionDepth: 0 },
      ...overrides.context,
    },
    messageParts: [],
    ...overrides,
  };
}

function mockSimple() {
  classifyComplexity.mockReturnValue({ system: 1, score: 0.2 });
  detectIntent.mockReturnValue({
    intents: ['action:fix'],
    best: { intent: 'action:fix', commands: ['/fix'], agents: [] },
    ambiguity: { ambiguous: false, score: 0 },
  });
}

function mockComplex() {
  classifyComplexity.mockReturnValue({ system: 2, score: 0.9 });
  detectIntent.mockReturnValue({
    intents: ['action:implement', 'action:refactor'],
    best: { intent: 'action:implement', commands: ['/implement'], agents: ['frontend-developer'] },
    ambiguity: { ambiguous: false, score: 10 },
  });
}

describe('middleware/router', () => {
  it('System 1 분류 (단순 프롬프트)', async () => {
    mockSimple();
    const mw = createRouterMiddleware();
    const state = makeState('fix typo');
    const result = await mw(state);

    expect(result.context.routing.system).toBe('system1');
    expect(result.userPrompt).toContain('System 1 mode');
    expect(result.userPrompt).toContain('Original request:');
    expect(result.userPrompt).toContain('fix typo');
    expect(result.messageParts).toContain('route=SYSTEM1');
  });

  it('System 2 분류 (복잡한 프롬프트)', async () => {
    mockComplex();
    const mw = createRouterMiddleware();
    const state = makeState('implement auth + refactor');
    const result = await mw(state);

    expect(result.context.routing.system).toBe('system2');
    expect(result.userPrompt).toContain('System 2 mode');
    expect(result.messageParts).toContain('route=SYSTEM2');
  });

  it('intent 정보 context에 저장', async () => {
    mockComplex();
    const mw = createRouterMiddleware();
    const state = makeState();
    const result = await mw(state);

    expect(result.context.intent.best).toBe('action:implement');
    expect(result.context.intent.intents).toEqual(['action:implement', 'action:refactor']);
    expect(result.context.intent.commands).toEqual(['/implement']);
    expect(result.context.intent.agents).toEqual(['frontend-developer']);
    expect(result.context.intent.ambiguous).toBe(false);
    expect(result.context.intent.ambiguityScore).toBe(10);
  });

  it('intent.best가 null인 경우', async () => {
    classifyComplexity.mockReturnValue({ system: 1, score: 0.1 });
    detectIntent.mockReturnValue({
      intents: [],
      best: null,
      ambiguity: { ambiguous: false, score: 0 },
    });

    const mw = createRouterMiddleware();
    const state = makeState('hello');
    const result = await mw(state);

    expect(result.context.intent.best).toBeNull();
    expect(result.context.intent.commands).toEqual([]);
    expect(result.context.intent.agents).toEqual([]);
    // intent= 메시지 파트가 추가되지 않아야 함
    expect(result.messageParts.some((p) => p.startsWith('intent='))).toBe(false);
  });

  it('intent.best가 있으면 messageParts에 추가', async () => {
    mockSimple();
    const mw = createRouterMiddleware();
    const state = makeState('fix');
    const result = await mw(state);

    expect(result.messageParts).toContain('intent=action:fix');
  });

  it('커스텀 prefix 적용', async () => {
    mockSimple();
    const mw = createRouterMiddleware({
      system1Prefix: 'FAST:',
      system2Prefix: 'DEEP:',
    });
    const state = makeState('quick fix');
    const result = await mw(state);

    expect(result.userPrompt).toContain('FAST:');
    expect(result.userPrompt).not.toContain('System 1 mode');
  });

  it('detectIntent에 config 옵션 전달', async () => {
    mockSimple();
    const mw = createRouterMiddleware();
    const state = makeState('test', {
      config: {
        automation: {
          supportedLanguages: ['en'],
          ambiguityThreshold: 80,
        },
      },
    });
    await mw(state);

    expect(detectIntent).toHaveBeenCalledWith('test', {
      languages: ['en'],
      ambiguityThreshold: 80,
    });
  });

  it('sessionDepth를 classifyComplexity에 전달', async () => {
    mockSimple();
    const mw = createRouterMiddleware();
    const state = makeState('test', {
      context: { runtime: { sessionDepth: 5 } },
    });
    await mw(state);

    expect(classifyComplexity).toHaveBeenCalledWith('test', { sessionDepth: 5 });
  });
});
