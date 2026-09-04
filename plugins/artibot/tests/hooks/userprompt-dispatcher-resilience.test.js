import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

/**
 * Regression tests for hook resilience in `_userprompt-dispatcher.js`.
 *
 * Covers:
 *   1. Empty-string rewriter output is preserved (not dropped by truthy check).
 *   2. One hook throwing does not abort the dispatcher chain — sibling hooks
 *      still execute via `safeRun` + `Promise.allSettled`.
 *
 * These exercise the dispatcher's internal seams without spawning a child
 * process, so they're fast and isolate the resilience semantics.
 */

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);
const DISPATCHER = path.join(PLUGIN_ROOT, 'scripts', 'hooks', '_userprompt-dispatcher.js');

describe('dispatcher resilience: empty-string rewriter output', () => {
  it('preserves "" as a valid rewriter user_prompt on the INTERNAL handoff', async () => {
    // Where this contract lives moved with the stdout allowlist. `user_prompt`
    // is no longer emitted (the host discards it), so the empty string can only
    // be observed where it still matters: the payload the parallel contributors
    // classify on. Asserting it against `mergeHookResults` would now be a test
    // of a key that is deliberately dropped.
    const rewriterResult = { user_prompt: '', message: 'cleared by rewriter' };
    const payload = { prompt: 'original' };
    // The dispatcher's guard, verbatim (pinned by the source test below).
    if (typeof rewriterResult?.user_prompt === 'string') {
      payload.user_prompt = rewriterResult.user_prompt;
    }
    expect(payload.user_prompt).toBe('');

    // And the merge drops both non-host keys, leaving nothing to send.
    const { mergeHookResults } = await import(DISPATCHER);
    expect(mergeHookResults(rewriterResult, [])).toBeNull();
  });

  it('source: dispatcher guards rewriter payload-write with typeof string', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(DISPATCHER, 'utf-8');
    // The new guard must be `typeof ... === 'string'`, not a bare truthy check,
    // so empty strings are preserved.
    expect(src).toMatch(/typeof\s+rewriterResult\?\.user_prompt\s*===\s*['"]string['"]/);
    // Ensure the old falsy gate is gone.
    expect(src).not.toMatch(/if\s*\(\s*rewriterResult\?\.user_prompt\s*\)/);
    // And the ASSIGNMENT itself must survive. `user_prompt` stopped being an
    // emitted key when the host allowlist landed, which makes it easy to read
    // the whole thing as dead and delete it — but the parallel contributors
    // classify on `payload.user_prompt`, so removing this line silently gives
    // them the pre-rewrite text. That failure is invisible on stdout.
    expect(src).toMatch(/payload\.user_prompt\s*=\s*rewriterResult\.user_prompt/);
  });
});

describe('dispatcher resilience: one hook throwing does not abort others', () => {
  it('safeRun wrapper returns null on throw, allowing sibling hooks to keep running', async () => {
    // Re-import the dispatcher module to reach its top-level functions. The
    // `safeRun` is module-internal but its behaviour is the contract under
    // test, so we reconstruct it (matching the implementation 1:1).
    const safeRun = async (fn, payload, _name) => {
      try {
        return await fn(payload);
      } catch (err) {
        // emulate stderr write
        void err;
        return null;
      }
    };

    const goodHook = vi.fn().mockResolvedValue({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'good ran',
      },
    });
    const throwingHook = vi.fn().mockImplementation(() => {
      throw new Error('boom');
    });
    const anotherGoodHook = vi.fn().mockResolvedValue({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'another ran',
      },
    });

    const results = await Promise.allSettled([
      safeRun(goodHook, {}, 'good'),
      safeRun(throwingHook, {}, 'throws'),
      safeRun(anotherGoodHook, {}, 'another'),
    ]);

    // All three settled fulfilled (safeRun never rejects).
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    // Good hooks ran AND their values made it through.
    expect(results[0].value?.hookSpecificOutput.additionalContext).toBe('good ran');
    expect(results[1].value).toBeNull();
    expect(results[2].value?.hookSpecificOutput.additionalContext).toBe('another ran');
    expect(goodHook).toHaveBeenCalledTimes(1);
    expect(throwingHook).toHaveBeenCalledTimes(1);
    expect(anotherGoodHook).toHaveBeenCalledTimes(1);
  });

  it('mergeHookResults composes surviving contributors when one rejected', async () => {
    const { mergeHookResults } = await import(DISPATCHER);
    // Simulate the post-allSettled shape: one rejection + two fulfilled.
    const merged = mergeHookResults(null, [
      {
        status: 'fulfilled',
        value: {
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: 'A',
          },
        },
      },
      { status: 'rejected', reason: new Error('hook B blew up') },
      {
        status: 'fulfilled',
        value: {
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: 'C',
          },
        },
      },
    ]);
    expect(merged.hookSpecificOutput.additionalContext).toBe('A\n\nC');
  });

  it('source: dispatcher uses Promise.allSettled for parallel contributors', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(DISPATCHER, 'utf-8');
    expect(src).toMatch(/Promise\.allSettled\(/);
    // safeRun must catch and return null (the contract relied on above).
    expect(src).toMatch(/async function safeRun[\s\S]*?try\s*\{[\s\S]*?catch[\s\S]*?return null/);
  });
});

describe('hooks.json: UserPromptSubmit timeout cold-start tolerance', () => {
  it('UserPromptSubmit dispatcher timeout is >= 15s (host unit is seconds)', async () => {
    const fs = await import('node:fs/promises');
    const hooksJsonPath = path.join(PLUGIN_ROOT, 'hooks', 'hooks.json');
    const cfg = JSON.parse(await fs.readFile(hooksJsonPath, 'utf-8'));
    const ups = cfg.hooks?.UserPromptSubmit;
    expect(Array.isArray(ups)).toBe(true);
    const dispatcherEntry = ups
      .flatMap((m) => m.hooks || [])
      .find((h) => typeof h.command === 'string' && h.command.includes('_userprompt-dispatcher.js'));
    expect(dispatcherEntry, 'dispatcher entry must exist in hooks.json').toBeTruthy();
    expect(dispatcherEntry.timeout).toBeGreaterThanOrEqual(15);
  });
});
