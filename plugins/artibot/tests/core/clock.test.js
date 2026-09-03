/**
 * `lib/core/clock.js` — the `now` port contract, exercised at its new home.
 *
 * What this proves: the four branches (omitted, valid Date, non-function,
 * wrong return type) behave as the contract says, the `label` argument reaches
 * every error message, and the shapes an earlier permissive version accepted —
 * epoch milliseconds and ISO text — are now refused.
 *
 * Why it lives here: three consumers on three layers now share this rule
 * (`verification/unified-verifier.js` L2, `topology/split-state.js` L4,
 * `runtime/event-writer.js` L5). The definition sits at L1 so none of them has
 * to borrow it from another's layer. `tests/verification` keeps its own copy of
 * these assertions on purpose — they pin the re-export, which is a separate
 * promise from the definition.
 *
 * What it cannot prove (rules §9): that the consumers actually route through
 * this function. Each consumer's own suite covers its wiring; a passing test
 * here says the rule is right, not that anyone obeys it.
 */

import { describe, expect, it } from 'vitest';

import { readClock } from '../../lib/core/clock.js';

const AT = () => new Date('2026-09-02T07:15:30.000Z');

describe('branch 1 — omitted clock', () => {
  it('falls back to the wall clock and returns a real ISO timestamp', () => {
    const iso = readClock(undefined);
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(iso))).toBe(false);
  });

  it('is the only omission accepted — null is a violation, not a default', () => {
    // Treating null as "omitted" would quietly restore the permissive contract
    // this narrowing removed.
    expect(() => readClock(null)).toThrow(TypeError);
  });
});

describe('branch 2 — a function returning a Date', () => {
  it('converts to ISO', () => {
    expect(readClock(AT)).toBe('2026-09-02T07:15:30.000Z');
  });

  it('accepts a Date built from epoch ms — the Date is what matters, not its origin', () => {
    expect(readClock(() => new Date(1788333330000))).toBe('2026-09-02T07:15:30.000Z');
  });

  it('calls the port exactly once', () => {
    let calls = 0;
    readClock(() => {
      calls += 1;
      return new Date(0);
    });
    expect(calls).toBe(1);
  });
});

describe('branch 3 — a non-function clock', () => {
  it('is a TypeError naming the type received', () => {
    expect(() => readClock(new Date())).toThrow(/now must be a function returning a Date, received object/);
    expect(() => readClock(null)).toThrow(/received null/);
    expect(() => readClock([])).toThrow(/received array/);
    expect(() => readClock(1788333330000)).toThrow(/received number/);
    expect(() => readClock('2026-09-02T07:15:30.000Z')).toThrow(/received string/);
  });
});

describe('branch 4 — a wrong return type', () => {
  it('refuses epoch ms and ISO text, the two shapes callers get wrong', () => {
    expect(() => readClock(() => 1788333330000)).toThrow(/now\(\) must return a Date, received number/);
    expect(() => readClock(() => '2026-09-02T07:15:30.000Z')).toThrow(/now\(\) must return a Date, received string/);
  });

  it('refuses an Invalid Date rather than stamping it', () => {
    expect(() => readClock(() => new Date('nonsense'))).toThrow(/now\(\) returned an Invalid Date/);
  });

  it('lets a broken clock surface its own error unrewrapped', () => {
    // A clock that throws is a broken clock, not a wrong-shaped one. Rewrapping
    // it as a TypeError would erase the cause.
    expect(() => readClock(() => { throw new RangeError('clock skew'); })).toThrow(RangeError);
    expect(() => readClock(() => { throw new RangeError('clock skew'); })).toThrow('clock skew');
  });
});

describe('label', () => {
  it('prefixes every one of the three messages', () => {
    expect(() => readClock(null, 'writeWorkerState')).toThrow(/^writeWorkerState: now must be a function/);
    expect(() => readClock(() => 42, 'writeWorkerState')).toThrow(/^writeWorkerState: now\(\) must return a Date/);
    expect(() => readClock(() => new Date('nonsense'), 'writeWorkerState'))
      .toThrow(/^writeWorkerState: now\(\) returned an Invalid Date$/);
  });

  it('defaults to this module, not to any one consumer', () => {
    // A core utility defaulting to an L2 caller's name would misdirect every
    // other caller that forgot to pass one.
    expect(() => readClock(null)).toThrow(/^clock: /);
  });
});
