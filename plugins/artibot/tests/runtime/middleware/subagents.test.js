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

    expect(result.context.subagents.contract.tools).toEqual(['Agent']);
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

  describe('Delegation contract honours team.enabled', () => {
    // This middleware computed `subagents.enabled` from `config.team.enabled`
    // and then appended the contract on `mode` alone, so a disabled team still
    // got a prompt block naming teammates and telling the model to parallelize.
    // The upstream mode gate (`workflow-mode.js`) now resolves an OFF config to
    // `subAgent` before this runs, which makes this the SECOND fence — kept
    // because a caller that sets `task.mode` itself would otherwise reopen the
    // hole this pins shut.
    function agentTeamState(teamOverrides) {
      return makeState({
        context: { tasks: { mode: 'agentTeam' } },
        config: {
          team: {
            ...makeState().config.team,
            ...teamOverrides,
          },
        },
      });
    }

    it('CONTROL: an enabled team still gets the contract', async () => {
      const result = await createSubagentsMiddleware()(agentTeamState({ enabled: true }));
      expect(result.userPrompt).toContain('Delegation contract');
      expect(result.context.subagents.enabled).toBe(true);
    });

    it('omits the contract when team.enabled is false', async () => {
      const result = await createSubagentsMiddleware()(agentTeamState({ enabled: false }));
      expect(result.userPrompt).not.toContain('Delegation contract');
      expect(result.context.subagents.enabled).toBe(false);
    });

    it('omits the contract when team.autoApply is false', async () => {
      // The second documented spelling of the same opt-out. This file used to
      // read `team.enabled` alone, so `autoApply:false` — the spelling
      // `CLAUDE.md` Operator-Waits names — was ignored here entirely.
      const result = await createSubagentsMiddleware()(agentTeamState({ autoApply: false }));
      expect(result.userPrompt).not.toContain('Delegation contract');
      expect(result.context.subagents.enabled).toBe(false);
    });

    it('needs BOTH keys non-false to stay on', async () => {
      // Truth table at the surface, matching `isTeamEnabled`: the two keys are
      // ANDed, so one of them being true does not rescue the other.
      const both = await createSubagentsMiddleware()(
        agentTeamState({ enabled: true, autoApply: false }),
      );
      expect(both.context.subagents.enabled).toBe(false);
      const other = await createSubagentsMiddleware()(
        agentTeamState({ enabled: false, autoApply: true }),
      );
      expect(other.context.subagents.enabled).toBe(false);
    });

    it('still publishes the structured contract object when disabled', async () => {
      // Only the PROMPT text is gated. `context.subagents.contract` is a data
      // surface other middleware reads, and blanking it would change more than
      // the opt-out asks for — the `enabled` flag beside it is how a consumer
      // knows what the contract is worth.
      const result = await createSubagentsMiddleware()(agentTeamState({ enabled: false }));
      expect(result.context.subagents.contract.mode).toBe('agentTeam');
      expect(result.messageParts).toContain('delegate=agentTeam');
    });

    it('defaults to enabled when the key is absent', async () => {
      const state = agentTeamState({});
      delete state.config.team.enabled;
      const result = await createSubagentsMiddleware()(state);
      expect(result.userPrompt).toContain('Delegation contract');
    });
  });
});
