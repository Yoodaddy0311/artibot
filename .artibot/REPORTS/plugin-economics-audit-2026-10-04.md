# Artibot 플러그인 감사 — 개발 진도와 검증 경제성

작성: 2026-10-04 23:50 KST 이후. 기준 HEAD: `bc98327a7cdf94fa040dc6bfce56a1181c0d7377` (v4.71.2).

이 문서는 감사 결과다. 실행 상태·미션 계획의 새 정본이 아니다. 제품 코드, 설정, 활성 규칙은 변경하지 않았다.

**결론: 병목은 테스트 개수 자체보다 검증 발화 조건·범위·종료조건의 불일치다.** 작은 작업에도 전체 테스트와 중첩 리뷰가 붙고, 완료된 작업에 시간 기준으로 추가 작업을 요구한다. 반면 비용 집계와 메모리 저장에서는 실제 파이프라인 결함을 확인했다. 중복 검증을 줄이고, 생산자→소비자 경계의 대표 통합 검증에 집중하는 것이 가장 먼저 할 일이다.

## 1. 범위와 증거 수준

- 3개 병렬 조사: 테스트/CI, 런타임/학습, 운영 규칙/리뷰. 대표가 주요 근거를 다시 읽고 비용·메모리 재현을 직접 확인했다.
- `ARTIBOT.md`, 프로젝트/플러그인 지침, 현재 config, 훅 등록/dispatch, 런타임, 메모리, 비용, 검증 결과, CI/릴리스, 명령/스킬/에이전트, 설치 규칙을 조사했다.
- **전체 테스트·coverage·빌드 재실행 0회.** 기존 실행 기록과 파일 읽기, 상태를 변경하지 않는 작은 재현을 사용했다. 이번 결과는 전체 코드의 무결성 인증이 아니다.
- **확정**: 소스·설정의 직접 확인 또는 출력 재현. **추론**: 그 구조가 만들 수 있는 시간·토큰 낭비. **미측정**: 사용자 작업에서 실제 발생한 총 중복 횟수, 월 비용, 개선 후 절감률.
- 감사 도중 다른 작업이 `52f010f5` 위에 `bc98327a` 릴리스를 커밋했다. 변경 12개 파일은 버전·README·CHANGELOG·lock 메타정보이며 아래 구현 근거는 유지됐다. 다른 작업의 파일은 수정하지 않았다.
- 원격 Actions 최신 실행·청구시간은 확인하지 못했다. 로컬 CI 정의를 실제 원격 실행 결과로 취급하지 않았다.

## 2. 현재 규모와 다섯 관점의 판정

| 관점 | 판정 | 우선 조치 |
|---|---|---|
| 확장성 | 팀과 훅이 늘면 같은 메모리 파일을 여러 경로가 갱신하고, 리뷰가 다시 리뷰어를 생성한다 | 저장 소유자 통합, 검수 역할/범위 분리 |
| 안정성 | 병렬 저장 갱신 유실 재현. 보호 판정 코어 일부는 훅까지 연결되지 않음 | 저장 transaction, 실제 훅 입출력 경계 검증 |
| 효율성 | 스킬 로딩·커밋·CI·릴리스에 중복 전체 검증 경로 존재 | 작업 중 표적 검증, 통합 시 전체 검증, 같은 결과 재사용 |
| 경제성 | 시간 채우기 규칙과 잘못된 usage 집계가 비용 최적화 판단을 왜곡 | 인위적 작업량 하한 제거, usage 집계부터 정확하게 |
| 미래지향성 | 이미 있는 부품의 연결·운영 증거보다 선언·문서·휴면 기능이 앞선 부분이 있음 | 신규 프레임워크보다 기존 기능의 소비처·완료조건 정리 |

파일 census(플러그인 디렉터리, `.js/.mjs/.md`, 참고문서 포함): `lib` 430파일, `scripts` 193파일, 명령 80파일. 테스트 실행 대상 `*.test.{js,mjs}` 878파일(훅 113, firewall 93, autopilot 81). 파일 수만으로 불필요하다고 판정하지 않았다.

