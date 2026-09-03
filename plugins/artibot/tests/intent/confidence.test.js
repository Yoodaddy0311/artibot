/**
 * Tests for intent confidence.
 *
 * The strongest assertion in this file is the shape one. `intent_confidence` is
 * four keys — three numbers and one boolean — at
 * `package/03_INTENT_MISSION_COMPILER.md:65-69`, and the landed T-13 schema
 * closes the object with `additionalProperties: false`
 * (`schemas/mission-contract.schema.json:170-184`). A fifth key would validate
 * fine here and fail at contract assembly, so the key set is read off the schema
 * file rather than restated, and asserted for equality in both directions.
 *
 * The numeric weights are a documented calibration, not a measured one — no
 * labelled corpus exists in this repository. So the score tests assert
 * ORDERING and TERM PRESENCE (a named target raises scope; ambiguity lowers
 * goal) rather than freezing magic constants that nothing justifies.
 *
 * @module tests/intent/confidence
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  clamp01,
  computeIntentConfidence,
  CONFIDENCE_KEYS,
  CONFIDENCE_WEIGHTS,
  explainConfidence,
  findConcreteTargets,
} from '../../lib/intent/confidence.js';
import { interpretIntent } from '../../lib/intent/interpreter.js';

const schemaPath = fileURLToPath(
  new URL('../../schemas/mission-contract.schema.json', import.meta.url),
);
const missionContractSchema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const schemaConfidence = missionContractSchema.properties.intent_confidence;

/**
 * @param {string} prompt
 * @param {object} [extra]
 */
function score(prompt, extra = {}) {
  const interpretation = interpretIntent({ prompt, ...extra });
  return computeIntentConfidence({ prompt, interpretation, ...extra });
}

describe('contract shape', () => {
  it('names the four axes of P03:65-69', () => {
    expect(CONFIDENCE_KEYS).toEqual([
      'goal', 'scope', 'completion_expectation', 'product_decision_required',
    ]);
    expect(Object.isFrozen(CONFIDENCE_KEYS)).toBe(true);
  });

  it('matches the landed T-13 schema key set exactly, in both directions', () => {
    const schemaKeys = Object.keys(schemaConfidence.properties).sort();
    expect(schemaKeys).toEqual([...CONFIDENCE_KEYS].sort());
    // The schema closes the object, which is why a fifth key must never appear.
    expect(schemaConfidence.additionalProperties).toBe(false);
  });

  it('returns exactly those four keys and no fifth', () => {
    const result = score('lib/auth/session.js 의 버그를 고쳐줘');
    expect(Object.keys(result).sort()).toEqual([...CONFIDENCE_KEYS].sort());
  });

  it('returns three numbers in [0,1] and one boolean', () => {
    const result = score('스키마를 설계해줘');
    for (const key of ['goal', 'scope', 'completion_expectation']) {
      expect(typeof result[key]).toBe('number');
      expect(result[key]).toBeGreaterThanOrEqual(0);
      expect(result[key]).toBeLessThanOrEqual(1);
      expect(result[key]).toBe(Math.round(result[key] * 100) / 100);
    }
    expect(typeof result.product_decision_required).toBe('boolean');
  });

  it('freezes the weight table', () => {
    expect(Object.isFrozen(CONFIDENCE_WEIGHTS)).toBe(true);
  });
});

describe('purity', () => {
  it('returns deep-equal results for equal inputs', () => {
    const input = { prompt: '이 모듈을 리팩터링해줘', interpretation: interpretIntent({ prompt: '이 모듈을 리팩터링해줘' }) };
    expect(computeIntentConfidence(input)).toEqual(computeIntentConfidence(input));
  });

  it('tolerates a completely empty call', () => {
    const r = computeIntentConfidence();
    expect(Object.keys(r).sort()).toEqual([...CONFIDENCE_KEYS].sort());
    expect(r.product_decision_required).toBe(false);
  });
});

describe('goal', () => {
  it('rises when a work purpose is evidenced', () => {
    const withPurpose = score('로그인 기능을 구현해줘');
    const without = score('hmm');
    expect(withPurpose.goal).toBeGreaterThan(without.goal);
  });

  it('falls as detectIntent ambiguity rises', () => {
    const interpretation = interpretIntent({ prompt: '구현해줘' });
    const clear = computeIntentConfidence({
      prompt: '구현해줘', interpretation, intent: { ambiguity: { score: 0 } },
    });
    const murky = computeIntentConfidence({
      prompt: '구현해줘', interpretation, intent: { ambiguity: { score: 100 } },
    });
    expect(murky.goal).toBeLessThan(clear.goal);
    expect(clear.goal - murky.goal).toBeCloseTo(CONFIDENCE_WEIGHTS.ambiguityPenalty, 5);
  });

  it('falls as the complexity uncertainty factor rises', () => {
    const interpretation = interpretIntent({ prompt: '구현해줘' });
    const low = computeIntentConfidence({ prompt: '구현해줘', interpretation });
    const high = computeIntentConfidence({
      prompt: '구현해줘', interpretation, classification: { factors: { uncertainty: 1 } },
    });
    expect(high.goal).toBeLessThan(low.goal);
  });

  it('names the terms that produced the score', () => {
    const prompt = '로그인 기능을 구현해줘';
    const detail = explainConfidence({ prompt, interpretation: interpretIntent({ prompt }) });
    const names = detail.goal.terms.map((t) => t.name);
    expect(names).toContain('base');
    expect(names).toContain('resolved:work_purpose');
    expect(detail.goal.value).toBe(clamp01(detail.goal.terms.reduce((a, t) => a + t.delta, 0)));
  });
});

