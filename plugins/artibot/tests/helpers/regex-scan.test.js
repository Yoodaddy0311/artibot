/**
 * Self-verification for tests/helpers/regex-scan.js.
 *
 * 게이트 자체가 거짓 그린이 되지 않게 스캐너를 스캐너로 검증한다(규율 §10).
 * 이 파일이 없으면 헬퍼는 "테스트 0개인 모듈"이 되고, 스캐너가 조용히 아무것도
 * 보고하지 않게 바뀌어도 L1·L2·HG 스캔은 전부 그린으로 남는다.
 *
 * 두 describe 의 출신이 다르다:
 *  - '스캐너 자기검증' 은 tests/autopilot/safety.test.js 에서 그대로 옮겨 왔다.
 *  - '옛 섹션 G 의 자기검증' 은 tests/firewall/human-gate-matrix-selfcheck.test.js
 *    섹션 G 의 사설 스캐너(`unboundedRunsOutsideLookahead`)가 들고 있던 단언이다.
 *    그 스캐너는 삭제됐고 단언만 헬퍼 기준으로 살아남았다.
 */
import { describe, expect, it } from 'vitest';
import { getGateRow } from '../../lib/security/human-gates.js';
import {
  ceilingFor,
  findUnboundedRuns,
  HG_SCAN_ALLOWLIST,
  WINDOW_CEILING_DEFAULT,
  WINDOW_CEILING_OVERRIDES,
} from './regex-scan.js';