기존 `plugins/artibot/runtime/last-test-result.json:1`의 2026-10-04 22:10:24 KST 기록:

| 항목 | 기록값 |
|---|---:|
| 실행시간 | 317,884ms = 약 5분 18초 |
| 수집 모듈 | 878 |
| total / passed / failed / skipped | 26,574 / 26,464 / 0 / 48 |

이 snapshot에는 검증한 SHA와 실행 범위가 없다. 따라서 현재 HEAD의 전체 통과 증명이 아니다. total과 나머지 합계의 차이 62도 별도 상태 미집계 가능성이 있어 전부 통과로 세지 않았다.

## 3. 검증 작업이 늘어나는 직접 원인

### A1. TDD 스킬 활성화가 전체 테스트를 실행한다 — 우선순위 높음

`plugins/artibot/skills/tdd-workflow/SKILL.md:34-36`의 동적 문맥은 다음 명령이다.

```text
!`npm test -- --reporter=dot 2>&1 | tail -5`
```

대상을 정하기 전에 전체 suite를 실행하는 정의다. 출력 5줄 제한은 실행 비용을 줄이지 않는다. 호스트에서 이 동적 문맥이 실행되는 경로에 적용되며, 이번 Codex 감사에서 파일을 읽은 것만으로 실행되지는 않았다.

**개선:** 이미 있는 test-status snapshot을 날짜·범위 미확인 표기와 함께 참조한다. 새 테스트는 선택한 변경에 대해 명시적으로 실행한다. 과거 snapshot은 참고정보이며 현재 변경의 통과 증거로 재사용하지 않는다.

### A2. 커밋마다 없는 검사까지 요구한다 — 우선순위 높음

`plugins/artibot/rules/verification-discipline.md:186-196`은 모든 커밋에 전체 vitest, `npx tsc --noEmit`, `npm run prebuild`, `npm run build`, 교차검수와 최종검수를 요구한다. 현재 `plugins/artibot/package.json:18-48`에는 해당 build/prebuild/typecheck 명령이 없다. 설치된 규칙에도 같은 요구가 있다. 소스 자체의 문제여서 단순 재설치로 해결되지 않는다.

추가로 TDD 스킬 `:266`은 변수명 변경 정도여도 REFACTOR에 최소 5분을 쓰도록 한다.

**개선:** 증거 요구는 유지하되 §11만 실제 저장소 명령·변경 위험·통합 시점에 맞춘다. 기계적 최소 시간은 제거한다. 관련 검증이 성공했고 추가 변경·실패·구체적 위험이 없으면 종료한다.

### A3. 검수가 다시 검수 팀을 만든다 — 우선순위 높음

`plugins/artibot/commands/team.md:330-347`은 팀원별 교차검수, `:349-376`은 전체 최종검수를 요구한다. 그런데 `plugins/artibot/agents/code-reviewer.md:46-85`의 code-reviewer는 직접 검수하지 않고 spec-reviewer와 quality-reviewer를 순차 호출한다.

N개 교차검수와 최종검수 모두 이 정상 경로를 따르면 리뷰 관련 agent 호출이 `3N+3`개가 될 수 있다(예: N=3이면 12개). 문서 구조로부터 계산한 값이며 실제 세션 빈도는 미측정이다.

`:124`는 SPEC_WARN과 QUALITY_WARN이 함께 나오면 REQUEST_CHANGES로 올린다. `team.md:376`은 수정 후 재검수를 지시하지만 전체 라운드 종료조건을 두지 않는다. 개별 maxTurns는 이 순환의 상한이 아니다.

**개선:** 필요한 교차검수는 변경 영역의 계약·회귀에 집중한다. 최종 독립 검수는 통합 경계·요구사항 충족·잔여 결함을 판정한다. 같은 tests를 역할별로 다시 실행하지 않는다. 정보·스타일 경고 개수만으로 수정을 강제하지 않는다. 안전·요구사항 결함은 WARN이라는 이름이어도 해결한다. 수정 후 재검수는 변경분에 한정하고, 예컨대 2회 뒤에도 같은 결함이면 실패를 유지한 채 원인 분석/재계획으로 전환한다. **회차 상한은 자동 승인 기준이 아니다.**

