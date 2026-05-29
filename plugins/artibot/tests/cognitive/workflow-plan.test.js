import { describe, expect, it } from 'vitest';
import {
  buildWorkflowPlan,
  deriveTeammateEfforts,
  EFFORT_LADDER,
} from '../../lib/cognitive/workflow-plan.js';
import { resolveEffort } from '../../lib/cognitive/router.js';

// --- Fixtures -------------------------------------------------------------

const TRIGGERS = Object.freeze({
  logic: 'OR',
  minSubtasks: 3,
  minFiles: 3,
  minComplexity: 'high',
  bypassIntents: ['question', 'diagnose', 'explain', 'lookup'],
});

const CONFIG = Object.freeze({ team: { autoApplyTriggers: TRIGGERS } });

/** Build an intent with N recommendations (each → one sub-objective). */
function intentWith(n, { best, intents } = {}) {
  const recommendations = Array.from({ length: n }, (_, i) => ({
    intent: `action:r${i}`,
    type: 'action',
    description: `rec ${i}`,
    agents: [`agent-${i}`],
    commands: [i % 2 === 0 ? '/implement' : '/code-review'],
  }));
  return {
    intents: intents || recommendations.map((r) => r.intent),
    matches: [],
    recommendations,
    best: best ?? { intent: 'action:implement', commands: ['/implement'], agents: ['planner'] },
    ambiguity: { ambiguous: false, score: 0, clarification: null },
  };
}

// --- EFFORT_LADDER --------------------------------------------------------

