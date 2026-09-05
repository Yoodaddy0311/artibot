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

/**
 * classifyPromptSource — the sender guard's decision function.
 *
 * Unit-level companion to the spawned cases in
 * tests/hooks/userprompt-dispatcher.test.js. Those prove the guard is WIRED
 * (zero hooks, empty stdout, one stderr line); these enumerate the decision
 * table itself, which is cheap to do exhaustively here and expensive there.
 *
 * Origin: 2026-09-04T19:02:21Z, when a harness `<task-notification>` body ran
 * all 6 UserPromptSubmit hooks and left 4 decision rows plus a
 * `mission.created` ledger event behind.
 */
describe('classifyPromptSource: sender allowlist', () => {
  /**
   * EXHAUSTIVE over the host's documented `source` values.
   *
   * Built by iterating HOST_PROMPT_SOURCES rather than by listing values here,
   * so adding a host value without deciding whether it is human-driven makes
   * this table fail rather than silently leaving the new value untested.
   */
  it('admits exactly user and sdk out of every documented host source', async () => {
    const { classifyPromptSource, HOST_PROMPT_SOURCES, USER_PROMPT_SOURCES } = await import(DISPATCHER);

    // The host list itself must not have drifted out from under the allowlist.
    expect([...HOST_PROMPT_SOURCES]).toEqual([
      'user', 'sdk', 'system', 'loop_wakeup', 'schedule_wakeup', 'poll_event',
    ]);

    const decisions = Object.fromEntries(
      HOST_PROMPT_SOURCES.map((source) => [
        source,
        classifyPromptSource({ prompt: 'fix typo in readme', source }).user,
      ]),
    );
    expect(decisions).toEqual({
      user: true,
      sdk: true,
      system: false,
      loop_wakeup: false,
      schedule_wakeup: false,
      poll_event: false,
    });

    // And the two admitted values are exactly the allowlist — not a coincidence
    // of this table agreeing with a hand-written literal.
    expect(Object.keys(decisions).filter((s) => decisions[s]).sort())
      .toEqual([...USER_PROMPT_SOURCES].sort());
  });

  it('reports the source it rejected, so a blocked turn is diagnosable', async () => {
    const { classifyPromptSource } = await import(DISPATCHER);
    expect(classifyPromptSource({ prompt: 'x', source: 'system' }))
      .toEqual({ user: false, reason: 'source:system' });
    expect(classifyPromptSource({ prompt: 'x', source: 'user' }))
      .toEqual({ user: true, reason: 'source:user' });
  });

  it('FAIL-CLOSED: an undocumented future source is rejected, not admitted', async () => {
    // The whole reason this is an allowlist. A deny list would admit whatever
    // channel the host adds next, and the failure would be invisible until the
    // ledger was already polluted.
    const { classifyPromptSource } = await import(DISPATCHER);
    const result = classifyPromptSource({ prompt: 'fix typo in readme', source: 'future_source' });
    expect(result.user).toBe(false);
    expect(result.reason).toBe('source:future_source');
  });

  it('clamps a hostile source string to one short line in the reason tag', async () => {
    // `reason` is interpolated into stderr. A newline would let an injected
    // source forge a second log line.
    const { classifyPromptSource } = await import(DISPATCHER);
    const { reason } = classifyPromptSource({
      prompt: 'x',
      source: `evil\nfaked log line${'x'.repeat(200)}`,
    });
    expect(reason).not.toContain('\n');
    expect(reason.length).toBeLessThanOrEqual('source:'.length + 64);
  });

  describe('body sniff — the fallback used only when `source` is absent', () => {
    it('rejects the task-notification prefix', async () => {
      const { classifyPromptSource } = await import(DISPATCHER);
      expect(classifyPromptSource({ prompt: '<task-notification>\n<task-id>abc</task-id>' }))
        .toEqual({ user: false, reason: 'body:task-notification' });
    });

    it('rejects the system-notification prefix', async () => {
      const { classifyPromptSource } = await import(DISPATCHER);
      expect(classifyPromptSource({ prompt: '[SYSTEM NOTIFICATION - NOT USER INPUT]\nidle' }))
        .toEqual({ user: false, reason: 'body:system-notification' });
    });

    it('trims leading whitespace before sniffing', async () => {
      // A single leading space would otherwise walk the whole 5KB body past
      // the guard, which is the entire defect in one character.
      const { classifyPromptSource } = await import(DISPATCHER);
      expect(classifyPromptSource({ prompt: '  <task-notification>\n<task-id>abc</task-id>' }).user)
        .toBe(false);
      expect(classifyPromptSource({ prompt: '\n\t<task-notification>\n' }).user).toBe(false);
    });

    it('falls back to `user_prompt` when `prompt` is absent', async () => {
      const { classifyPromptSource } = await import(DISPATCHER);
      expect(classifyPromptSource({ user_prompt: '<task-notification>\n' }).user).toBe(false);
    });

    it('admits an ordinary prompt with no source at all', async () => {
      // Hosts before the `source` field, and 2.1.x while it "rolls out". If
      // this ever flipped, all 6 hooks would go dark for real users on those
      // hosts — a worse failure than the one being fixed.
      const { classifyPromptSource } = await import(DISPATCHER);
      expect(classifyPromptSource({ prompt: 'fix typo in readme' }))
        .toEqual({ user: true, reason: 'source:absent' });
    });

    /**
     * DOCUMENTED NARROWNESS — not a bug, and deliberately pinned.
     *
     * `<task-notification>` is matched WITH its closing `>`, so a tag that
     * merely starts similarly is admitted as a user prompt. That is the
     * intended trade: the sniff only runs when `source` is missing, and an
     * over-broad marker there silently disables every hook for humans who
     * happen to open a message with an angle bracket.
     *
     * The team-lead brief for this bundle predicted `false` (non-user) for this
     * input. Measured behaviour is the opposite, and the source comment at
     * `_userprompt-dispatcher.js#NON_USER_BODY_PREFIXES` ("Deliberately
     * NARROW") says the measured behaviour is the intended one. Pinned as
     * measured; if the marker ever needs widening, change it here first.
     */
    it('does NOT reject a look-alike tag: the prefix includes the closing bracket', async () => {
      const { classifyPromptSource } = await import(DISPATCHER);
      expect(classifyPromptSource({ prompt: '<task-notification-ish>hello' }))
        .toEqual({ user: true, reason: 'source:absent' });
    });

    /**
     * Asymmetry with the tag above, pinned because it is easy to "tidy" away:
     * the system marker has NO closing bracket in the prefix, so it matches a
     * whole family of `[SYSTEM NOTIFICATION…]` variants on purpose.
     */
    it('DOES reject system-notification variants: that prefix has no closing bracket', async () => {
      const { classifyPromptSource } = await import(DISPATCHER);
      expect(classifyPromptSource({ prompt: '[SYSTEM NOTIFICATIONS PAUSED] carry on' }).user)
        .toBe(false);
    });
  });

  describe('non-string source falls through to the body rules', () => {
    it.each([
      ['number', 7],
      ['null', null],
      ['undefined', undefined],
      ['object', { kind: 'system' }],
      ['boolean', true],
    ])('source=%s with an ordinary body is admitted', async (_label, source) => {
      const { classifyPromptSource } = await import(DISPATCHER);
      expect(classifyPromptSource({ prompt: 'fix typo in readme', source }))
        .toEqual({ user: true, reason: 'source:absent' });
    });

    it.each([
      ['number', 7],
      ['null', null],
      ['object', { kind: 'system' }],
    ])('source=%s with a notification body is still rejected', async (_label, source) => {
      // The type confusion must not become an admission channel: a non-string
      // `source` disables the allowlist, so the sniff has to carry the case.
      const { classifyPromptSource } = await import(DISPATCHER);
      expect(classifyPromptSource({ prompt: '<task-notification>\nx', source }).user).toBe(false);
    });
  });

  describe('degenerate payloads keep the pre-existing "still runs" path', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a string', 'not an object'],
      ['a number', 42],
    ])('%s is treated as a user prompt (payload:empty)', async (_label, payload) => {
      // NOT a fail-open hole: readPayload() returns {} for empty stdin, and the
      // existing case "emits nothing for an empty stdin payload" pins that an
      // empty payload produces no output anyway. Changing this to false would
      // alter a path the guard was never meant to touch.
      const { classifyPromptSource } = await import(DISPATCHER);
      expect(classifyPromptSource(payload)).toEqual({ user: true, reason: 'payload:empty' });
    });

    it('an empty object (the readPayload default) is admitted', async () => {
      const { classifyPromptSource } = await import(DISPATCHER);
      expect(classifyPromptSource({})).toEqual({ user: true, reason: 'source:absent' });
    });
  });

  it('the allowlist constants are frozen — no runtime widening', async () => {
    const { HOST_PROMPT_SOURCES, USER_PROMPT_SOURCES, NON_USER_BODY_PREFIXES } = await import(DISPATCHER);
    expect(Object.isFrozen(HOST_PROMPT_SOURCES)).toBe(true);
    expect(Object.isFrozen(USER_PROMPT_SOURCES)).toBe(true);
    expect(Object.isFrozen(NON_USER_BODY_PREFIXES)).toBe(true);
    expect([...NON_USER_BODY_PREFIXES]).toEqual(['<task-notification>', '[SYSTEM NOTIFICATION']);
  });

  it('source: the guard runs before the rewriter and before any hook', async () => {
    // Ordering is the whole point — a guard placed after the rewriter would
    // still spawn git-autopilot-save and still write decision rows. Pinned
    // against the source because ordering is invisible to a return-value test.
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(DISPATCHER, 'utf-8');
    const guardAt = src.indexOf('const promptSource = classifyPromptSource(payload)');
    const rewriterAt = src.indexOf('// Step 1: rewriter');
    expect(guardAt).toBeGreaterThan(-1);
    expect(rewriterAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(rewriterAt);
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