### A4. 작은 계획을 시간대에 맞추어 키운다 — 우선순위 중간

`plugins/artibot/commands/ultraplan.md:105-110`은 기본 2~4시간 밴드 미달이면 테스트·하드닝·관측·문서로 확장하도록 한다. `plugins/artibot/lib/planning/session-sizer.js:309-310`은 시간 미달을 `expand`로 반환한다. 실제 `classifySize(0.25)` 출력도 `target={minHours:2,maxHours:4}, recommendation=expand`였다.

**개선:** 시간은 예산 상한·분할 판단에 사용한다. 수락기준을 충족한 15분 작업은 15분에 끝낸다. 추가 테스트는 확인한 위험 때문에 추가하며 목표 시간 채우기 때문에 만들지 않는다. 이 문제의 범위는 해당 ultraplan 경로다.

### A5. 검증 기준과 활성 규칙이 서로 다르다 — 우선순위 중간

| 위치 | statements / branches / functions / lines |
|---|---|
| `rules/test-patterns.md:18-21` | 90 / 85 / 88 / 90 |
| `vitest.config.js:63-66` | 80 / 76 / 80 / 80 |
| `scripts/ci/validate-coverage.js:25-28` | 85 / 76 / 85 / 85 |

로컬 기준과 CI 기준의 차이는 문서화돼 있다. 문제는 테스트 규칙의 높은 수치가 별도 강제 목표처럼 전달되는 점이다. 기준을 낮추지 않고 **권장 목표 / 로컬 게이트 / CI 게이트**를 명시해 같은 정본을 참조하도록 해야 한다.

소스와 설치된 규칙 10개 중 agent-coordination, dev-protocol, verification-discipline 3개가 다르며 `.artibot-new`도 있다. 설치본 모델 지침은 이전 정책을 말한다. `plugins/artibot/install.sh:827-831`과 `plugins/artibot/install.ps1:323-340`은 기존 파일이 다르면 보존하고 새 파일을 옆에 둔다. 사용자 편집 보존은 옳지만 업데이트가 실제 활성 규칙에 적용됐다는 뜻은 아니다.

**개선:** 현재 3개 충돌은 내용 단위로 병합한다. 설치본 안전 지침을 통째로 덮어쓰지 않는다. 차후 이전 설치본 해시가 확인되는 파일만 자동 갱신하는 작은 보완을 검토한다. TDD 스킬의 기술적 사실 확인용 사람 체크포인트(`:153-162`)는 testing-standards의 기존 Self-check 방식을 재사용한다.

## 4. CI와 검증 결과 재사용

### B1. 네 환경 모두 coverage를 계산한다 — 우선순위 중간

`.github/workflows/ci.yml:55-66`은 Linux Node 20/22/24와 Windows Node 22, 총 4환경이다. `:151-158`은 모든 환경에서 전체 suite+coverage+runtime eval을 수행한다. 같은 브랜치의 낡은 실행을 취소하는 concurrency 설정도 없다. 중첩된 플러그인 내부 `.github`의 matrix는 현재 저장소 Actions 수에 합산하지 않았다.

**최소 변경:** 네 환경의 전체 테스트를 유지하고 coverage와 coverage 임계값 검사는 대표 환경 한 곳으로 모은다. 계측 실행 4→1은 **coverage 실행 횟수 75% 감소**이며 총 CI 시간·청구비 75% 절감은 아니다. 같은 PR/브랜치의 오래된 실행만 취소한다. required check 이름과 착지에 필요한 결과는 유지한다. 매트릭스별 필수 runtime eval은 근거 없이 제거하지 않는다.

### B2. 릴리스가 테스트 수를 세려고 다시 테스트한다 — 우선순위 중간

`.github/workflows/release.yml:136-143`은 informational full suite를 실행하고, `:522-535`는 test count를 얻기 위해 전체 suite를 다시 실행한다.

