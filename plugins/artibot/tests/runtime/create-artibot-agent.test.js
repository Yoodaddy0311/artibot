import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createArtibotAgent } from '../../lib/runtime/create-artibot-agent.js';

const TEST_CONFIG = {
  automation: {
    supportedLanguages: ['en', 'ko'],
    ambiguityThreshold: 50,
  },
  team: {
    enabled: true,
    delegationModeSelection: {
      subAgent: {
        tools: ['Task'],
        communication: 'one-way (result return only)',
      },
      agentTeam: {
        tools: ['TeamCreate', 'TaskCreate', 'TaskUpdate'],
        communication: 'P2P bidirectional + shared task list',
      },
    },
  },
  cognitive: {
    router: {
      threshold: 0.4,
    },
  },
};

function makeRuntime(overrides = {}) {
  return createArtibotAgent({
    config: TEST_CONFIG,
    now: () => 1700000000000,
    checkpointOptions: {
      persistToDisk: false,
    },
    ...overrides,
  });
}

describe('runtime/createArtibotAgent', () => {
  it('returns concrete API with preparePrompt()', () => {
    const runtime = makeRuntime();
    expect(runtime).toBeDefined();
    expect(typeof runtime.preparePrompt).toBe('function');
  });

  it('preparePrompt returns { userPrompt, message, context } with structured snapshot', async () => {
    const runtime = makeRuntime();
    const result = await runtime.preparePrompt({
      prompt: 'build a dashboard component',
      hookData: { event: 'UserPromptSubmit', cwd: '/tmp/demo' },
    });

    expect(result).toHaveProperty('userPrompt');
    expect(result).toHaveProperty('message');
    expect(result).toHaveProperty('context');
    expect(typeof result.userPrompt).toBe('string');
    expect(typeof result.message).toBe('string');
    expect(typeof result.context).toBe('object');

    expect(result.context.runtime.name).toBe('artibot-runtime-phase1');
    expect(result.context).toHaveProperty('routing');
    expect(result.context).toHaveProperty('intent');
    expect(result.context).toHaveProperty('tasks');
    expect(result.context).toHaveProperty('subagents');
    expect(result.context).toHaveProperty('skills');
    expect(result.context).toHaveProperty('backend');
  });

  it('rewrites simple prompt into System 1 mode', async () => {
    const runtime = makeRuntime();
    const result = await runtime.preparePrompt({
      prompt: 'fix typo in readme',
      hookData: { event: 'UserPromptSubmit' },
    });

    expect(result.context.routing.system).toBe('system1');
    expect(result.userPrompt).toContain('System 1 mode');
    expect(result.userPrompt).toContain('Original request:');
    expect(result.message).toContain('route=SYSTEM1');
    expect(result.context.subagents.contract.mode).toBe('subAgent');
  });

  it('rewrites complex prompt into System 2 mode with execution contract', async () => {
    const runtime = makeRuntime();
    const result = await runtime.preparePrompt({
      prompt: 'analyze security vulnerabilities, then refactor auth flow, then deploy to production',
      hookData: { event: 'UserPromptSubmit' },
    });

    expect(result.context.routing.system).toBe('system2');
    expect(result.userPrompt).toContain('System 2 mode');
    expect(result.userPrompt).toContain('Execution contract:');
    expect(result.userPrompt).toContain('Delegation contract:');
    expect(result.message).toContain('route=SYSTEM2');
    expect(result.message).toContain('delegate=agentTeam');
    expect(result.context.subagents.contract.mode).toBe('agentTeam');
    expect(result.context.subagents.contract.requiresPlan).toBe(true);
  });

  it('derives command and skill suggestions from implementation intent', async () => {
    const runtime = makeRuntime();
    const result = await runtime.preparePrompt({
      prompt: 'implement a new REST API endpoint for user authentication',
      hookData: { event: 'UserPromptSubmit' },
    });

    expect(result.context.intent.best).toBe('action:implement');
    expect(result.context.intent.commands).toContain('/implement');
    expect(result.context.tasks.recommendedCommand).toBe('/implement');
    expect(result.context.skills.suggested).toContain('cmd-implement');
  });

  it('persists checkpoints to disk when a file path is provided', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'artibot-runtime-'));
    const checkpointPath = path.join(dir, 'checkpoints.json');

    try {
      const runtime = makeRuntime({
        checkpointStore: new Map(),
        checkpointOptions: {
          filePath: checkpointPath,
        },
      });

      const result = await runtime.preparePrompt({
        prompt: 'analyze security vulnerabilities, then refactor auth flow, then deploy to production',
        hookData: { event: 'UserPromptSubmit' },
      });

      expect(result.context.checkpoint.id).toMatch(/^ckpt-/);
      expect(result.context.checkpoint.persisted).toBe(true);
      expect(result.context.checkpoint.filePath).toBe(checkpointPath);

      const saved = JSON.parse(await readFile(checkpointPath, 'utf-8'));
      expect(Array.isArray(saved.entries)).toBe(true);
      expect(saved.entries).toHaveLength(1);
      expect(saved.entries[0].id).toBe(result.context.checkpoint.id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
