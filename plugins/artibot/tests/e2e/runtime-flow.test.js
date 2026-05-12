import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

function runHook(scriptName, payload) {
  const scriptPath = path.join(PLUGIN_ROOT, 'scripts', 'hooks', scriptName);
  const stdout = execFileSync(
    process.execPath,
    [scriptPath],
    {
      cwd: PLUGIN_ROOT,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
        ARTIBOT_RUNTIME_CHECKPOINT_DISABLE: '1',
        ARTIBOT_RUNTIME_MEMORY_DISABLE: '1',
      },
      input: JSON.stringify(payload),
      encoding: 'utf-8',
    },
  ).trim();

  if (!stdout) return null;
  return JSON.parse(stdout);
}

function runHookChain(promptValue) {
  const basePayload = { user_prompt: promptValue, event: 'UserPromptSubmit' };
  const firstOutput = runHook('user-prompt-handler.js', basePayload);
  const runtimePayload = {
    ...basePayload,
    user_prompt: firstOutput?.user_prompt || promptValue,
  };
  const runtimeOutput = runHook('runtime-prompt.js', runtimePayload);
  return { firstOutput, runtimeOutput };
}

describe('hook-chain runtime flow', () => {
  it('applies System 1 rewrite when the prompt stays simple', () => {
    const { firstOutput, runtimeOutput } = runHookChain('fix typo in readme');
    expect(firstOutput).toBeNull();
    expect(runtimeOutput).not.toBeNull();
    expect(runtimeOutput.message).toContain('[runtime]');
    expect(runtimeOutput.message).toContain('route=SYSTEM1');
    expect(runtimeOutput.user_prompt).toContain('System 1 mode');
    expect(runtimeOutput.user_prompt).toContain('Original request:');
  }, 30000);

  it('preserves special-trigger rewrites before runtime enrichment', () => {
    const { firstOutput, runtimeOutput } = runHookChain('!rv check auth module');
    expect(firstOutput).not.toBeNull();
    expect(firstOutput.user_prompt).toContain('CRITICAL RE-VERIFICATION MODE');
    expect(runtimeOutput).not.toBeNull();
    expect(runtimeOutput.user_prompt).toContain('CRITICAL RE-VERIFICATION MODE');
    expect(runtimeOutput.message).toContain('[runtime]');
  }, 30000);

  it('preserves Korean special-trigger rewrites before runtime enrichment', () => {
    const { firstOutput, runtimeOutput } = runHookChain('!\uC7AC\uAC80\uC99D auth \uBAA8\uB4C8 \uB2E4\uC2DC \uD655\uC778');
    expect(firstOutput).not.toBeNull();
    expect(firstOutput.user_prompt).toContain('CRITICAL RE-VERIFICATION MODE');
    expect(runtimeOutput).not.toBeNull();
    expect(runtimeOutput.user_prompt).toContain('CRITICAL RE-VERIFICATION MODE');
    expect(runtimeOutput.message).toContain('[runtime]');
  }, 30000);
});