**개선:** 첫 실행에 JSON 결과를 함께 남겨 artifact로 전달한다. 두 번째 단계는 그 숫자를 읽는다. 태그를 검사한 결과는 그 태그 SHA의 숫자다. 후속 master checkout의 현재 테스트 수로 바꾸어 읽지 않는다. 실행한 tree가 다르면 재사용할 수 없다.

### B3. 부분 테스트의 성공을 전체 성공처럼 읽을 수 있다 — 우선순위 높음

`tests/reporters/test-status-reporter.js:101-114`는 모든 실행이 같은 last-test-result 파일을 덮어쓰며 명령·필터·tree를 남기지 않는다. `lib/verification/deterministic-source.js:180-205`도 테스트 수만으로 전체/부분을 판별할 수 없다고 명시한다.

**개선:** 기존 검증 결과에 실행 명령, 선택 범위, 실제 수집 파일, 대상 내용 fingerprint, 테스트 설정·lockfile·Node/OS 정보, 종료 코드와 완료 시점을 연결한다. 상태가 같은 증거만 재사용한다. snapshot의 날짜가 최근이라는 이유로 재사용하지 않는다. 별도 원장·대시보드를 새로 만들 필요는 없다.

Vitest의 기존 `related`/`--changed`를 활용할 수 있지만, 이 저장소의 firewall/계약 tests는 파일을 문자열로 읽기도 한다. import 관계만으로 선택하면 놓친다. rules/commands/config/schema/install 변경은 명시적인 계약 검사 묶음을 포함하고, 영향 범위가 불명확하면 전체 검사로 돌아간다.

### B4. 목표 검증의 중복 실행과 무기한 대기 가능성 — 우선순위 중간

`lib/autopilot/engine.js:505`의 VERIFY는 `npm run ci`를 요청한다. goal mode는 IMPROVE 뒤 EVALUATE로 가고, `lib/autopilot/goal-evaluator.js:82-84`는 validationCommand를 다시 실행한다. 기본 runner의 `execSync`(`:24-28`)에는 명시적인 timeout/cwd가 없다.

**개선:** 먼저 실행시간 상한과 올바른 작업 디렉터리를 명시한다. 이후 앞의 검증 결과와 내용·명령·환경·범위가 일치할 때만 재사용한다. IMPROVE가 내용을 바꿨다면 재검증은 필요하다. 출하 autopilot 최상위 enabled는 false이므로 이 문제를 모든 일반 채팅의 병목으로 확대하지 않는다.

## 5. 실제 파이프라인 결함과 안전성

### C1. 동일 응답의 비용 집계 규칙이 둘이다 — 우선순위 높음

`lib/economics/usage-receipt.js:605-624`는 같은 requestId의 첫 행을 채택하고 나머지는 버린다. 반면 `scripts/evals/context-roi-census.mjs:146`은 마지막 행을 채택한다. 해당 census 헤더는 분할 응답에서 output_tokens가 뒤 행으로 갈수록 증가한 관측을 명시한다.

동일한 두 행(output 10→160)을 두 exported API에 주입한 재현:

```json
{"census":160,"receipt":10,"coverage":1,"latency":0}
```

**개선:** 같은 request의 집계 규칙을 공통으로 사용한다. 최종 usage와 시간 범위를 보존하는 대표 회귀 하나를 두 소비자에 적용한다. 이는 합성 fixture의 재현이며 실제 청구비가 항상 16배 틀린다는 뜻은 아니다. 가격은 이번 감사에서 검증하지 않았다.

### C2. SessionEnd의 중복 메모리 writer와 갱신 유실 — 우선순위 높음

`hooks/dispatch-table.json:74,77`의 session-end와 memory-tracker가 `_sessionend-dispatcher.js:62`에서 병렬 실행된다.

- session-end → `learning/pipeline.js:406` → `memory-manager.js:629`: session-summarizer 경로.
- `scripts/hooks/memory-tracker.js:129-157`: 같은 project-contexts 파일에 직접 쓰는 경로.
- tracker는 `:83`에서 non-atomic `writeFileSync`, `:156`에서 기존 항목 100개만 유지 후 1개 추가. library는 최대 1000개 정책이다.

