import { describe, expect, it } from 'vitest';

import {
  isUnsafeMergeKey,
  mergeResults,
} from '../../scripts/hooks/_dispatcher-utils.js';
import { mergeHookResults } from '../../scripts/hooks/_userprompt-dispatcher.js';

/**
 * Prototype-hostile keys through the dispatcher merges.
 *
 * Both merges copy a child hook's parsed stdout into a response envelope with
 * `out[key] = val`. That is a [[Set]], so a key of `__proto__` invokes the
 * inherited accessor on Object.prototype and REPLACES the envelope's prototype
 * instead of adding a property. `constructor`/`prototype` differ — they land as
 * ordinary own enumerable properties and are serialized to stdout verbatim.
 *
 * Blast radius, measured 2026-08-15 (see the NEGATIVE CONTROL block below):
 *   - Object.prototype is NOT polluted globally. `__proto__` arrives from
 *     JSON.parse as an OWN data property, so the damage is scoped to the one
 *     envelope object that the merge assigns into.
 *   - JSON.stringify emits own properties only, so a `__proto__` payload does
 *     not change what the dispatchers currently write to stdout. All six
 *     callers (`_posttooluse`/`_stop`/`_subagentstop`/`_sessionstart`/
 *     `_sessionend`/`_userprompt`) only stringify the merged object today.
 *   - What IS reachable is every field READ off the envelope: an injected
 *     prototype supplies `merged.decision === 'block'` while the serialized
 *     form stays `{}`. That is the latent half.
 *   - `constructor`/`prototype` are NOT latent — they reach stdout today.
 *
 * FIXTURE MUST REACH THE FAILURE REGION — rules/verification-discipline.md §9.
 * A test that merges an object literal `{ __proto__: {...} }` proves NOTHING
 * here: in a literal, `__proto__:` is dedicated syntax that sets the prototype
 * at construction time, so the key never exists as an own property and never
 * reaches the merge loop at all. Only `JSON.parse` (the real path — hook stdout
 * is parsed, never authored inline) creates it as an own enumerable property.
 * The first test below asserts that distinction directly, so the suite fails
 * loudly if someone "simplifies" the fixtures into literals and turns every
 * assertion underneath into a vacuous green.
 */

/** The exact shape a hostile child hook would print on stdout. */
const HOSTILE_PROTO = () => JSON.parse('{"__proto__":{"polluted":1,"decision":"block"}}');

describe('dispatcher merges — fixture reaches the failure region', () => {
  it('NEGATIVE CONTROL: JSON.parse yields an own __proto__ key; a literal does not', () => {
    const parsed = HOSTILE_PROTO();
    // Own, enumerable, and therefore visible to the Object.entries() loop that
    // both merges run. This is the delivery vector.
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect(Object.keys(parsed)).toContain('__proto__');
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);

    // The counterexample. If a future edit swaps the fixture for this form,
    // the merge loop never sees the key and the guard is never exercised.
    const literal = { __proto__: { polluted: 1 } };
    expect(Object.hasOwn(literal, '__proto__')).toBe(false);
    expect(Object.keys(literal)).toEqual([]);
  });

  it('NEGATIVE CONTROL: an unguarded merge really is hijacked by these bytes', () => {
    // Reproduces the pre-fix loop verbatim. If this stops hijacking, the
    // language semantics under test have changed and every assertion below has
    // silently gone vacuous — do NOT relax it, re-derive the fixture.
    const unguarded = {};
    for (const [key, val] of Object.entries(HOSTILE_PROTO())) unguarded[key] = val;

    expect(Object.getPrototypeOf(unguarded)).not.toBe(Object.prototype);
    expect(unguarded.polluted).toBe(1);
    expect(unguarded.decision).toBe('block');
    // …and the corruption is invisible in the serialized form, which is why it
    // survived review: own properties only.
    expect(JSON.stringify(unguarded)).toBe('{}');
  });
});

describe('isUnsafeMergeKey', () => {
  it('rejects exactly the three spec-fixed keys', () => {
    expect(isUnsafeMergeKey('__proto__')).toBe(true);
    expect(isUnsafeMergeKey('constructor')).toBe(true);
    expect(isUnsafeMergeKey('prototype')).toBe(true);
  });

  it('passes ordinary envelope fields through', () => {
    for (const key of ['decision', 'reason', 'message', 'continue', 'user_prompt', 'proto', '__proto']) {
      expect(isUnsafeMergeKey(key)).toBe(false);
    }
  });
});

