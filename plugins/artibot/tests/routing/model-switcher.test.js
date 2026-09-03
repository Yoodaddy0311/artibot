/**
 * Tests for model-switcher — the proposal vocabulary, the branch order, and
 * the Observe invariant that nothing is ever applied.
 *
 * WHAT THESE TESTS CANNOT SEE (per PRD R-05):
 *  - THE GATES ARE UNCALIBRATED. Every branch below is exercised against
 *    hand-built verdicts. The thresholds those verdicts come from are
 *    heuristics: §30 states the minimum-residency and cooldown numbers await
 *    RouteBench calibration that has not run, and the hysteresis band has no
 *    measurement behind it either. A green run proves the branch order, not
 *    that any proposal would be the right call.
 *  - ZERO LIVE PROPOSALS. There is no consumer of `proposeSwitch` as of
 *    2026-09-02, so nothing here shows that a proposal reaches anyone, is
 *    honoured, or is ignored. `applied: false` is asserted as a property of
 *    this function; it is NOT evidence that the surrounding system applies
 *    nothing.
 *  - The source grep proves this FILE emits no `model.switched` and touches no
 *    event bus. It cannot prove a future caller does not.
 *  - `current` is caller-asserted. No test here can tell whether the tier
 *    handed in is the tier actually running.
 *
 * @module tests/routing/model-switcher
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  NOT_APPLIED_REASON,
  OBSERVE_DECISIONS,
  PROPOSALS,
  proposeSwitch,
} from '../../lib/routing/model-switcher.js';
import { evaluateSwitch } from '../../lib/routing/route-hysteresis.js';
import { resolveEscalation } from '../../lib/routing/escalation-controller.js';
import { DEFAULT_CATALOG } from '../../lib/routing/route-scorer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SWITCHER_SOURCE = path.resolve(__dirname, '../../lib/routing/model-switcher.js');

/** Switcher source with comments stripped, for the emission and import greps. */
const SWITCHER_CODE = stripComments(await readFile(SWITCHER_SOURCE, 'utf-8'));

/**
 * Minimal receipt stub. Only the two fields the switcher reads are populated;
 * the router's own tests cover the rest of the shape.
 *
 * @param {object} [over] - `{decision, current, recommended}` overrides.
 * @returns {object} Receipt-shaped object.
 */
function receipt(over = {}) {
  return {
    decision: { type: over.decision ?? 'route' },
    models: {
      current: over.current === undefined ? { tier: 'opus' } : over.current,
      recommended: over.recommended === undefined ? { tier: 'fable' } : over.recommended,
      selected: { tier: 'opus' },
    },
  };
}

/** A hysteresis verdict that released the seat. */
const RELEASED = Object.freeze({ hold: false, reason: ['above-threshold'] });

/** A hysteresis verdict that kept the seat. */
const HELD = Object.freeze({ hold: true, reason: ['minimum-residency'] });

