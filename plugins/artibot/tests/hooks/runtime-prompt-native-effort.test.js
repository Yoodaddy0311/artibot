/**
 * TODO #30806 — native effort PRODUCER wiring in runtime-prompt.js.
 *
 * runtime-prompt is a UserPromptSubmit hook, so per code.claude.com/docs/en/
 * hooks.md the stdin `effort.level` field is NOT delivered to it — the operative
 * native source is the inherited `$CLAUDE_EFFORT` env var (the producer reads
 * both via lib/cognitive/native-effort.js#resolveNativeEffort).
 *
 * Split of concerns (kept deterministic, no shared-process-env flakiness):
 *   - Producer + precedence (stdin>env>heuristic) + normalization + router
 *     override are proven with INJECTED env/payload in
 *     tests/cognitive/native-effort.test.js.
 *   - CONSUMER wiring is proven HERE against the pure, exported
 *     composePromptOutput(): a native-overridden effortMeta (the exact shape
 *     resolveEffortMeta emits when the native band wins, reason='native-effort')
 *     must flow into BOTH the injected directive and the hook message; and an
 *     absent override must leave the heuristic effortMeta intact (regression-0).
 *
 * composePromptOutput is a pure function of its args (no env, no I/O, no dynamic
 * import), so these assertions are race-free under vitest's pooled workers.
 */

import { describe, expect, it } from 'vitest';
import { composePromptOutput } from '../../scripts/hooks/runtime-prompt.js';

/** Minimal prepared envelope (composePromptOutput only reads these fields). */
const prepared = { userPrompt: '/implement add oauth login', message: '[runtime] prompt prepared' };

describe('runtime-prompt — native effort override propagation (#30806)', () => {
  it('(a) a native-overridden effortMeta surfaces in the directive AND message', () => {
    // Shape produced by resolveEffortMeta when the native band wins: the
    // heuristic baseline is preserved but `effort` is the native band and the
    // reason flips to 'native-effort'. Here /implement's xhigh baseline is
    // overridden DOWN to low by a native signal.
    const effortMeta = {
      command: 'implement', effort: 'low', baseline: 'xhigh', shift: 0, reason: 'native-effort',
    };
    const out = composePromptOutput({
      prepared, prompt: prepared.userPrompt, effortMeta, taskBudgetDirective: '', injectPrompt: true,
    });
    // Directive reflects the native band, not the xhigh baseline.
    expect(out.user_prompt).toMatch(/^\[artibot:effort level=low command=implement\]/);
    // Message reflects it too (this field is emitted regardless of injectPrompt).
    expect(out.message).toContain('cmd=/implement effort=low');
  });

  it('(a) native override UP (low baseline → max) also propagates', () => {
    const effortMeta = {
      command: 'update', effort: 'max', baseline: 'low', shift: 0, reason: 'native-effort',
    };
    const out = composePromptOutput({
      prepared: { userPrompt: '/update', message: '[runtime] prepared' },
      prompt: '/update', effortMeta, taskBudgetDirective: '', injectPrompt: true,
    });
    expect(out.user_prompt).toMatch(/^\[artibot:effort level=max command=update\]/);
    expect(out.message).toContain('cmd=/update effort=max');
  });

  it('(b) regression-zero: a heuristic effortMeta (no override) is unchanged', () => {
    // When the producer returns null, resolveEffortMeta leaves effortMeta as the
    // heuristic result (reason != native-effort). composePromptOutput must emit
    // that band verbatim — proving the override path adds nothing when dormant.
    const effortMeta = {
      command: 'implement', effort: 'xhigh', baseline: 'xhigh', shift: 0, reason: 'baseline',
    };
    const out = composePromptOutput({
      prepared, prompt: prepared.userPrompt, effortMeta, taskBudgetDirective: '', injectPrompt: true,
    });
    expect(out.user_prompt).toMatch(/^\[artibot:effort level=xhigh command=implement\]/);
    expect(out.message).toContain('cmd=/implement effort=xhigh');
    expect(out.message).not.toContain('native-effort');
  });

  it('(b) no effortMeta at all → no effort directive, base message preserved', () => {
    const out = composePromptOutput({
      prepared, prompt: prepared.userPrompt, effortMeta: null, taskBudgetDirective: '', injectPrompt: true,
    });
    expect(out.user_prompt).not.toMatch(/\[artibot:effort/);
    expect(out.message).toBe('[runtime] prompt prepared');
  });
});
