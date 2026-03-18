import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const PLUGIN_ROOT = path.resolve(
  decodeURIComponent(
    path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1')),
  ),
  '..', '..',
);

const SCRIPT_PATH = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'runtime-prompt.js');

function runHook(payload) {
  const stdout = execFileSync(
    process.execPath,
    [SCRIPT_PATH],
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

  return stdout ? JSON.parse(stdout) : null;
}

describe('runtime-prompt hook', () => {
  it('returns no stdout when prompt payload is missing', () => {
    const output = runHook({ other: 'value' });
    expect(output).toBeNull();
  });

  it('consumes a prompt already rewritten by user-prompt-handler', () => {
    const output = runHook({
      user_prompt: 'CRITICAL RE-VERIFICATION MODE ACTIVATED.\nCLAIM AUDIT\nEVIDENCE CHECK',
      event: 'UserPromptSubmit',
    });

    expect(output).not.toBeNull();
    expect(output.message).toContain('[runtime]');
    expect(output.user_prompt).toContain('CRITICAL RE-VERIFICATION MODE ACTIVATED.');
  });

  it('rewrites a simple prompt through the Phase 1 runtime path', () => {
    const output = runHook({
      user_prompt: 'fix typo in readme',
      event: 'UserPromptSubmit',
    });

    expect(output).not.toBeNull();
    expect(output.message).toContain('[runtime]');
    expect(output.message).toContain('route=SYSTEM1');
    expect(output.user_prompt).toContain('System 1 mode');
    expect(output.user_prompt).toContain('Original request:');
    expect(output.user_prompt).toContain('fix typo in readme');
  });

  it('rewrites a complex prompt through the Phase 1 runtime path', () => {
    const output = runHook({
      user_prompt: 'analyze security vulnerabilities, then refactor auth flow, then deploy to production',
      event: 'UserPromptSubmit',
    });

    expect(output).not.toBeNull();
    expect(output.message).toContain('[runtime]');
    expect(output.message).toContain('route=SYSTEM2');
    expect(output.user_prompt).toContain('System 2 mode');
    expect(output.user_prompt).toContain('Execution contract:');
  });
});
