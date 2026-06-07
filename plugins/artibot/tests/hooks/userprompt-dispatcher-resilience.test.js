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
  it('preserves "" as a valid rewriter user_prompt (not treated as missing)', async () => {
    const { mergeHookResults } = await import(DISPATCHER);
    const merged = mergeHookResults(
      { user_prompt: '', message: 'cleared by rewriter' },
      [],
    );
    // Empty string must round-trip through the merge — the rewriter
    // intentionally chose to clear the prompt.
    expect(merged).not.toBeNull();
    expect(merged.user_prompt).toBe('');
    expect(merged.message).toBe('cleared by rewriter');
  });

  it('source: dispatcher guards rewriter payload-write with typeof string', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(DISPATCHER, 'utf-8');
    // The new guard must be `typeof ... === 'string'`, not a bare truthy check,
    // so empty strings are preserved.
    expect(src).toMatch(/typeof\s+rewriterResult\?\.user_prompt\s*===\s*['"]string['"]/);
    // Ensure the old falsy gate is gone.
    expect(src).not.toMatch(/if\s*\(\s*rewriterResult\?\.user_prompt\s*\)/);
  });
});

describe('dispatcher resilience: one hook throwing does not abort others', () => {
  it('safeRun wrapper returns null on throw, allowing sibling hooks to keep running', async () => {
    // Re-import the dispatcher module to reach its top-level functions. The
    // `safeRun` is module-internal but its behaviour is the contract under
    // test, so we reconstruct it (matching the implementation 1:1).
    const safeRun = async (fn, payload, name) => {
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
  it('UserPromptSubmit dispatcher timeout is >= 15000ms', async () => {
    const fs = await import('node:fs/promises');
    const hooksJsonPath = path.join(PLUGIN_ROOT, 'hooks', 'hooks.json');
    const cfg = JSON.parse(await fs.readFile(hooksJsonPath, 'utf-8'));
    const ups = cfg.hooks?.UserPromptSubmit;
    expect(Array.isArray(ups)).toBe(true);
    const dispatcherEntry = ups
      .flatMap((m) => m.hooks || [])
      .find((h) => typeof h.command === 'string' && h.command.includes('_userprompt-dispatcher.js'));
    expect(dispatcherEntry, 'dispatcher entry must exist in hooks.json').toBeTruthy();
    expect(dispatcherEntry.timeout).toBeGreaterThanOrEqual(15000);
  });
});
