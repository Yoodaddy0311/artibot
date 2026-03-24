import { afterEach, describe, expect, it } from 'vitest';
import { createSkillsMiddleware, _resetSkillCaches } from '../../../lib/runtime/middleware/skills.js';

function makeState(overrides = {}) {
  return {
    context: {
      intent: {
        best: 'action:implement',
        commands: ['/implement'],
        agents: ['frontend-developer'],
        intents: ['action:implement'],
        ambiguous: false,
      },
      ...overrides.context,
    },
    messageParts: [],
    userPrompt: 'test',
    ...overrides,
  };
}

describe('middleware/skills', () => {
  it('command에서 스킬 이름 도출 (/implement → cmd-implement)', async () => {
    const mw = createSkillsMiddleware();
    const state = makeState();
    const result = await mw(state);

    expect(result.context.skills.suggested).toContain('cmd-implement');
    expect(result.context.skills.source).toBe('intent-derived');
  });

  it('intentToSkills 매핑에서 추가 스킬 도출', async () => {
    const mw = createSkillsMiddleware({
      intentToSkills: {
        'action:implement': ['coding-standards', 'tdd-workflow'],
      },
    });
    const state = makeState();
    const result = await mw(state);

    expect(result.context.skills.suggested).toContain('cmd-implement');
    expect(result.context.skills.suggested).toContain('coding-standards');
    expect(result.context.skills.suggested).toContain('tdd-workflow');
  });

  it('중복 스킬 제거', async () => {
    const mw = createSkillsMiddleware({
      intentToSkills: {
        'action:implement': ['cmd-implement', 'extra-skill'],
      },
    });
    const state = makeState();
    const result = await mw(state);

    const count = result.context.skills.suggested.filter((s) => s === 'cmd-implement').length;
    expect(count).toBe(1);
  });

  it('command 없을 때 빈 suggested', async () => {
    const mw = createSkillsMiddleware();
    const state = makeState({
      context: {
        intent: { best: null, commands: [], agents: [] },
      },
    });
    const result = await mw(state);

    expect(result.context.skills.suggested).toEqual([]);
  });

  it('intent.best는 있지만 intentToSkills에 매핑 없을 때', async () => {
    const mw = createSkillsMiddleware({ intentToSkills: {} });
    const state = makeState({
      context: {
        intent: { best: 'action:fix', commands: ['/fix'], agents: [] },
      },
    });
    const result = await mw(state);

    expect(result.context.skills.suggested).toEqual(['cmd-fix']);
  });

  it('messageParts에 skills 개수 추가', async () => {
    const mw = createSkillsMiddleware({
      intentToSkills: { 'action:implement': ['skill-a'] },
    });
    const state = makeState();
    const result = await mw(state);

    expect(result.messageParts).toContain('skills=2');
  });

  it('context.intent 없을 때 안전하게 동작', async () => {
    const mw = createSkillsMiddleware();
    const state = { context: {}, messageParts: [], userPrompt: 'test' };
    const result = await mw(state);

    expect(result.context.skills.suggested).toEqual([]);
    expect(result.messageParts).toContain('skills=0');
  });
});

// ---------------------------------------------------------------------------
// Lazy loading mode
// ---------------------------------------------------------------------------

describe('middleware/skills - lazy loading', () => {
  afterEach(() => {
    _resetSkillCaches();
  });

  it('loads skill index and matches by trigger keywords', async () => {
    const mw = createSkillsMiddleware({
      lazyLoading: { enabled: true, maxConcurrent: 5 },
    });
    const state = makeState({
      context: {
        intent: {
          best: 'action:implement',
          commands: ['/implement'],
          agents: [],
          intents: ['action:implement'],
        },
      },
    });
    const result = await mw(state);

    expect(result.context.skills.source).toBe('lazy-loaded');
    expect(result.context.skills.indexSize).toBeGreaterThan(0);
    expect(Array.isArray(result.context.skills.loaded)).toBe(true);
    expect(result.context.skills.loaded.length).toBeGreaterThan(0);
  });

  it('caches loaded skills across calls', async () => {
    const mw = createSkillsMiddleware({
      lazyLoading: { enabled: true, maxConcurrent: 5 },
    });
    const state1 = makeState();
    await mw(state1);
    const cacheSize1 = state1.context.skills.cacheSize;

    const state2 = makeState();
    await mw(state2);
    const cacheSize2 = state2.context.skills.cacheSize;

    expect(cacheSize2).toBeGreaterThanOrEqual(cacheSize1);
    expect(state2.context.skills.source).toBe('lazy-loaded');
  });

  it('respects maxConcurrent limit', async () => {
    const mw = createSkillsMiddleware({
      lazyLoading: { enabled: true, maxConcurrent: 2 },
    });
    const state = makeState({
      context: {
        intent: {
          best: 'action:implement',
          commands: ['/implement'],
          agents: [],
          intents: ['action:implement'],
        },
      },
    });
    const result = await mw(state);

    expect(result.context.skills.loaded.length).toBeLessThanOrEqual(2);
  });

  it('returns empty loaded with non-existent pluginRoot (graceful degradation)', async () => {
    const mw = createSkillsMiddleware({
      lazyLoading: { enabled: true, maxConcurrent: 5 },
      pluginRoot: '/nonexistent/path',
    });
    const state = makeState();
    const result = await mw(state);

    expect(result.context.skills.source).toBe('lazy-loaded');
    expect(result.context.skills.loaded).toEqual([]);
    expect(result.context.skills.suggested).toContain('cmd-implement');
  });

  it('still populates suggested from intentToSkills in lazy mode', async () => {
    const mw = createSkillsMiddleware({
      intentToSkills: { 'action:implement': ['extra-skill'] },
      lazyLoading: { enabled: true, maxConcurrent: 5 },
    });
    const state = makeState();
    const result = await mw(state);

    expect(result.context.skills.suggested).toContain('cmd-implement');
    expect(result.context.skills.suggested).toContain('extra-skill');
    expect(result.context.skills.source).toBe('lazy-loaded');
  });

  it('disabled lazy loading behaves like original', async () => {
    const mw = createSkillsMiddleware({
      lazyLoading: { enabled: false },
    });
    const state = makeState();
    const result = await mw(state);

    expect(result.context.skills.source).toBe('intent-derived');
    expect(result.context.skills.loaded).toBeUndefined();
  });

  it('matches test-related skills with test intent', async () => {
    const mw = createSkillsMiddleware({
      lazyLoading: { enabled: true, maxConcurrent: 10 },
    });
    const state = makeState({
      context: {
        intent: {
          best: 'action:test',
          commands: ['/test'],
          agents: ['tdd-guide'],
          intents: ['action:test'],
        },
      },
    });
    const result = await mw(state);

    expect(result.context.skills.source).toBe('lazy-loaded');
    expect(result.context.skills.loaded.some((n) => n.toLowerCase().includes('tdd'))).toBe(true);
  });
});