describe('mergeResults — prototype-hostile hook output', () => {
  it('leaves the envelope prototype intact and drops the injected fields', () => {
    const merged = mergeResults([HOSTILE_PROTO(), { message: 'real' }], 'Stop');

    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(merged.polluted).toBeUndefined();
    // The injected `decision: 'block'` must NOT become a blocker — a hostile
    // hook could otherwise halt the slot without ever setting a real decision.
    expect(merged.decision).toBeUndefined();
    expect(merged).toEqual({ message: 'real' });
  });

  it('does not pollute Object.prototype globally', () => {
    mergeResults([HOSTILE_PROTO()], 'Stop');
    expect({}.polluted).toBeUndefined();
    expect(Object.prototype.polluted).toBeUndefined();
  });

  it('drops constructor/prototype instead of emitting them on stdout', () => {
    const merged = mergeResults(
      [JSON.parse('{"constructor":{"evil":1},"prototype":{"evil":2},"continue":true}')],
      'Stop',
    );

    expect(JSON.stringify(merged)).toBe('{"continue":true}');
    // `constructor` must still resolve to the real one, not a shadowing value.
    expect(merged.constructor).toBe(Object);
  });

  it('returns null when a hostile payload was the only input', () => {
    // Every key dropped => no own keys => the envelope is nothing to send,
    // and the dispatchers' `if (merged)` guard skips the stdout write.
    expect(mergeResults([HOSTILE_PROTO()], 'Stop')).toBeNull();
  });

  it('still merges a legitimate field named alongside a hostile one', () => {
    const merged = mergeResults(
      [JSON.parse('{"__proto__":{"decision":"block"},"suppressOutput":true}')],
      'PostToolUse',
    );
    expect(merged).toEqual({ suppressOutput: true });
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
  });

  it('preserves a genuine block decision from a well-behaved hook', () => {
    // Guards against over-blocking: the fix must not eat real fields.
    const merged = mergeResults(
      [HOSTILE_PROTO(), { decision: 'block', reason: 'real reason' }],
      'Stop',
    );
    expect(merged.decision).toBe('block');
    expect(merged.reason).toBe('real reason');
  });
});

describe('mergeHookResults — prototype-hostile hook output', () => {
  /** Shape the UserPromptSubmit dispatcher receives from Promise.allSettled. */
  const settled = (value) => ({ status: 'fulfilled', value });

  it('leaves the envelope prototype intact when the rewriter is hostile', () => {
    const merged = mergeHookResults(HOSTILE_PROTO(), [settled({ user_prompt: 'hi' })]);

    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(merged.polluted).toBeUndefined();
    expect(merged).toEqual({ user_prompt: 'hi' });
    expect({}.polluted).toBeUndefined();
  });

  it('leaves the envelope prototype intact when a parallel contributor is hostile', () => {
    const merged = mergeHookResults({ user_prompt: 'hi' }, [settled(HOSTILE_PROTO())]);

    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(merged.decision).toBeUndefined();
    expect(merged).toEqual({ user_prompt: 'hi' });
  });

  it('drops constructor/prototype instead of emitting them on stdout', () => {
    const merged = mergeHookResults(
      JSON.parse('{"constructor":{"evil":1},"prototype":{"evil":2},"user_prompt":"hi"}'),
      [],
    );
    expect(JSON.stringify(merged)).toBe('{"user_prompt":"hi"}');
    expect(merged.constructor).toBe(Object);
  });

  it('returns null when a hostile payload was the only input', () => {
    expect(mergeHookResults(HOSTILE_PROTO(), [])).toBeNull();
  });

  it('still concatenates additionalContext from a hostile contributor', () => {
    // additionalContext is read off `hookSpecificOutput`, which the guard does
    // not touch — a hostile top-level key must not cost a legitimate context.
    const hostile = JSON.parse(
      '{"__proto__":{"polluted":1},"hookSpecificOutput":{"additionalContext":"ctx"}}',
    );
    const merged = mergeHookResults(hostile, []);
    expect(merged.hookSpecificOutput.additionalContext).toBe('ctx');
    expect(merged.polluted).toBeUndefined();
  });
});