현재 로컬 저장소는 73항목(tracker 42, summarizer 31), 같은 sessionId의 중복 그룹 26개였다. 내용·세션 식별자는 보고서에 노출하지 않았다. 동일 세션 중복은 곧바로 데이터 유실 횟수를 뜻하지 않는다.

별도로 실제 `saveMemory`의 파일 I/O만 메모리 Map으로 대체해 병렬 저장 두 번을 실행했다.

```json
{"returned":2,"stored":1,"reportedFailure":0}
```

`memory-manager.js:407,438-444`의 read-modify-write는 atomic rename만으로 직렬화되지 않는다. `searchMemory(:519-544)`도 접근 횟수 갱신 때문에 전체 store를 다시 쓴다.

**개선:** 요약 저장 소유자를 하나로 정하고, 같은 저장소 갱신을 공통 transaction으로 보호한다. 조회 통계는 매번 본문 전체를 덮어쓰는 경로에서 분리한다. 새 데이터베이스 도입까지 확장할 필요는 없다. 검증은 동시 writer, 조회+writer, 같은 session 중복 이벤트의 대표 시나리오에 집중한다.

### C3. 세션 토큰 표시가 마지막 입력 추정치로 되돌아간다 — 우선순위 중간

`runtime-prompt.js:496`은 호출마다 runtime을 만들고 `middleware/token-usage.js:241`의 store도 새로 만들어진다. `runtime-prompt.js:525-537`은 이를 세션 파일에 덮어쓴다. middleware는 입력 길이 추정이며 outputTokens도 0이다.

같은 session의 100·200 토큰 상당 두 입력에서 새 runtime 방식은 마지막 200/requestCount1, 동일 instance 대조는 300/requestCount2였다.

**개선:** 현재 값을 '현재 입력 추정치'로 정확히 표시하거나 기존 transcript 기반 사용량을 소비한다. 실제 비용 원장과 경쟁하는 새 누적기를 추가하지 않는다.

### C4. 안전 판정 코어가 있어도 실제 훅 보호가 되는 것은 아니다 — 우선순위 높음

`lib/security/human-gate-enforce.js:16-24`는 production caller 0, 기본 OFF, 훅 배선 미완료를 명시한다. lib/scripts/hooks/config를 검색해 그 설명과 일치함을 확인했다. 실제 출하 config를 순수 판정 함수에 넣으면 보호 설정 경로 HG-12/HG-13은 다음처럼 나온다.

```json
{"decision":"record","wouldDecide":"deny","reason":"enforce-disabled"}
```

이는 **이 플러그인의 해당 보호 경로가 미완성**이라는 뜻이다. 호스트 권한·샌드박스 전체가 없거나 임의 작업이 허용된다는 뜻은 아니다. HG-07 외부 쓰기 확대는 기존 정책 결정도 남아 있다.

**개선:** 새 판정기를 추가하지 않고 기존 코어→PreToolUse→호스트 판정 전달을 연결하는 수직 작업을 우선한다. 정상 읽기와 되돌릴 수 있는 편집은 막지 않도록 실제 호스트 계약을 먼저 확인한다. 이 감사에서 설정을 켜거나 승인 정책을 변경하지 않았다.

별도의 작은 보안 차이: `.github/workflows/ci.yml:102`, `self-control.yml:98`의 `npm ci --ignore-scripts || npm install`은 fallback에서 ignore-scripts를 잃는다. release `:82`에는 이미 보완이 있다. lockfile 설치 실패를 명확히 실패 처리하거나, 허용된 fallback에도 같은 제한을 유지한다.

### C5. 소비되지 않는 skill 본문 사전 읽기 — 우선순위 낮음

`skills.lazyLoading`이 켜져 있지만 `core/skill-exporter.js:219-224`는 전체 SKILL.md를 읽고 `:258-271`은 매칭 본문을 다시 읽는다. `middleware/skills.js:249-260`은 이름 목록만 저장하며 실제 hook additionalContext는 이 본문을 소비하지 않는다. 조사 agent의 cold probe는 117회/약1.02MB/41ms였다. 전체 작업 지연의 주원인으로 볼 수준은 아니지만 불필요 I/O다.

