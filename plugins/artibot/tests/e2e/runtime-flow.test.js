import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  const basePayload = { user_prompt: promptValue, event: 'UserPromptSubmit', cwd: sandboxRoot };
  const firstOutput = handleSpecialTrigger(basePayload);
  const runtimePayload = {
    ...basePayload,
    user_prompt: firstOutput?.user_prompt || promptValue,
  };
  const runtimeOutput = await handleRuntimePrompt(runtimePayload);
  return { firstOutput, runtimeOutput };
}

/**
 * SETUP-ONLY ISOLATION (assertions and fixtures below are untouched).
 *
 * This suite used to point `CLAUDE_PLUGIN_ROOT` at the REAL plugin root, so
 * running it mutated the developer's live `runtime/` — `token-usage-session
 * .json` every run, and (once the recorder-stats flush landed) a line in the
 * real decision store that `/doctor` reads to decide whether
 * recording is alive. Writing fixture data into the store a health check reads
 * is worse than recording nothing, and being gitignored does not make it safe.
 *
 * The sandbox LINKS the real `lib/`, `commands/`, `skills/` and `agents/` and
 * copies the real `artibot.config.json`, so both hooks in the chain still
 * resolve the REAL modules and the REAL config — the flow under test is
 * unchanged. Only the writable `runtime/` directory is redirected.
 *
 * Links, not copies: a sandbox missing the modules would send every dynamic
 * import into its catch block, and the assertions below would then be measuring
 * the in-script fallback rather than the runtime path they name.
 */
const LINKED_DIRS = ['lib', 'commands', 'skills', 'agents'];

let sandboxRoot = '';

beforeAll(() => {
  sandboxRoot = mkdtempSync(path.join(tmpdir(), 'artibot-runtime-flow-'));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const dir of LINKED_DIRS) {
    symlinkSync(path.join(PLUGIN_ROOT, dir), path.join(sandboxRoot, dir), linkType);
  }
  copyFileSync(
    path.join(PLUGIN_ROOT, 'artibot.config.json'),
    path.join(sandboxRoot, 'artibot.config.json'),
  );
  mkdirSync(path.join(sandboxRoot, 'runtime'), { recursive: true });
  // The decision store is anchored on the PROJECT root, not CLAUDE_PLUGIN_ROOT
  // (`decision-events.js#getDecisionStoreDir`), so redirecting the plugin root
  // alone no longer keeps this suite out of the real store. A `.git` marker
  // makes `lib/git/project-root.js#resolveProjectRoot` stop at the sandbox, and
  // the payloads below carry `cwd: sandboxRoot` so the hook resolves from here.
  mkdirSync(path.join(sandboxRoot, '.git'), { recursive: true });
});

afterAll(() => {
  if (sandboxRoot) rmSync(sandboxRoot, { recursive: true, force: true });
});

describe('hook-chain runtime flow', () => {
  let savedEnv;

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

  it('applies System 1 rewrite when the prompt stays simple', async () => {
    const { firstOutput, runtimeOutput } = await runHookChain('fix typo in readme');
    expect(firstOutput).toBeNull();
    expect(runtimeOutput).not.toBeNull();
    expect(runtimeOutput.message).toContain('[runtime]');
    expect(runtimeOutput.message).toContain('route=SYSTEM1');
    // Pipeline-internal envelope (what the eval suite's prompt-rewritten
    // assertion reads) is unchanged.
    expect(runtimeOutput.user_prompt).toContain('System 1 mode');
    expect(runtimeOutput.user_prompt).toContain('Original request:');
    // What the HOST receives is the same verdict as a one-line directive. The
    // 'Original request:' wrapper is dropped: it framed a prompt substitution
    // the host never performed (2.1.259 measured).
    const ctx = runtimeOutput.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('[artibot:route system1]');
    expect(ctx).not.toContain('Original request:');
    expect(ctx).not.toContain('fix typo in readme');
  });

  it('preserves special-trigger rewrites before runtime enrichment', async () => {
    const { firstOutput, runtimeOutput } = await runHookChain('!rv check auth module');
    expect(firstOutput).not.toBeNull();
    expect(firstOutput.user_prompt).toContain('CRITICAL RE-VERIFICATION MODE');
    // The rewriter now also states the protocol on the host channel, because
    // replacing the prompt was never possible (design §2.1 A).
    expect(firstOutput.hookSpecificOutput?.additionalContext)
      .toContain('CRITICAL RE-VERIFICATION MODE');
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