describe('scope', () => {
  it('rises when the prompt names a concrete target', () => {
    expect(score('lib/auth/session.js 를 고쳐줘').scope)
      .toBeGreaterThan(score('로그인을 고쳐줘').scope);
  });

  it('rises further, up to a cap, as more targets are named', () => {
    const one = score('`sessionCache` 를 고쳐줘').scope;
    const three = score('`sessionCache` 와 lib/auth/token.js 와 config.yaml 을 고쳐줘').scope;
    expect(three).toBeGreaterThan(one);
    const detail = explainConfidence({
      prompt: '`a` 와 lib/b.js 와 c.yaml 와 d.json 와 e.md 를 고쳐줘',
      interpretation: interpretIntent({ prompt: 'x' }),
    });
    const extra = detail.scope.terms.find((t) => t.name === 'extra_targets');
    expect(extra.delta).toBeLessThanOrEqual(CONFIDENCE_WEIGHTS.extraTargetCap);
  });

  it('falls when a universal quantifier widens the stated target', () => {
    expect(score('lib/auth/session.js 를 전부 고쳐줘').scope)
      .toBeLessThan(score('lib/auth/session.js 를 고쳐줘').scope);
  });

  it('falls as the complexity domain spread rises', () => {
    const interpretation = interpretIntent({ prompt: '고쳐줘' });
    const narrow = computeIntentConfidence({ prompt: '고쳐줘', interpretation });
    const wide = computeIntentConfidence({
      prompt: '고쳐줘', interpretation, classification: { factors: { domains: 1 } },
    });
    expect(wide.scope).toBeLessThan(narrow.scope);
  });
});

describe('findConcreteTargets', () => {
  it.each([
    ['lib/auth/session.js 를 봐줘', 'lib/auth/session.js'],
    ['`sessionCache` 를 봐줘', '`sessioncache`'],
    ['config.yaml 을 봐줘', 'config.yaml'],
    ['detectIntent 를 봐줘', 'detectintent'],
  ])('finds a target in %j', (prompt, expected) => {
    expect(findConcreteTargets(prompt)).toContain(expected);
  });

  it('finds nothing in a prompt with no named target', () => {
    expect(findConcreteTargets('로그인이 안 돼요')).toEqual([]);
  });

  it('deduplicates repeated mentions', () => {
    expect(findConcreteTargets('lib/a.js 와 lib/a.js')).toHaveLength(1);
  });
});

describe('completion_expectation', () => {
  it('rises when a completion cue is present', () => {
    expect(score('구현하고 커밋해줘').completion_expectation)
      .toBeGreaterThan(score('hmm').completion_expectation);
  });

  it('falls when the prompt straddles distant tiers', () => {
    const prompt = '이 코드가 뭐야? 그리고 배포해줘';
    const interpretation = interpretIntent({ prompt });
    expect(interpretation.completion_expectations).toEqual(
      expect.arrayContaining(['answer', 'deploy']),
    );
    const detail = explainConfidence({ prompt, interpretation });
    expect(detail.completion_expectation.terms.map((t) => t.name))
      .toContain('completion_spread');
  });

  it('sits at the base when the axis fell back to a default', () => {
    const detail = explainConfidence({ prompt: 'hmm', interpretation: interpretIntent({ prompt: 'hmm' }) });
    expect(detail.completion_expectation.terms).toEqual([
      { name: 'base', delta: CONFIDENCE_WEIGHTS.base },
    ]);
  });
});

describe('product_decision_required delegates to the question gate', () => {
  it('is false for a plain implementation request', () => {
    expect(score('로그인 기능을 구현해줘').product_decision_required).toBe(false);
  });

  it('is false for a fact-finding question', () => {
    expect(score('detectIntent 함수 어디 있는지 알려줘').product_decision_required).toBe(false);
  });

  it('is true only when all four gate conditions hold', () => {
    const prompt =
      '이 스키마를 어느 쪽으로 갈지 결정해야 하는데 비즈니스 방향에 따라 되돌리기 어렵습니다';
    const interpretation = interpretIntent({ prompt });
    const detail = explainConfidence({ prompt, interpretation });
    expect(detail.gate.required).toBe(true);
    expect(computeIntentConfidence({ prompt, interpretation }).product_decision_required)
      .toBe(true);
  });

  it('agrees with the gate verdict it was derived from, on both outcomes', () => {
    for (const prompt of [
      '로그인 기능을 구현해줘',
      '이 스키마를 어느 쪽으로 갈지 결정해야 하는데 비즈니스 방향에 따라 되돌리기 어렵습니다',
    ]) {
      const interpretation = interpretIntent({ prompt });
      const detail = explainConfidence({ prompt, interpretation });
      expect(computeIntentConfidence({ prompt, interpretation }).product_decision_required)
        .toBe(detail.gate.required);
    }
  });
});

describe('clamp01', () => {
  it('clamps and rounds to two decimals', () => {
    expect(clamp01(1.7)).toBe(1);
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(0.456)).toBe(0.46);
  });

  it('maps non-finite input to 0 rather than propagating NaN into a contract', () => {
    expect(clamp01(NaN)).toBe(0);
    expect(clamp01(Infinity)).toBe(1);
  });
});
