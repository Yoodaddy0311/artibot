import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createArtibotAgent } from '../../lib/runtime/create-artibot-agent.js';
import { createRouterMiddleware } from '../../lib/runtime/middleware/router.js';
import { createSkillsMiddleware } from '../../lib/runtime/middleware/skills.js';
import { createTasksMiddleware } from '../../lib/runtime/middleware/tasks.js';
import { createSubagentsMiddleware } from '../../lib/runtime/middleware/subagents.js';
import { createSummarizationMiddleware } from '../../lib/runtime/middleware/summarization.js';
import { createCheckpointMiddleware, readCheckpoints } from '../../lib/runtime/middleware/checkpoint.js';
import {
  evaluateRuntimeScenario,
  evaluateRuntimeSuite,
} from '../../lib/runtime/evaluator.js';

const BASE_CONFIG = {
  automation: { supportedLanguages: ['en'], ambiguityThreshold: 50 },
  team: {
    enabled: true,
    delegationModeSelection: {
      subAgent: { tools: ['Task'], communication: 'one-way (result return only)' },
      agentTeam: {
        tools: ['TeamCreate', 'SendMessage', 'TaskCreate'],
        communication: 'P2P bidirectional + shared task list',
      },
    },
  },
};

function makeRuntime(overrides = {}) {
  return createArtibotAgent({
    config: BASE_CONFIG,
    now: () => 1700000000000,
    checkpointStore: new Map(),
    checkpointOptions: { persistToDisk: false },
    ...overrides,
  });
}

function grade(result) {
  const system = result.context.routing.system;
  const score = Number(
    (
      0.5 +
      (system === 'system2' ? 0.25 : 0) +
      (result.context.checkpoint?.persisted ? 0.15 : 0) +
      (result.context.subagents.contract?.mode === 'agentTeam' ? 0.1 : 0)
    ).toFixed(2),
  );
  return { pass: score >= 0.55, score };
}

