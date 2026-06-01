/**
 * P2 / symptom② — workflow-plan team directive injection.
 *
 * The tasks middleware builds a unified workflow plan (team trigger +
 * per-teammate effort/budget) on every agentTeam prompt, but composePromptOutput
 * previously injected ONLY the effort/task-budget directives and dropped
 * prepared.context entirely — so the parallel-spawn signal never reached the
 * model ("parallel-not-spawned"). These tests pin the new wiring: when the plan
 * elects runner='team', composePromptOutput prefixes an [artibot:team …]
 * directive with one effort+budget pair per teammate, on the SAME leading line
 * pattern as effort/budget.
 */

import { describe, expect, it } from 'vitest';
import {
  buildRecommendationDirective,
  buildTeamDirective,
  composePromptOutput,
} from '../../scripts/hooks/runtime-prompt.js';

function teamPlan() {
  return {
    runner: 'team',
    effort: 'xhigh',
    perAgentBudget: 42666,
    teammates: [
      { agent: 'frontend-developer', command: '/implement', intent: 'action:fe', effort: 'xhigh', budget: 128000 },
      { agent: 'backend-developer', command: '/implement', intent: 'action:be', effort: 'high', budget: 64000 },
    ],
    trigger: { fired: true, runner: 'team', reasons: ['subtasks>=3'], bypassed: false },
  };
}

describe('buildTeamDirective()', () => {
  it('serializes one effort+budget pair per teammate behind the team head', () => {
    const d = buildTeamDirective(teamPlan());
    expect(d).toBe(
      '[artibot:team runner=team teammates=2]'
      + '[artibot:effort level=xhigh][artibot:task-budget max_tokens=128000]'
      + '[artibot:effort level=high][artibot:task-budget max_tokens=64000]',
    );
  });

  it('returns empty string for an inline plan', () => {
    expect(buildTeamDirective({ runner: 'inline', teammates: [] })).toBe('');
  });

  it('returns empty string when teammates is empty (complexity-only fire)', () => {
    expect(buildTeamDirective({ runner: 'team', teammates: [] })).toBe('');
  });

  it('returns empty string for missing/invalid plan', () => {
    expect(buildTeamDirective(null)).toBe('');
    expect(buildTeamDirective(undefined)).toBe('');
    expect(buildTeamDirective({})).toBe('');
  });

  it('omits budget for a teammate with no positive budget but keeps effort', () => {
    const d = buildTeamDirective({
      runner: 'team',
      teammates: [{ effort: 'medium', budget: 0 }],
    });
    expect(d).toBe('[artibot:team runner=team teammates=1][artibot:effort level=medium]');
  });
});

describe('buildRecommendationDirective()', () => {
  it('emits an advisory hint when the plan recommends workflow', () => {
    const d = buildRecommendationDirective({ recommendation: 'workflow' });
    expect(d).toBe('[artibot:hint recommend=workflow]');
    expect(d).toContain('recommend=workflow');
  });

  it('emits an advisory hint when the plan recommends autopilot', () => {
    const d = buildRecommendationDirective({ recommendation: 'autopilot' });
    expect(d).toBe('[artibot:hint recommend=autopilot]');
  });

  it('returns empty string when recommendation is null', () => {
    expect(buildRecommendationDirective({ recommendation: null })).toBe('');
  });

  it('returns empty string when recommendation is absent', () => {
    expect(buildRecommendationDirective({})).toBe('');
  });

  it('returns empty string for a missing/invalid plan', () => {
    expect(buildRecommendationDirective(null)).toBe('');
    expect(buildRecommendationDirective(undefined)).toBe('');
  });
});

describe('composePromptOutput() — team directive reaches the prompt (no longer dropped)', () => {
  const prepared = {
    userPrompt: 'Original request: build the thing',
    message: '[runtime] prepared',
    context: { tasks: { meta: { workflowPlan: teamPlan() } } },
  };

  it('prepends [artibot:team …] when the plan elects a parallel runner', () => {
    const out = composePromptOutput({
      prepared,
      prompt: 'build the thing',
      effortMeta: null,
      taskBudgetDirective: '',
      injectPrompt: true,
    });
    expect(out.user_prompt).toMatch(/^\[artibot:team runner=team teammates=2\]/);
    expect(out.user_prompt).toContain('[artibot:effort level=xhigh][artibot:task-budget max_tokens=128000]');
    expect(out.user_prompt).toContain('[artibot:effort level=high][artibot:task-budget max_tokens=64000]');
    // Original prompt body survives after the blank-line separator.
    expect(out.user_prompt).toMatch(/\]\n\nOriginal request: build the thing$/);
  });

  it('team directive precedes the parent effort/budget directives', () => {
    const out = composePromptOutput({
      prepared,
      prompt: 'build the thing',
      effortMeta: { command: 'implement', effort: 'xhigh' },
      taskBudgetDirective: '[artibot:task-budget max_tokens=128000]',
      injectPrompt: true,
    });
    const teamIdx = out.user_prompt.indexOf('[artibot:team');
    const effortIdx = out.user_prompt.indexOf('[artibot:effort level=xhigh command=implement]');
    expect(teamIdx).toBe(0);
    expect(effortIdx).toBeGreaterThan(teamIdx);
  });

  it('does not inject a team directive for an inline plan', () => {
    const inline = {
      userPrompt: 'Original request: tiny fix',
      message: '[runtime] prepared',
      context: { tasks: { meta: { workflowPlan: { runner: 'inline', teammates: [] } } } },
    };
    const out = composePromptOutput({
      prepared: inline,
      prompt: 'tiny fix',
      effortMeta: null,
      taskBudgetDirective: '',
      injectPrompt: true,
    });
    expect(out.user_prompt).not.toContain('[artibot:team');
    expect(out.user_prompt).toBe('Original request: tiny fix');
  });

  it('respects injectPrompt=false (no directives at all)', () => {
    const out = composePromptOutput({
      prepared,
      prompt: 'build the thing',
      effortMeta: null,
      taskBudgetDirective: '',
      injectPrompt: false,
    });
    expect(out.user_prompt).not.toContain('[artibot:team');
    expect(out.user_prompt).toBe('Original request: build the thing');
  });

  it('handles a prepared envelope with no tasks context (missing plan → no team directive)', () => {
    const out = composePromptOutput({
      prepared: { userPrompt: 'x', message: 'm', context: {} },
      prompt: 'x',
      effortMeta: null,
      taskBudgetDirective: '',
      injectPrompt: true,
    });
    expect(out.user_prompt).toBe('x');
  });
});
