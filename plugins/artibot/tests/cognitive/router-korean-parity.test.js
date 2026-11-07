/**
 * Korean/English scoring parity for `lib/cognitive/router.js#classifyComplexity`.
 *
 * Measured 2026-11-07 on HEAD afe4a680: the same request scored lower in Korean
 * than in English (e.g. 0.36 vs 0.52, system 1 vs 2), because
 *   (a) every Hangul alternative in STEP_PATTERNS sat inside `\b…\b`, and JS `\b`
 *       is an ASCII word boundary, so none of them could ever match;
 *   (b) the 150/300-char length bonus counted characters, and a Hangul syllable
 *       carries ~2.4 English characters of meaning;
 *   (d) `보안` was missing from RISK_KEYWORDS while `security` is in it, and `인증`
 *       was missing from the backend domain while `auth` is in it.
 *
 * The pair corpus split was fixed before any measurement: even index = TRAIN,
 * odd index = HOLDOUT. Pairs 0-2 are the investigator's original pairs.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { classifyComplexity, resetRouter } from '../../lib/cognitive/router.js';

const PAIRS = [
  ['결제 모듈 리팩토링하고 API 문서 갱신하고 e2e 테스트 추가해줘', 'Refactor the payment module, update the API docs, and add e2e tests'],
  ['플러그인 전수조사해서 훅 파이프라인 지연이랑 코드 무게를 측정하고 결과를 표로 정리해줘', 'Run a full census of the plugin, measure hook pipeline latency and code weight, and summarize the results in a table'],
  ['인증 시스템을 마이크로서비스로 분리하고 보안 검토 후 배포 파이프라인까지 구성해줘', 'Split the authentication system into microservices, do a security review, then set up the deployment pipeline'],
  ['README 오타 수정해줘', 'Fix the typo in the README'],
  ['이 함수 이름을 바꿔줘', 'Rename this function'],
  ['먼저 로그인 버그를 재현하고, 그 다음 원인을 찾아서 고친 뒤 회귀 테스트를 추가해줘', 'First reproduce the login bug, then find the root cause and fix it, and add a regression test'],
  ['package.json 버전 올려줘', 'Bump the version in package.json'],
  ['데이터베이스 스키마를 마이그레이션하고 프로덕션에 배포하기 전에 롤백 계획도 세워줘', 'Migrate the database schema and also prepare a rollback plan before deploying to production'],
  ['이 에러 메시지가 무슨 뜻이야?', 'What does this error message mean?'],
  ['프론트엔드 컴포넌트를 리액트로 옮기고, 접근성 문제를 고치고, 그런 다음 스토리북 문서를 작성해줘', 'Port the frontend components to React, fix the accessibility issues, then write the Storybook docs'],
  ['아마 캐시 때문인 것 같은데 원인을 조사해줘', 'It might be the cache, investigate the cause'],
  ['1단계로 API 엔드포인트를 설계하고 2단계로 서버를 구현한 다음 3단계로 부하 테스트를 돌려줘', 'In step 1 design the API endpoints, in step 2 implement the server, then in step 3 run a load test'],
  ['주석 하나 추가해줘', 'Add a comment'],
  ['보안 취약점을 점검하고 또한 의존성도 업데이트한 다음 CI 파이프라인에서 테스트가 통과하는지 확인해줘', 'Check for security vulnerabilities, and also update the dependencies, then verify the tests pass in the CI pipeline'],
  ['사용자 대시보드가 느려졌어. 쿼리를 프로파일링해서 병목을 찾고, 인덱스를 추가하고, 프론트에서는 페이지네이션을 넣어줘. 끝나면 변경 사항을 문서로 정리해줘.', "The user dashboard has become slow. Profile the queries to find the bottleneck, add indexes, and add pagination on the frontend. When you're done, write up the changes in a document."],
  ['이 파일 포맷팅해줘', 'Format this file'],
  ['인증 미들웨어를 리팩토링한 후에 세션 저장소를 레디스로 바꾸고 부하 테스트까지 해줘', 'Refactor the auth middleware, then switch the session store to Redis and run a load test as well'],
  ['로그 레벨을 debug로 바꿔줘', 'Change the log level to debug'],
];

/**
 * Pairs where the English side is the one under-scored, so Korean lands above
 * it. Fixing them means changing English scores, which this suite forbids.
 * Pinned so the entry is removed (and the pair re-enters parity) the day the
 * English side is fixed.
 */
