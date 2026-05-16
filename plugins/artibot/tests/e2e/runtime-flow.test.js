import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleUserPromptSubmit as handleSpecialTrigger } from '../../scripts/hooks/user-prompt-handler.js';
import { handleUserPromptSubmit as handleRuntimePrompt } from '../../scripts/hooks/runtime-prompt.js';

/**
 * Hook-chain runtime flow — in-process.
 *
 * Previously this suite spawned both hooks via `execFileSync` to exercise
 * the dispatcher contract end-to-end. That worked when the plugin lived
 * on an ASCII filesystem path but silently failed on paths containing
 * non-ASCII segments (e.g. Korean `바탕 화면`): the scripts' `isMain`
 * guard compares decoded `process.argv[1]` against `new URL(import.meta.url).pathname`,
 * and the latter percent-encodes those segments — so `main()` never ran
 * and stdout was empty.
 *
 * Both hooks export `handleUserPromptSubmit` for the in-process
 * dispatcher (`_userprompt-dispatcher.js`). Driving the chain through
 * those exports tests the same contract without the spawn/encoding
 * fragility.
 */

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

async function runHookChain(promptValue) {
  const basePayload = { user_prompt: promptValue, event: 'UserPromptSubmit' };
  const firstOutput = handleSpecialTrigger(basePayload);
  const runtimePayload = {
    ...basePayload,
    user_prompt: firstOutput?.user_prompt || promptValue,
  };
  const runtimeOutput = await handleRuntimePrompt(runtimePayload);
  return { firstOutput, runtimeOutput };
}

describe('hook-chain runtime flow', () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = {
      CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT,
      ARTIBOT_RUNTIME_CHECKPOINT_DISABLE: process.env.ARTIBOT_RUNTIME_CHECKPOINT_DISABLE,
      ARTIBOT_RUNTIME_MEMORY_DISABLE: process.env.ARTIBOT_RUNTIME_MEMORY_DISABLE,
    };
    process.env.CLAUDE_PLUGIN_ROOT = PLUGIN_ROOT;
    process.env.ARTIBOT_RUNTIME_CHECKPOINT_DISABLE = '1';
    process.env.ARTIBOT_RUNTIME_MEMORY_DISABLE = '1';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('applies System 1 rewrite when the prompt stays simple', async () => {
    const { firstOutput, runtimeOutput } = await runHookChain('fix typo in readme');
    expect(firstOutput).toBeNull();
    expect(runtimeOutput).not.toBeNull();
    expect(runtimeOutput.message).toContain('[runtime]');
    expect(runtimeOutput.message).toContain('route=SYSTEM1');
    expect(runtimeOutput.user_prompt).toContain('System 1 mode');
    expect(runtimeOutput.user_prompt).toContain('Original request:');
  });

  it('preserves special-trigger rewrites before runtime enrichment', async () => {
    const { firstOutput, runtimeOutput } = await runHookChain('!rv check auth module');
    expect(firstOutput).not.toBeNull();
    expect(firstOutput.user_prompt).toContain('CRITICAL RE-VERIFICATION MODE');
    expect(runtimeOutput).not.toBeNull();
    expect(runtimeOutput.user_prompt).toContain('CRITICAL RE-VERIFICATION MODE');
    expect(runtimeOutput.message).toContain('[runtime]');
  });

  it('preserves Korean special-trigger rewrites before runtime enrichment', async () => {
    const { firstOutput, runtimeOutput } = await runHookChain('!\uC7AC\uAC80\uC99D auth \uBAA8\uB4C8 \uB2E4\uC2DC \uD655\uC778');
    expect(firstOutput).not.toBeNull();
    expect(firstOutput.user_prompt).toContain('CRITICAL RE-VERIFICATION MODE');
    expect(runtimeOutput).not.toBeNull();
    expect(runtimeOutput.user_prompt).toContain('CRITICAL RE-VERIFICATION MODE');
    expect(runtimeOutput.message).toContain('[runtime]');
  });
});
