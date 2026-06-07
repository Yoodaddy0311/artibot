/**
 * Full-chain regression — the parallel-spawn signal must survive the REAL
 * pipeline, not just the unit boundary.
 *
 * Symptom②: router middleware used to write a SHALLOW intent (no
 * `recommendations`), so workflow-plan.js#extractSubObjectives always saw zero
 * sub-objectives → empty teammates → buildTeamDirective produced an empty
 * string at runtime even though the wiring was correct. This test drives the
 * actual chain:
 *
 *   router middleware  → state.context.intent (now carries recommendations)
 *   → tasks middleware → state.context.tasks.meta.workflowPlan
 *   → buildWorkflowPlan → teammates.length > 0
 *   → buildTeamDirective → non-empty [artibot:team …] directive
 *
 * and asserts teammates is NON-empty (the caveat: 0 → >0) plus a populated
 * team directive.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRouterMiddleware } from '../../lib/runtime/middleware/router.js';
import { createTasksMiddleware } from '../../lib/runtime/middleware/tasks.js';
import { buildTeamDirective } from '../../scripts/hooks/runtime-prompt.js';

// Three distinct action verbs across implement/test/review → detectIntent
// yields 3 recommendations, and classifyComplexity routes it to system2.
const MULTI_DOMAIN_PROMPT =
  'implement the new oauth login feature, write tests for it, and review the security of the auth flow';

const CONFIG = {
  automation: { supportedLanguages: ['en'], ambiguityThreshold: 50 },
  team: {
    enabled: true,
    // OR logic, 3 recommendations meets minSubtasks → size signal fires.
    autoApplyTriggers: { logic: 'OR', minSubtasks: 3, minFiles: 3, minComplexity: 'high' },
  },
};

describe('workflow-plan full chain — router → tasks → team directive', () => {
  let pluginRoot;

  beforeEach(() => {
    pluginRoot = mkdtempSync(path.join(tmpdir(), 'artibot-fullchain-'));
    mkdirSync(path.join(pluginRoot, 'runtime'), { recursive: true });
    writeFileSync(
      path.join(pluginRoot, 'artibot.config.json'),
      JSON.stringify({
        team: { autoApplyTriggers: CONFIG.team.autoApplyTriggers },
        runtime: { effort: { budgetMap: { xhigh: 128000, high: 64000, medium: 32000, low: 16000 } } },
      }),
    );
  });

  afterEach(() => {
    rmSync(pluginRoot, { recursive: true, force: true });
  });

  function freshState() {
    return {
      input: { prompt: MULTI_DOMAIN_PROMPT, pluginRoot },
      userPrompt: MULTI_DOMAIN_PROMPT,
      messageParts: [],
      config: CONFIG,
      context: { runtime: { sessionDepth: 0 } },
    };
  }

  it('router middleware now carries recommendations into state.context.intent', async () => {
    const router = createRouterMiddleware();
    const state = freshState();
    await router(state);

    expect(Array.isArray(state.context.intent.recommendations)).toBe(true);
    expect(state.context.intent.recommendations.length).toBeGreaterThan(0);
    // `best` stays a string (no regression for string consumers).
    expect(typeof state.context.intent.best).toBe('string');
    // System 2 → tasks middleware will enter agentTeam mode.
    expect(state.context.routing.system).toBe('system2');
  });

  it('tasks middleware builds a workflow plan with teammates.length > 0 (caveat fixed)', async () => {
    const router = createRouterMiddleware();
    const tasks = createTasksMiddleware({ now: () => 1700000000000 });
    const state = freshState();

    await router(state);
    await tasks(state);

    const plan = state.context.tasks.meta?.workflowPlan;
    expect(plan).toBeDefined();
    expect(plan.runner).toBe('team');
    // THE caveat: previously 0 because recommendations were dropped.
    expect(plan.teammates.length).toBeGreaterThan(0);
    // Each teammate carries an effort band from the unified classification.
    for (const tm of plan.teammates) {
      expect(['low', 'medium', 'high', 'xhigh', 'max']).toContain(tm.effort);
    }
  });

  it('buildTeamDirective is NON-empty for the full-chain plan (signal reaches the model)', async () => {
    const router = createRouterMiddleware();
    const tasks = createTasksMiddleware({ now: () => 1700000000000 });
    const state = freshState();

    await router(state);
    await tasks(state);

    const directive = buildTeamDirective(state.context.tasks.meta.workflowPlan);
    expect(directive).not.toBe('');
    expect(directive).toMatch(/^\[artibot:team runner=team teammates=[1-9]\d*\]/);
    // At least one per-teammate effort directive is serialized behind the head.
    expect(directive).toMatch(/\[artibot:effort level=(low|medium|high|xhigh|max)\]/);
  });
});