const EN_SIDE_GAPS = {
  14: 'en "frontend" is not a frontend keyword (only component/ui/css/...), so en has 1 domain where ko 프론트+문서 has 2',
};

/**
 * HOLDOUT pairs that still miss parity after the fix. Measured once and left as
 * found rather than tuned away. Pinned so the entry is removed the day it passes.
 */
const KO_SIDE_RESIDUALS = {
  13: 'verb-ending sequencing (업데이트한 다음) is not counted, while en counts "and also" twice (step pattern + conjunction) plus two commas',
};

const CONTEXTS = [{}, { sessionDepth: 0 }];

/** Parity = |Δscore| <= 0.05 (scores are 2-dp, compare in hundredths) or the same system. */
function parity(ko, en, ctx) {
  const a = classifyComplexity(ko, ctx);
  const b = classifyComplexity(en, ctx);
  const gap = Math.round(Math.abs(a.score - b.score) * 100);
  return { a, b, ok: gap <= 5 || a.system === b.system };
}

beforeEach(() => {
  resetRouter();
});

describe('router Korean parity — STEP_PATTERNS non-ASCII alternatives (cause a)', () => {
  // None of these contain 하고/해서/그리고/까지 or commas: the conjunction pass
  // cannot rescue them, which is why router.test.js's connector test stayed
  // green while every Hangul STEP alternative was dead.
  it.each([
    ['1단계 설계 2단계 구현 3단계 검증', '설계 구현 검증'],
    ['로그 확인 그런 다음 재시작', '로그 확인 재시작'],
    ['로그 확인 그 다음 재시작', '로그 확인 재시작'],
    ['먼저 로그 확인', '로그 확인'],
    ['또한 문서 갱신', '문서 갱신'],
  ])('counts the step marker in %s', (marked, bare) => {
    expect(classifyComplexity(marked).factors.steps)
      .toBeGreaterThan(classifyComplexity(bare).factors.steps);
  });

  it.each([
    ['먼저 로그 확인', 'first check logs'],
    ['로그 확인 그 다음 재시작', 'check logs then restart'],
    ['로그 확인 그 후 재시작', 'check logs after that restart'],
    ['1단계 설계', 'step 1 design'],
    ['추가로 문서 갱신', 'additionally update docs'],
    ['게다가 문서 갱신', 'furthermore update docs'],
  ])('scores %s the same steps as %s', (ko, en) => {
    expect(classifyComplexity(ko).factors.steps).toBe(classifyComplexity(en).factors.steps);
  });

  it('counts 그리고 once, like English "and"', () => {
    expect(classifyComplexity('파일 읽기 그리고 저장').factors.steps)
      .toBe(classifyComplexity('read file and save').factors.steps);
  });

  // The same `\b` defect hid the Japanese alternatives; freeing them is intended.
  // Values measured 2026-11-07 against HEAD afe4a680 (before) and this fix (after).
  it.each([
    ['ログを確認 それから 再起動', 0.2, 0.1], // before: steps 0, score 0.05
    ['設計 次に 実装', 0.2, 0.14], // before: steps 0, score 0.09
    ['フェーズ1 設計 フェーズ2 実装', 0.4, 0.19], // before: steps 0, score 0.09
  ])('now counts the Japanese step marker in %s', (input, steps, score) => {
    const c = classifyComplexity(input);
    expect([c.factors.steps, c.score]).toEqual([steps, score]);
  });
});

describe('router Korean parity — Hangul-weighted length bonus (cause b)', () => {
  // 70 Hangul syllables, no step markers: 70 chars raw, ~168 English-equivalent.
  const LONG_KO = '가나다라마바사아자차카타파하'.repeat(5);

  it('gives a long Hangul input the >150 length bonus', () => {
    expect(LONG_KO.length).toBeLessThan(150);
    expect(classifyComplexity(LONG_KO).factors.steps).toBe(0.2);
  });

  it('leaves a short Hangul input without the bonus', () => {
    expect(classifyComplexity('가나다라마바사아자차카타파하').factors.steps).toBe(0);
  });
});

