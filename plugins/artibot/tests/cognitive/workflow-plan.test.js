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

// --- Advisory recommendation / autoFire (P2) ------------------------------

/** Build an intent whose every recommendation uses the SAME command. */
function homogeneousIntentWith(n, command = '/implement') {
  const recommendations = Array.from({ length: n }, (_, i) => ({
    intent: `action:r${i}`,
    type: 'action',
    description: `rec ${i}`,
    agents: [`agent-${i}`],
    commands: [command],
  }));
  return {
    intents: recommendations.map((r) => r.intent),
    matches: [],
    recommendations,
    best: { intent: 'action:implement', commands: [command], agents: ['planner'] },
    ambiguity: { ambiguous: false, score: 0, clarification: null },
  };
}

describe('buildWorkflowPlan() — advisory recommendation & autoFire', () => {
  it('homogeneous fan-out (3x same command) firing team → workflow + autoFire', () => {
    const plan = buildWorkflowPlan({ score: 0.2 }, homogeneousIntentWith(3), CONFIG);
    expect(plan.runner).toBe('team');
    expect(plan.recommendation).toBe('workflow');
    expect(plan.autoFire).toBe(true);
  });

  it('plain inline case → recommendation null & autoFire false', () => {
    const plan = buildWorkflowPlan({ score: 0.1 }, intentWith(1), CONFIG);
    expect(plan.runner).toBe('inline');
    expect(plan.recommendation).toBeNull();
    expect(plan.autoFire).toBe(false);
  });

  it('high tier + >=6 heterogeneous sub-objectives → autopilot', () => {
    // 6 recs cycling 3 distinct commands → each appears twice (maxRepeat 2),
    // so the homogeneity branch does NOT fire; tier high + 6 subs → autopilot.
    const cmds = ['/implement', '/code-review', '/verify'];
    const recommendations = Array.from({ length: 6 }, (_, i) => ({
      intent: `action:r${i}`, type: 'action', description: `rec ${i}`,
      agents: [`agent-${i}`], commands: [cmds[i % 3]],
    }));
    const intent = {
      intents: recommendations.map((r) => r.intent), matches: [], recommendations,
      best: { intent: 'action:implement', commands: ['/implement'], agents: ['planner'] },
      ambiguity: { ambiguous: false, score: 0, clarification: null },
    };
    // CONFIG has no split block → the pre-split behaviour, byte for byte.
    const plan = buildWorkflowPlan({ score: 0.8 }, intent, CONFIG);
    expect(plan.runner).toBe('team');
    expect(plan.recommendation).toBe('autopilot');
    expect(plan.autoFire).toBe(true);
  });

  it('mixed-command team plan with no homogeneity/size signal → recommendation null (purely additive fallback)', () => {
    // intentWith(3) alternates /implement,/code-review,/implement → maxRepeat 2,
    // only 3 subs so no autopilot either → recommendation must stay null.
    const plan = buildWorkflowPlan({ score: 0.8 }, intentWith(3), CONFIG);
    expect(plan.runner).toBe('team');
    expect(plan.recommendation).toBeNull();
    expect(plan.autoFire).toBe(true);
  });
});

// --- Advisory recommendation: split (config-gated) ------------------------

/**
 * N recs cycling 3 commands (maxRepeat < 3 for n <= 8 → never homogeneous)
 * + N distinct agents. n=6 is the autopilot fixture.
 */
function heterogeneousN(n, { agents } = {}) {
  const cmds = ['/implement', '/code-review', '/verify'];
  const recommendations = Array.from({ length: n }, (_, i) => ({
    intent: `action:r${i}`, type: 'action', description: `rec ${i}`,
    agents: [agents ? agents[i % agents.length] : `agent-${i}`], commands: [cmds[i % 3]],
  }));
  return {
    intents: recommendations.map((r) => r.intent), matches: [], recommendations,
    best: { intent: 'action:implement', commands: ['/implement'], agents: ['planner'] },
    ambiguity: { ambiguous: false, score: 0, clarification: null },
  };
}
const heterogeneousSix = () => heterogeneousN(6);

/**
 * Shipped shape (artibot.config.json#split, 2026-08-26 22:32 실측:
 * minStems 2 / recommendMinSubtasks 6). Two keys, two roles: `minStems` is the
 * PLAN validity floor, `recommendMinSubtasks` is the HINT gate (leader decision
 * — checker-3 REQUEST_CHANGES). The value 6 is a conservative guess with zero
 * live-operator evidence, not a measurement.
 */
const CONFIG_SPLIT = Object.freeze({ ...CONFIG, split: { maxWindows: 4, minStems: 2, recommendMinSubtasks: 6 } });
/** cmd's config BEFORE the hint gate existed — must behave exactly like no split block. */
const CONFIG_SPLIT_PLAN_ONLY = Object.freeze({ ...CONFIG, split: { maxWindows: 4, minStems: 2 } });

