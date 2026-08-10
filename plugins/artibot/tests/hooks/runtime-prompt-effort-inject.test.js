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
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleUserPromptSubmit } from '../../scripts/hooks/runtime-prompt.js';

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

const SCRIPT_PATH = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'runtime-prompt.js');
const REAL_CONFIG_PATH = path.join(PLUGIN_ROOT, 'artibot.config.json');

/**
 * Read-only directories the hook resolves through `getPluginRoot()` at
 * runtime: it dynamically `import()`s `lib/core/decision-trail.js`,
 * `lib/core/user-profile.js`, `lib/learning/macro-learner.js`,
 * `lib/runtime/task-budget.js` and `lib/runtime/create-artibot-agent.js`.
 * They are linked (not copied) so the suite exercises the REAL modules —
 * a sandbox root without them would make every one of those imports throw
 * into its catch block, and the effort prefix would then be absent for the
 * wrong reason, i.e. the opt-out assertion would pass vacuously.
 */
const LINKED_DIRS = ['lib', 'commands', 'skills', 'agents'];

/** sha256 of the real repo config, sampled before anything runs. */
const realConfigDigestAtStart = createHash('sha256')
  .update(readFileSync(REAL_CONFIG_PATH))
  .digest('hex');

describe('runtime-prompt effort + task-budget prefix injection', () => {
  let sandboxRoot;
  let sandboxConfigPath;
  let baseConfig;
  let savedEnv;

  beforeAll(() => {
    expect(existsSync(SCRIPT_PATH)).toBe(true);

    // The hook reads AND writes through its plugin root: it reads
    // `artibot.config.json` and writes `runtime/*.json`. Earlier revisions of
    // this suite mutated the REPO config in place to exercise the opt-out
    // branch and restored it afterwards, which left `artibot.config.json`
    // reformatted (compact arrays re-emitted multi-line by
    // `JSON.stringify(…, 2)`) whenever the restore did not complete. Instead
    // of writing the shared repo file at all, the plugin root is redirected to
    // a throwaway sandbox that owns its own copy of the config, so both the
    // config edits and the runtime/ writes land in the temp dir.
    sandboxRoot = mkdtempSync(path.join(tmpdir(), 'artibot-effort-root-'));
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    for (const dir of LINKED_DIRS) {
      symlinkSync(path.join(PLUGIN_ROOT, dir), path.join(sandboxRoot, dir), linkType);
    }

    sandboxConfigPath = path.join(sandboxRoot, 'artibot.config.json');
    copyFileSync(REAL_CONFIG_PATH, sandboxConfigPath);
    baseConfig = JSON.parse(readFileSync(sandboxConfigPath, 'utf-8'));

    // Force a deterministic config for the positive-path assertions so that
    // the suite is resilient to drift in artibot.config.json (e.g. an
    // auto-commit flipping runtime.effort.injectPrompt to false). The opt-out
    // test below writes its own config and restores in a finally block.
    writeFileSync(sandboxConfigPath, JSON.stringify(withInjectPrompt(baseConfig, true), null, 2));
  });

  afterAll(() => {
    if (sandboxRoot) rmSync(sandboxRoot, { recursive: true, force: true });
  });

  /** @returns {object} `base` with runtime.effort.injectPrompt set to `value`. */
  function withInjectPrompt(base, value) {
    return {
      ...base,
      runtime: {
        ...base.runtime,
        effort: {
          ...(base.runtime?.effort || {}),
          injectPrompt: value,
        },
      },
    };
  }

  beforeEach(() => {
    savedEnv = {
      CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT,
      ARTIBOT_RUNTIME_CHECKPOINT_DISABLE: process.env.ARTIBOT_RUNTIME_CHECKPOINT_DISABLE,
      ARTIBOT_RUNTIME_MEMORY_DISABLE: process.env.ARTIBOT_RUNTIME_MEMORY_DISABLE,
    };
    process.env.CLAUDE_PLUGIN_ROOT = sandboxRoot;
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
    // Temporarily overwrite the SANDBOX config to exercise the opt-out branch,
    // then restore in the same test to avoid cross-test bleed. The repo config
    // is never touched.
    writeFileSync(sandboxConfigPath, JSON.stringify(withInjectPrompt(baseConfig, false), null, 2));

    try {
      const output = await handleUserPromptSubmit({
        user_prompt: '/implement add oauth login',
        event: 'UserPromptSubmit',
      });

      expect(output).not.toBeNull();
      expect(output.user_prompt).not.toMatch(/^\[artibot:effort/);
      expect(output.user_prompt).toContain('/implement add oauth login');
    } finally {
      // Restore forced (injectPrompt:true) config so subsequent tests
      // observe the same baseline as beforeAll set up.
      writeFileSync(sandboxConfigPath, JSON.stringify(withInjectPrompt(baseConfig, true), null, 2));
    }
  });

  /**
   * Isolation self-check. The suite drives the real hook, which persists
   * `runtime/*.json` and reads `artibot.config.json` from its plugin root; both
   * must land in the sandbox, not the repo.
   *
   * Blind spots this does NOT cover: writes reaching the repo through the
   * linked directories (`lib/`, `commands/`, `skills/`, `agents/` are
   * junctions, so a write through them still hits the real tree — none of the
   * exercised code paths writes there), and writes to `<home>/.claude/`, which
   * this suite was measured not to make.
   */
  it('leaves the repo config untouched and redirects runtime writes to the sandbox', () => {
    const digestNow = createHash('sha256').update(readFileSync(REAL_CONFIG_PATH)).digest('hex');
    expect(digestNow).toBe(realConfigDigestAtStart);

    // Positive proof the redirection actually took effect: had CLAUDE_PLUGIN_ROOT
    // still pointed at the repo, these writes would have gone there instead.
    expect(existsSync(path.join(sandboxRoot, 'runtime'))).toBe(true);
  });
});