**개선:** native skill 활성화는 유지하면서 소비되지 않는 prefetch 경로부터 좁게 비활성화/정리한다. 실제 prompt·라우팅 결과가 같다는 경계 검증을 사용한다. 존재 감사 정책에 따른 모듈 삭제와 작은 동작 변경을 혼동하지 않는다.

## 6. 제안하는 검증 운영 방식

| 변경/시점 | 실행할 검증 | 종료조건 |
|---|---|---|
| 일반 설명·문서 | 관련 링크·형식·계약 검사 | 해당 계약 통과. 일반 문구마다 전체 테스트 금지 |
| prompt/rules/commands/schema/config | 영향받는 계약·firewall + 필요 smoke | 단순 문서 취급 금지. 선택 범위 불명확하면 full |
| 기능/버그 수정 중 | 재현 또는 변경 동작의 관련 tests + 직접 소비자 통합 검사 | 해당 위험 해소. 매 파일·매 커밋 full 반복 없음 |
| 보안·상태 저장·설치·동시성 | 차단/허용, 실패/복구, 경합을 다루는 대표 통합 회귀 | 정상 경로와 위험 경로 모두 증거 확보 |
| 안정된 통합 지점 | full suite·lint·필수 eval + 독립 최종판정 | 새 변경·실패·구체적 미해결 위험 없으면 완료 |
| 수정 후 재검수 | 수정 범위와 관련 회귀 | 바뀌지 않은 증거 재사용. 같은 실패 반복은 재계획 |
| CI/릴리스 | 4환경 호환성 유지, 대표환경 coverage, SHA에 연결된 결과 사용 | 기존 필수 안전/릴리스 기준 유지 |

검증 비용 예산은 **검사 빈도와 범위 선택**에 쓰고, 실패를 성공으로 바꾸는 근거로 사용하지 않는다. 큰 결과물 단위로 변경을 묶되 실패 시 원인 추적이 가능한 크기는 유지한다.

신규 테스트의 질문은 '테스트를 하나 더 추가할까'가 아니라 '어떤 실패를 막으며 어느 소비자까지 증명할까'다. 구현을 그대로 복제한 테스트, 정상 문구를 한 글자씩 고정하는 테스트, 테스트 숫자/coverage 숫자를 채우기 위한 작업은 기본 제안에서 제외한다. 기존 보호 계약은 효과 근거 없이 삭제하지 않는다.

## 7. 적용 순서와 경제성 측정

1. **규칙 정리 묶음:** A1/A2/A3/A4를 정리한다. 로딩 full, 매커밋 full, 최소 시간 채우기, 정보성 경고 재작업을 제거한다. 활성 설치 규칙까지 반영되는지 확인한다.
2. **검증 재사용 묶음:** 기존 결과에 범위/내용/환경을 연결한다. release 중복 실행 제거, CI coverage 단일화와 같은 브랜치 낡은 실행 취소를 적용한다.
3. **실제 안정성 묶음:** 메모리 저장 소유권/경합과 usage 집계 불일치를 고친다. 각각 대표 통합 검증을 수행한 뒤 안정된 통합 지점에서 전체 검사한다.
4. **연결 완성 묶음:** 사람 게이트의 기존 승인 범위·호스트 계약을 확인하고 실제 훅 연결을 완성한다. 휴면 자율기능 추가보다 우선한다.

작은 변경마다 새 감사 프로젝트를 만들지 않는다. 위 묶음마다 수락조건과 대표 증거를 정하고 완료시킨다.

기존 중앙 원장 `.git/artibot/ledger.jsonl`과 usage/검증 결과를 활용해 다음을 비교한다: 수락한 결과물당 비용, 구현 대비 검증 시간, 동일 내용의 full 재실행 수, 재검수 라운드 수, 검수 후 회귀·재오픈 수. **반복 full과 검증 시간을 줄이되 검수 후 회귀를 늘리지 않는 것**이 목표다. 새 대시보드부터 만들지 않는다.

