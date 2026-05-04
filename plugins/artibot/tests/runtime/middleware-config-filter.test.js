import { describe, expect, it, vi } from 'vitest';
import { createArtibotAgent } from '../../lib/runtime/create-artibot-agent.js';

const BASE_CONFIG = {
  automation: { supportedLanguages: ['en', 'ko'], ambiguityThreshold: 50 },
  team: { enabled: true },
  cognitive: { router: { threshold: 0.4 } },
};

function makeRuntime(configOverrides = {}, options = {}) {
  return createArtibotAgent({
    config: { ...BASE_CONFIG, ...configOverrides },
    now: () => 1700000000000,
    checkpointOptions: { persistToDisk: false },
    ...options,
  });
}

describe('runtime/middleware config filtering', () => {
  it('loads all default middleware when config.runtime.middleware is absent', async () => {
    const runtime = makeRuntime({});
    const result = await runtime.preparePrompt({
      prompt: 'hello world',
      hookData: { event: 'UserPromptSubmit' },
    });

    const names = result.context.runtime.middleware;
    // All 10 default middleware should be present
    expect(names.length).toBe(10);
  });

  it('loads all default middleware when config.runtime.middleware is empty array', async () => {
    const runtime = makeRuntime({ runtime: { middleware: [] } });
    const result = await runtime.preparePrompt({
      prompt: 'hello world',
      hookData: { event: 'UserPromptSubmit' },
    });

    const names = result.context.runtime.middleware;
    expect(names.length).toBe(10);
  });

  it('filters middleware to only those listed in config.runtime.middleware', async () => {
    const runtime = makeRuntime({
      runtime: { middleware: ['router', 'memory'] },
    });
    const result = await runtime.preparePrompt({
      prompt: 'hello world',
      hookData: { event: 'UserPromptSubmit' },
    });

    const names = result.context.runtime.middleware;
    expect(names.length).toBe(2);
  });

  it('preserves default pipeline order regardless of config order', async () => {
    // Config lists memory before router, but pipeline should run router first
    const runtime = makeRuntime({
      runtime: { middleware: ['memory', 'router', 'lifecycle'] },
    });
    const result = await runtime.preparePrompt({
      prompt: 'hello world',
      hookData: { event: 'UserPromptSubmit' },
    });

    const names = result.context.runtime.middleware;
    // Should be ordered: lifecycle, router, memory (pipeline order, not config order)
    expect(names.length).toBe(3);
  });

  it('ignores unknown middleware names in config without error', async () => {
    const runtime = makeRuntime({
      runtime: { middleware: ['router', 'nonexistent-mw', 'memory'] },
    });
    const result = await runtime.preparePrompt({
      prompt: 'hello world',
      hookData: { event: 'UserPromptSubmit' },
    });

    const names = result.context.runtime.middleware;
    // Only known middleware should be included
    expect(names.length).toBe(2);
  });

  it('skips disabled middleware in phased execution', async () => {
    // Only enable router and lifecycle — skills, memory, tasks, etc. should not run
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const runtime = makeRuntime({
      runtime: { middleware: ['lifecycle', 'router'] },
    });
    const result = await runtime.preparePrompt({
      prompt: 'fix typo in readme',
      hookData: { event: 'UserPromptSubmit' },
    });

    // Should have routing context (router ran) but NOT skills/tasks/subagents context
    expect(result.context.routing).toBeDefined();
    expect(result.context.skills).toBeUndefined();
    expect(result.context.tasks).toBeUndefined();
    expect(result.context.subagents).toBeUndefined();
    expect(result.context.checkpoint).toBeUndefined();

    stderrSpy.mockRestore();
  });

  it('supports disabling a single middleware (e.g., summarization)', async () => {
    // All defaults except summarization
    const allExceptSummarization = [
      'lifecycle', 'router', 'memory', 'skills', 'tasks',
      'subagents', 'guardrail', 'token-usage', 'checkpoint',
    ];
    const runtime = makeRuntime({
      runtime: { middleware: allExceptSummarization },
    });
    const result = await runtime.preparePrompt({
      prompt: 'build a dashboard component',
      hookData: { event: 'UserPromptSubmit' },
    });

    const names = result.context.runtime.middleware;
    expect(names.length).toBe(9);
    // Summarization context should not be set
    expect(result.context.summarization).toBeUndefined();
  });

  it('custom middleware option still overrides config filtering', async () => {
    const customMw = async (state) => {
      state.context.custom = true;
    };
    Object.defineProperty(customMw, 'name', { value: 'testCustom' });

    const runtime = makeRuntime(
      { runtime: { middleware: ['router'] } },
      { middleware: [customMw] },
    );
    const result = await runtime.preparePrompt({
      prompt: 'hello world',
      hookData: { event: 'UserPromptSubmit' },
    });

    // Custom middleware should have run, not the config-filtered pipeline
    expect(result.context.custom).toBe(true);
  });

  it('handles non-array runtime.middleware gracefully (string, number, null)', async () => {
    for (const invalidValue of ['router', 42, null, undefined, true]) {
      const runtime = makeRuntime({
        runtime: { middleware: invalidValue },
      });
      const result = await runtime.preparePrompt({
        prompt: 'hello world',
        hookData: { event: 'UserPromptSubmit' },
      });

      // Should fall back to all defaults
      expect(result.context.runtime.middleware.length).toBe(10);
    }
  });
});
