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
 * RED 가 된다(2026-09-11 12:10 UTC 실측). 그 12건은 **이 조건의 판정 대상으로서**
 * 오탐이다 — 토큰 본체 런 하나는 공백을 못 넘는다. 3번의 근거는 그것뿐이다.
 * **철회(2026-09-23)**: 종전 이 자리는 "그 규칙은 120KB 적대 입력에서 선형인
 * 것이 이미 측정돼 있다"를 근거로 들었다. **틀렸다** — 그 규칙은 두 모양에서
 * 2차식이다. (a) 플래그 토큰의 1-b 형(아래 "못 보는 것" 1-b, 이 줄기에서 수리)
 * (b) `'git branch '` 반복의 다중 시작점(아래 3, 미수리). 둘 다 3번이 가린 것이
 * 아니라 다른 기전이다. 선형 주장의 근거가 된 측정은 그 두 모양을 안 밟은
 * 것으로 보인다(추론 — 그 측정의 payload 원문은 이 파일에 없다).
 *
 * **룩어헤드 안이라고 면제하지 않는다.** 섹션 G 의 종전 사설 스캐너는 룩어헤드
 * 내부를 지운 뒤 훑었고 근거는 "부정 룩어헤드 안의 런은 한 번만 평가된다"였다.
 * 그 일반화는 거짓이다 — 반증은 바운드 **이전**의 HG-09 실측이다(2026-09-14
 * 정찰, 규칙 단독, 122,880B 에서 173~223ms · 6배 구간 growth 17.7~19.9 = 2차식;
 * 수치 전문은 아래 "못 보는 것" 7(h)). 그 규칙은 2026-09-15 에 바운드됐지만
 * **반증은 그대로 선다** — 당시 그것이 조용했던 이유는 룩어헤드라서가 아니라
 * **긍정 클래스**(1번)여서였고, 긍정 클래스 사각 자체는 지금도 남아 있다.
 * 면제 사유를 잘못 적으면 다음 사람이 그 사유를 넓힌다.
 *
 * ── 이 스캐너가 못 보는 것 (그린을 이 목록의 근거로 쓰지 말 것) ──
 *  1. 긍정 문자클래스의 무제한 런. `[\w."` ]+` 는 공백을 포함하지만 스캔하지
 *     않는다 — 뒤따르는 필수 토큰이 클래스에 안 들어가면 2차식이 아닐 수 있어
 *     모양만으로 판정이 서지 않는다.
 *  1-b. **같은 긍정 클래스 star 런 둘이 필수 글자를 끼고 있는 모양** —
 *     `-[a-z]*[r][a-z]*` · `-\w*r\w*f` · `-\w*[rf]\w*`. 1번의 하위 종이지만
 *     따로 적는다: 이것은 "2차식일 수 있다"가 아니라 **2026-09-21·22 에 실측된
 *     2차식**이었고, 8개 규칙(L2 rm 4종 · L1 rm 4종)에 동시에 있었다.
 *     `findUnboundedRuns` 는 부정 클래스와 `.` 만 모으므로 구조적으로 못 본다.
 *     필수 글자가 두 런 **어느 쪽에도** 속하므로 그 글자만으로 채운 입력이
 *     n 갈래로 쪼개지고 전부 재시도된다. 실측(node v24.15.0, 중앙값 3회,
 *     payload `rm -` + 'r'×n + `_`): L2 rm-rf-root 단독 8.8 / 34.6 / 151.1ms,
 *     classifyRisk 전체 36.8 / 129.7 / 657.8ms (n = 2,500 / 5,000 / 10,000),
 *     n = 20,000 에서 classifyRisk 3,715ms — PreToolUse 예산 5s 에 근접.
 *     **왜 성장 비율 게이트도 못 봤나**: 종전 SCALED_PAYLOADS 는 전부 `'rm -rf '`
 *     류의 **촘촘한 반복**이라 첫 위치에서 매치하거나 곧장 실패해 플래그 런
 *     안으로 들어가지 않는다. 잡으려면 **quantifier 마다 긴 단일 런** payload 가
 *     필요하다 — 2026-09-22 에 `rm flag run (r)`·`rm flag run (f)` 행으로
 *     safety.test.js 에 들어갔고, 그것이 이 형을 RED 로 만든 유일한 게이트다.
 *     수리는 첫 런에서 필수 글자를 뺀 **언어 보존 토큰 교체**였다
 *     (`-[a-qs-z]*r[a-z]*`). 클래스를 부정형으로 바꾸지 않은 것은 의도다 —
 *     그러면 1번이 아니라 스캐너 본진에 걸려 엉뚱한 이유로 RED 가 된다.
 *     **2026-09-23 재발**: 같은 모양이 git-branch-delete(L2 id · L1 label
 *     'git branch -D (force delete)')의 플래그 토큰 셋 `-[a-zA-Z]*D[a-zA-Z]*` ·
 *     `-[a-z]*d[a-z]*` · `-[a-z]*f[a-z]*` 에 있었다. 실측(node v24.15.0, 규칙
 *     단독 L2, 중앙값 3회, payload `git branch -` + 'd'×n + 단어 글자 꼬리,
 *     n = 2,500 / 5,000 / 10,000 / 20,000): 리더 11:19 KST 14.4 / 44.0 / 190.6 /
 *     736.6ms, 재측정 11:30 KST 15.5 / 61.2 / 254.3 / 1,044.0ms. 꼬리가 `.`·`,`
 *     처럼 `(?![\w-])` 를 곧장 통과시키는 글자면 1.1ms 미만이다 — payload 꼬리가
 *     측정의 일부다. 수리는 rm 과 같은 토큰 교체(`-[a-zA-CE-Z]*D…` ·
 *     `-[a-ce-z]*d…` · `-[a-eg-z]*f…`)다.
 *     **검출기(2026-09-23)**: {@link findOverlappingStarPairs} — 인접한
 *     `A{긴 런} M B{긴 런}` 에서 어떤 글자가 A·M·B 셋 모두에 속하면 보고한다.
 *     첫 런이 필수 글자를 빼면(수리형) 분할점이 하나라 그린이다. 세 카탈로그
 *     전부에 예외 없이 걸린다(L1·L2 는 regex-scan.test.js, HG 는
 *     human-gate-matrix-selfcheck 섹션 G). **이 검출기가 못 보는 것**:
 *       (i)   인접하지 않은 쌍 — 사이에 원자가 둘 이상 끼면 안 본다.
 *             `\w*rr\w*` 처럼 끼인 글자가 전부 두 런에 들어도 마찬가지다.
 *       (ii)  그룹 경계 · 교대 — `(?:-[a-z]*)d[a-z]*`, `-[a-z]*(?:d|x)[a-z]*`.
 *             그룹 수량자가 만드는 반복(3번)도 여기 해당한다.
 *       (iii) 수량자가 붙은 필수 글자 — `[a-z]*r+[a-z]*`.
 *       (iv)  글자 집합은 프로브(ASCII 128자 + 비-ASCII 6자)로 잰다. 프로브 밖
 *             글자만 공유하는 쌍은 못 본다.
 *       (v)   2차식인지는 판정하지 않는다 — 모양만 본다. 반대로 긴 런의 상한이
 *             창(`{0,512}` 등록분)이면 창 규칙에 따라 조용하다: L1 'rm -fr with
 *             path' 의 `\w*r[^\n]{0,512}` 가 그 예로, 512 창 때문에 선형(창 크기
 *             배수)이다 — 2026-09-23 11:29 KST 규칙 단독 `rm -f` + 'r'×n,
 *             n = 2,500 / 5,000 / 10,000 / 20,000 에서 4.9 / 9.0 / 13.5 / 32.5ms.
 *       (vi)  가운데 원자가 **0개**인 인접 런 쌍 — `A*B*` · `A*B+` (A∩B≠∅).
 *             검출기는 A·M·B 세 토큰을 요구하므로 M 이 없으면 안 본다(M 자리에
 *             수량자 붙은 런이 오면 (iii)으로 빠진다). **카탈로그 실례**:
 *             HG-13[2] `\bbypassPre(?:Commit|Push)Hooks\s*["':=\s]+true\b`/i
 *             — `\s*` 와 `["':=\s]+` 가 공백을 공유한다. 검수자 실측(12:1x KST,
 *             규칙 단독, `bypassPreCommitHooks` + 공백×n + `x`, n = 2.5K / 5K /
 *             10K / 20K): 3.6 / 12.7 / 50.2 / 200.6ms = 2차식. 122,880B 약 7.5s
 *             는 외삽이지 측정이 아니다. 이 줄기 이전부터 있던 결함이고
 *             human-gates.js 는 이 줄기 소유 밖이라 **후속 후보**로만 적는다
 *             (실행형 핀 없음 — 미수리 결함에 RED 핀을 박지 않는다). 최악 영향은
 *             차단 우회가 아니라 기록 유실로 보인다 — pre-bash 가 recordHumanAsked
 *             전에 차단 판정을 쓰기 때문이다(추론, 미실측).
 *  2. 축약 부정 클래스 `\S` `\W` `\D`. rm-rf-path 꼬리의 `\S+` 와 L1
 *     'rm recursive+force' 의 `(?:\s+-\S+)*` 가 여기 해당한다.
 *  3. 그룹에 붙은 수량자 = 중첩 수량자. `(?:\s+--?\w[\w-]*)*` 처럼 rm 규칙군의
 *     **지수식** 위험이 이 모양인데 스캐너는 보지 않는다. safety.test.js 의
 *     `--opt` 프로브가 그 자리를 맡는다.
 *     **등록 사례 — git-branch-delete 다중 시작점(2026-09-23, 미수리).**
 *     `'git branch '.repeat(k)` 는 2차식이다: `git…branch` 시작점마다 그룹
 *     수량자가 붙은 룩어헤드 `(?:(?:[^\S\n]|\\\r?\n)+(?:토큰))*` 가 줄 나머지를
 *     다시 훑는다. 토큰 본체 런 하나는 공백을 못 넘지만(조건 3) **그룹 반복은
 *     넘는다**. 실측(node v24.15.0) — 어느 규칙 판에서 쟀는지가 수치의 일부다:
 *       교체 **전** 규칙: 리더 11:21 KST 122,880B 규칙 단독 15,018ms ·
 *         classifyRisk 13,143ms — PreToolUse 예산 5s 초과. 재측정 11:30 KST
 *         (중앙값 3회, 회차마다 다른 꼬리) 규칙 단독(L2) 5,633 / 11,265 /
 *         22,529B = 26.3 / 91.3 / 395.0ms (2배마다 3.5~4.3배).
 *       교체 **후보** 규칙: 리더 11:21 KST 약 2.5K~20K B 4.7 / 22.2 / 92.0 /
 *         378.7ms.
 *       교체 **커밋 후** 규칙: 리더 12:13 KST 규칙 단독, 같은 모양 약 2.5K~20K B
 *         L2 3.97 / 10.91 / 47.66 / 182.01ms · L1 4.12 / 10.53 / 38.70 /
 *         156.32ms — **여전히 2차식**.
 *     1-b 토큰 교체로는 안 고쳐진다 — 고치려면 규칙 언어가 바뀌므로 리더·오너
 *     결정 몫이다. 이 스캐너와 1-b 검출기는 둘 다 조용하다.
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
 *     (h) **긍정 클래스 사각 — 조건 1. (등록 사례: `lib/security/human-gates.js`
 *         HG-09 patterns[2], 2026-09-15 에 바운드됨.)** 부정 룩어헤드 **안의
 *         긍정 클래스** 런은 이 스캐너가 구조적으로 못 본다. 그 사각 자체는
 *         남아 있다 — 다음에 같은 모양이 들어와도 여기는 조용하다.
 *         **이 매트릭스의 HG-09 는 이제 사각이 아니다**: 룩어헤드 몸통이
 *         `[^;]{0,192}`(부정 클래스 + 바운드 창)라 스캐너가 창을 **실제로
 *         검사**하고 통과시킨다. 실행형 핀은 tests/helpers/regex-scan.test.js
 *         의 'HG-09 patterns[2] 는 매트릭스에서 읽어' it 이다(매트릭스를
 *         getGateRow 로 읽는다 — 리터럴 사본 금지).
 *         바운드 전 실측(2026-09-14 정찰, node v24.15.0, Windows, 규칙 단독,
 *         회차마다 다른 payload 3회 중앙값, 122,880B):
 *           F1 `'UPDATE t SET a=1 WHERE '` 반복  179.64ms · growth 17.68
 *           F3 `'UPDATE t SET a=1 '` 반복 + 꼬리 WHERE 1개 223.19ms · growth 18.39
 *           F5 다행 SQL 반복                      173.17ms · growth 19.93
 *         = **2차식**. 위 수치가 이 항목의 정본이다 — 종전 판에 적혀 있던 더
 *         작은 절대값들은 같은 모양을 다른 부하에서 잰 것이라 폐기했다. 절대값은
 *         부하 의존이고 판정(2차식)은 동일하다.
 *         **철회**: 종전 이 항목은 "WHERE 가 끝이나 앞에 하나뿐인 입력은 같은
 *         사이즈에서 선형(1ms 미만)"이라 적었다. **틀렸다.** F3 가 정확히 그
 *         모양인데 122,880B 에서 223.19ms 다. 변수는 WHERE 위치가 아니라
 *         **후보 시작점 수**(= `UPDATE … SET` 출현 수, 122,880B 에 약 7,200개)다.
 *         `[^;]*` 로 바꿔도 2차식이 유지되는 것이 음성 대조다 — 고치는 것은
 *         클래스가 아니라 **창**이다.
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
 * 1-b 검출기의 글자 집합 프로브 — ASCII 전부 + /i·/u 에서 접히거나 클래스
 * 경계에 걸리는 비-ASCII 몇 개(NBSP · é · 점 없는 ı · 긴 s ſ · U+2028 · 켈빈 K).
 */
const OVERLAP_PROBE_CHARS = Object.freeze([
  ...Array.from({ length: 0x80 }, (_, code) => String.fromCharCode(code)),
  ' ', 'é', 'ı', 'ſ', ' ', 'K',
]);

/** 이스케이프 하나의 길이를 정하는 식. 역참조 `\1` 은 숫자 전부를 먹는다. */
const ESCAPE_TOKEN = /^\\(?:x[0-9A-Fa-f]{2}|u\{[0-9A-Fa-f]+\}|u[0-9A-Fa-f]{4}|c[A-Za-z]|[pP]\{[^}]*\}|k<[^>]*>|\d+|[\s\S])/;

