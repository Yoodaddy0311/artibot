/**
 * P3-1 / P3-2 — runtime-prompt.js effort+task-budget prefix injection.
 *
 * Verifies that slash commands are auto-wired with:
 *   [artibot:effort level=<X> command=<cmd>][artibot:task-budget max_tokens=<N>]
 * at the start of the user prompt, and that the opt-out flag
 * `runtime.effort.injectPrompt=false` leaves the prompt untouched.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

const SCRIPT_PATH = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'runtime-prompt.js');
const CONFIG_PATH = path.join(PLUGIN_ROOT, 'artibot.config.json');

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

describe('runtime-prompt effort + task-budget prefix injection', () => {
  let originalConfig;

  beforeAll(() => {
    expect(existsSync(SCRIPT_PATH)).toBe(true);
    originalConfig = readFileSync(CONFIG_PATH, 'utf-8');
  });

  afterAll(() => {
    // Always restore the real config even if an earlier assertion threw.
    writeFileSync(CONFIG_PATH, originalConfig);
  });

  it('injects effort + task-budget prefix for /implement', () => {
    const output = runHook({
      user_prompt: '/implement add oauth login',
      event: 'UserPromptSubmit',
    });

    expect(output).not.toBeNull();
    expect(output.user_prompt).toMatch(
      /^\[artibot:effort level=xhigh command=implement\]\[artibot:task-budget max_tokens=128000\]/,
    );
    // Prefix is followed by blank line, then the (possibly-prepared) prompt
    // which must still carry the original request text somewhere.
    expect(output.user_prompt).toMatch(
      /\[artibot:task-budget max_tokens=128000\]\n\n/,
    );
    expect(output.user_prompt).toContain('/implement add oauth login');
  }, 30000);

  it('injects prefix for /code-review at high effort (64000 tokens)', () => {
    const output = runHook({
      user_prompt: '/code-review auth module',
      event: 'UserPromptSubmit',
    });

    expect(output).not.toBeNull();
    expect(output.user_prompt).toMatch(
      /^\[artibot:effort level=high command=code-review\]\[artibot:task-budget max_tokens=64000\]/,
    );
  }, 30000);

  it('does not inject prefix for prompts without a slash command', () => {
    const output = runHook({
      user_prompt: 'fix typo in readme',
      event: 'UserPromptSubmit',
    });

    expect(output).not.toBeNull();
    expect(output.user_prompt).not.toMatch(/^\[artibot:effort/);
    expect(output.user_prompt).toContain('fix typo in readme');
  }, 30000);

  it('respects runtime.effort.injectPrompt=false (opt-out)', () => {
    // Temporarily overwrite config to exercise the opt-out branch,
    // then restore in the same test to avoid cross-test bleed.
    const base = JSON.parse(originalConfig);
    const optOut = {
      ...base,
      runtime: {
        ...base.runtime,
        effort: {
          ...(base.runtime?.effort || {}),
          injectPrompt: false,
        },
      },
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(optOut, null, 2));

    try {
      const output = runHook({
        user_prompt: '/implement add oauth login',
        event: 'UserPromptSubmit',
      });

      expect(output).not.toBeNull();
      expect(output.user_prompt).not.toMatch(/^\[artibot:effort/);
      expect(output.user_prompt).toContain('/implement add oauth login');
    } finally {
      writeFileSync(CONFIG_PATH, originalConfig);
    }
  }, 30000);
});
