/**
 * ReDoS 정적 스캐너 — 선형성의 **정본 게이트**.
 *
 * 2026-09-14 에 `tests/autopilot/safety.test.js` 에서 이 파일로 추출했다. 종전에는
 * 같은 29패턴(HG)을 safety.test.js 의 `findUnboundedRuns` 와
 * `tests/firewall/human-gate-matrix-selfcheck.test.js` 섹션 G 의 사설 스캐너가
 * **서로 다른 규칙으로 두 번** 훑었고, HG-11 예외도 두 곳(키 목록 / 원문 목록)에
 * 있었다. 구현이 둘이면 한쪽만 고쳐진다 — 그래서 구현과 예외를 각각 하나로 합쳤다.
 * 이 모듈이 스캐너의 유일한 구현이고, {@link HG_SCAN_ALLOWLIST} 가 HG 예외의
 * 유일한 등록처다.
 *
 * 왜 벽시계가 아니라 소스인가: 시간 단언은 러너에 따라 흔들린다(Windows 에서
 * `< 50` 이 50.54ms 로 떨어진 사례, 2026-09-11). 느슨하게 하면 게이트가 죽고
 * 조이면 플레이크가 된다. 정규식 **소스의 모양**은 머신과 무관하므로 이쪽이
 * 주 게이트이고, 호출처의 타이밍 블록은 smoke + 성장 비율로 내려간다.
 *
 * 무제한 런의 정의(이 스캐너가 RED 로 보는 것) — 세 조건을 모두 만족할 때:
 *   1. 원자가 `.` 또는 부정 문자클래스 `[^…]` 이고,
 *   2. 수량자의 상한이 **그 규칙에 허가된 창**을 넘고(기본 192, 예외 등록분만
 *      512 — {@link WINDOW_CEILING_OVERRIDES}; `*` `+` `{n,}` = 무한,
 *      `{0,193}` = 193),
 *   3. 그 원자가 공백 문자를 하나라도 매치할 수 있을 때.
 *
 * 3번은 브리프 원안에 없던 좁힘이다. 근거: 실측된 2차식 5건(dd·curl·wget·
 * git push 규칙 3종)은 전부 "<단어> <한 줄 아무거나> <토큰>" 모양이었고, 가운데
 * 런이 **공백을 넘어 여러 토큰을 가로지를 수 있어서** 단어가 나올 때마다 줄
 * 끝까지 재스캔했다. 공백을 못 넘는 런은 토큰 하나 안에 갇힌다. 3번 없이
 * 돌리면 git-branch-delete 의 토큰 본체 `[^\s;&|]*` 가 L1·L2 양쪽에서 6건씩
 * RED 가 된다(2026-09-11 12:10 UTC 실측). 그 규칙은 120KB 적대 입력에서 선형인
 * 것이 이미 측정돼 있으므로 12건 전부 오탐이다.
 *
 * **룩어헤드 안이라고 면제하지 않는다.** 섹션 G 의 종전 사설 스캐너는 룩어헤드
 * 내부를 지운 뒤 훑았고 근거는 "부정 룩어헤드 안의 런은 한 번만 평가된다"였다.
 * 그 일반화는 거짓이다 — 아래 "못 보는 것" 7번의 HG-09 실측(6배 구간 raw 21.4배)이
 * 반증이다. 그 규칙이 이 스캐너에서 조용한 이유는 룩어헤드라서가 아니라
 * **긍정 클래스**(1번)여서다. 면제 사유를 잘못 적으면 다음 사람이 그 사유를
 * 넓힌다.
 *
 * ── 이 스캐너가 못 보는 것 (그린을 이 목록의 근거로 쓰지 말 것) ──
 *  1. 긍정 문자클래스의 무제한 런. `[\w."` ]+` 는 공백을 포함하지만 스캔하지
 *     않는다 — 뒤따르는 필수 토큰이 클래스에 안 들어가면 2차식이 아닐 수 있어
 *     모양만으로 판정이 서지 않는다.
 *  2. 축약 부정 클래스 `\S` `\W` `\D`. rm-rf-path 꼬리의 `\S+` 와 L1
 *     'rm recursive+force' 의 `(?:\s+-\S+)*` 가 여기 해당한다.
 *  3. 그룹에 붙은 수량자 = 중첩 수량자. `(?:\s+--?\w[\w-]*)*` 처럼 rm 규칙군의
 *     **지수식** 위험이 이 모양인데 스캐너는 보지 않는다. safety.test.js 의
 *     `--opt` 프로브가 그 자리를 맡는다.
 *  4. 공백을 못 넘는 무제한 런. 토큰 하나가 무한히 길면 O(토큰²) 은 여전히
 *     가능하다. 실측된 사례는 없고, 생기면 성장 비율이 잡아야 한다.
 *  5. 전처리(guard-registry#normalizeCommand)와의 상호작용, 규칙 간 평가 순서,
 *     classifyRisk 전체 경로의 합산 비용.
 *  6. `[]]` 같은 JS 문자클래스 극단 문법(파싱 실패 시 fail-closed 로 보고한다).
 *  7. **스캔 밖에 있는 리포의 나머지 정규식.** 이 스캔이 훑는 것은 세 카탈로그뿐
 *     이다 — BLOCKED_PATTERNS(L1 39) · DANGEROUS_PATTERNS(L2 27) ·
 *     HUMAN_GATE_MATRIX(HG 13행 29패턴) = 95패턴(2026-09-14 실측 분모).
 *     네 번째 카탈로그를 늘릴지 2026-09-14 에 census 로 판정했고, 답은
 *     **늘리지 않는다**였다: 후보 10건을 현행 조건에 넣으면 RED 6건이 전부
 *     오탐이고 진양성이 0 이다. 대신 밖에 있는 것들의 안전 근거를 여기에 적는다.
 *     근거는 모양이 아니라 **실측 수치와 캡 상수**다(아래 전부 node v24.15.0,
 *     Windows, 중앙값 3회, 타이밍마다 서로 다른 payload — 같은 문자열을 반복
 *     측정하면 V8 정규식 결과 캐시가 2회차부터 0 을 돌려준다, 2026-09-14 실측).
 *
 *     (a) `lib/core/guard-registry.js#normalizeCommand` 4식(백틱·홑따옴표·
 *         겹따옴표·`[^\S\n]+`) — 부정 클래스가 **자기 종결자를 제외**하는
 *         자기제한형. 함수 전체 20,480 / 40,962 / 122,880B:
 *           겹따옴표 0.46 / 2.09 / 4.51 · 홑따옴표 0.46 / 1.42 / 3.13
 *           백틱     0.45 / 0.87 / 2.20 · 공백     0.24 / 0.46 / 2.09 ms
 *         6배 구간 raw 4.9~9.7배 = 선형.
 *     (b) 시크릿 2식(`SECRET_CONTENT_PATTERNS[0]` · `POST_SECRET_PATTERNS[0]`
 *         의 `[^"']{8,}`) — 같은 자기제한형. 시크릿 키 + 여는 따옴표 반복
 *         픽스처 4형을 Write pre 체인 전체로 태워 전 사이즈 **<= 0.28ms**,
 *         크기 의존이 관측되지 않는다(6배 구간 비율 0.97~1.00).
 *     (c) `checkBashQuoteBalance` 의 heredoc 제거 2식
 *         `<<-?\s*…[\s\S]*?\n\1\s*$`/gm — **2차식이다.** 규칙 단독
 *         2,000 / 4,000 / 8,000B = 0.82~1.04 / 3.94~5.18 / 16.94~17.72ms
 *         (3패스), 4배 구간 raw 16.6~20.8배(4² = 16). 결함이 아니라
 *         **캡이 바운드**다 — 같은 함수 첫 줄이 `command.length > 8000` 이면
 *         `null` 로 빠진다(guard-registry.js#checkBashQuoteBalance). 8,000 은
 *         통과하고 8,001 부터 안 본다. 실효 최대 약 17ms.
 *         (초안 추정 6~9ms 는 이 창의 재측정으로 교정됐다. 캡을 올리면
 *         이 수치가 제곱으로 따라 오른다 — 캡 정책은 이 줄기 소유 밖.)
 *     (d) `lib/core/command-segments.js` 3식 — `^…=` 앵커, `^\d+…$` 앵커,
 *         `[^\n\r]`(수량자 없음). **스캔할 것이 없다.**
 *     (e) `scripts/hooks/tool-tracker.js` 명령 분류 11식 — 전부 `^` 앵커.
 *     (f) `scripts/hooks/permission-auto-approve.js` 의 `commandPattern` —
 *         config 유래 **동적** 정규식이라 테스트 시점에 소스가 없다. HEAD 의
 *         `artibot.config.json#permissions.autoApprove` 는 `[]`(0건)이므로
 *         지금 스캔할 대상 자체가 0 이다. 항목이 생기면 로드 시점 모양 검증이
 *         필요하다 — 이 줄기 소유 밖.
 *     (g) `scripts/hooks/post-tool-failure-advisor.js` 의 `tokenizeCommand` ·
 *         `CD_FAILURE_RE` · `EXIT_CODE_LINE_RE` — 자기제한/앵커형이라는 **모양
 *         추론**이고 **타이밍은 미확인**이다. PostToolUse 실패 경로.
 *     (h) **알려진 사각 — `lib/security/human-gates.js` HG-09 의
 *         `UPDATE … SET\b(?![\s\S]*\bWHERE\b)`.** 부정 룩어헤드 **안의 긍정
 *         클래스**라 이 스캐너가 구조적으로 못 본다(조건 1). 규칙 단독
 *         20,480 / 40,962 / 122,880B = 5.04 / 15.41 / 107.98ms, 6배 구간
 *         raw 21.4배 = **2차식**. 단 픽스처 모양에 민감하다 — 반복 단위마다
 *         WHERE 가 붙은 입력에서만 나오고, WHERE 가 끝이나 앞에 하나뿐이면
 *         같은 사이즈에서 <= 0.35ms 로 선형이다(그리디 `[\s\S]*` 가 뒤에서
 *         몇 자만 되짚기 때문). 이 줄기는 human-gates.js 를 편집하지 않는다 —
 *         수치와 함께 사각으로 등록만 한다.
 *
 *     요약하면 **긍정 클래스 · 입력 캡 · 자기제한형은 스캐너 밖이며, 그 안전
 *     근거는 실측 수치와 캡 상수다**(quote-balance 8,000B).
 *  8. **등록된 예외 규칙의 정확한 창 값.** 기본 192 를 넘는 창은 등록해야만
 *     통과하므로 **신규 규칙 구멍은 닫혔다**(2026-09-11 리더 판정 전에는 전역
 *     상한 512 였고, 그때는 열려 있었다). 남는 것은 *등록된* 2건뿐이다: rm
 *     규칙이 512 안에서 어떤 값을 쓰든 여기는 그린이다. 그 정확 값은
 *     tests/core/blocked-patterns.test.js 의 정확값 `toBe` 와 경계 쌍이 핀한다.
 *     이 목록은 상한 허가일 뿐 폭의 정본이 아니다.
 *     실측(B, 2026-09-11): 전역 상한 512 이던 판에서 L2 `wget-external` 을
 *     `{0,192}` → `{0,512}` 로 넓혀 보니 **정적 스캔은 그린**이었고 경계 쌍
 *     단언 하나만 RED 였다. 경계 쌍이 없는 신규 규칙이었다면 아무것도 못 잡았다.
 *
 * 이 모듈 자체의 자기검증은 `tests/helpers/regex-scan.test.js` 다 — 게이트가
 * 거짓 그린이 되지 않게 스캐너를 스캐너로 검증한다(규율 §10).
 *
 * @module tests/helpers/regex-scan
 */