describe('ReDoS 정적 스캔 — 스캐너 자기검증', () => {
  // 게이트 자체가 거짓 그린이 되지 않게 스캐너를 스캐너로 검증한다.
  it.each([
    ['dot star', /a.*b/],
    ['dot plus with the s flag', /a.+b/s],
    ['negated-newline class star', /[^\n]*x/],
    ['negated-newline class plus', /[^\n]+x/],
    ['a window one past the default ceiling', /[^\n]{0,193}y/],
    ['a window at the rm exception width but unregistered', /[^\n]{0,512}y/],
    ['a window far wider than the ceiling', /[^\n]{0,1000}y/],
    ['an open-ended repeat', /[^\n]{3,}z/],
  ])('reports %s', (_name, re) => {
    expect(findUnboundedRuns(re.source, re.flags).length).toBeGreaterThan(0);
  });

  it.each([
    ['an escaped dot and star', /\.\*/],
    ['a dot and a star inside a class', /[.*]/],
    ['a window at exactly 192', /[^\n]{0,192}q/],
    ['a separator window at 192', /[^\n;&|]{0,192}q/],
    // 아래 셋은 "못 보는 것" 목록의 1·4번 그대로다. 통과가 안전을 뜻하지 않는다.
    ['a positive-class run (out of scope)', /[\w."` ]+/],
    ['an open repeat on a positive class (out of scope)', /[A-Za-z0-9]{16,}/],
    ['a token-confined run that cannot cross whitespace', /[^\s;&|]*/],
    ['a negated class that is alternated, not quantified', /(?:[^\S\n]|\\\r?\n)+x/],
  ])('does not report %s', (_name, re) => {
    expect(findUnboundedRuns(re.source, re.flags)).toEqual([]);
  });

  it('reports the exact span and kind, not just a boolean', () => {
    const hits = findUnboundedRuns(/\bdd\b[^\n]*\sof=/.source, 'i');
    // `\bdd\b` 는 소스에서 6자다(백슬래시 2개 포함).
    expect(hits).toEqual([{ index: 6, snippet: '[^\\n]*', kind: 'unbounded' }]);
  });

  it('reports a wide window as wide-window, not unbounded', () => {
    const hits = findUnboundedRuns(/\bdd\b[^\n]{0,193}\sof=/.source, 'i');
    expect(hits.map((h) => h.kind)).toEqual(['wide-window']);
  });

  // 상한 기본값이나 예외 목록이 조용히 움직이면 게이트의 의미가 통째로 바뀐다.
  it('pins the default ceiling at 192 and the boundary either side of it', () => {
    expect(WINDOW_CEILING_DEFAULT).toBe(192);
    expect(findUnboundedRuns(/[^\n]{0,192}q/.source)).toEqual([]);
    expect(findUnboundedRuns(/[^\n]{0,193}q/.source)).toHaveLength(1);
  });

  it('pins the override list to exactly the two L1 rm rules at 512', () => {
    expect(Object.keys(WINDOW_CEILING_OVERRIDES).sort()).toEqual([
      'L1:rm -fr with path',
      'L1:rm -rf with path',
    ]);
    expect(WINDOW_CEILING_OVERRIDES['L1:rm -rf with path']).toBe(512);
    expect(WINDOW_CEILING_OVERRIDES['L1:rm -fr with path']).toBe(512);
  });

  // 실행형 반증. 등록되지 않은 규칙은 192 를 넘는 순간 잡히고, 등록된 이름으로
  // 조회해야만 512 까지 통과한다 — 신규 규칙이 fail-closed 라는 주장의 증거다.
  it('reports a wide window on a rule that is not registered', () => {
    expect(findUnboundedRuns(/[^\n]{0,193}z/.source, '', ceilingFor('L1', 'not-registered'))).toHaveLength(1);
    expect(findUnboundedRuns(/[^\n]{0,512}z/.source, '', ceilingFor('L2', 'not-registered'))).toHaveLength(1);
  });

  it('lets a registered rule run to 512 but not past it', () => {
    const ceiling = ceilingFor('L1', 'rm -rf with path');
    expect(ceiling).toBe(512);
    expect(findUnboundedRuns(/[^\n]{0,512}z/.source, '', ceiling)).toEqual([]);
    expect(findUnboundedRuns(/[^\n]{0,513}z/.source, '', ceiling)).toHaveLength(1);
  });

  // 층 접두가 실제로 네임스페이스를 가르는지. 접두 없이 label 과 id 를 섞어
  // 두면 같은 문자열이 양쪽 층에 조용히 예외를 주는데, 핀 it 은 키 목록만
  // 고정하므로 그 충돌을 못 본다. 여기가 그 자리를 맡는다.
  it('keeps the L1, L2 and HG key namespaces apart', () => {
    // 같은 식별자라도 등록된 층에서만 512 가 나온다.
    expect(ceilingFor('L1', 'rm -rf with path')).toBe(512);
    expect(ceilingFor('L2', 'rm -rf with path')).toBe(WINDOW_CEILING_DEFAULT);
    expect(ceilingFor('HG', 'rm -rf with path')).toBe(WINDOW_CEILING_DEFAULT);
    // 등록 키는 전부 층 접두를 달고 있다.
    for (const key of Object.keys(WINDOW_CEILING_OVERRIDES)) {
      expect(key).toMatch(/^(?:L[12]|HG):/);
    }
    // HG 는 2026-09-14 현재 등록 0건이다 — 세 번째 카탈로그가 예외를 들고
    // 들어오지 않았다는 핀. HG 패턴이 192 를 넘으려면 여기 등록해야 하고,
    // 그러면 위 'pins the override list to exactly the two L1 rm rules' 가
    // 먼저 RED 가 된다.
    expect(Object.keys(WINDOW_CEILING_OVERRIDES).filter((k) => k.startsWith('HG:'))).toEqual([]);
  });

  it('예외 등록처는 하나이고 HG-11 두 건뿐이다', () => {
    // 통합 전에는 같은 두 패턴이 여기 키 형태와 selfcheck 섹션 G 의 원문 배열로
    // 두 곳에 있었다. 한 곳만 지워지는 경로를 없앤 것이 이 통합의 목적이다.
    expect([...HG_SCAN_ALLOWLIST].sort()).toEqual(['HG-11[0]', 'HG-11[1]']);
  });
});

describe('ReDoS 정적 스캔 — 옛 섹션 G 의 자기검증', () => {
  // 옛 `unboundedRunsOutsideLookahead` 가 붙들던 단언을 헬퍼 기준으로 옮겼다.
  // 라벨 배열 대신 snippet 배열을 보지만 문자열은 같다.
  it('일부러 심은 무앵커 런을 헬퍼가 보고한다', () => {
    expect(findUnboundedRuns(/\bcurl\b[^\n]*x/i.source, 'i').map((h) => h.snippet)).toEqual(['[^\\n]*']);
    expect(findUnboundedRuns(/\bcurl\b[^\n]+x/i.source, 'i').map((h) => h.snippet)).toEqual(['[^\\n]+']);
    expect(findUnboundedRuns(/\bcurl\b.*x/i.source, 'i').map((h) => h.snippet)).toEqual(['.*']);
    expect(findUnboundedRuns(/\bcurl\b.+x/i.source, 'i').map((h) => h.snippet)).toEqual(['.+']);
    // 반대 방향: 바운드된 창과 이스케이프된 점은 보고하지 않는다.
    expect(findUnboundedRuns(/\bcurl\b[^\n]{0,192}x/i.source, 'i')).toEqual([]);
    expect(findUnboundedRuns(/a\.env\b/i.source, 'i')).toEqual([]);
  });

  it('HG-09 patterns[2] 는 매트릭스에서 읽어 스캔 0 hit — 이제 바운드된 부정 클래스라서', () => {
    // **매트릭스를 읽는다.** 2026-09-15 이전 이 it 은 규칙의 로컬 리터럴
    // 복사본을 스캔했다. 그러면 매트릭스가 무엇으로 바뀌든 영원히 그린이고,
    // 거짓 근거가 된다 — RED 보다 나쁜 stale 이다(규율 §10). 그래서 이
    // it 안에는 HG-09 정규식 리터럴이 **없다**. 사본을 다시 들이면 이 핀은
    // 다시 아무것도 증명하지 않는다.
    const pattern = getGateRow('HG-09').patterns[2];
    expect(findUnboundedRuns(pattern.source, pattern.flags, ceilingFor('HG', 'HG-09[2]'))).toEqual([]);
    // 0 hit 의 **이유**까지 핀한다. 종전에는 런의 원자가 긍정 클래스
    // `[\s\S]` 라서 스캐너 조건 1이 구조적으로 못 보는 사각이었다(조용했지만
    // 2차식). 2026-09-15 에 룩어헤드 몸통을 `[^;]{0,192}` 로 바꿨으므로 이제는
    // **부정 클래스 + 바운드 창** — 스캐너가 창을 실제로 검사하고 통과시킨다.
    // 두 단언이 없으면 규칙이 다시 긍정 클래스로 돌아가도 위 0 hit 은 그린이다.
    expect(pattern.source).toContain('[^;]{0,192}');
    expect(pattern.source).not.toContain('[\\s\\S]*');
  });

  it('룩어헤드 안의 **긍정 클래스** 런은 여전히 사각이다 — 면제라서가 아니다 (합성 증명)', () => {
    // 옛 섹션 G 는 룩어헤드 안의 런이 조용한 이유를 "룩어헤드라서 면제" 로
    // 적었다. 그 일반 규칙은 버렸다(규율 §8 — 일반 면제는 미래 항목에
    // fail-open). 진짜 이유는 런의 원자가 **긍정 클래스**이고 스캐너 조건 1이
    // 그것을 안 보기 때문이며, 그 사각은 공짜가 아니다 — 아래 리터럴 모양이
    // 규칙 단독에서 2차식으로 측정됐다(2026-09-14 정찰, node v24.15.0,
    // Windows, 회차마다 다른 payload 3회 중앙값, 122,880B: F1 179.64ms
    // growth 17.68 · F3 223.19ms growth 18.39 · F5 173.17ms growth 19.93).
    //
    // 아래는 2026-09-15 바운드 **이전** 모양의 **합성 복사본**이다. 현재
    // 매트릭스를 대변하지 않는다 — 매트릭스 주장은 바로 위 it 이 getGateRow 로
    // 읽어서 한다. 여기 남는 것은 스캐너 조건 1 자체의 실행형 증거다.
    const syntheticPositiveClassInLookahead = /\bUPDATE\s+[\w."`[\]]+\s+SET\b(?![\s\S]*\bWHERE\b)/i;
    expect(findUnboundedRuns(
      syntheticPositiveClassInLookahead.source,
      syntheticPositiveClassInLookahead.flags,
    )).toEqual([]);
    // 같은 자리에 **부정** 클래스를 넣으면 룩어헤드 안이어도 보고한다.
    // 이것이 "룩어헤드면 면제" 를 버린 이유의 실행형 증거다.
    const negatedInsideLookahead = /\bUPDATE\b(?![^\n]*\bWHERE\b)/i;
    expect(findUnboundedRuns(negatedInsideLookahead.source, 'i').map((h) => h.snippet))
      .toEqual(['[^\\n]*']);
  });
});
