import { describe, expect, it } from 'vitest';
import { createSubagentsMiddleware } from '../../../lib/runtime/middleware/subagents.js';

function makeState(overrides = {}) {
  return {
    context: {
      intent: {
        best: 'action:implement',
        commands: ['/implement'],
        agents: ['frontend-developer'],
      },
      tasks: { mode: 'subAgent', recommendedAgent: null, recommendedCommand: null },
      ...overrides.context,
    },
    config: {
      team: {
        enabled: true,
        delegationModeSelection: {
          subAgent: {
            tools: ['Task'],
            communication: 'one-way',
          },
          agentTeam: {
            tools: ['TeamCreate', 'SendMessage'],
            communication: 'P2P bidirectional',
          },
        },
      },
      ...overrides.config,
    },
    messageParts: [],
    userPrompt: 'test prompt',
    ...overrides,
  };
}

describe('middleware/subagents', () => {
  it('enabled=false 시 비활성 상태 반환', async () => {
    const mw = createSubagentsMiddleware({ enabled: false });
    const state = makeState();
    const result = await mw(state);

    expect(result.context.subagents.enabled).toBe(false);
    expect(result.context.subagents.contract).toBeNull();
  });

  it('subAgent 모드 contract 생성', async () => {
    const mw = createSubagentsMiddleware();
    const state = makeState({
      context: {
        tasks: { mode: 'subAgent' },
        intent: { agents: ['code-reviewer'], commands: ['/review'] },
      },
    });
    const result = await mw(state);
    const contract = result.context.subagents.contract;

    expect(contract.mode).toBe('subAgent');
    expect(contract.shouldParallelize).toBe(false);
    expect(contract.requiresPlan).toBe(false);
    expect(contract.targetAgent).toBe('code-reviewer');
    expect(contract.targetCommand).toBe('/review');
    expect(contract.tools).toEqual(['Task']);
    expect(contract.communication).toBe('one-way');
  });

  it('agentTeam 모드 contract 생성', async () => {
    const mw = createSubagentsMiddleware();
    const state = makeState({
      context: {
        tasks: { mode: 'agentTeam' },
        intent: { agents: ['orchestrator'], commands: ['/sc'] },
      },
    });
    const result = await mw(state);
    const contract = result.context.subagents.contract;

    expect(contract.mode).toBe('agentTeam');
    expect(contract.shouldParallelize).toBe(true);
    expect(contract.requiresPlan).toBe(true);
    expect(contract.tools).toEqual(['TeamCreate', 'SendMessage']);
  });

  it('agentTeam 모드에서 프롬프트에 Delegation contract 추가', async () => {
    const mw = createSubagentsMiddleware();
    const state = makeState({
      context: {
        tasks: { mode: 'agentTeam' },
        intent: { agents: ['orchestrator'], commands: ['/sc'] },
      },
    });
    const result = await mw(state);

    expect(result.userPrompt).toContain('Delegation contract:');
    expect(result.userPrompt).toContain('Preferred mode: agentTeam');
    expect(result.userPrompt).toContain('Preferred agent: orchestrator');
  });

  it('subAgent 모드에서 프롬프트 변경 없음', async () => {
    const mw = createSubagentsMiddleware();
    const state = makeState({
      context: {
        tasks: { mode: 'subAgent' },
        intent: { agents: [], commands: [] },
      },
    });
    const originalPrompt = state.userPrompt;
    const result = await mw(state);

    expect(result.userPrompt).toBe(originalPrompt);
  });

  it('intent에 agent/command 없을 때 task 추천값 사용', async () => {
    const mw = createSubagentsMiddleware();
    const state = makeState({
      context: {
        tasks: {
          mode: 'subAgent',
          recommendedAgent: 'backend-developer',
          recommendedCommand: '/build',
        },
        intent: { agents: [], commands: [] },
      },
    });
    const result = await mw(state);

    expect(result.context.subagents.contract.targetAgent).toBe('backend-developer');
    expect(result.context.subagents.contract.targetCommand).toBe('/build');
  });

  it('config에 정책 없을 때 기본 정책 사용', async () => {
    const mw = createSubagentsMiddleware();
    const state = makeState({ config: {} });
    const result = await mw(state);

    expect(result.context.subagents.contract.tools).toEqual(['Task']);
    expect(result.context.subagents.contract.communication).toBe('one-way (result return only)');
  });

  it('messageParts에 delegate= 추가', async () => {
    const mw = createSubagentsMiddleware();
    const state = makeState();
    const result = await mw(state);

    expect(result.messageParts).toContain('delegate=subAgent');
  });

  it('team.enabled=false 시 subagents.enabled=false', async () => {
    const mw = createSubagentsMiddleware();
    const state = makeState({
      config: { team: { enabled: false } },
      context: {
        tasks: { mode: 'subAgent' },
        intent: { agents: [], commands: [] },
      },
    });
    const result = await mw(state);

    expect(result.context.subagents.enabled).toBe(false);
  });

  it('agentTeam에서 agent 없으면 orchestrator 표시', async () => {
    const mw = createSubagentsMiddleware();
    const state = makeState({
      context: {
        tasks: { mode: 'agentTeam' },
        intent: { agents: [], commands: [] },
      },
    });
    const result = await mw(state);

    expect(result.userPrompt).toContain('Preferred agent: orchestrator');
  });
});