이번 중앙 원장 표본에는 verify.completed 4건, review.completed·mission.completed·usage.receipt 0건이었다(현재 표본은 10/04, 진행 중인 세션 포함). 이 표본만으로 전체 운영 빈도나 결과물당 비용을 계산할 수 없다. 예전 `.artibot/runtime/ledger.jsonl`은 legacy 위치이므로 최신 지표로 혼합하지 않았다. mission-complete-record는 accepted:null만 쓰는 단계이며, 판정 완료와 연결된 비용 분모의 완성도도 별도 확인이 필요하다.

현재 기록의 full suite 1회는 약 5분18초다. 동등한 실행 한 번을 없애면 그 실행의 시간을 줄일 수 있다는 계산만 가능하다. **전체 개발속도 몇 배, 비용 몇 % 감소는 현재 근거로 약속할 수 없다.**

## 8. 제외·보류한 제안

| 판정 | 제안 | 이유 |
|---|---|---|
| REJECT | QA·Phase 4.5·독립 최종검수·보안 훅 삭제 | 실제 경합/집계/배선 결함이 있으므로 경계 검증은 필요 |
| REJECT | coverage 기준 일괄 완화 | 중복 실행의 원인을 해결하지 못함 |
| REJECT | post-write가 자동 full을 돌리니 훅 제거 | post-write-tdd는 scope가 제한된 advisory이며 테스트 실행기가 아님 |
| REJECT | Stop 반복 방지 캐시 신규 구축 | stop-review-gate에 fingerprint+mtime guard가 이미 있음 |
| REJECT | autopilot tests 직렬화 해제 | git worktree 충돌의 실제 회귀 방지 장치 |
| REJECT | checkpoint 경합을 다시 수정 | 이미 append-only로 고친 경로 |
| REJECT | 계층형 메모리·자율기능을 바로 ON | 휴면·미연결을 명시한 상태이며 범위와 검증비만 늘어남 |
| DEFER | 저가 모델 일괄 전환 | 현재 모델 정책은 명시 결정. 우선 불필요 호출과 잘못된 비용 측정을 고쳐야 함 |
| DEFER | 테스트/문서 대량 삭제 | 개수만으로 무가치함을 입증하지 못함 |
| DEFER | 새 테스트 선택 엔진·비용 대시보드·대형 scheduler | 기존 Vitest/원장/결과 재사용이 더 작고 저렴함 |
| DEFER | 모든 대형 파일·계층·다중 도구 adapter 재설계 | 현재 사용자 병목을 고치는 직접 근거보다 유지비가 큼 |

## 9. 재현 방법의 핵심

수집 대상: `rg --files plugins/artibot/tests`에서 `\.test\.(js|mjs)$`만 집계. JS census는 node:fs로 대상 디렉터리를 재귀 순회하고 파일 종류/문자/행 수를 계산했다. Git 근거는 `git status --short`, `git show --stat bc98327a`, `git diff --stat`로 대조했다.

비용 재현은 `buildUsageReceipts`의 readTranscript/listSubagentTranscripts를 주입하고 `createCensus`에 동일 JSONL 두 행을 넣었다. 모델 식별은 카탈로그가 인식하는 ID만 사용하고 `priceReceipts:false`로 가격 계산을 끈다. 요청 id 하나, input100, cache0, output10→160, timestamp1초 간격이다.

메모리 재현은 실제 `saveMemory`를 import하고 그 프로세스의 fs/promises readFile/writeFile/mkdir/rename/unlink만 메모리 Map으로 대체했다. `Promise.all([saveMemory('context',{project:'auditA'}), saveMemory('context',{project:'auditB'})])`의 반환 수와 저장 배열 길이를 비교하고 mock을 복원했다. 디스크의 사용자 메모리를 쓰지 않았다. 이는 겹친 read-modify-write의 결정적 재현이며 운영 유실률 추정은 아니다.

보안 재현은 실제 config 객체와 가상 보호 경로를 `decideHumanGate`에 전달했다. 도구 실행·파일 쓰기·네트워크 호출 없이 decision만 읽었다. 코드의 비활성/미연결 상태와 호스트 전체의 보안 보장은 구분했다.
