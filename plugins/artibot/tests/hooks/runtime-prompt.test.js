import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

/**
 * SETUP-ONLY ISOLATION (assertions and fixtures below are untouched).
 *
 * This suite used to point `CLAUDE_PLUGIN_ROOT` at the REAL plugin root, so
 * running it mutated the developer's live `runtime/` — `token-usage-session.json`
 * on every run, and (once the recorder-stats flush landed) a line in the real
 * `runtime/decisions/` store that `/doctor` reads. Writing fixture data into the
 * store a health check reads is worse than recording nothing.
 *
 * The sandbox LINKS the real `lib/`, `commands/`, `skills/` and `agents/` and
 * copies the real `artibot.config.json`, so the hook still resolves the REAL
 * modules and the REAL config — the runtime path these tests exercise is
 * unchanged. Only the writable `runtime/` directory is redirected.
 *
 * Links, not copies: a sandbox missing the modules would send every dynamic
 * import into its catch block, and the dual-path assertions below (which accept
 * the in-script fallback) would then pass for the wrong reason.
 */
const LINKED_DIRS = ['lib', 'commands', 'skills', 'agents'];

let sandboxRoot = '';
let savedEnv;

beforeAll(() => {
  sandboxRoot = mkdtempSync(path.join(tmpdir(), 'artibot-runtime-prompt-'));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const dir of LINKED_DIRS) {
    symlinkSync(path.join(PLUGIN_ROOT, dir), path.join(sandboxRoot, dir), linkType);
  }
  copyFileSync(
    path.join(PLUGIN_ROOT, 'artibot.config.json'),
    path.join(sandboxRoot, 'artibot.config.json'),
  );
  mkdirSync(path.join(sandboxRoot, 'runtime'), { recursive: true });
});

afterAll(() => {
  if (sandboxRoot) rmSync(sandboxRoot, { recursive: true, force: true });
});

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
