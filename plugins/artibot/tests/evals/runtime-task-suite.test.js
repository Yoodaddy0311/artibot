import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createArtibotAgent } from '../../lib/runtime/create-artibot-agent.js';

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
      const saved = JSON.parse(await readFile(checkpointPath, 'utf-8'));
      expect(Array.isArray(saved.entries)).toBe(true);
      expect(saved.entries.some((entry) => entry.id === result.context.checkpoint.id)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
