/**
 * Tests for the intent interpreter — the four runtime-activation axes.
 *
 * Two things are being pinned here, and they are different in kind:
 *
 * 1. VOCABULARY FIDELITY. The axis values are not this module's to choose; they
 *    are copied from `package/02_PRODUCT_UX_NATURAL_LANGUAGE_RUNTIME.md:55-58`
 *    and must stay compatible with the landed T-18 execution-profile schema.
 *    Those assertions read the schema file from disk rather than restating its
 *    enum, so a change on either side breaks the test instead of drifting.
 *
 * 2. BEHAVIOUR. Purity, precedence, defaults, and the eight worked rows of the
 *    P02 example table (`:70-77`), which are the only labelled examples the
 *    design corpus provides.
 *
 * @module tests/intent/interpreter
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  AXIS_DEFAULTS,
  COMPLETION_EXPECTATIONS,
  COMPLETION_RANK,
  cueMatches,
  DEPTH_RANK,
  DEPTHS,
  INTENT_TO_COMPLETION,
  INTENT_TO_PURPOSE,
  interpretIntent,
  PERFORMANCE_PRECEDENCE,
  PERFORMANCE_PRIORITIES,
  PERFORMANCE_PROSE_ALIASES,
  WORK_PURPOSES,
} from '../../lib/intent/interpreter.js';

const schemaPath = fileURLToPath(
  new URL('../../schemas/execution-profile.schema.json', import.meta.url),
);
const executionProfileSchema = JSON.parse(readFileSync(schemaPath, 'utf8'));

describe('axis vocabularies match the design documents', () => {
  it('carries the 12 work purposes of P02:55 verbatim and in order', () => {
    expect(WORK_PURPOSES).toEqual([
      'explain', 'investigate', 'design', 'implement', 'debug', 'review',
      'compare', 'migrate', 'refactor', 'release', 'document', 'operate',
    ]);
    expect(WORK_PURPOSES).toHaveLength(12);
  });

  it('carries the 4 depths of P02:56 verbatim', () => {
    expect(DEPTHS).toEqual(['direct', 'plan', 'deep-plan', 'ultraplan']);
  });

  it('carries the 7 completion expectations of P02:57 verbatim, PR upper-cased', () => {
    expect(COMPLETION_EXPECTATIONS).toEqual([
      'answer', 'artifact', 'implement', 'test', 'commit', 'PR', 'deploy',
    ]);
  });

  it('carries 5 performance priorities and maps the two P02 prose spellings', () => {
    expect(PERFORMANCE_PRIORITIES).toHaveLength(5);
    // The mapping the T-18 README demands at schemas/execution-profile.README.md:86-89.
    expect(PERFORMANCE_PROSE_ALIASES['high-quality']).toBe('quality');
    expect(PERFORMANCE_PROSE_ALIASES['maximum-performance']).toBe('maximum_performance');
  });

  it('freezes every exported table so a caller cannot mutate shared state', () => {
    for (const table of [
      WORK_PURPOSES, DEPTHS, COMPLETION_EXPECTATIONS, PERFORMANCE_PRIORITIES,
      DEPTH_RANK, COMPLETION_RANK, PERFORMANCE_PRECEDENCE, AXIS_DEFAULTS,
      INTENT_TO_PURPOSE, INTENT_TO_COMPLETION,
    ]) {
      expect(Object.isFrozen(table)).toBe(true);
    }
  });

  it('ranks every value of the ordered axes exactly once', () => {
    expect(Object.keys(DEPTH_RANK).sort()).toEqual([...DEPTHS].sort());
    expect(Object.keys(COMPLETION_RANK).sort()).toEqual([...COMPLETION_EXPECTATIONS].sort());
    expect([...PERFORMANCE_PRECEDENCE].sort()).toEqual([...PERFORMANCE_PRIORITIES].sort());
  });
});

describe('cross-check against the landed T-18 execution-profile schema', () => {
  it('emits only depths the schema accepts for reasoning.depth', () => {
    const enumerated = executionProfileSchema.properties.reasoning.properties.depth.enum;
    for (const depth of DEPTHS) expect(enumerated).toContain(depth);
  });

  it('emits only performance priorities the schema accepts', () => {
    const enumerated = executionProfileSchema.properties.performance.properties.priority.enum;
    for (const value of PERFORMANCE_PRIORITIES) expect(enumerated).toContain(value);
  });

  it('never emits the two P02 prose spellings the schema rejects', () => {
    const enumerated = executionProfileSchema.properties.performance.properties.priority.enum;
    for (const prose of Object.keys(PERFORMANCE_PROSE_ALIASES)) {
      expect(enumerated).not.toContain(prose);
      expect(PERFORMANCE_PRIORITIES).not.toContain(prose);
    }
  });
});

describe('purity', () => {
  const input = { prompt: 'lib/auth/session.js 의 로그인 버그를 제대로 고쳐줘' };

  it('returns deep-equal results for equal inputs', () => {
    expect(interpretIntent(input)).toEqual(interpretIntent(input));
  });

  it('does not mutate its input', () => {
    const frozen = Object.freeze({ prompt: '구현해줘', intent: Object.freeze({ intents: [] }) });
    expect(() => interpretIntent(frozen)).not.toThrow();
  });

  it('tolerates a completely empty call', () => {
    const r = interpretIntent();
    expect(r.work_purpose).toBeNull();
    expect(r.depth).toBe('direct');
    expect(r.completion_expectation).toBe('answer');
    expect(r.performance).toBe('balanced');
    expect(r.defaulted).toEqual(['depth', 'completion_expectation', 'performance']);
  });
});

describe('work purpose', () => {
  it.each([
    ['로그인 기능을 구현해줘', 'implement'],
    ['이 버그를 고쳐줘', 'debug'],
    ['이 PR 을 검수해줘', 'review'],
    ['스키마를 설계해줘', 'design'],
    ['원인을 조사해줘', 'investigate'],
    ['이 코드가 뭐 하는지 설명해줘', 'explain'],
    ['두 라이브러리를 비교해줘', 'compare'],
    ['postgres 로 마이그레이션 해줘', 'migrate'],
    ['중복 코드를 정리해줘', 'refactor'],
    ['v2 를 출시해줘', 'release'],
    ['이 모듈 문서화해줘', 'document'],
    ['서버를 재시작해줘', 'operate'],
  ])('reads %j as %s', (prompt, expected) => {
    expect(interpretIntent({ prompt }).work_purpose).toBe(expected);
  });

  it('resolves to null when no cue evidences any purpose', () => {
    const r = interpretIntent({ prompt: 'hmm' });
    expect(r.work_purpose).toBeNull();
    expect(r.work_purposes).toEqual([]);
    // A null purpose is deliberately NOT listed as defaulted: there is no
    // default to have fallen back to.
    expect(r.defaulted).not.toContain('work_purpose');
  });

  it('accepts detectIntent output as a second source of evidence', () => {
    const r = interpretIntent({ prompt: 'do it', intent: { intents: ['action:refactor'] } });
    expect(r.work_purpose).toBe('refactor');
    expect(r.evidence).toContainEqual({
      axis: 'work_purpose', value: 'refactor', cue: 'action:refactor', source: 'intent',
    });
  });

  it('ranks every evidenced purpose, most-evidenced first', () => {
    const r = interpretIntent({ prompt: '버그를 고쳐줘. 그리고 문서도 갱신해줘.' });
    expect(r.work_purposes[0]).toBe('debug');
    expect(r.work_purposes).toContain('document');
  });
});

describe('depth', () => {
  it('escalates to the deepest cue present', () => {
    const r = interpretIntent({ prompt: '계획을 세우고 구조부터 제대로 봐줘' });
    expect(r.depth).toBe('deep-plan');
    expect(DEPTH_RANK[r.depth]).toBeGreaterThan(DEPTH_RANK.plan);
  });

  it('raises the floor to plan when the complexity router chose the deep path', () => {
    const r = interpretIntent({ prompt: '고쳐줘', classification: { system: 2 } });
    expect(r.depth).toBe('plan');
    expect(r.evidence).toContainEqual({
      axis: 'depth', value: 'plan', cue: 'system=2', source: 'classification',
    });
  });

  it('does not lower an already-deeper cue when the router chose the deep path', () => {
    const r = interpretIntent({ prompt: '울트라플랜으로 가자', classification: { system: 2 } });
    expect(r.depth).toBe('ultraplan');
  });
});

describe('completion expectation', () => {
  it('resolves to the furthest-reaching cue present', () => {
    const r = interpretIntent({ prompt: '구현하고 테스트하고 커밋하고 배포까지 해줘' });
    expect(r.completion_expectation).toBe('deploy');
    expect(r.completion_expectations).toEqual(
      expect.arrayContaining(['implement', 'test', 'commit', 'deploy']),
    );
  });

  it('lists tiers in document order regardless of the order they appeared', () => {
    const r = interpretIntent({ prompt: '배포하기 전에 테스트부터' });
    const ranks = r.completion_expectations.map((v) => COMPLETION_RANK[v]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('defaults to answer, the only tier that implies no repository write', () => {
    const r = interpretIntent({ prompt: 'hmm' });
    expect(r.completion_expectation).toBe('answer');
    expect(r.defaulted).toContain('completion_expectation');
  });
});

describe('performance', () => {
  it('defaults to balanced, the mission contract default at P03:32-33', () => {
    expect(interpretIntent({ prompt: 'hmm' }).performance).toBe('balanced');
    expect(AXIS_DEFAULTS.performance).toBe('balanced');
  });

  it('prefers a speed cue over a quality cue, per the P02 --fast row', () => {
    expect(interpretIntent({ prompt: '최대한 빨리 정확하게' }).performance).toBe('fast');
  });

  it('lets an explicit spend-freely phrase outrank everything', () => {
    expect(
      interpretIntent({ prompt: '토큰 아끼지 말고 빨리 제대로 처리해' }).performance,
    ).toBe('maximum_performance');
  });

  it('does not treat a bare 최대한 as maximum_performance', () => {
    // That word appears in the P02 row that maps to `--fast`, so claiming it for
    // the high-resource row would collapse two documented rows into one.
    expect(interpretIntent({ prompt: '최대한 빨리' }).performance).toBe('fast');
  });
});

describe('P02 example table (:70-77)', () => {
  it.each([
    ['간단히 고쳐줘', { depth: 'direct' }],
    ['구조부터 보고 제대로 해줘', { depth: 'deep-plan' }],
    ['근본적으로 해결해줘', { depth: 'deep-plan' }],
    ['최대한 빨리 정확하게', { performance: 'fast' }],
    ['토큰 아끼지 말고 제대로 처리해', { performance: 'maximum_performance' }],
    ['중요한 작업이니 꼼꼼하게 검토해', { work_purpose: 'review', performance: 'quality' }],
  ])('reads %j as %o', (prompt, expected) => {
    expect(interpretIntent({ prompt })).toMatchObject(expected);
  });
});

describe('explicit settings win over inference', () => {
  it('takes reasoning.depth from config and drops the defaulted marker', () => {
    const r = interpretIntent({
      prompt: '간단히 고쳐줘',
      config: { execution_profile: { reasoning: { depth: 'ultraplan' } } },
    });
    expect(r.depth).toBe('ultraplan');
    expect(r.defaulted).not.toContain('depth');
    expect(r.evidence).toContainEqual({
      axis: 'depth', value: 'ultraplan',
      cue: 'execution_profile.reasoning.depth', source: 'explicit_setting',
    });
  });

  it('normalises a P02 prose spelling supplied as an explicit setting', () => {
    const r = interpretIntent({
      prompt: '빨리',
      config: { execution_profile: { performance: { priority: 'maximum-performance' } } },
    });
    expect(r.performance).toBe('maximum_performance');
  });

  it('ignores an explicit value that is not in the vocabulary', () => {
    const r = interpretIntent({
      prompt: '빨리',
      config: { execution_profile: { performance: { priority: 'blazing' } } },
    });
    expect(r.performance).toBe('fast');
  });
});

describe('cueMatches', () => {
  it('anchors ASCII cues to alphanumeric boundaries', () => {
    expect(cueMatches('the latest build', 'test')).toBe(false);
    expect(cueMatches('prompt engineering', 'pr')).toBe(false);
    expect(cueMatches('open a pr now', 'pr')).toBe(true);
  });

  it('matches Korean cues as plain substrings, since particles attach directly', () => {
    expect(cueMatches('버그를 고쳐줘', '버그')).toBe(true);
    expect(cueMatches('구현해주세요', '구현')).toBe(true);
  });

  it('returns false for an empty cue', () => {
    expect(cueMatches('anything', '')).toBe(false);
  });
});
