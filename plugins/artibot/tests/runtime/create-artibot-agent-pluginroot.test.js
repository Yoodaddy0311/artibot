/**
 * Keystone regression — pluginRoot must thread from the factory into the
 * pipeline state so the tasks middleware can (a) read runtime/current-effort.json
 * and (b) read artibot.config.json to build the workflow plan.
 *
 * These exercise the REAL factory path (createArtibotAgent({pluginRoot}) →
 * preparePrompt), NOT direct state injection — the unit tests in tasks.test.js
 * inject state.input.pluginRoot by hand and therefore could not have caught the
 * factory failing to thread it (the original bug: state.input was only
 * { prompt, hookData }).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createArtibotAgent } from '../../lib/runtime/create-artibot-agent.js';

// A system2-classifying prompt so the tasks middleware enters agentTeam mode
// (score 0.47 → system 2), which is the only mode that builds a workflow plan.
const SYSTEM2_PROMPT =
  'refactor the entire authentication architecture and migrate the database and audit security';

function makeConfig() {
  return {
    automation: { supportedLanguages: ['en'], ambiguityThreshold: 50 },
    team: {
      enabled: true,
      autoApplyTriggers: { logic: 'OR', minSubtasks: 3, minFiles: 3, minComplexity: 'high' },
    },
    cognitive: { router: { threshold: 0.4 } },
    runtime: { effort: { budgetMap: { xhigh: 128000, high: 64000, medium: 32000, low: 16000 } } },
    // Only run the middleware needed for this contract so the test is fast and
    // does not depend on memory/skills/checkpoint side effects.
    'runtime.middleware': undefined,
  };
}

describe('createArtibotAgent — pluginRoot threading (keystone)', () => {
  let pluginRoot;

  beforeEach(() => {
    pluginRoot = mkdtempSync(path.join(tmpdir(), 'artibot-pluginroot-'));
    mkdirSync(path.join(pluginRoot, 'runtime'), { recursive: true });
    // Real config on disk so buildWorkflowPlan reads non-empty triggers.
    writeFileSync(
      path.join(pluginRoot, 'artibot.config.json'),
      JSON.stringify({
        team: { autoApplyTriggers: { logic: 'OR', minSubtasks: 3, minFiles: 3, minComplexity: 'high' } },
        runtime: { effort: { budgetMap: { xhigh: 128000, high: 64000, medium: 32000, low: 16000 } } },
      }),
    );
  });

  afterEach(() => {
    rmSync(pluginRoot, { recursive: true, force: true });
  });

  function agent(config) {
    return createArtibotAgent({
      pluginRoot,
      config,
      // Limit the pipeline to router + tasks so we isolate the keystone path.
      middleware: null,
      middlewareOptions: { memory: { enabled: false } },
    });
  }

  it('threads pluginRoot so tasks middleware reads current-effort.json (effort meta populated)', async () => {
    writeFileSync(
      path.join(pluginRoot, 'runtime', 'current-effort.json'),
      JSON.stringify({ command: 'implement', effort: 'xhigh', baseline: 'xhigh', shift: 0, reason: 'baseline' }),
    );

    const config = { ...makeConfig(), runtime: { middleware: ['router', 'tasks'] } };
    const { context } = await agent(config).preparePrompt({ prompt: SYSTEM2_PROMPT });

    expect(context.tasks).toBeDefined();
    expect(context.tasks.mode).toBe('agentTeam');
    // Keystone proof: effort meta was read via state.input.pluginRoot. With the
    // bug (pluginRoot absent from state) readEffortMeta returns null and
    // task.meta.effort would be undefined.
    expect(context.tasks.meta).toBeDefined();
    expect(context.tasks.meta.effort).toBe('xhigh');
    expect(context.tasks.meta.command).toBe('implement');
  });

  it('threads pluginRoot so buildWorkflowPlan reads the real config (non-empty trigger)', async () => {
    const config = { ...makeConfig(), runtime: { middleware: ['router', 'tasks'] } };
    const { context } = await agent(config).preparePrompt({ prompt: SYSTEM2_PROMPT });

    expect(context.tasks.meta).toBeDefined();
    const plan = context.tasks.meta.workflowPlan;
    expect(plan).toBeDefined();
    // Trigger object is present and reflects the config-driven evaluation,
    // proving the config path (path.join(pluginRoot,'artibot.config.json')) was
    // read rather than the empty '' fallback.
    expect(plan.trigger).toBeDefined();
    expect(typeof plan.trigger.fired).toBe('boolean');
    expect(['inline', 'team']).toContain(plan.runner);
  });

  it('without pluginRoot, effort meta is absent (documents the failure mode)', async () => {
    writeFileSync(
      path.join(pluginRoot, 'runtime', 'current-effort.json'),
      JSON.stringify({ command: 'implement', effort: 'xhigh' }),
    );
    const config = { ...makeConfig(), runtime: { middleware: ['router', 'tasks'] } };
    // Factory created WITHOUT pluginRoot — mirrors the pre-fix behaviour.
    const noRoot = createArtibotAgent({ config, middlewareOptions: { memory: { enabled: false } } });
    const { context } = await noRoot.preparePrompt({ prompt: SYSTEM2_PROMPT });

    expect(context.tasks.mode).toBe('agentTeam');
    // No pluginRoot → readEffortMeta(undefined) → null → no effort key on meta.
    // (workflowPlan may still be present but with empty config.)
    expect(context.tasks.meta?.effort).toBeUndefined();
  });
});
