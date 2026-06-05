import { describe, expect, it } from 'vitest';
import { createSubagentsMiddleware } from '../../lib/runtime/middleware/subagents.js';

const baseState = (workflowPlan) => ({
  config: { team: { enabled: true } },
  context: {
    tasks: { mode: 'agentTeam', meta: { workflowPlan } },
    intent: { agents: ['orchestrator'], commands: ['/team'] },
  },
  userPrompt: '',
  messageParts: [],
});

describe('WIRE-03: subagents contract carries per-teammate effort/budget', () => {
  it('maps teammates[] onto the contract when runner=team', async () => {
    const plan = {
      runner: 'team',
      effort: 'xhigh',
      perAgentBudget: 42666,
      teammates: [
        { agent: 'frontend-developer', command: '/implement', effort: 'xhigh', budget: 128000 },
        { agent: 'backend-developer', command: '/implement', effort: 'high', budget: 64000 },
      ],
      trigger: {},
    };
    const out = await createSubagentsMiddleware()(baseState(plan));
    const c = out.context.subagents.contract;
    expect(c.parentEffort).toBe('xhigh');
    expect(c.perAgentBudget).toBe(42666);
    expect(c.teammates).toHaveLength(2);
    expect(c.teammates[1]).toMatchObject({ agent: 'backend-developer', effort: 'high', budget: 64000 });
  });

  it('emits empty teammates[] for an inline plan (no per-teammate data)', async () => {
    const plan = { runner: 'inline', effort: 'high', perAgentBudget: 0, teammates: [], trigger: {} };
    const out = await createSubagentsMiddleware()(baseState(plan));
    expect(out.context.subagents.contract.teammates).toEqual([]);
  });

  it('does not throw when workflowPlan is absent', async () => {
    const out = await createSubagentsMiddleware()(baseState(undefined));
    const c = out.context.subagents.contract;
    expect(c.teammates).toEqual([]);
    expect(c.parentEffort).toBeNull();
    expect(c.perAgentBudget).toBe(0);
  });
});
