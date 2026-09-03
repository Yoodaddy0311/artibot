/**
 * Tests for the human question gate.
 *
 * The load-bearing property is the conjunction. `ADDENDUM-HARDENING.md:659-673`
 * says the gate must NOT be a confidence threshold, and names four conditions
 * joined by `+`. Three of four is not three quarters of a reason to interrupt
 * someone, so this file walks all sixteen truth-table rows and asserts that
 * exactly one of them opens the gate.
 *
 * On top of that it checks the same property end-to-end on real prompts: four
 * prompts each engineered to fire exactly one condition (asserted, not assumed)
 * and shown to yield `required: false`, and one prompt that fires all four.
 * The truth table alone would leave the prompt-to-condition mapping untested;
 * the prompts alone would leave fourteen of the sixteen rows unvisited.
 *
 * @module tests/planning/question-gate
 */

import { describe, expect, it } from 'vitest';

import {
  COMPLETION_EXPECTATIONS,
  COMPLETION_RANK,
  cueMatches,
  interpretIntent,
  WORK_PURPOSES,
} from '../../lib/intent/interpreter.js';
import {
  ESCALATING_COMPLETIONS,
  ESCALATION_FLOOR,
  evaluateConditions,
  evaluateQuestionGate,
  firstCue,
  GATE_CONDITIONS,
  isFactualLookup,
  planQuestionBatch,
  PRODUCT_DECISION,
  QUESTION_BATCH_POINT,
  requiresQuestion,
  STRUCTURAL_PURPOSES,
} from '../../lib/planning/question-gate.js';

/**
 * Judge a prompt the way a caller would: interpret first, then gate.
 * @param {string} prompt
 * @param {object} [extra]
 */
function judge(prompt, extra = {}) {
  const interpretation = interpretIntent({ prompt });
  const input = { prompt, interpretation, ...extra };
  return {
    conditions: evaluateConditions(input),
    verdict: evaluateQuestionGate(input),
  };
}

/** @param {Record<string, boolean>} conditions */
function trueCount(conditions) {
  return GATE_CONDITIONS.filter((k) => conditions[k]).length;
}

describe('vocabulary is derived from the interpreter, not copied beside it', () => {
  it('derives the escalating tiers by rank from the interpreter vocabulary', () => {
    expect(ESCALATING_COMPLETIONS).toEqual(
      COMPLETION_EXPECTATIONS.filter(
        (t) => COMPLETION_RANK[t] >= COMPLETION_RANK[ESCALATION_FLOOR],
      ),
    );
    expect(Object.isFrozen(ESCALATING_COMPLETIONS)).toBe(true);
  });

  it('pins the resulting members so a vocabulary change surfaces in review', () => {
    // The derivation keeps the set semantically correct; this line keeps a
    // change to it VISIBLE. Both are needed — a derivation alone would let the
    // gate widen silently when someone appends a tier.
    expect(ESCALATING_COMPLETIONS).toEqual(['commit', 'PR', 'deploy']);
    expect(ESCALATION_FLOOR).toBe('commit');
  });

  it('excludes every tier below the floor', () => {
    for (const tier of ['answer', 'artifact', 'implement', 'test']) {
      expect(COMPLETION_RANK[tier]).toBeLessThan(COMPLETION_RANK[ESCALATION_FLOOR]);
      expect(ESCALATING_COMPLETIONS).not.toContain(tier);
    }
  });

  it('keeps STRUCTURAL_PURPOSES inside the interpreter work-purpose vocabulary', () => {
    // This one has no ordering to derive from — it is a genuine semantic subset,
    // so membership is the guard that catches a typo or a renamed purpose.
    for (const purpose of STRUCTURAL_PURPOSES) {
      expect(WORK_PURPOSES).toContain(purpose);
    }
    expect(STRUCTURAL_PURPOSES).toEqual(['design', 'migrate', 'release']);
  });
});

describe('firstCue delegates to the interpreter matcher', () => {
  it('agrees with cueMatches on ASCII boundaries', () => {
    expect(firstCue('the latest build', ['test'])).toBeNull();
    expect(cueMatches('the latest build', 'test')).toBe(false);
    expect(firstCue('open a pr now', ['test', 'pr'])).toBe('pr');
  });

  it('matches Korean cues as substrings', () => {
    expect(firstCue('배포까지 해줘', ['배포'])).toBe('배포');
  });

  it('returns the FIRST matching cue, in list order', () => {
    expect(firstCue('배포하고 커밋해', ['커밋', '배포'])).toBe('커밋');
  });

  it('no longer treats an empty cue as a universal match', () => {
    // The hand-rolled matcher this replaced would have returned '' here,
    // pinning whichever condition owned that list permanently true.
    expect(firstCue('anything at all', [''])).toBeNull();
  });

  it('returns null when no cue fires', () => {
    expect(firstCue('nothing here', ['absent', '없음'])).toBeNull();
  });
});