/**
 * 원자 하나를 읽는다(1-b 용). 글자 하나를 소비하는 원자면 그 원문을, 폭 0
 * 단언 · 역참조 · 그룹 경계 · 교대면 null 을 돌려준다 — null 은 인접성을 끊는다.
 * @param {string} source @param {number} i
 * @returns {{ end: number, atom: string|null }}
 */
function readAtom(source, i) {
  const ch = source[i];
  if (ch === '[') {
    const cls = readCharClass(source, i);
    return cls ? { end: cls.end, atom: source.slice(i, cls.end) } : { end: i + 1, atom: null };
  }
  if (ch === '\\') {
    const text = ESCAPE_TOKEN.exec(source.slice(i))?.[0] ?? '\\';
    const zeroWidthOrBackref = /^\\(?:[bB]|\d|k<)/.test(text);
    return { end: i + text.length, atom: zeroWidthOrBackref ? null : text };
  }
  if (ch === '(') {
    const open = /^\((?:\?:|\?=|\?!|\?<=|\?<!|\?<[A-Za-z_$][\w$]*>)?/.exec(source.slice(i));
    return { end: i + open[0].length, atom: null };
  }
  if (ch === ')' || ch === '|' || ch === '^' || ch === '$') return { end: i + 1, atom: null };
  return { end: i + 1, atom: ch };
}

/**
 * 소스를 (원자, 수량자) 토큰 열로 자른다. 그룹에 붙은 수량자는 닫는 괄호
 * 토큰(atom null)에 붙어 버려진다 — 못 보는 것 1-b(ii).
 * @param {string} source
 * @returns {{ index: number, end: number, atom: string|null, max: number, quantified: boolean }[]}
 */
function tokenizeAtoms(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const index = i;
    const { end, atom } = readAtom(source, i);
    i = end;
    const q = readQuantifier(source, i);
    if (q) {
      i = q.end;
      if (source[i] === '?') i += 1; // lazy
    }
    tokens.push({ index, end: i, atom, max: q ? q.max : 1, quantified: q !== null });
  }
  return tokens;
}