describe('EFFORT_LADDER', () => {
  it('is frozen and ordered low → max', () => {
    expect(Object.isFrozen(EFFORT_LADDER)).toBe(true);
    expect(EFFORT_LADDER).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});

// --- Trigger matrix -------------------------------------------------------

describe('buildWorkflowPlan() — trigger matrix (config thresholds 1:1)', () => {
  it('fires team when recommendations >= minSubtasks/minFiles (3)', () => {
    const plan = buildWorkflowPlan({ score: 0.2 }, intentWith(3), CONFIG);
    expect(plan.runner).toBe('team');
    expect(plan.trigger.fired).toBe(true);
    expect(plan.trigger.reasons).toContain('subtasks>=3');
    expect(plan.trigger.reasons).toContain('files>=3');
  });

  it('does NOT fire when below all thresholds (2 recs, low score)', () => {
    const plan = buildWorkflowPlan({ score: 0.2 }, intentWith(2), CONFIG);
    expect(plan.runner).toBe('inline');
    expect(plan.trigger.fired).toBe(false);
    expect(plan.teammates).toEqual([]);
  });

  it('fires on complexity alone (high score) under OR even with few recs', () => {
    const plan = buildWorkflowPlan({ score: 0.7 }, intentWith(1), CONFIG);
    expect(plan.runner).toBe('team');
    expect(plan.trigger.reasons).toContain('complexity>=high');
  });

  it('complexity below high (medium tier) does not satisfy complexity reason', () => {
    const plan = buildWorkflowPlan({ score: 0.4 }, intentWith(1), CONFIG);
    expect(plan.trigger.reasons).not.toContain('complexity>=high');
    expect(plan.runner).toBe('inline');
  });

  it('logic=AND requires all three reasons', () => {
    const andCfg = { team: { autoApplyTriggers: { ...TRIGGERS, logic: 'AND' } } };
    // 3 recs but low score → subtasks+files satisfied, complexity not → no fire
    const partial = buildWorkflowPlan({ score: 0.2 }, intentWith(3), andCfg);
    expect(partial.runner).toBe('inline');
    // 3 recs + high score → all three → fire
    const full = buildWorkflowPlan({ score: 0.8 }, intentWith(3), andCfg);
    expect(full.runner).toBe('team');
    expect(full.trigger.reasons).toHaveLength(3);
  });

  it('bypassIntents suppress the trigger even when thresholds met', () => {
    const intent = intentWith(3, {
      best: { intent: 'question:explain', commands: ['/explain'], agents: [] },
      intents: ['question', 'action:r0'],
    });
    const plan = buildWorkflowPlan({ score: 0.9 }, intent, CONFIG);
    expect(plan.trigger.bypassed).toBe(true);
    expect(plan.runner).toBe('inline');
  });
});

// --- Frozen return + inline shape ----------------------------------------

describe('buildWorkflowPlan() — return contract', () => {
  it('returns a deeply frozen plan', () => {
    const plan = buildWorkflowPlan({ score: 0.8 }, intentWith(3), CONFIG, {
      budgetResolver: () => 60000,
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.teammates)).toBe(true);
    expect(Object.isFrozen(plan.teammates[0])).toBe(true);
    expect(Object.isFrozen(plan.trigger)).toBe(true);
  });

  it('inline runner yields empty teammates and zero perAgentBudget', () => {
    const plan = buildWorkflowPlan({ score: 0.1 }, intentWith(1), CONFIG);
    expect(plan.runner).toBe('inline');
    expect(plan.teammates).toEqual([]);
    expect(plan.perAgentBudget).toBe(0);
    expect(plan.effort).toBe('xhigh'); // parent /implement baseline
  });
});

// --- Teammate effort / budget --------------------------------------------

describe('buildWorkflowPlan() — per-teammate effort & budget', () => {
  it('every teammate effort ∈ [parent−1, parent]', () => {
    const plan = buildWorkflowPlan({ score: 0.8 }, intentWith(4), CONFIG, {
      resolveEffort,
      budgetResolver: (e) => ({ low: 16000, medium: 32000, high: 64000, xhigh: 128000, max: 200000 }[e] || 0),
    });
    const parentIdx = EFFORT_LADDER.indexOf(plan.effort);
    for (const tm of plan.teammates) {
      const i = EFFORT_LADDER.indexOf(tm.effort);
      expect(i).toBeGreaterThanOrEqual(parentIdx - 1);
      expect(i).toBeLessThanOrEqual(parentIdx);
    }
  });

  it('perAgentBudget = floor(parentBudget / teammates.length)', () => {
    // parent /implement → with deps.resolveEffort + score 0.8 → 'max' (xhigh+1)
    const budgetMap = { low: 16000, medium: 32000, high: 64000, xhigh: 128000, max: 200000 };
    const plan = buildWorkflowPlan({ score: 0.8 }, intentWith(3), CONFIG, {
      resolveEffort,
      budgetResolver: (e) => budgetMap[e] || 0,
    });
    const expected = Math.floor(budgetMap[plan.effort] / plan.teammates.length);
    expect(plan.perAgentBudget).toBe(expected);
  });

  it('each teammate carries agent/command/intent from its recommendation', () => {
    const plan = buildWorkflowPlan({ score: 0.8 }, intentWith(3), CONFIG, {
      budgetResolver: () => 30000,
    });
    expect(plan.teammates[0]).toMatchObject({
      agent: 'agent-0', command: '/implement', intent: 'action:r0', budget: 30000,
    });
  });

  it('deps.resolveEffort is used over the static fallback', () => {
    let called = 0;
    const fakeResolve = () => { called++; return { effort: 'low' }; };
    const plan = buildWorkflowPlan({ score: 0.8 }, intentWith(3), CONFIG, {
      resolveEffort: fakeResolve,
    });
    expect(called).toBeGreaterThan(0);
    // parent forced to 'low' → all teammates clamp into ['low','low']
    expect(plan.effort).toBe('low');
    for (const tm of plan.teammates) expect(tm.effort).toBe('low');
  });

  it('falls back to getEffortForCommand when no resolveEffort injected', () => {
    const plan = buildWorkflowPlan({ score: 0.8 }, intentWith(3), CONFIG);
    // /implement static baseline = xhigh (score ignored without resolver)
    expect(plan.effort).toBe('xhigh');
  });
});

// --- deriveTeammateEfforts -----------------------------------------------

describe('deriveTeammateEfforts()', () => {
  const resolveFn = (cmd) => ({ '/implement': 'xhigh', '/code-review': 'high', '/explain': 'medium' }[cmd] || 'medium');

  it('empty sub-objectives → empty array', () => {
    expect(deriveTeammateEfforts([], 'xhigh', resolveFn)).toEqual([]);
    expect(deriveTeammateEfforts(undefined, 'xhigh', resolveFn)).toEqual([]);
  });

  it("parent='low' floors every teammate to 'low' (cannot drop below ladder[0])", () => {
    const subs = [{ command: '/implement' }, { command: '/code-review' }];
    expect(deriveTeammateEfforts(subs, 'low', resolveFn)).toEqual(['low', 'low']);
  });

  it('strong sub-objective is capped at the parent band', () => {
    const subs = [{ command: '/implement' }]; // resolves xhigh
    expect(deriveTeammateEfforts(subs, 'high', resolveFn)).toEqual(['high']);
  });

  it('weak sub-objective is floored to parent−1', () => {
    const subs = [{ command: '/explain' }]; // resolves medium
    // parent max → floor = xhigh
    expect(deriveTeammateEfforts(subs, 'max', resolveFn)).toEqual(['xhigh']);
  });
});

// --- Edge cases -----------------------------------------------------------

describe('buildWorkflowPlan() — edge cases', () => {
  it('trigger fires but no sub-objectives (complexity-only) → team with empty teammates', () => {
    const intent = {
      intents: ['action:big'], recommendations: [], best: { commands: ['/implement'] },
    };
    const plan = buildWorkflowPlan({ score: 0.9 }, intent, CONFIG, { budgetResolver: () => 50000 });
    expect(plan.runner).toBe('team');
    expect(plan.teammates).toEqual([]);
    expect(plan.perAgentBudget).toBe(0);
  });

  it('missing config triggers → uses built-in defaults (min 3, high)', () => {
    const plan = buildWorkflowPlan({ score: 0.2 }, intentWith(3), {});
    expect(plan.runner).toBe('team'); // 3 recs meets default minSubtasks/minFiles
    const single = buildWorkflowPlan({ score: 0.2 }, intentWith(1), {});
    expect(single.runner).toBe('inline');
  });

  it('null intent is handled gracefully → inline', () => {
    const plan = buildWorkflowPlan({ score: 0.2 }, null, CONFIG);
    expect(plan.runner).toBe('inline');
    expect(plan.teammates).toEqual([]);
    expect(plan.effort).toBe('xhigh'); // parentCmd defaults to 'team' → xhigh
  });

  it('null classification (no score) → low tier, no complexity reason', () => {
    const plan = buildWorkflowPlan(null, intentWith(1), CONFIG);
    expect(plan.runner).toBe('inline');
  });

  it('parentCmd defaults to "team" when best has no commands', () => {
    const intent = { intents: [], recommendations: [], best: null };
    const plan = buildWorkflowPlan({ score: 0.1 }, intent, CONFIG);
    expect(plan.effort).toBe('xhigh'); // EFFORT_POLICY.team === 'xhigh'
  });
});