describe('the four conditions are a conjunction, not a score', () => {
  it('names exactly the four conditions of ADDENDUM-HARDENING.md:665-671', () => {
    expect(GATE_CONDITIONS).toEqual([
      'valueJudgmentRequired',
      'materialDownstreamImpact',
      'evidenceCannotDecide',
      'costOfWrongAssumptionMeaningful',
    ]);
    expect(Object.isFrozen(GATE_CONDITIONS)).toBe(true);
  });

  it('opens on exactly 1 of the 16 truth-table rows', () => {
    const rows = [];
    for (let mask = 0; mask < 16; mask += 1) {
      const conditions = Object.fromEntries(
        GATE_CONDITIONS.map((key, i) => [key, Boolean(mask & (1 << i))]),
      );
      rows.push({ mask, conditions, required: requiresQuestion(conditions) });
    }
    expect(rows).toHaveLength(16);
    expect(rows.filter((r) => r.required)).toHaveLength(1);
    expect(rows.find((r) => r.required).mask).toBe(15);
  });

  it('stays closed for every single condition held alone', () => {
    for (const key of GATE_CONDITIONS) {
      const conditions = Object.fromEntries(GATE_CONDITIONS.map((k) => [k, k === key]));
      expect(requiresQuestion(conditions)).toBe(false);
    }
  });

  it('stays closed for every three-of-four combination', () => {
    for (const missing of GATE_CONDITIONS) {
      const conditions = Object.fromEntries(GATE_CONDITIONS.map((k) => [k, k !== missing]));
      expect(trueCount(conditions)).toBe(3);
      expect(requiresQuestion(conditions)).toBe(false);
    }
  });

  it('fails closed on a malformed or partial conditions object', () => {
    expect(requiresQuestion(null)).toBe(false);
    expect(requiresQuestion(undefined)).toBe(false);
    expect(requiresQuestion({})).toBe(false);
    expect(requiresQuestion('yes')).toBe(false);
    // Truthy-but-not-true must not pass: the check is `=== true`.
    expect(requiresQuestion(
      Object.fromEntries(GATE_CONDITIONS.map((k) => [k, 1])),
    )).toBe(false);
  });
});

describe('each condition alone, on a real prompt, leaves the gate closed', () => {
  it.each([
    ['어느 쪽이 나을까?', 'valueJudgmentRequired'],
    ['public api 를 바꿔줘', 'materialDownstreamImpact'],
    ['비즈니스 전략상 필요해', 'evidenceCannotDecide'],
    ['이건 리스크가 커', 'costOfWrongAssumptionMeaningful'],
  ])('%j fires only %s', (prompt, only) => {
    const { conditions, verdict } = judge(prompt);
    expect(trueCount(conditions)).toBe(1);
    expect(conditions[only]).toBe(true);
    expect(verdict.required).toBe(false);
    expect(verdict.kind).toBeNull();
    expect(verdict.reason).toContain('not met');
  });
});

describe('all four together open the gate', () => {
  const prompt =
    '이 스키마를 어느 쪽으로 갈지 결정해야 하는데 비즈니스 방향에 따라 되돌리기 어렵습니다';

  it('fires every condition', () => {
    expect(trueCount(judge(prompt).conditions)).toBe(4);
  });

  it('returns required with the product-decision kind and a reason', () => {
    const { verdict } = judge(prompt);
    expect(verdict).toEqual({
      required: true,
      kind: PRODUCT_DECISION,
      reason: expect.stringContaining('all four gate conditions hold'),
    });
  });

  it('returns exactly the three contract keys and nothing more', () => {
    expect(Object.keys(judge(prompt).verdict).sort()).toEqual(['kind', 'reason', 'required']);
  });

  it('never returns a question — judgment only', () => {
    const { verdict } = judge(prompt);
    expect(verdict).not.toHaveProperty('question');
    expect(verdict).not.toHaveProperty('questions');
  });
});