/**
 * 원자 셋이 **모두** 매치하는 프로브 글자. 플래그는 글자 집합을 바꾸는 i·u·s 만
 * 넘긴다. 원자를 단독으로 컴파일하지 못하면 fail-closed — 그 원자는 프로브
 * 글자 전부를 매치한다고 본다.
 * @param {string[]} atoms @param {string} flags
 * @returns {string[]}
 */
function sharedProbeChars(atoms, flags) {
  const setFlags = flags.replace(/[^ius]/g, '');
  const matchers = atoms.map((atom) => {
    try {
      const re = new RegExp(`^(?:${atom})$`, setFlags);
      return (c) => re.test(c);
    } catch {
      return () => true;
    }
  });
  return OVERLAP_PROBE_CHARS.filter((c) => matchers.every((matches) => matches(c)));
}

/**
 * 1-b 형을 보고한다: **인접한** `A{긴 런} M B{긴 런}` 에서 M 이 수량자 없는
 * 글자 하나이고, 어떤 글자 c 가 A·M·B 셋 모두에 속할 때. "긴 런" 은 상한이
 * `ceiling` 을 넘는 수량자다({@link findUnboundedRuns} 와 같은 창 규칙).
 *
 * 왜 셋의 교집합인가(두 쌍의 교집합이 아니라): 분할점은 A 런 안에서 M∩A
 * 글자가 있는 자리뿐이고, 그 자리마다 B 런이 멀리 가려면 뒤따르는 글자가 B
 * 에 들고 **다음 분할점 글자도 B 에 들어야** 한다. c ∈ A∩M∩B 가 없으면 각
 * 분할점의 B 런은 다음 분할점에서 끊기고 전체 일은 O(n) 이다. 수리형
 * `-[a-qs-z]*r[a-z]*` 은 A 가 M 을 빼서(분할점 1개) 그린이고, 반대로 B 만
 * M 을 뺀 `[a-z]*r[a-qs-z]*` 도 같은 이유로 그린이다.
 * @param {string} source @param {string} [flags]
 * @param {number} [ceiling] 이 규칙에 허가된 창 — {@link ceilingFor} 로 고른다
 * @returns {{ index: number, snippet: string, shared: string[] }[]}
 */
export function findOverlappingStarPairs(source, flags = '', ceiling = WINDOW_CEILING_DEFAULT) {
  const tokens = tokenizeAtoms(source);
  const found = [];
  for (let k = 0; k + 2 < tokens.length; k += 1) {
    const [a, m, b] = tokens.slice(k, k + 3);
    if (a.atom === null || m.atom === null || b.atom === null) continue;
    if (m.quantified || a.max <= ceiling || b.max <= ceiling) continue;
    const shared = sharedProbeChars([a.atom, m.atom, b.atom], flags);
    if (shared.length === 0) continue;
    found.push({ index: a.index, snippet: source.slice(a.index, b.end), shared });
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