/**
 * 기본 허용 최대 창. **192 를 넘는 창은 아래 OVERRIDES 에 등록해야 통과한다**
 * — 등록 안 된 규칙이 넓은 창을 쓰면 RED 다(신규 규칙 fail-closed).
 *
 * 왜 전역 상수가 아니라 기본값 + 허가 목록인가(2026-09-11 리더 판정): 전역
 * 상한을 512 로 올렸던 판이 fail-open 이었다. 실측 — 그 상태에서 L2
 * `wget-external` 을 `{0,192}` → `{0,512}` 로 넓혀 보니 **정적 스캔은 그린**
 * 이었고 경계 쌍 단언 하나만 RED 였다. 기존 규칙은 경계 쌍이 받쳐 줘서 막혔지만,
 * 경계 쌍 없이 새로 추가되는 규칙은 아무것도 잡지 못했다. 규율 §8 — 부정 목록은
 * 미래 항목에 fail-open 이고, 허용 목록은 아니다.
 */
export const WINDOW_CEILING_DEFAULT = 192;

/**
 * 192 를 넘도록 **허가된** 규칙 목록. 키는 `<층>:<식별자>` 로, L1 은 label,
 * L2 는 id 를 쓴다(2026-09-14 현재 L2·HG 예외 0건).
 *
 * 층 접두가 붙은 이유: 접두 없이 label 과 id 를 한 객체에 섞으면 **네임스페이스가
 * 겹친다.** 지금은 충돌이 없지만, 미래에 L2 id 가 L1 label 과 같은 문자열이 되면
 * 등록하지 않은 층에까지 조용히 예외가 적용된다 — 키 목록을 고정하는 핀 it 은
 * 새 키 추가는 잡아도 그 충돌은 감지하지 못한다. 접두가 그 경로를 아예 없앤다.
 *
 * 이것은 **폭 표가 아니라 상한 허가 목록**이다. 정확한 폭의 정본은 여전히
 * 경계 쌍·구조 단언이다 — L1 은 tests/core/blocked-patterns.test.js 의 정확값
 * `toBe`(rm 512 · pipe 192), L2 는 tests/autopilot/safety.test.js 의 describe
 * 'classifyRisk — the dd/curl/wget window bound keeps ordinary commands matched'.
 *
 * **두 값이 어긋나면 RED 가 맞다. 여기를 고쳐 맞추지 마라** — 게이트를
 * 통과시키려 게이트를 깎지 않는다(규율 §10). 폭이 정말 바뀌어야 하면 정본 쪽을
 * 먼저 옮기고 그 근거를 남긴 뒤 여기를 따라 올려라.
 *
 * rm 2건이 512 인 이유: rm 의 타깃은 PATH 이고 Windows MAX_PATH 는 260 이라
 * 192 창은 평범한 긴 경로를 아예 못 본다. 192 를 적용했더니
 * `rm --recursive <193자 이상>/x` 가 종전 L1 block → approve 로 뒤집혔고
 * (L2 에도 recursive-only 규칙이 없어 full-stack), 그건 사각이 아니라 커버리지
 * 회귀라 리더가 문서화 대신 창을 옮겼다. dd·pipe·git-push 는 옵션과 URL 을 재는
 * 다른 분포라 192 로 남는다 — dd 가 192 인 건 512 를 택할 이유가 없어서지
 * 512 가 금지라서가 아니다.
 */