describe('Runtime Task Eval Suite', () => {
  it('grades simple typo/fix prompt as System 1 success', async () => {
    const runtime = makeRuntime();
    const result = await runtime.preparePrompt({
      prompt: 'fix the typo in README',
      hookData: { event: 'UserPromptSubmit' },
    });

    expect(result.context.routing.system).toBe('system1');
    expect(result.context.subagents.contract.mode).toBe('subAgent');
    const { pass, score } = grade(result);
    expect(pass).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0.6);
  });

  it('grades complex security/refactor/deploy prompt as System 2 with delegation', async () => {
    const runtime = makeRuntime();
    const prompt =
      'analyze security vulnerabilities, then refactor auth flow, then deploy to production';
    const result = await runtime.preparePrompt({
      prompt,
      hookData: { event: 'UserPromptSubmit' },
    });

    expect(result.context.routing.system).toBe('system2');
    expect(result.context.subagents.contract.mode).toBe('agentTeam');
    expect(result.context.subagents.contract.requiresPlan).toBe(true);
    expect(result.userPrompt).toContain('Delegation contract:');
    const { pass, score } = grade(result);
    expect(pass).toBe(true);
    expect(score).toBeGreaterThan(0.8);
  });

  it('maps implementation intent into command and skill suggestions', async () => {
    const runtime = makeRuntime();
    const result = await runtime.preparePrompt({
      prompt: 'implement a new REST API endpoint for user authentication',
      hookData: { event: 'UserPromptSubmit' },
    });

    expect(result.context.intent.best).toBe('action:implement');
    expect(result.context.intent.commands).toContain('/implement');
    expect(result.context.tasks.recommendedCommand).toBe('/implement');
    expect(result.context.skills.suggested).toContain('cmd-implement');
    const { pass, score } = grade(result);
    expect(pass).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0.6);
  });

  it('keeps !rv re-verification prompt across the runtime', async () => {
    const runtime = makeRuntime();
    const reverifyPayload = [
      'CRITICAL RE-VERIFICATION MODE ACTIVATED.',
      'CLAIM AUDIT',
      'EVIDENCE CHECK',
    ].join('\n');
    const result = await runtime.preparePrompt({
      hookData: { event: 'UserPromptSubmit', user_prompt: reverifyPayload },
    });

    expect(result.context.tasks.objective).toContain('CRITICAL RE-VERIFICATION MODE ACTIVATED.');
    expect(result.context.routing.system).toBe('system1');
    const { pass, score } = grade(result);
    expect(pass).toBe(true);
    expect(score).toBeGreaterThan(0.6);
  });

  it('produces checkpoint and subagent contract data for complex tasks', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'artibot-eval-'));
    const checkpointPath = path.join(dir, 'runtime-checkpoints.json');
    try {
      const runtime = makeRuntime({
        checkpointOptions: { persistToDisk: true, filePath: checkpointPath },
      });
      const prompt = 'implement CI pipeline, run tests, prepare release notes';
      const result = await runtime.preparePrompt({
        prompt,
        hookData: { event: 'UserPromptSubmit' },
      });

      expect(result.context.subagents.contract).toBeDefined();
      expect(result.context.checkpoint.persisted).toBe(true);
    expect(result.context.checkpoint.id).toMatch(/^ckpt-/);
    const { pass, score } = grade(result);
    expect(pass).toBe(true);
    expect(score).toBeGreaterThan(0.6);
      const saved = readCheckpoints(checkpointPath);
      expect(Array.isArray(saved)).toBe(true);
      expect(saved.some((entry) => entry.id === result.context.checkpoint.id)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('processes multiple prompts in parallel through middleware pipeline', async () => {
    const results = await Promise.all([
      makeRuntime().preparePrompt({ prompt: 'fix typo in readme', hookData: { event: 'UserPromptSubmit' } }),
      makeRuntime().preparePrompt({ prompt: 'analyze security vulnerabilities, then refactor auth flow, then deploy to production', hookData: { event: 'UserPromptSubmit' } }),
      makeRuntime().preparePrompt({ prompt: 'implement a new REST API endpoint for user authentication', hookData: { event: 'UserPromptSubmit' } }),
    ]);

    expect(results).toHaveLength(3);
    expect(results[0].context.routing.system).toBe('system1');
    expect(results[1].context.routing.system).toBe('system2');
    expect(results[2].context.intent.best).toBe('action:implement');
    expect(results.every((r) => r.context.runtime.name === 'artibot-runtime-phase1')).toBe(true);
  });

  it('recovers gracefully when a middleware throws', async () => {
    const failingMiddleware = async () => {
      throw new Error('simulated middleware failure');
    };
    Object.defineProperty(failingMiddleware, 'name', { value: 'failingMiddleware' });

    const runtime = createArtibotAgent({
      config: BASE_CONFIG,
      now: () => 1700000000000,
      checkpointStore: new Map(),
      middleware: [
        createRouterMiddleware(),
        failingMiddleware,
        createSkillsMiddleware(),
        createTasksMiddleware({ now: () => 1700000000000 }),
        createSubagentsMiddleware(),
        createSummarizationMiddleware(),
        createCheckpointMiddleware({ store: new Map(), now: () => 1700000000000, persistToDisk: false }),
      ],
    });

    const result = await runtime.preparePrompt({
      prompt: 'build a dashboard with charts and authentication',
      hookData: { event: 'UserPromptSubmit' },
    });

    expect(result).toBeDefined();
    expect(result.context.routing).toBeDefined();
    expect(result.message).toContain('error');
    expect(result.userPrompt.length).toBeGreaterThan(0);
  });

  it('routes scheduling-related prompts and produces valid context', async () => {
    const runtime = makeRuntime();
    const result = await runtime.preparePrompt({
      prompt: 'schedule nightly learning at 2 AM',
      hookData: { event: 'UserPromptSubmit' },
    });

    expect(result.context.routing).toBeDefined();
    expect(result.context.intent).toBeDefined();
    expect(result.userPrompt.length).toBeGreaterThan(0);
    expect(result.context.runtime.name).toBe('artibot-runtime-phase1');
  });
});

describe('Evaluator scenario runner', () => {
  it('evaluateRuntimeScenario includes timing and memory metrics', async () => {
    const scenario = {
      id: 'test-metrics',
      name: 'Metrics test',
      run: async () => ({ value: 42 }),
      evaluate: (output) => [
        { name: 'has-value', passed: output.value === 42, detail: String(output.value), critical: true },
      ],
    };

    const result = await evaluateRuntimeScenario(scenario);
    expect(result.durationMs).toBeTypeOf('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.memDeltaBytes).toBeTypeOf('number');
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  it('evaluateRuntimeSuite includes suiteDurationMs and supports parallel mode', async () => {
    const scenarios = [
      {
        id: 'fast-a',
        name: 'Fast A',
        run: async () => ({ ok: true }),
        evaluate: () => [{ name: 'ok', passed: true, detail: 'ok', critical: true }],
      },
      {
        id: 'fast-b',
        name: 'Fast B',
        run: async () => ({ ok: true }),
        evaluate: () => [{ name: 'ok', passed: true, detail: 'ok', critical: true }],
      },
    ];

    const report = await evaluateRuntimeSuite(scenarios, { parallel: true });
    expect(report.suiteDurationMs).toBeTypeOf('number');
    expect(report.total).toBe(2);
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(0);
    expect(report.results).toHaveLength(2);
    expect(report.results[0].durationMs).toBeTypeOf('number');
  });
});
