import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSkillTriggerMiddleware,
  createIdentityFallback,
  DEFAULT_TRIGGER_OPTIONS,
} from '../../../lib/runtime/middleware/skill-trigger.js';

function makeState(overrides = {}) {
  return {
    context: {
      intent: {
        best: 'action:test',
        commands: ['/test'],
        intents: ['action:test'],
        domains: [],
        agents: [],
      },
      skills: {
        suggested: ['tdd-workflow', 'copywriting'],
      },
      ...overrides.context,
    },
    messageParts: [],
    userPrompt: 'write tests',
    config: {
      learning: {
        grpoRouting: {
          skillPolicy: {
            enabled: false,
          },
        },
      },
      ...overrides.config,
    },
    ...overrides,
  };
}

function makePolicyStub(scoreMap) {
  return {
    scoreSkills: vi.fn(async (_intent, _ctx, { candidates }) => {
      const out = {};
      for (const c of candidates) out[c] = scoreMap[c] ?? 0.5;
      return out;
    }),
    selectSkills: vi.fn(async (_intent, _ctx, { candidates, threshold, maxTriggers }) => {
      const t = threshold ?? 0.5;
      const m = maxTriggers ?? 3;
      const entries = candidates
        .map((c) => ({ name: c, score: scoreMap[c] ?? 0.5 }))
        .filter((e) => e.score >= t)
        .sort((a, b) => b.score - a.score)
        .slice(0, m);
      return entries;
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createIdentityFallback', () => {
  it('returns a copy of suggested list', () => {
    const fb = createIdentityFallback();
    const state = makeState();
    const result = fb.match(state);
    expect(result).toEqual(['tdd-workflow', 'copywriting']);
    // Mutation isolation
    result.push('x');
    expect(state.context.skills.suggested).toEqual(['tdd-workflow', 'copywriting']);
  });

  it('returns [] when suggested missing', () => {
    const fb = createIdentityFallback();
    expect(fb.match({})).toEqual([]);
    expect(fb.match({ context: {} })).toEqual([]);
  });
});

describe('skill-trigger middleware — disabled mode', () => {
  it('regex fallback selects all candidates when disabled', async () => {
    const mw = createSkillTriggerMiddleware();
    const state = makeState();
    const result = await mw(state);
    expect(result.context.skills.triggered).toEqual(['tdd-workflow', 'copywriting']);
    expect(result.context.skills.triggerSource).toBe('regex');
  });

  it('does not consult policy when flag is false', async () => {
    const policy = makePolicyStub({ 'tdd-workflow': 0.9, copywriting: 0.1 });
    const mw = createSkillTriggerMiddleware({ skillPolicy: policy });
    await mw(makeState());
    expect(policy.scoreSkills).not.toHaveBeenCalled();
    expect(policy.selectSkills).not.toHaveBeenCalled();
  });

  it('applies maxTriggers cap in regex mode', async () => {
    const mw = createSkillTriggerMiddleware();
    const state = makeState({
      context: {
        intent: { best: 'action:test', commands: ['/test'] },
        skills: { suggested: ['s1', 's2', 's3', 's4', 's5'] },
      },
      config: {
        learning: {
          grpoRouting: {
            skillPolicy: { enabled: false, maxTriggers: 2 },
          },
        },
      },
    });
    const result = await mw(state);
    expect(result.context.skills.triggered.length).toBe(2);
  });

  it('handles empty candidates gracefully', async () => {
    const mw = createSkillTriggerMiddleware();
    const state = makeState({ context: { intent: { best: 'x' }, skills: { suggested: [] } } });
    const result = await mw(state);
    expect(result.context.skills.triggered).toEqual([]);
    expect(result.context.skills.triggerSource).toBe('none');
  });
});

describe('skill-trigger middleware — enabled mode', () => {
  it('uses policy scores when enabled', async () => {
    const policy = makePolicyStub({ 'tdd-workflow': 0.9, copywriting: 0.1 });
    const mw = createSkillTriggerMiddleware({ skillPolicy: policy });
    const state = makeState({
      config: {
        learning: { grpoRouting: { skillPolicy: { enabled: true, threshold: 0.5, maxTriggers: 3 } } },
      },
    });
    const result = await mw(state);
    expect(policy.scoreSkills).toHaveBeenCalledTimes(1);
    expect(policy.selectSkills).toHaveBeenCalledTimes(1);
    expect(result.context.skills.triggered).toEqual(['tdd-workflow']);
    expect(result.context.skills.triggerSource).toBe('policy');
    expect(result.context.skills.triggerScores['tdd-workflow']).toBe(0.9);
    expect(result.context.skills.triggerScores.copywriting).toBe(0.1);
  });

  it('respects custom threshold', async () => {
    const policy = makePolicyStub({ a: 0.7, b: 0.55, c: 0.4 });
    const mw = createSkillTriggerMiddleware({ skillPolicy: policy });
    const state = makeState({
      context: { skills: { suggested: ['a', 'b', 'c'] } },
      config: {
        learning: { grpoRouting: { skillPolicy: { enabled: true, threshold: 0.6, maxTriggers: 5 } } },
      },
    });
    const result = await mw(state);
    expect(result.context.skills.triggered).toEqual(['a']);
  });

  it('falls back to regex when policy returns empty selection', async () => {
    const policy = makePolicyStub({ a: 0.1, b: 0.1 });
    const mw = createSkillTriggerMiddleware({ skillPolicy: policy });
    const state = makeState({
      context: { skills: { suggested: ['a', 'b'] } },
      config: {
        learning: { grpoRouting: { skillPolicy: { enabled: true, threshold: 0.9 } } },
      },
    });
    const result = await mw(state);
    expect(result.context.skills.triggered).toEqual(['a', 'b']);
    expect(result.context.skills.triggerSource).toBe('regex-fallback-empty');
  });

  it('falls back to regex when policy throws', async () => {
    const brokenPolicy = {
      scoreSkills: vi.fn(async () => { throw new Error('boom'); }),
      selectSkills: vi.fn(async () => { throw new Error('boom'); }),
    };
    const warn = vi.fn();
    const mw = createSkillTriggerMiddleware({ skillPolicy: brokenPolicy, logger: { info() {}, warn } });
    const state = makeState({
      config: { learning: { grpoRouting: { skillPolicy: { enabled: true } } } },
    });
    const result = await mw(state);
    expect(warn).toHaveBeenCalled();
    expect(result.context.skills.triggerSource).toBe('regex-on-error');
    expect(result.context.skills.triggered.length).toBeGreaterThan(0);
  });

  it('treats enabled:true without a skillPolicy as disabled', async () => {
    const mw = createSkillTriggerMiddleware(); // no policy
    const state = makeState({
      config: { learning: { grpoRouting: { skillPolicy: { enabled: true } } } },
    });
    const result = await mw(state);
    expect(result.context.skills.triggerSource).toBe('regex');
  });

  it('passes intent tokens and context to the policy', async () => {
    const policy = makePolicyStub({ 'tdd-workflow': 0.9 });
    const mw = createSkillTriggerMiddleware({ skillPolicy: policy });
    const state = makeState({
      context: {
        intent: {
          best: 'action:test',
          commands: ['/test'],
          intents: ['action:test'],
          domains: ['backend'],
        },
        skills: { suggested: ['tdd-workflow'] },
      },
      config: { learning: { grpoRouting: { skillPolicy: { enabled: true } } } },
    });
    await mw(state);
    const call = policy.scoreSkills.mock.calls[0];
    expect(call[0]).toBe('action:test');
    expect(call[1].commands).toEqual(['/test']);
    expect(call[1].domains).toEqual(['backend']);
    expect(call[2].candidates).toEqual(['tdd-workflow']);
  });
});

describe('middleware chain integration', () => {
  it('does not mutate the candidates array', async () => {
    const mw = createSkillTriggerMiddleware();
    const candidates = ['a', 'b'];
    const state = makeState({ context: { skills: { suggested: candidates } } });
    await mw(state);
    expect(candidates).toEqual(['a', 'b']);
  });

  it('appends a messagePart for observability', async () => {
    const mw = createSkillTriggerMiddleware();
    const state = makeState();
    const result = await mw(state);
    expect(result.messageParts.some((p) => p.startsWith('triggered='))).toBe(true);
  });

  it('preserves other context.skills fields', async () => {
    const mw = createSkillTriggerMiddleware();
    const state = makeState({
      context: {
        intent: { best: 'x', commands: [] },
        skills: { suggested: ['a'], source: 'intent-derived', custom: 42 },
      },
    });
    const result = await mw(state);
    expect(result.context.skills.source).toBe('intent-derived');
    expect(result.context.skills.custom).toBe(42);
    expect(result.context.skills.triggered).toEqual(['a']);
  });

  it('handles non-object state without throwing', async () => {
    const mw = createSkillTriggerMiddleware();
    await expect(mw(null)).resolves.toBeNull();
    await expect(mw(undefined)).resolves.toBeUndefined();
  });

  it('default trigger options match DEFAULT_TRIGGER_OPTIONS', () => {
    expect(DEFAULT_TRIGGER_OPTIONS.threshold).toBe(0.5);
    expect(DEFAULT_TRIGGER_OPTIONS.maxTriggers).toBe(3);
  });
});

describe('intent fallback', () => {
  it('uses first command when intent.best missing', async () => {
    const policy = makePolicyStub({ a: 0.9 });
    const mw = createSkillTriggerMiddleware({ skillPolicy: policy });
    const state = makeState({
      context: {
        intent: { best: null, commands: ['/refactor'], intents: [] },
        skills: { suggested: ['a'] },
      },
      config: { learning: { grpoRouting: { skillPolicy: { enabled: true } } } },
    });
    await mw(state);
    expect(policy.scoreSkills.mock.calls[0][0]).toBe('/refactor');
  });

  it('falls back to userPrompt when intent fields missing', async () => {
    const policy = makePolicyStub({ a: 0.9 });
    const mw = createSkillTriggerMiddleware({ skillPolicy: policy });
    const state = makeState({
      context: {
        intent: {},
        skills: { suggested: ['a'] },
      },
      userPrompt: 'raw user text',
      config: { learning: { grpoRouting: { skillPolicy: { enabled: true } } } },
    });
    await mw(state);
    expect(policy.scoreSkills.mock.calls[0][0]).toBe('raw user text');
  });
});
