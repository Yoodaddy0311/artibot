import { describe, expect, it } from 'vitest';
import { createTasksMiddleware } from '../../../lib/runtime/middleware/tasks.js';

function makeState(overrides = {}) {
  return {
    input: { prompt: 'build a dashboard' },
    context: {
      routing: { system: 'system1', score: 0.3 },
      intent: {
        best: 'action:implement',
        commands: ['/implement'],
        agents: ['frontend-developer'],
        ambiguous: false,
      },
      ...overrides.context,
    },
    messageParts: [],
    userPrompt: 'test prompt',
    ...overrides,
  };
}

describe('middleware/tasks', () => {
  it('system1 → subAgent 모드 (2 phases)', async () => {
    const mw = createTasksMiddleware({ now: () => 1700000000000 });
    const state = makeState();
    const result = await mw(state);

    expect(result.context.tasks.mode).toBe('subAgent');
    expect(result.context.tasks.phases).toEqual(['execute', 'verify']);
    expect(result.context.tasks.id).toMatch(/^rt-/);
    expect(result.messageParts).toContain('task=subAgent');
  });

  it('system2 → agentTeam 모드 (3 phases)', async () => {
    const mw = createTasksMiddleware({ now: () => 1700000000000 });
    const state = makeState({
      context: {
        routing: { system: 'system2', score: 0.9 },
        intent: {
          best: 'action:implement',
          commands: ['/implement'],
          agents: ['orchestrator'],
          ambiguous: false,
        },
      },
    });
    const result = await mw(state);

    expect(result.context.tasks.mode).toBe('agentTeam');
    expect(result.context.tasks.phases).toEqual(['plan', 'execute', 'verify']);
    expect(result.messageParts).toContain('task=agentTeam');
  });

  it('agentTeam 모드에서 프롬프트에 Execution contract 추가', async () => {
    const mw = createTasksMiddleware({ now: () => 1700000000000 });
    const state = makeState({
      context: {
        routing: { system: 'system2' },
        intent: { agents: [], commands: [], ambiguous: false },
      },
    });
    const result = await mw(state);

    expect(result.userPrompt).toContain('Execution contract:');
    expect(result.userPrompt).toContain('Create a plan first');
  });

  it('subAgent 모드에서 프롬프트 변경 없음', async () => {
    const mw = createTasksMiddleware({ now: () => 1700000000000 });
    const state = makeState();
    const originalPrompt = state.userPrompt;
    const result = await mw(state);

    expect(result.userPrompt).toBe(originalPrompt);
  });

  it('task에 intent 정보 포함', async () => {
    const mw = createTasksMiddleware({ now: () => 1700000000000 });
    const state = makeState();
    const result = await mw(state);

    expect(result.context.tasks.recommendedAgent).toBe('frontend-developer');
    expect(result.context.tasks.recommendedCommand).toBe('/implement');
    expect(result.context.tasks.complexity).toBe(0.3);
    expect(result.context.tasks.ambiguity).toBe(false);
    expect(result.context.tasks.objective).toBe('build a dashboard');
  });

  it('intent에 agent/command 없을 때 null', async () => {
    const mw = createTasksMiddleware({ now: () => 1700000000000 });
    const state = makeState({
      context: {
        routing: { system: 'system1' },
        intent: { agents: [], commands: [], ambiguous: false },
      },
    });
    const result = await mw(state);

    expect(result.context.tasks.recommendedAgent).toBeNull();
    expect(result.context.tasks.recommendedCommand).toBeNull();
  });

  it('createdAt ISO 형식', async () => {
    const mw = createTasksMiddleware({ now: () => 1700000000000 });
    const state = makeState();
    const result = await mw(state);

    expect(result.context.tasks.createdAt).toBe(new Date(1700000000000).toISOString());
  });

  it('routing 없을 때 기본값 system1 사용', async () => {
    const mw = createTasksMiddleware({ now: () => 1700000000000 });
    const state = makeState({
      context: {
        intent: { agents: [], commands: [], ambiguous: false },
      },
    });
    const result = await mw(state);

    expect(result.context.tasks.mode).toBe('subAgent');
  });

  it('deterministic ID (now 주입)', async () => {
    const mw = createTasksMiddleware({ now: () => 1700000000000 });
    const state = makeState();
    const result = await mw(state);

    // ID starts with rt- and contains base36 of timestamp
    expect(result.context.tasks.id).toMatch(/^rt-[a-z0-9]+-[a-z0-9]+$/);
  });
});