describe('buildWorkflowPlan() — advisory recommendation: split (advisory only, opt-in via recommendMinSubtasks)', () => {
  it('6 sub-objectives (>= recommendMinSubtasks 6) across >= minStems agents at high tier → split', () => {
    const plan = buildWorkflowPlan({ score: 0.8 }, heterogeneousSix(), CONFIG_SPLIT);
    expect(plan.recommendation).toBe('split');
    // Advisory only: the runner decision is untouched by the recommendation.
    expect(plan.runner).toBe('team');
    expect(plan.autoFire).toBe(true);
  });

  it('5 sub-objectives (< recommendMinSubtasks 6) → no split, and no autopilot either (below its floor)', () => {
    expect(buildWorkflowPlan({ score: 0.8 }, heterogeneousN(5), CONFIG_SPLIT).recommendation).toBeNull();
  });

  it('recommendMinSubtasks absent → OFF: the autopilot hint is byte-identical to a config with no split block', () => {
    const six = heterogeneousSix();
    const withoutKey = buildWorkflowPlan({ score: 0.8 }, six, CONFIG_SPLIT_PLAN_ONLY);
    const noBlock = buildWorkflowPlan({ score: 0.8 }, six, CONFIG);
    expect(withoutKey.recommendation).toBe('autopilot');
    expect(withoutKey.recommendation).toBe(noBlock.recommendation);
    expect(buildWorkflowPlan({ score: 0.8 }, six, { ...CONFIG, split: {} }).recommendation).toBe('autopilot');
    // minStems alone (the plan floor) must never turn the hint on.
    expect(buildWorkflowPlan({ score: 0.8 }, heterogeneousN(3), CONFIG_SPLIT_PLAN_ONLY).recommendation).toBeNull();
  });

  it('actually reads recommendMinSubtasks (not a hard-coded 6): 5 sub-objectives fire at 5, not at 6', () => {
    const five = heterogeneousN(5);
    expect(buildWorkflowPlan({ score: 0.8 }, five, { ...CONFIG, split: { minStems: 2, recommendMinSubtasks: 5 } }).recommendation).toBe('split');
    expect(buildWorkflowPlan({ score: 0.8 }, five, { ...CONFIG, split: { minStems: 2, recommendMinSubtasks: 6 } }).recommendation).toBeNull();
  });

  it('actually reads minStems as the distinct-agent floor: 6 subs over 2 agents fire at minStems 2, not 3', () => {
    const twoAgents = heterogeneousN(6, { agents: ['backend-developer', 'frontend-developer'] });
    expect(buildWorkflowPlan({ score: 0.8 }, twoAgents, CONFIG_SPLIT).recommendation).toBe('split');
    const at3 = buildWorkflowPlan({ score: 0.8 }, twoAgents, { ...CONFIG, split: { minStems: 3, recommendMinSubtasks: 6 } });
    // Falls through to the old autopilot signal — split never swallows a hint it does not earn.
    expect(at3.recommendation).toBe('autopilot');
  });

  it('rejects a malformed recommendMinSubtasks or minStems as disabled — never as 0', () => {
    for (const bad of [1, 0, -1, 2.5, '6', null, true]) {
      expect(buildWorkflowPlan({ score: 0.8 }, heterogeneousSix(), { ...CONFIG, split: { minStems: 2, recommendMinSubtasks: bad } }).recommendation,
        `recommendMinSubtasks=${JSON.stringify(bad)}`).toBe('autopilot');
      expect(buildWorkflowPlan({ score: 0.8 }, heterogeneousSix(), { ...CONFIG, split: { minStems: bad, recommendMinSubtasks: 6 } }).recommendation,
        `minStems=${JSON.stringify(bad)}`).toBe('autopilot');
    }
  });

  it('one agent across all sub-objectives = one stem → no split; the autopilot signal is what remains', () => {
    const plan = buildWorkflowPlan({ score: 0.8 }, heterogeneousN(6, { agents: ['backend-developer'] }), CONFIG_SPLIT);
    expect(plan.recommendation).toBe('autopilot');
  });

  it('medium/low tier never recommends split even with enough sub-objectives and stems', () => {
    expect(buildWorkflowPlan({ score: 0.4 }, heterogeneousSix(), CONFIG_SPLIT).recommendation).toBeNull();
    expect(buildWorkflowPlan({ score: 0.1 }, heterogeneousSix(), CONFIG_SPLIT).recommendation).toBeNull();
  });

  it('precedence: homogeneous batch still wins as workflow over split', () => {
    const plan = buildWorkflowPlan({ score: 0.8 }, homogeneousIntentWith(6), CONFIG_SPLIT);
    expect(plan.recommendation).toBe('workflow');
  });

  it('precedence (documented consequence): with recommendMinSubtasks 6, split SHADOWS the autopilot hint for multi-agent jobs', () => {
    // The autopilot floor is also 6, so the shipped value flips every multi-agent
    // autopilot hint to split. Byte-identical autopilot behaviour exists only
    // while the key is absent (previous test). Recorded here on purpose.
    expect(buildWorkflowPlan({ score: 0.8 }, heterogeneousSix(), CONFIG_SPLIT).recommendation).toBe('split');
    expect(buildWorkflowPlan({ score: 0.8 }, heterogeneousSix(), CONFIG).recommendation).toBe('autopilot');
  });

  it('inline plans can still carry the split hint (advisory is independent of the runner)', () => {
    // Bypassed intent → inline regardless of size/complexity; 6 sub-objectives
    // across 6 agents still satisfy the thresholds at tier high.
    const plan = buildWorkflowPlan({ score: 0.8 }, heterogeneousSix(), {
      team: { autoApplyTriggers: { ...TRIGGERS, bypassIntents: ['action'] } },
      split: { minStems: 2, recommendMinSubtasks: 6 },
    });
    expect(plan.runner).toBe('inline');
    expect(plan.autoFire).toBe(false);
    expect(plan.recommendation).toBe('split');
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