export const WINDOW_CEILING_OVERRIDES = Object.freeze({
  'L1:rm -rf with path': 512,
  'L1:rm -fr with path': 512,
});

/**
 * 규칙 하나에 적용할 상한을 고른다.
 * @param {'L1'|'L2'|'HG'} layer 카탈로그 — L1 = blocked-patterns,
 *   L2 = safety, HG = security/human-gates (2026-09-14 추가)
 * @param {string} key L1 은 label, L2 는 id, HG 는 `<행 id>[<패턴 인덱스>]`
 * @returns {number}
 */
export function ceilingFor(layer, key) {
  return WINDOW_CEILING_OVERRIDES[`${layer}:${key}`] ?? WINDOW_CEILING_DEFAULT;
}

/** 클래스가 공백을 매치할 수 있는지 보는 프로브 문자들. */
const SCAN_WHITESPACE = [' ', '\t', '\n', '\r', '\f', '\v'];

/**
 * 문자클래스 하나를 읽는다. JS 비-v 모드에서는 `[` 또는 `[^` 직후의 `]` 도
 * 클래스를 닫으므로 특례가 없다.
 * @param {string} source @param {number} start
 * @returns {{ end: number, negated: boolean } | null}
 */
export function readCharClass(source, start) {
  let i = start + 1;
  const negated = source[i] === '^';
  if (negated) i += 1;
  while (i < source.length) {
    if (source[i] === '\\') { i += 2; continue; }
    if (source[i] === ']') return { end: i + 1, negated };
    i += 1;
  }
  return null;
}

