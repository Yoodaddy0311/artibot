import { describe, expect, it } from 'vitest';
import {
  _ALLOWED_TOOLS,
  _BLOCKED_TOOLS,
  _evaluateTool,
  createPlanModeMiddleware,
  disablePlanMode,
  enablePlanMode,
  isPlanMode,
} from '../../../lib/runtime/middleware/plan-mode.js';

function makeState(overrides = {}) {
  return {
    input: { prompt: 'plan the feature' },
    context: {
      routing: { system: 'system2', score: 0.8 },
      intent: { best: 'action:plan', commands: ['/plan'], agents: [], ambiguous: false },
      ...overrides.context,
    },
    messageParts: [],
    userPrompt: 'test prompt',
    ...overrides,
  };
}

describe('plan-mode middleware', () => {
  describe('isPlanMode', () => {
    it('returns true when plan mode is active', () => {
      expect(isPlanMode({ planMode: { active: true } })).toBe(true);
    });

    it('returns false when plan mode is inactive', () => {
      expect(isPlanMode({ planMode: { active: false } })).toBe(false);
    });

    it('returns false for null/undefined context', () => {
      expect(isPlanMode(null)).toBe(false);
      expect(isPlanMode(undefined)).toBe(false);
      expect(isPlanMode({})).toBe(false);
    });
  });

  describe('enablePlanMode', () => {
    it('returns new context with active: true', () => {
      const original = { existing: 'data' };
      const result = enablePlanMode(original);

      expect(result.planMode.active).toBe(true);
      expect(result.planMode.enabledAt).toBeTruthy();
      expect(result.existing).toBe('data');
      // Immutability check
      expect(original.planMode).toBeUndefined();
    });
  });

  describe('disablePlanMode', () => {
    it('returns new context with active: false', () => {
      const original = { planMode: { active: true, enabledAt: '2026-01-01' } };
      const result = disablePlanMode(original);

      expect(result.planMode.active).toBe(false);
      expect(result.planMode.disabledAt).toBeTruthy();
      // Immutability check
      expect(original.planMode.active).toBe(true);
    });
  });

  describe('_evaluateTool', () => {
    it('allows read-only tools', () => {
      for (const tool of ['Read', 'Grep', 'Glob', 'Agent']) {
        const result = _evaluateTool(tool);
        expect(result.decision).toBe('allow');
      }
    });

    it('blocks write/execute tools', () => {
      for (const tool of ['Write', 'Edit', 'Bash']) {
        const result = _evaluateTool(tool);
        expect(result.decision).toBe('block');
        expect(result.reason).toContain('Plan mode active');
      }
    });

    it('blocks unknown tools (fail-closed)', () => {
      const result = _evaluateTool('SomeNewTool');
      expect(result.decision).toBe('block');
    });
  });

  describe('tool classifications', () => {
    it('ALLOWED_TOOLS contains read-only and investigation tools', () => {
      expect(_ALLOWED_TOOLS.has('Read')).toBe(true);
      expect(_ALLOWED_TOOLS.has('Grep')).toBe(true);
      expect(_ALLOWED_TOOLS.has('Glob')).toBe(true);
      expect(_ALLOWED_TOOLS.has('Agent')).toBe(true);
    });

    it('BLOCKED_TOOLS contains write and execute tools', () => {
      expect(_BLOCKED_TOOLS.has('Write')).toBe(true);
      expect(_BLOCKED_TOOLS.has('Edit')).toBe(true);
      expect(_BLOCKED_TOOLS.has('Bash')).toBe(true);
    });
  });

  describe('createPlanModeMiddleware', () => {
    it('passes through when disabled', async () => {
      const mw = createPlanModeMiddleware({ enabled: false });
      const state = makeState({ context: { planMode: { active: true } } });
      const result = await mw(state);

      expect(result.context.planMode.active).toBe(false);
      expect(result.messageParts).toEqual([]);
    });

    it('passes through when plan mode not active and not forced', async () => {
      const mw = createPlanModeMiddleware();
      const state = makeState();
      const result = await mw(state);

      expect(result.context.planMode.active).toBe(false);
    });

    it('activates when mode option is "plan"', async () => {
      const mw = createPlanModeMiddleware({ mode: 'plan' });
      const state = makeState();
      const result = await mw(state);

      expect(result.context.planMode.active).toBe(true);
    });

    it('activates when context has planMode.active = true', async () => {
      const mw = createPlanModeMiddleware();
      const state = makeState({ context: { planMode: { active: true } } });
      const result = await mw(state);

      expect(result.context.planMode.active).toBe(true);
    });

    it('blocks write tools from subagent contracts', async () => {
      const mw = createPlanModeMiddleware({ mode: 'plan' });
      const state = makeState({
        context: {
          subagents: { contract: { tools: ['Read', 'Write', 'Bash', 'Grep'] } },
        },
      });
      const result = await mw(state);

      expect(result.context.planMode.blocked).toContain('Write');
      expect(result.context.planMode.blocked).toContain('Bash');
      expect(result.messageParts[0]).toContain('planMode=blocked');
    });

    it('allows all read-only tools from subagent contracts', async () => {
      const mw = createPlanModeMiddleware({ mode: 'plan' });
      const state = makeState({
        context: {
          subagents: { contract: { tools: ['Read', 'Grep', 'Glob'] } },
        },
      });
      const result = await mw(state);

      expect(result.context.planMode.blocked).toEqual([]);
      expect(result.messageParts).toContain('planMode=ok');
    });

    it('evaluates agentTeam tools — SendMessage/TaskCreate allowed, TeamCreate blocked', async () => {
      const mw = createPlanModeMiddleware({ mode: 'plan' });
      const state = makeState({
        context: {
          tasks: { mode: 'agentTeam' },
        },
      });
      const result = await mw(state);

      // TeamCreate is not in ALLOWED_TOOLS, so it gets blocked
      expect(result.context.planMode.blocked).toContain('TeamCreate');
      // SendMessage and TaskCreate are allowed
      const allowed = result.context.planMode.evaluations
        .filter((e) => e.decision === 'allow')
        .map((e) => e.tool);
      expect(allowed).toContain('SendMessage');
      expect(allowed).toContain('TaskCreate');
    });

    it('appends warning to userPrompt when tools are blocked', async () => {
      const mw = createPlanModeMiddleware({ mode: 'plan' });
      const state = makeState({
        context: {
          subagents: { contract: { tools: ['Edit'] } },
        },
      });
      const result = await mw(state);

      expect(result.userPrompt).toContain('Plan mode');
      expect(result.userPrompt).toContain('Edit');
    });
  });
});