describe('factual questions never open the gate', () => {
  it.each([
    'detectIntent 함수 어디 있는지 알려줘',
    'where is the session cache configured',
    '이 훅이 어떻게 동작하는지 보여줘',
  ])('%j is a factual lookup with required:false', (prompt) => {
    expect(isFactualLookup(prompt)).toBe(true);
    const { conditions, verdict } = judge(prompt);
    expect(conditions.valueJudgmentRequired).toBe(false);
    expect(verdict.required).toBe(false);
  });

  it('is still a value judgment when a value cue rides along with the phrasing', () => {
    const prompt = '어느 쪽이 더 나을지 알려줘';
    expect(isFactualLookup(prompt)).toBe(false);
    expect(judge(prompt).conditions.valueJudgmentRequired).toBe(true);
  });

  it('does not call a prompt factual merely because it lacks factual cues', () => {
    expect(isFactualLookup('배포해')).toBe(false);
    expect(isFactualLookup('')).toBe(false);
  });
});

describe('condition 3 defers to evidence when evidence exists', () => {
  it('is false when the prompt points at something measurable', () => {
    // P03:62-63 — "Low confidence first triggers investigation, not a user
    // question." A benchmark can settle this, so the gate must not fire.
    const { conditions } = judge('비즈니스 전략상 어느 쪽이 빠른지 벤치마크로 확인해줘');
    expect(conditions.evidenceCannotDecide).toBe(false);
    expect(judge('비즈니스 전략상 어느 쪽이 빠른지 벤치마크로 확인해줘').verdict.required)
      .toBe(false);
  });
});

describe('interpretation feeds conditions 2 and 4', () => {
  it('treats a completion expectation at or past commit as material and costly', () => {
    const interpretation = interpretIntent({ prompt: '커밋까지 해줘' });
    expect(interpretation.completion_expectation).toBe('commit');
    const conditions = evaluateConditions({ prompt: '커밋까지 해줘', interpretation });
    expect(conditions.materialDownstreamImpact).toBe(true);
    expect(conditions.costOfWrongAssumptionMeaningful).toBe(true);
  });

  it('treats design, migrate and release purposes as structural', () => {
    for (const prompt of ['스키마를 설계해줘', 'postgres 로 마이그레이션 해줘', 'v2 를 출시해줘']) {
      const interpretation = interpretIntent({ prompt });
      const conditions = evaluateConditions({ prompt, interpretation });
      expect(conditions.materialDownstreamImpact).toBe(true);
      expect(conditions.costOfWrongAssumptionMeaningful).toBe(true);
    }
  });

  it('reads a high risk factor from the complexity classification', () => {
    const conditions = evaluateConditions({
      prompt: '이거 해줘',
      classification: { factors: { risk: 0.8 } },
    });
    expect(conditions.costOfWrongAssumptionMeaningful).toBe(true);
  });

  it('works with no interpretation at all', () => {
    expect(() => evaluateQuestionGate({ prompt: 'anything' })).not.toThrow();
    expect(evaluateQuestionGate().required).toBe(false);
    expect(evaluateQuestionGate().reason).toBe('no gate condition holds');
  });
});

describe('config can pin a condition', () => {
  it('honours an explicit force for a single condition', () => {
    const conditions = evaluateConditions({
      prompt: '어느 쪽이 나을까?',
      config: { question_gate: { force: { valueJudgmentRequired: false } } },
    });
    expect(conditions.valueJudgmentRequired).toBe(false);
  });

  it('ignores a forced value that is not a boolean', () => {
    const conditions = evaluateConditions({
      prompt: '어느 쪽이 나을까?',
      config: { question_gate: { force: { valueJudgmentRequired: 'no' } } },
    });
    expect(conditions.valueJudgmentRequired).toBe(true);
  });
});

describe('planQuestionBatch — the ADR-start batching rule', () => {
  it('points at the start of ADR work, per ADDENDUM-HARDENING.md:673-677', () => {
    expect(QUESTION_BATCH_POINT).toBe('adr_start');
  });

  it('collapses several firing verdicts into one ask', () => {
    const firing = { required: true, kind: PRODUCT_DECISION, reason: 'x' };
    const quiet = { required: false, kind: null, reason: 'y' };
    expect(planQuestionBatch([firing, quiet, firing])).toEqual({
      ask: true,
      at: 'adr_start',
      count: 2,
      kinds: [PRODUCT_DECISION],
    });
  });

  it('asks nothing when no verdict fired', () => {
    expect(planQuestionBatch([{ required: false, kind: null, reason: 'y' }]))
      .toMatchObject({ ask: false, count: 0, kinds: [] });
    expect(planQuestionBatch()).toMatchObject({ ask: false, count: 0 });
    expect(planQuestionBatch(null)).toMatchObject({ ask: false, count: 0 });
  });
});

describe('purity', () => {
  it('returns deep-equal verdicts for equal inputs', () => {
    const input = { prompt: '스키마를 어느 쪽으로 결정할지 비즈니스 리스크가 큽니다' };
    expect(evaluateQuestionGate(input)).toEqual(evaluateQuestionGate(input));
  });
});