/**
 * 수량자 하나를 읽는다. 상한이 없으면 Infinity.
 * @param {string} source @param {number} i
 * @returns {{ end: number, max: number } | null}
 */
export function readQuantifier(source, i) {
  const ch = source[i];
  if (ch === '*' || ch === '+') return { end: i + 1, max: Infinity };
  if (ch === '?') return { end: i + 1, max: 1 };
  if (ch !== '{') return null;
  const m = /^\{(\d+)(,(\d+)?)?\}/.exec(source.slice(i));
  if (!m) return null;
  const max = m[2] === undefined ? Number(m[1]) : (m[3] === undefined ? Infinity : Number(m[3]));
  return { end: i + m[0].length, max };
}

/**
 * 이 원자가 공백을 하나라도 매치할 수 있는가. `.` 은 어느 모드에서도 스페이스와
 * 탭을 매치하므로 항상 true. 파싱 불가면 fail-closed(true)로 보고한다.
 * @param {string|null} classSource `[^…]` 원문, `.` 이면 null
 * @param {string} flags
 * @returns {boolean}
 */
export function canMatchWhitespace(classSource, flags) {
  if (classSource === null) return true;
  try {
    const probe = new RegExp(classSource, flags.includes('i') ? 'i' : '');
    return SCAN_WHITESPACE.some((c) => probe.test(c));
  } catch {
    return true;
  }
}

/**
 * 정규식 소스를 이스케이프 인식하며 걸어서 무제한 런을 보고한다.
 * @param {string} source @param {string} [flags]
 * @param {number} [ceiling] 이 규칙에 허가된 창 — {@link ceilingFor} 로 고른다
 * @returns {{ index: number, snippet: string, kind: 'unbounded'|'wide-window' }[]}
 */