describe('router Korean parity — keywords aligned with their English entries (cause d)', () => {
  it('treats 보안 as a risk signal like security', () => {
    expect(classifyComplexity('보안 검토').factors.risk)
      .toBe(classifyComplexity('security review').factors.risk);
  });

  it('treats 인증 as a backend domain signal like auth', () => {
    expect(classifyComplexity('인증 수정').factors.domains)
      .toBe(classifyComplexity('fix auth').factors.domains);
  });
});

describe.each([
  ['TRAIN', 0],
  ['HOLDOUT', 1],
])('router Korean parity — %s pairs', (_set, rem) => {
  const rows = PAIRS.map((p, i) => [i, ...p])
    .filter(([i]) => i % 2 === rem && !(i in EN_SIDE_GAPS) && !(i in KO_SIDE_RESIDUALS));

  it.each(CONTEXTS.flatMap((ctx) => rows.map(([i, ko, en]) => [i, JSON.stringify(ctx), ko, en, ctx])))(
    'pair %i (ctx %s) scores within 0.05 or on the same system',
    (_i, _label, ko, en, ctx) => {
      const { a, b, ok } = parity(ko, en, ctx);
      expect(ok, `ko ${a.score}/S${a.system} vs en ${b.score}/S${b.system}`).toBe(true);
    },
  );
});

describe('router Korean parity — documented exceptions', () => {
  it.each(Object.entries(EN_SIDE_GAPS))('pair %s still has its English-side gap: %s', (i) => {
    const [ko, en] = PAIRS[Number(i)];
    const a = classifyComplexity(ko);
    const b = classifyComplexity(en);
    expect(a.score).toBeGreaterThan(b.score);
    expect(a.factors.domains).toBeGreaterThan(b.factors.domains);
  });

  it.each(Object.entries(KO_SIDE_RESIDUALS))('pair %s is still a Korean-side residual: %s', (i) => {
    const [ko, en] = PAIRS[Number(i)];
    const { a, b, ok } = parity(ko, en, {});
    expect(ok).toBe(false);
    expect(a.factors.steps).toBeLessThan(b.factors.steps);
  });
});

describe('router Korean parity — English scores pinned from HEAD afe4a680', () => {
  it.each([
    ['Fix the typo in the README', 0.09, 1, { steps: 0, domains: 0.2, uncertainty: 0, risk: 0, novelty: 0.3 }],
    ['First reproduce the login bug, then find the root cause and fix it, and add a regression test', 0.34, 1, { steps: 1, domains: 0.2, uncertainty: 0, risk: 0, novelty: 0.3 }],
    ['In step 1 design the API endpoints, in step 2 implement the server, then in step 3 run a load test', 0.5, 2, { steps: 1, domains: 1, uncertainty: 0, risk: 0, novelty: 0.3 }],
    ['Check for security vulnerabilities, and also update the dependencies, then verify the tests pass in the CI pipeline', 0.51, 2, { steps: 1, domains: 0.75, uncertainty: 0, risk: 0.3, novelty: 0.3 }],
    ['Migrate the database schema and also prepare a rollback plan before deploying to production', 0.48, 2, { steps: 0.4, domains: 0.75, uncertainty: 0, risk: 0.9, novelty: 0.3 }],
    ['It might be the cache, investigate the cause', 0.2, 1, { steps: 0.2, domains: 0, uncertainty: 0.5, risk: 0, novelty: 0.3 }],
    ['What does this error message mean?', 0.1, 1, { steps: 0, domains: 0, uncertainty: 0.25, risk: 0, novelty: 0.3 }],
    ['additionally refactor the module. furthermore update the docs. afterwards deploy. next run the tests.', 0.56, 2, { steps: 1, domains: 1, uncertainty: 0, risk: 0.3, novelty: 0.3 }],
    ['x'.repeat(151), 0.1, 1, { steps: 0.2, domains: 0, uncertainty: 0, risk: 0, novelty: 0.3 }],
    ['refactor the module '.repeat(16), 0.15, 1, { steps: 0.4, domains: 0, uncertainty: 0, risk: 0, novelty: 0.3 }],
  ])('keeps %s unchanged', (input, score, system, factors) => {
    const c = classifyComplexity(input);
    expect([c.score, c.system, c.factors]).toEqual([score, system, factors]);
  });
});
