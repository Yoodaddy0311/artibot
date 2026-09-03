/**
 * lib/mission/blindspot-scanner.js — 3-class findings, and the standing proof
 * that the scanner never authorizes a fix.
 *
 * WHAT THESE TESTS CANNOT SEE
 * ---------------------------
 *  - The six conditions are caller assertions. `small: true` is believed here
 *    and in production alike; nothing counts lines or runs anything.
 *  - "Never fixes" is proved for THIS module's return value. It cannot prove a
 *    downstream consumer will not act on `bounded_blindspots` anyway — that is
 *    the caller's gate, and decision A1 is what settles whether one exists.
 */

import { describe, expect, it } from 'vitest';

import {
  BOUNDED_CONDITIONS,
  classifyBlindspot,
  FINDING_CLASSES,
  scanBlindspots,
} from '../../lib/mission/blindspot-scanner.js';

const allSix = {
  causal: true,
  small: true,
  reversible: true,
  intentClear: true,
  noNewProductDecision: true,
  verifiable: true,
};

describe('the six conditions of design 09', () => {
  it('are exactly the six, in the design\'s order', () => {
    expect(BOUNDED_CONDITIONS).toEqual([
      'causal', 'small', 'reversible', 'intentClear', 'noNewProductDecision', 'verifiable',
    ]);
  });

  it('re-exports the 3-class vocabulary so consumers need one import', () => {
    expect(FINDING_CLASSES).toEqual([
      'mission_blockers', 'bounded_blindspots', 'future_opportunities',
    ]);
  });
});

describe('classifyBlindspot()', () => {
  it('all six met → bounded_blindspots', () => {
    const result = classifyBlindspot({ subject: 'stale JSDoc in split/plan.js', ...allSix });
    expect(result.class).toBe('bounded_blindspots');
    expect(result.conditions.allMet).toBe(true);
  });

  it('one condition unmet → future_opportunities, naming which', () => {
    const result = classifyBlindspot({ subject: 'rewrite the router', ...allSix, small: false });
    expect(result.class).toBe('future_opportunities');
    expect(result.conditions.unmet).toEqual(['small']);
    expect(result.reason).toMatch(/small/);
  });

  it('an UNSET condition counts as unmet — silence never promotes', () => {
    const partial = { ...allSix };
    delete partial.verifiable;
    const result = classifyBlindspot({ subject: 'x', ...partial });
    expect(result.class).toBe('future_opportunities');
    expect(result.conditions.unmet).toEqual(['verifiable']);
  });

  it('only a literal true counts — truthy values do not', () => {
    const result = classifyBlindspot({ subject: 'x', ...allSix, causal: 'yes' });
    expect(result.conditions.unmet).toEqual(['causal']);
  });

  it('a blocker outranks the six conditions', () => {
    const result = classifyBlindspot({
      subject: 'missing schema', blocksMission: true, small: false,
    });
    expect(result.class).toBe('mission_blockers');
  });

  it('an empty candidate lands in future_opportunities with every condition unmet', () => {
    const result = classifyBlindspot({});
    expect(result.class).toBe('future_opportunities');
    expect(result.conditions.unmet).toHaveLength(6);
  });
});

describe('scanBlindspots()', () => {
  const report = scanBlindspots({
    candidates: [
      { subject: 'missing mission_id in envelope', blocksMission: true },
      { subject: 'stale JSDoc', ...allSix },
      { subject: 'rewrite the router', ...allSix, small: false },
    ],
  });

  it('splits candidates into the three classes', () => {
    expect(report.findings).toEqual({
      mission_blockers: ['missing mission_id in envelope'],
      bounded_blindspots: ['stale JSDoc'],
      future_opportunities: ['rewrite the router'],
    });
  });

  it('always reports auto-fix as NOT allowed, blocked by open decision A1', () => {
    expect(report.autoFix.allowed).toBe(false);
    expect(report.autoFix.blockedBy).toBe('A1');
  });

  it('auto-fix stays blocked even when every candidate is bounded', () => {
    const all = scanBlindspots({ candidates: [{ subject: 'a', ...allSix }] });
    expect(all.findings.bounded_blindspots).toEqual(['a']);
    expect(all.autoFix.allowed).toBe(false);
  });

  it('returns three empty lists for no candidates', () => {
    const empty = scanBlindspots({});
    expect(empty.findings).toEqual({
      mission_blockers: [], bounded_blindspots: [], future_opportunities: [],
    });
    expect(empty.classified).toEqual([]);
  });

  it('does not mutate the contract it is given', () => {
    const contract = { goal: 'g', scope: { requested_target: ['split'] } };
    const before = JSON.stringify(contract);
    scanBlindspots({ candidates: [{ subject: 'a', ...allSix }], contract });
    expect(JSON.stringify(contract)).toBe(before);
  });

  it('does not mutate the candidates it is given', () => {
    const candidates = [{ subject: 'a', ...allSix }];
    const before = JSON.stringify(candidates);
    scanBlindspots({ candidates });
    expect(JSON.stringify(candidates)).toBe(before);
  });
});
