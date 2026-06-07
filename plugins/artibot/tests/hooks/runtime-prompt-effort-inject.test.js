/**
 * P3-1 / P3-2 — runtime-prompt.js effort+task-budget prefix injection.
 *
 * Verifies that slash commands are auto-wired with:
 *   [artibot:effort level=<X> command=<cmd>][artibot:task-budget max_tokens=<N>]
 * at the start of the user prompt, and that the opt-out flag
 * `runtime.effort.injectPrompt=false` leaves the prompt untouched.
 *
 * Migrated 2026-05-16 from `execFileSync` to in-process import. The CLI
 * pathway depended on `isMain` correctly matching `process.argv[1]`
 * against `import.meta.url`, but the latter percent-encodes non-ASCII
 * path segments (e.g. Korean `바탕 화면`) and the comparison fell
 * through to `false`, so `main()` never ran. Calling the exported
 * handler bypasses that fragility while exercising the same contract.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleUserPromptSubmit } from '../../scripts/hooks/runtime-prompt.js';

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

const SCRIPT_PATH = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'runtime-prompt.js');
const CONFIG_PATH = path.join(PLUGIN_ROOT, 'artibot.config.json');

describe('runtime-prompt effort + task-budget prefix injection', () => {
  let originalConfig;
  let savedEnv;

  beforeAll(() => {
    expect(existsSync(SCRIPT_PATH)).toBe(true);
    originalConfig = readFileSync(CONFIG_PATH, 'utf-8');
    // Force a deterministic config for the positive-path assertions so that
    // the suite is resilient to drift in artibot.config.json (e.g. an
    // auto-commit flipping runtime.effort.injectPrompt to false). The opt-out
    // test below writes its own config and restores in a finally block.
    const base = JSON.parse(originalConfig);
    const forced = {
      ...base,
      runtime: {
        ...base.runtime,
        effort: {
          ...(base.runtime?.effort || {}),
          injectPrompt: true,
        },
      },
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(forced, null, 2));
  });

  afterAll(() => {
    // Always restore the real config even if an earlier assertion threw.
    writeFileSync(CONFIG_PATH, originalConfig);
  });

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

  // Budget-per-band (artibot.config.json#/runtime/effort/budgetMap, == DEFAULT_BUDGET_MAP).
  const BUDGET_BY_LEVEL = { max: 200000, xhigh: 128000, high: 64000, medium: 32000, low: 16000 };

  it('injects effort + task-budget prefix for /implement', async () => {
    const output = await handleUserPromptSubmit({
      user_prompt: '/implement add oauth login',
      event: 'UserPromptSubmit',
    });

    expect(output).not.toBeNull();
    // P1 (Score-Aware Effort): the injected level is the command baseline
    // (implement→xhigh) shifted ±1 by prompt complexity, so assert the
    // injection CONTRACT — a valid band + the budget matching that band —
    // rather than a fixed level that breaks whenever scoring changes.
    const m = output.user_prompt.match(
      /^\[artibot:effort level=(low|medium|high|xhigh|max) command=implement\]\[artibot:task-budget max_tokens=(\d+)\]/,
    );
    expect(m).not.toBeNull();
    expect(Number(m[2])).toBe(BUDGET_BY_LEVEL[m[1]]);
    // Prefix is followed by blank line, then the (possibly-prepared) prompt
    // which must still carry the original request text somewhere.
    expect(output.user_prompt).toMatch(/\[artibot:task-budget max_tokens=\d+\]\n\n/);
    expect(output.user_prompt).toContain('/implement add oauth login');
  });

  it('injects effort + task-budget prefix for /code-review (band/budget consistent)', async () => {
    const output = await handleUserPromptSubmit({
      user_prompt: '/code-review auth module',
      event: 'UserPromptSubmit',
    });

    expect(output).not.toBeNull();
    const m = output.user_prompt.match(
      /^\[artibot:effort level=(low|medium|high|xhigh|max) command=code-review\]\[artibot:task-budget max_tokens=(\d+)\]/,
    );
    expect(m).not.toBeNull();
    expect(Number(m[2])).toBe(BUDGET_BY_LEVEL[m[1]]);
  });

  it('does not inject prefix for prompts without a slash command', async () => {
    const output = await handleUserPromptSubmit({
      user_prompt: 'fix typo in readme',
      event: 'UserPromptSubmit',
    });

    expect(output).not.toBeNull();
    expect(output.user_prompt).not.toMatch(/^\[artibot:effort/);
    expect(output.user_prompt).toContain('fix typo in readme');
  });

  it('respects runtime.effort.injectPrompt=false (opt-out)', async () => {
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
      const output = await handleUserPromptSubmit({
        user_prompt: '/implement add oauth login',
        event: 'UserPromptSubmit',
      });

      expect(output).not.toBeNull();
      expect(output.user_prompt).not.toMatch(/^\[artibot:effort/);
      expect(output.user_prompt).toContain('/implement add oauth login');
    } finally {
      // Restore forced (injectPrompt:true) config so subsequent suite runs
      // observe the same baseline as beforeAll set up.
      const forced = {
        ...base,
        runtime: {
          ...base.runtime,
          effort: {
            ...(base.runtime?.effort || {}),
            injectPrompt: true,
          },
        },
      };
      writeFileSync(CONFIG_PATH, JSON.stringify(forced, null, 2));
    }
  });
});