export function findUnboundedRuns(source, flags = '', ceiling = WINDOW_CEILING_DEFAULT) {
  const found = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const atomStart = i;
    /** @type {{ classSource: string|null } | null} */
    let atom = null;
    if (ch === '\\') {
      i += 2;
    } else if (ch === '[') {
      const cls = readCharClass(source, i);
      if (!cls) { i += 1; continue; }
      if (cls.negated) atom = { classSource: source.slice(atomStart, cls.end) };
      i = cls.end;
    } else if (ch === '(') {
      // 그룹 여는 괄호는 원자가 아니다. 수량자는 닫는 괄호에 붙는다.
      const open = /^\((?:\?:|\?=|\?!|\?<=|\?<!|\?<[A-Za-z_$][\w$]*>)?/.exec(source.slice(i));
      i += open[0].length;
      continue;
    } else if (ch === ')') {
      i += 1;
      const groupQuantifier = readQuantifier(source, i);
      // 그룹 수량자는 이번 스캔 범위 밖(못 보는 것 #3). 오파싱만 막고 넘어간다.
      if (groupQuantifier) {
        i = groupQuantifier.end;
        if (source[i] === '?') i += 1;
      }
      continue;
    } else if (ch === '.') {
      atom = { classSource: null };
      i += 1;
    } else {
      i += 1;
    }

    const q = readQuantifier(source, i);
    if (!q) continue;
    const quantifierEnd = q.end;
    i = q.end;
    if (source[i] === '?') i += 1; // lazy
    if (!atom) continue;
    if (q.max <= ceiling) continue;
    if (!canMatchWhitespace(atom.classSource, flags)) continue;
    found.push({
      index: atomStart,
      snippet: source.slice(atomStart, quantifierEnd),
      kind: q.max === Infinity ? 'unbounded' : 'wide-window',
    });
  }
  return found;
}

/**
 * HG 카탈로그의 스캔 예외 — **유일한 등록처**. 키는 `<행 id>[<패턴 인덱스>]`.
 *
 * 2026-09-14 통합: 종전에는 같은 두 패턴이 safety.test.js 에서는 이 키 형태로,
 * human-gate-matrix-selfcheck.test.js 섹션 G 에서는 `ANCHORED_LINEAR_EXEMPTIONS`
 * 원문 배열로 **두 번** 등록돼 있었다(두 집합이 가리키는 대상은 동일했다 —
 * HG-11 patterns[0]·[1], 2026-09-14 대조 실측). 두 곳에 두면 한쪽만 지워진다.
 *
 * **리더 지시 교정(2026-09-14, 전 창).** 지시는 "HG-07 을 바운드하면 세 번째
 * 카탈로그는 그린"이었으나 실측하면 그렇지 않다. HG-11 의 두 패턴도
 * `[^\n]*` 무제한 런을 갖는다 — 스캐너는 순수 구문 도구라 `^` 앵커를 보지
 * 않기 때문이다.
 *
 * 왜 바운드가 아니라 예외인가: 두 패턴은 `^\s*(?:cat|less|…)` 로 **시작
 * 앵커**를 갖고 `m` 플래그가 없다. `^` 는 문자열 첫 위치에서만 매치하므로
 * 엔진이 시도하는 시작 위치가 하나뿐이고, 2차식의 원인인 "단어가 나올 때마다
 * 줄 끝까지 재스캔"이 성립하지 않는다. 실측(3회 중앙값, node v24.15.0,
 * 2026-09-14 01:3x KST, `'cat '` 반복 근접-비매치):
 *   HG-11[0] `.env`      20,480B 0.0 · 40,962B 0.0 · 122,880B 0.1 ms
 *   HG-11[1] `id_rsa` 등 20,480B 0.0 · 40,962B 0.0 · 122,880B 0.3 ms
 * 같은 시각 같은 하네스에서 바운드 전 HG-07[0] 은 122,880B 1,658.6ms 였다 —
 * 네 자릿수 차이다. 폭을 좁히면 커버리지만 잃고 얻는 것이 없다.
 *
 * 이 예외는 "앵커면 안전"도 "룩어헤드 안이면 안전"도 아닌 **열거형**이다.
 * 앵커가 사라지면 면제 근거도 사라지므로, safety.test.js 의
 * '`^` 로 시작하고 m 플래그가 없다' it 이 그것을 실행형으로 붙든다.
 * @type {Set<string>}
 */
export const HG_SCAN_ALLOWLIST = new Set(['HG-11[0]', 'HG-11[1]']);