/**
 * Strip comments before grepping source, so a header that NAMES a forbidden
 * event in prose is not mistaken for an emission of it.
 *
 * @param {string} source - File text.
 * @returns {string} Code with block and line comments removed.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('exported contract', () => {
  it('offers four proposals, ordered least to most invasive', () => {
    expect([...PROPOSALS]).toEqual(['hold', 'switch', 'escalate', 'downgrade']);
  });

  it('expects the receipt to stay inside the two Phase 0 decision values', () => {
    expect([...OBSERVE_DECISIONS]).toEqual(['route', 'pin']);
  });
});

describe('the Observe invariant', () => {
  it('returns applied:false on every branch', () => {
    const cases = [
      {},
      { hysteresis: RELEASED, receipt: receipt() },
      { hysteresis: HELD, receipt: receipt() },
      { current: 'sonnet', escalation: { nextTier: 'opus', kind: 'escalate', reason: 'escalate:fail' } },
      { current: 'fable', hysteresis: RELEASED, escalation: { nextTier: 'opus', kind: 'downgrade', reason: 'downgrade:status' } },
      { current: 'fable', hysteresis: HELD, escalation: { nextTier: 'opus', kind: 'downgrade', reason: 'downgrade:status' } },
    ];
    for (const input of cases) {
      const out = proposeSwitch(input);
      expect(out.applied, JSON.stringify(input)).toBe(false);
      expect(PROPOSALS).toContain(out.proposal);
      expect(out.reason).toContain(NOT_APPLIED_REASON);
    }
  });

  it('cannot be talked into applying by an input that says so', () => {
    const out = proposeSwitch({
      applied: true,
      proposal: 'switch',
      hysteresis: RELEASED,
      receipt: receipt(),
    });
    expect(out.applied).toBe(false);
    expect(Object.keys(out).sort()).toEqual(['applied', 'proposal', 'reason']);
  });

  it('freezes the result, so a caller cannot flip applied after the fact', () => {
    const out = proposeSwitch({ hysteresis: HELD, receipt: receipt() });
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.reason)).toBe(true);
  });

  it('emits no model.switched and reaches no event bus', () => {
    expect(SWITCHER_CODE).not.toMatch(/model\.switched/);
    expect(SWITCHER_CODE).not.toMatch(/event-bus/);
    expect(SWITCHER_CODE).not.toMatch(/emit\s*\(/);
    expect(SWITCHER_CODE).not.toMatch(/node:fs/);
    expect(SWITCHER_CODE).not.toMatch(/Date\s*\.\s*now/);
    expect(SWITCHER_CODE).not.toMatch(/Math\s*\.\s*random/);
  });

  it('imports nothing at all — the proposal is a pure fold of its inputs', () => {
    expect([...SWITCHER_CODE.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])).toEqual([]);
  });
});

describe('branch order', () => {
  it('escalates ahead of the economics — §29 does not wait out residency', () => {
    const out = proposeSwitch({
      current: 'sonnet',
      hysteresis: HELD,
      escalation: { nextTier: 'opus', kind: 'escalate', reason: 'escalate:fail' },
      receipt: receipt({ current: { tier: 'sonnet' } }),
    });
    expect(out.proposal).toBe('escalate');
    expect(out.reason).toContain('target:opus');
    expect(out.reason).toContain('escalation:escalate:fail');
    expect(out.reason).toContain('hysteresis:minimum-residency');
  });

  it('holds a downgrade the economics did not release', () => {
    const out = proposeSwitch({
      current: 'fable',
      hysteresis: HELD,
      escalation: { nextTier: 'opus', kind: 'downgrade', reason: 'downgrade:status' },
      receipt: receipt({ current: { tier: 'fable' } }),
    });
    expect(out.proposal).toBe('hold');
    expect(out.reason).toContain('hold:downgrade-blocked-by-economics');
    expect(out.reason).not.toContain('target:opus');
  });

  it('downgrades once the economics release the seat', () => {
    const out = proposeSwitch({
      current: 'fable',
      hysteresis: RELEASED,
      escalation: { nextTier: 'opus', kind: 'downgrade', reason: 'downgrade:status' },
      receipt: receipt({ current: { tier: 'fable' } }),
    });
    expect(out.proposal).toBe('downgrade');
    expect(out.reason).toContain('target:opus');
  });

  it('proposes a switch to the recommended tier when nothing escalates', () => {
    const out = proposeSwitch({ current: 'opus', hysteresis: RELEASED, receipt: receipt() });
    expect(out.proposal).toBe('switch');
    expect(out.reason).toContain('target:fable');
  });

  it('holds when the recommendation is the incumbent', () => {
    const out = proposeSwitch({
      current: 'opus',
      hysteresis: RELEASED,
      receipt: receipt({ recommended: { tier: 'opus' } }),
    });
    expect(out.proposal).toBe('hold');
    expect(out.reason.some((r) => r.startsWith('target:'))).toBe(false);
  });

  it('holds when a proposed escalation would not move', () => {
    const out = proposeSwitch({
      current: 'opus',
      hysteresis: HELD,
      escalation: { nextTier: 'opus', kind: 'escalate', reason: 'ceiling' },
      receipt: receipt({ recommended: { tier: 'opus' } }),
    });
    expect(out.proposal).toBe('hold');
  });

  it('holds with no economics at all rather than guessing', () => {
    const out = proposeSwitch({ current: 'opus', receipt: receipt() });
    expect(out.proposal).toBe('hold');
    expect(out.reason).toContain('hold:no-economics');
  });
});

describe('incumbent resolution', () => {
  it('falls back to the receipt when the caller asserts no tier', () => {
    const out = proposeSwitch({
      hysteresis: RELEASED,
      receipt: receipt({ current: { tier: 'fable' }, recommended: { tier: 'opus' } }),
    });
    expect(out.proposal).toBe('switch');
    expect(out.reason).toContain('target:opus');
  });

  it('holds when the receipt incumbent already IS the recommendation', () => {
    const out = proposeSwitch({
      hysteresis: RELEASED,
      receipt: receipt({ current: { tier: 'fable' }, recommended: { tier: 'fable' } }),
    });
    expect(out.proposal).toBe('hold');
  });

  it('treats a session with no incumbent as switchable to the recommendation', () => {
    const out = proposeSwitch({ hysteresis: RELEASED, receipt: receipt({ current: null }) });
    expect(out.proposal).toBe('switch');
    expect(out.reason).toContain('target:fable');
  });
});

describe('receipt audit', () => {
  it('reports a receipt carrying a Canary-gated decision instead of trusting it', () => {
    for (const gated of ['switch', 'escalate', 'downgrade']) {
      const out = proposeSwitch({ current: 'opus', hysteresis: HELD, receipt: receipt({ decision: gated }) });
      expect(out.reason).toContain(`receipt:decision-unexpected:${gated}`);
      expect(out.applied).toBe(false);
    }
  });

  it('accepts route and pin without comment', () => {
    for (const ok of OBSERVE_DECISIONS) {
      const out = proposeSwitch({ current: 'opus', hysteresis: HELD, receipt: receipt({ decision: ok }) });
      expect(out.reason.some((r) => r.startsWith('receipt:decision'))).toBe(false);
    }
  });

  it('says so when there is no receipt', () => {
    expect(proposeSwitch({}).reason).toContain('receipt:absent');
  });
});

describe('integration with the real economics modules', () => {
  it('holds a same-tier evaluation that route-hysteresis blocked', () => {
    const hysteresis = evaluateSwitch({ from: 'opus', to: 'opus', catalog: DEFAULT_CATALOG });
    const out = proposeSwitch({
      current: 'opus',
      hysteresis,
      receipt: receipt({ recommended: { tier: 'opus' } }),
    });
    expect(hysteresis.hold).toBe(true);
    expect(out.proposal).toBe('hold');
    expect(out.reason).toContain('hysteresis:same-tier');
  });

  it('escalates on a real resolveEscalation verdict', () => {
    const escalation = resolveEscalation({
      outcome: 'fail', tier: 'sonnet', allowedTiers: ['sonnet', 'opus'],
    });
    expect(escalation.kind).toBe('escalate');
    const out = proposeSwitch({
      current: 'sonnet',
      escalation,
      hysteresis: HELD,
      receipt: receipt({ current: { tier: 'sonnet' } }),
    });
    expect(out.proposal).toBe('escalate');
    expect(out.reason).toContain(`target:${escalation.nextTier}`);
  });

  it('ignores a null-tier escalation verdict', () => {
    const escalation = resolveEscalation({ outcome: 'ok', tier: 'opus', allowedTiers: ['opus'] });
    expect(escalation.nextTier).toBeNull();
    const out = proposeSwitch({ current: 'opus', escalation, hysteresis: HELD, receipt: receipt() });
    expect(out.proposal).toBe('hold');
  });
});

describe('robustness', () => {
  it('never throws on hostile input', () => {
    for (const bad of [undefined, null, 'x', 7, [], { receipt: 'no', hysteresis: 1, escalation: [] }]) {
      expect(() => proposeSwitch(bad)).not.toThrow();
      expect(proposeSwitch(bad).applied).toBe(false);
    }
  });

  it('accepts a string reason from a verdict as readily as an array', () => {
    const out = proposeSwitch({
      current: 'sonnet',
      escalation: { nextTier: 'opus', kind: 'escalate', reason: 'escalate:timeout' },
      receipt: receipt({ current: { tier: 'sonnet' } }),
    });
    expect(out.reason).toContain('escalation:escalate:timeout');
  });
});
