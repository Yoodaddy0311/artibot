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

// ---------------------------------------------------------------------------
// CA-15 follow-up (a): the `commit` completion tier and the `migrate` work
// purpose used to fire on bare words. Both feed the question gate as
// "structural / escalating" evidence, so a false positive there makes gate
// conditions 2 and 4 true for a prompt that never asked for a commit or a
// migration (measured 2026-09-30 on ad8e5b28 through evaluateConditions: every
// case in the NEGATIVE tables below returned conditions 2 and 4 both true).
//
// The fix is an ALLOWLIST of phrases, not a deny list: a bare `commit`,
// `check in`, `upgrade`, `업그레이드` or `이전` is no longer a cue; only the
// phrases that state the intent are. So an unlisted phrasing FAILS CLOSED
// (the tier is missed, which under-serves) instead of failing open. The
// POSITIVE tables are what keep that from being satisfied by deleting the
// cues altogether.
//
// The review of that follow-up (2026-09-30) found the allowlist still let two
// kinds of phrase through, and narrowed both the same way. A sequencing word
// alone ("and commit", "then commit") and a bare determiner ("commit the",
// "commit all") open the decision idiom ("decide and commit to a plan", "commit
// all our effort to it"), and the verb stem "이전하" is also 이전 (previous) plus
// the particle 하고 ("이전하고 비교해줘"). What is listed now is the verb WITH
// its object, and only the inflections the particle cannot be. So an
// object-less "... then commit." or "이전하고" is MISSED by design.
// ---------------------------------------------------------------------------
describe('cue vocabulary — phrase-context allowlists (CA-15 follow-up)', () => {
  /** @param {string} prompt @returns {string[]} every completion tier with a cue */
  const completionTiers = (prompt) => interpretIntent({ prompt }).completion_expectations;
  /** @param {string} prompt @returns {string[]} every work purpose with a cue */
  const purposes = (prompt) => interpretIntent({ prompt }).work_purposes;

  describe('completion tier: commit', () => {
    it.each([
      ['a decision, not a git commit', 'Which should we pick? It is a product decision with no right answer, so commit to it.'],
      ['commit to an approach', 'We should commit to this approach and move on.'],
      ['commit to a naming scheme', "Let's commit to a naming scheme first."],
      ['commit to memory', 'I want to commit to memory the rule about tabs.'],
      ['check in with people', 'Please check in with the team about the schedule.'],
      ['check in on a status', 'Can you check in on the status of the build?'],
      ['a commit mentioned as a noun', 'What does the last commit do?'],
      // Review of the follow-up: the first three are the reviewer's own
      // sentences, and each was read as a commit by a different phrase
      // ("and commit", "then commit", "commit all"). The next three are the same
      // idiom through the sibling phrases that were narrowed with them.
      ['"and commit" opening a decision idiom', "Let's discuss the options and commit to a plan."],
      ['"then commit" opening a decision idiom', 'Weigh both, then commit to one.'],
      ['committing effort, not files ("commit all")', 'commit all our effort to the redesign'],
      ['a stock decision phrase with no object', 'Both are fine, so pick one and commit.'],
      ['committing a team, not a change ("commit the")', 'We should commit the team to a firm deadline.'],
      ['"commit and" followed by a non-git verb', 'A team should commit and deliver on its promises.'],
    ])('does not read %s as a commit request', (_label, prompt) => {
      expect(completionTiers(prompt)).not.toContain('commit');
      expect(interpretIntent({ prompt }).completion_expectation).not.toBe('commit');
    });

    it.each([
      'Fix the typo and commit it.',
      // Was "... then commit." — an object-less sequencing phrase is no longer a
      // cue (it is the shape of "then commit to one"), so the request names its object.
      'Implement the parser, run the tests, then commit it.',
      'Please commit the changes when you are done.',
      'commit these files and push',
      'git commit the fix after review',
      'Make a commit with the updated README.',
      'Check in the changes once the build is green.',
      'README 오타 고치고 커밋까지 해줘',
      '구현하고 커밋해줘',
      // One per object phrase that replaced a bare "commit the" / "commit all" /
      // "commit and" / "and commit" / "then commit".
      'It is a coin flip, so decide and commit the change.',
      'Please commit the code.',
      'Review the diff, then commit the fix.',
      'Please commit the file.',
      'Please commit the files.',
      'Commit all changes.',
      'Stage everything and commit all the changes.',
      'Commit all files.',
      'Commit all the files.',
      'Refactor the module, then commit and push.',
    ])('still reads %j as a commit request', (prompt) => {
      expect(completionTiers(prompt)).toContain('commit');
    });

    it('resolves a plain commit request to the commit tier when nothing further is asked', () => {
      expect(interpretIntent({ prompt: 'Fix the typo and commit it.' }).completion_expectation)
        .toBe('commit');
    });
  });

  describe('work purpose: migrate', () => {
    it.each([
      ['a generic improvement (Korean)', '이 함수 성능을 업그레이드해줘'],
      ['the project owner\'s own "upgrade split" phrasing', 'split 을 업그레이드해줘'],
      ['a cosmetic upgrade', 'UI 를 좀 더 예쁘게 업그레이드해줘'],
      ['"previous" (이전) as a word', '이전 대화 내용을 요약해줘'],
      ['"previously" (이전에)', '이전에 만든 함수 이름이 뭐였지'],
      ['이전 inside 에이전트 (agent)', '에이전트 팀을 구성해줘'],
      ['이전 inside 서브에이전트', '서브에이전트에게 위임해줘'],
      ['a revert to a previous version', '이전 버전으로 되돌려줘'],
      ['a generic improvement (English)', 'Please upgrade the split command'],
      ['a cosmetic upgrade (English)', 'upgrade the UI so it looks nicer'],
      // Review of the follow-up: "이전하고" is 이전 (previous) + the particle 하고
      // ("with"), so it is not the verb "migrate, and". The third row puts an
      // object particle in front of it and is still a comparison.
      ['"이전하고" as 이전 + the particle 하고 (compare)', '이전하고 비교해줘'],
      ['"이전하고" opening a question about the previous state', '이전하고 뭐가 달라졌어?'],
      ['an object particle before "이전하고" (compare with the previous)', '이번 결과를 이전하고 비교해줘'],
    ])('does not read %s as a migration', (_label, prompt) => {
      expect(purposes(prompt)).not.toContain('migrate');
      expect(interpretIntent({ prompt }).work_purpose).not.toBe('migrate');
    });

    it.each([
      '패키지 버전 업그레이드 해줘',
      '최신 버전으로 업그레이드해줘',
      '의존성 업그레이드가 필요해',
      '메이저 버전 업그레이드를 진행해줘',
      '서버를 새 리전으로 이전해줘',
      '데이터베이스 이전 작업을 계획해줘',
      '서버 이전 계획을 세워줘',
      '데이터를 새 저장소로 이전했다',
      // The verb inflections that replaced the bare stem "이전하": none of them
      // can be read as 이전 + the particle 하고.
      '서버를 이전하려고 해',
      '서버를 이전하는 절차가 필요해',
      'DB 를 이전할 계획이야',
      '서버를 이전하면 다운타임이 얼마나 생겨?',
      '서버를 이전하기 전에 백업해줘',
      'postgres 로 마이그레이션 해줘',
      'upgrade to node 22',
      'upgrade the dependencies to the latest major version',
      'migrate the database to postgres',
    ])('still reads %j as a migration', (prompt) => {
      expect(purposes(prompt)).toContain('migrate');
      expect(interpretIntent({ prompt }).work_purpose).toBe('migrate');
    });
  });

  it('records the allowlisted phrase, not a bare word, as the evidence cue', () => {
    const { evidence } = interpretIntent({ prompt: '서버를 새 리전으로 이전해줘 그리고 커밋해줘 then commit the change' });
    const cues = evidence.filter((e) => e.value === 'migrate' || e.value === 'commit').map((e) => e.cue);
    expect(cues).toContain('이전해');
    expect(cues).toContain('commit the change');
    expect(cues).not.toContain('이전');
    expect(cues).not.toContain('commit');
    // Neither the sequencing word nor the bare determiner is a cue on its own.
    expect(cues).not.toContain('then commit');
    expect(cues).not.toContain('commit the');
  });
});
