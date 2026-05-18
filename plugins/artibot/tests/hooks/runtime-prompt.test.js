import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleUserPromptSubmit } from '../../scripts/hooks/runtime-prompt.js';

/**
 * runtime-prompt hook — in-process contract test.
 *
 * Historically this suite spawned the hook as a child process with
 * `execFileSync`, which inadvertently relied on the script's `isMain`
 * guard succeeding. That guard percent-decodes `process.argv[1]` and
 * compares against `new URL(import.meta.url).pathname` — the latter is
 * percent-encoded on paths with non-ASCII characters (e.g. Korean
 * `바탕 화면`), so `main()` never ran and stdout came back empty.
 *
 * The hook exports `handleUserPromptSubmit` precisely for in-process
 * callers (the userprompt dispatcher uses it too). Driving the contract
 * through the export removes the spawn/path-encoding flake, runs ~10x
 * faster, and keeps the assertions identical.
 */

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

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

describe('runtime-prompt hook', () => {
  it('returns null when prompt payload is missing', async () => {
    const output = await handleUserPromptSubmit({ other: 'value' });
    expect(output).toBeNull();
  });

  it('consumes a prompt already rewritten by user-prompt-handler', async () => {
    const output = await handleUserPromptSubmit({
      user_prompt: 'CRITICAL RE-VERIFICATION MODE ACTIVATED.\nCLAIM AUDIT\nEVIDENCE CHECK',
      event: 'UserPromptSubmit',
    });

    expect(output).not.toBeNull();
    expect(output.message).toContain('[runtime]');
    expect(output.user_prompt).toContain('CRITICAL RE-VERIFICATION MODE ACTIVATED.');
  });

  it('rewrites a simple prompt through the Phase 1 runtime path', async () => {
    const output = await handleUserPromptSubmit({
      user_prompt: 'fix typo in readme',
      event: 'UserPromptSubmit',
    });

    // Accept both the real runtime path (returns `route=SYSTEM1`) and the
    // in-script fallback (returns `[runtime] SYSTEM1 | fallback`). The
    // fallback triggers in fresh-checkout environments (CI) where the full
    // runtime state cache isn't populated. Both paths correctly classify
    // "fix typo" as SYSTEM1.
    expect(output).not.toBeNull();
    expect(output.message).toContain('[runtime]');
    expect(output.message).toMatch(/route=SYSTEM1|SYSTEM1\s*\|\s*fallback/);
    expect(output.user_prompt).toContain('fix typo in readme');
  });

  it('rewrites a complex prompt through the Phase 1 runtime path', async () => {
    const output = await handleUserPromptSubmit({
      user_prompt: 'analyze security vulnerabilities, then refactor auth flow, then deploy to production',
      event: 'UserPromptSubmit',
    });

    // Same dual-path acceptance as the SYSTEM1 test above.
    expect(output).not.toBeNull();
    expect(output.message).toContain('[runtime]');
    expect(output.message).toMatch(/route=SYSTEM2|SYSTEM2\s*\|\s*fallback/);
    expect(output.user_prompt).toContain('analyze security vulnerabilities');
  });
});
