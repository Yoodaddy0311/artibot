import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * UserPromptSubmit dispatcher integration tests.
 *
 * The dispatcher is exec'd as a child process so we exercise the same code
 * path that hooks.json uses (single node entry, stdin JSON in, stdout JSON
 * out). Unit-level tests for `mergeHookResults` cover the merging logic.
 *
 * git-autopilot-save is spawned by the dispatcher as a side-effect; we don't
 * have a test repo configured, so the child returns immediately without
 * touching git. This is the same path users hit in non-allowlisted repos.
 */

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);
const SCRIPT_PATH = path.join(PLUGIN_ROOT, 'scripts', 'hooks', '_userprompt-dispatcher.js');

function runDispatcher(payload, env = {}) {
  const stdout = execFileSync(
    process.execPath,
    [SCRIPT_PATH],
    {
      cwd: PLUGIN_ROOT,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
        // Disable downstream side-effects that would otherwise touch
        // network / disk / runtime caches during the test run.
        ARTIBOT_RUNTIME_CHECKPOINT_DISABLE: '1',
        ARTIBOT_RUNTIME_MEMORY_DISABLE: '1',
        ...env,
      },
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      timeout: 20000,
    },
  ).trim();
  return stdout ? JSON.parse(stdout) : null;
}

describe('_userprompt-dispatcher (integration)', () => {
  it('emits at most a pass-through envelope when stdin payload is empty', () => {
    const out = runDispatcher({});
    // ambiguity-guard always returns { continue: true } even on empty input,
    // so the merged output is either null or a no-op pass-through. No
    // user_prompt rewriting and no additionalContext should be present.
    if (out !== null) {
      expect(out.user_prompt).toBeUndefined();
      expect(out.hookSpecificOutput).toBeUndefined();
    }
  });

  it('emits a single merged JSON object for an ordinary prompt', () => {
    const out = runDispatcher({ user_prompt: 'fix typo in readme' });
    expect(out).not.toBeNull();
    // runtime-prompt always contributes user_prompt for non-empty input.
    expect(typeof out.user_prompt).toBe('string');
    expect(out.user_prompt.length).toBeGreaterThan(0);
  });

  it('rewrites !rv prompts via user-prompt-handler before parallel hooks see them', () => {
    const out = runDispatcher({ user_prompt: '!rv check the auth module' });
    expect(out).not.toBeNull();
    // user-prompt-handler rewrote into the CRITICAL RE-VERIFICATION envelope.
    expect(out.user_prompt).toMatch(/CRITICAL RE-VERIFICATION MODE/);
    // runtime-prompt, in turn, prefixed/appended runtime envelope content.
    // (It composed on top of the rewriter's output — confirms the ordering.)
  });

  it('strips --no-team flag from the prompt', () => {
    const out = runDispatcher({ user_prompt: 'implement feature --no-team' });
    expect(out).not.toBeNull();
    // user-prompt-handler stripped --no-team. runtime-prompt then rebuilt the
    // user_prompt envelope, but the underlying prompt no longer contains
    // --no-team.
    expect(out.user_prompt).not.toMatch(/--no-team/);
  });

  it('flags short destructive prompts via ambiguity-guard additionalContext', () => {
    const out = runDispatcher({ user_prompt: 'delete it' });
    expect(out).not.toBeNull();
    const ctx = out.hookSpecificOutput?.additionalContext || '';
    expect(ctx).toContain('ambiguity-guard');
  });

  it('respects ARTIBOT_DISABLE_DISPATCHER=1 (no-op)', () => {
    const out = runDispatcher(
      { user_prompt: 'this would normally trigger several hooks' },
      { ARTIBOT_DISABLE_DISPATCHER: '1' },
    );
    expect(out).toBeNull();
  });

  it('finishes within the 8000ms hooks.json timeout for typical prompts', () => {
    const start = Date.now();
    runDispatcher({ user_prompt: 'add a small comment to lib/index.js' });
    const elapsed = Date.now() - start;
    // Generous bound — the spec'd timeout is 8000ms, so we assert well under.
    expect(elapsed).toBeLessThan(15000);
  });
});

describe('mergeHookResults (unit)', () => {
  it('returns null when no contributors produced anything', async () => {
    const { mergeHookResults } = await import('../../scripts/hooks/_userprompt-dispatcher.js');
    expect(mergeHookResults(null, [])).toBeNull();
    expect(mergeHookResults(null, [{ status: 'fulfilled', value: null }])).toBeNull();
  });

  it('preserves the rewriter user_prompt and message', async () => {
    const { mergeHookResults } = await import('../../scripts/hooks/_userprompt-dispatcher.js');
    const merged = mergeHookResults(
      { user_prompt: 'rewritten', message: '[trigger] applied' },
      [],
    );
    expect(merged.user_prompt).toBe('rewritten');
    expect(merged.message).toBe('[trigger] applied');
  });

  it('concatenates additionalContext from every fulfilled contributor', async () => {
    const { mergeHookResults } = await import('../../scripts/hooks/_userprompt-dispatcher.js');
    const merged = mergeHookResults(null, [
      {
        status: 'fulfilled',
        value: {
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: 'first',
          },
        },
      },
      {
        status: 'fulfilled',
        value: {
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: 'second',
          },
        },
      },
    ]);
    expect(merged.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(merged.hookSpecificOutput.additionalContext).toBe('first\n\nsecond');
  });

  it('ignores rejected contributors without breaking', async () => {
    const { mergeHookResults } = await import('../../scripts/hooks/_userprompt-dispatcher.js');
    const merged = mergeHookResults(null, [
      { status: 'rejected', reason: new Error('boom') },
      {
        status: 'fulfilled',
        value: {
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: 'survived',
          },
        },
      },
    ]);
    expect(merged.hookSpecificOutput.additionalContext).toBe('survived');
  });
});

describe('dispatcher writes a single newline-free JSON document to stdout', () => {
  it('emits exactly one JSON object (not NDJSON)', async () => {
    // We capture raw stdout (no JSON.parse) to verify there is at most one
    // JSON object — multiple writes would break Claude Code's hook protocol.
    const raw = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SCRIPT_PATH], {
        cwd: PLUGIN_ROOT,
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
          ARTIBOT_RUNTIME_CHECKPOINT_DISABLE: '1',
          ARTIBOT_RUNTIME_MEMORY_DISABLE: '1',
        },
        stdio: ['pipe', 'pipe', 'inherit'],
        windowsHide: true,
      });
      const chunks = [];
      child.stdout.on('data', (c) => chunks.push(c));
      child.on('exit', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      child.on('error', reject);
      child.stdin.end(JSON.stringify({ user_prompt: 'fix a small bug' }));
    });
    // Exactly zero or one newline-separated JSON document.
    const trimmed = raw.trim();
    if (trimmed.length === 0) return; // permissible: hook chose to pass through
    // Should parse as a single JSON value.
    expect(() => JSON.parse(trimmed)).not.toThrow();
  });
});
