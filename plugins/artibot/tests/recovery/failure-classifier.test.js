/**
 * `lib/recovery/failure-classifier` — verdict/verification -> failure class.
 *
 * The verdict enum is asserted against `schemas/review-output.schema.json`
 * rather than retyped, so the module constant and the schema cannot drift
 * apart silently.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CANONICAL_VERDICTS as REVIEWER_VERDICTS,
} from '../../lib/review/independent-reviewer.js';
import {
  CANONICAL_VERDICTS,
  classify,
  FAILURE_CLASSES,
} from '../../lib/recovery/failure-classifier.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REVIEW_SCHEMA = path.join(PLUGIN_ROOT, 'schemas', 'review-output.schema.json');
const ADAPTER_MAP = path.join(PLUGIN_ROOT, 'schemas', 'verdict-adapter-map.json');

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

describe('contract with the review schema', () => {
  it('re-exports the reviewer vocabulary rather than holding a copy of it', () => {
    // Reference identity, not deep equality: a copy that happens to agree
    // today would pass a value comparison and still be a second truth.
    expect(CANONICAL_VERDICTS).toBe(REVIEWER_VERDICTS);
  });

  it('CANONICAL_VERDICTS matches the reviewOutputV2 verdict enum exactly', () => {
    const schema = readJson(REVIEW_SCHEMA);
    const enumerated = schema.definitions.reviewOutputV2.properties.verdict.enum;
    expect([...CANONICAL_VERDICTS]).toEqual(enumerated);
  });

  it('matches the adapter map target_verdicts, so both sides fold to one list', () => {
    const adapter = readJson(ADAPTER_MAP);
    expect([...CANONICAL_VERDICTS].sort()).toEqual([...adapter.target_verdicts].sort());
  });

  it('exposes exactly the five failure classes', () => {
    expect([...FAILURE_CLASSES]).toEqual([
      'implementation',
      'plan',
      'framing',
      'human-value',
      'unknown',
    ]);
  });
});

describe('all five verdicts, with no history', () => {
  const table = [
    ['PASS', 'unknown'],
    ['REPAIR_REQUIRED', 'implementation'],
    ['REPLAN_REQUIRED', 'plan'],
    ['INTENT_REVIEW_REQUIRED', 'human-value'],
    ['BLOCK', 'human-value'],
  ];

  it.each(table)('%s -> %s', (verdict, expected) => {
    expect(classify({ verdict }).class).toBe(expected);
  });

  it('every canonical verdict is covered by the table above', () => {
    expect(table.map(([verdict]) => verdict).sort()).toEqual([...CANONICAL_VERDICTS].sort());
  });

  it('PASS is named a precondition violation, not a silent no-op', () => {
    const result = classify({ verdict: 'PASS' });
    expect(result.class).toBe('unknown');
    expect(result.reason).toMatch(/not a failure/i);
  });

  it('always returns a class drawn from FAILURE_CLASSES', () => {
    for (const verdict of CANONICAL_VERDICTS) {
      expect(FAILURE_CLASSES).toContain(classify({ verdict }).class);
    }
  });
});

describe('all five verdicts, with prior history', () => {
  const history = [
    { class: 'implementation' },
    { class: 'implementation' },
    { class: 'plan' },
    { class: 'human-value' },
  ];

  it.each([
    ['PASS', 'unknown', 0],
    ['REPAIR_REQUIRED', 'implementation', 2],
    ['REPLAN_REQUIRED', 'plan', 1],
    ['INTENT_REVIEW_REQUIRED', 'human-value', 1],
    ['BLOCK', 'human-value', 1],
  ])('%s keeps class %s and counts %i prior sighting(s)', (verdict, expected, prior) => {
    const result = classify({ verdict, history });
    expect(result.class).toBe(expected);
    expect(result.signals.priorSameClass).toBe(prior);
  });

  it('history never changes the class — thresholds belong to the controller', () => {
    const heavy = Array.from({ length: 9 }, () => ({ class: 'implementation' }));
    expect(classify({ verdict: 'REPAIR_REQUIRED', history: heavy }).class).toBe('implementation');
    expect(classify({ verdict: 'REPAIR_REQUIRED', history: heavy }).signals.priorSameClass).toBe(9);
  });

  it('reads the alternate `classification` key used by some attempt records', () => {
    const result = classify({
      verdict: 'REPAIR_REQUIRED',
      history: [{ classification: 'implementation' }, { classification: 'plan' }],
    });
    expect(result.signals.priorSameClass).toBe(1);
  });

  it('tolerates a malformed history without throwing', () => {
    for (const malformed of [null, 'nope', [null, 42, {}, { class: 7 }]]) {
      expect(classify({ verdict: 'BLOCK', history: malformed }).signals.priorSameClass).toBe(0);
    }
  });
});

describe('architecture contradictions (Hardening 35, ultraplan rung)', () => {
  const planDelta = { contradictions: ['storage layer is both L2 and L4'] };

  it('upgrades plan to framing', () => {
    const result = classify({ verdict: 'REPLAN_REQUIRED', planDelta });
    expect(result.class).toBe('framing');
    expect(result.signals.contradictions).toHaveLength(1);
  });

  it('does NOT upgrade implementation — a reviewer repair request stands', () => {
    expect(classify({ verdict: 'REPAIR_REQUIRED', planDelta }).class).toBe('implementation');
  });

  it('does not upgrade human-value either', () => {
    expect(classify({ verdict: 'BLOCK', planDelta }).class).toBe('human-value');
    expect(classify({ verdict: 'INTENT_REVIEW_REQUIRED', planDelta }).class).toBe('human-value');
  });

  it('ignores an empty or blank contradiction list', () => {
    expect(classify({ verdict: 'REPLAN_REQUIRED', planDelta: { contradictions: [] } }).class)
      .toBe('plan');
    expect(classify({ verdict: 'REPLAN_REQUIRED', planDelta: { contradictions: ['  '] } }).class)
      .toBe('plan');
    expect(classify({ verdict: 'REPLAN_REQUIRED', planDelta: { contradictions: 'oops' } }).class)
      .toBe('plan');
  });
});

describe('verification with no review verdict', () => {
  it('FAIL is an implementation failure', () => {
    const result = classify({ verification: { status: 'FAIL' } });
    expect(result.class).toBe('implementation');
    expect(result.signals.verificationStatus).toBe('FAIL');
  });

  it('UNMEASURED is unknown — an unmeasured layer is not a pass', () => {
    const result = classify({ verification: { status: 'UNMEASURED' } });
    expect(result.class).toBe('unknown');
    expect(result.reason).toMatch(/UNMEASURED/);
  });

  it('PASS with no verdict is unknown, not a failure to repair', () => {
    expect(classify({ verification: { status: 'PASS' } }).class).toBe('unknown');
  });

  it('a review verdict outranks the verification status', () => {
    expect(classify({ verdict: 'BLOCK', verification: { status: 'FAIL' } }).class)
      .toBe('human-value');
  });
});

describe('fail-closed on anything unrecognized', () => {
  it('legacy vocabulary tokens are not folded here', () => {
    for (const token of ['fail', 'REQUEST_CHANGES', 'SPEC_FAIL', 'QUALITY_FAIL', 'repair']) {
      const result = classify({ verdict: token });
      expect(result.class).toBe('unknown');
      expect(result.reason).toMatch(/verdict-adapter-map/);
    }
  });

  it('empty input is unknown', () => {
    expect(classify().class).toBe('unknown');
    expect(classify({}).class).toBe('unknown');
    expect(classify(null).class).toBe('unknown');
  });

  it('never returns a class outside the five, whatever it is fed', () => {
    const junk = [
      { verdict: 42 },
      { verdict: '' },
      { verdict: '  ' },
      { verification: 'FAIL' },
      { verification: { status: 'GREEN' } },
      { planDelta: 3 },
    ];
    for (const input of junk) {
      expect(FAILURE_CLASSES).toContain(classify(input).class);
    }
  });

  it('always carries a non-empty reason', () => {
    for (const input of [{}, { verdict: 'PASS' }, { verdict: 'BLOCK' }, { verdict: 'nope' }]) {
      expect(classify(input).reason.length).toBeGreaterThan(0);
    }
  });
});

describe('purity', () => {
  it('does not mutate its input', () => {
    const input = {
      verdict: 'REPLAN_REQUIRED',
      verification: { status: 'FAIL' },
      planDelta: { contradictions: ['a'] },
      history: [{ class: 'plan' }],
    };
    const snapshot = JSON.stringify(input);
    classify(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('returns a frozen result', () => {
    const result = classify({ verdict: 'BLOCK' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.signals)).toBe(true);
  });
});
