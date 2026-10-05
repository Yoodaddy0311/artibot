# Artibot 검증 경제성·안정성 개선 설계

작성일: 2026-10-05 · 상태: **제안 설계 / 제품 구현 미적용**  
기준: `bc98327a7cdf94fa040dc6bfce56a1181c0d7377` / v4.71.2  
근거: [플러그인 감사 보고서](../REPORTS/plugin-economics-audit-2026-10-04.md). A/B/C 번호는 이 보고서의 항목이며, 아래 섹션 제목·행에 `(A2)` 같은 태그로 대응시켰다(매핑: A1→§2.2 tdd-workflow, A2→§2.1·§2.2 §11, A3→§2.3, A4→§2.2 plan/ultraplan/session-sizer, A5→§2.2 test-patterns+§2.4 설치본 규칙, B1→§3.1, B2→§3.3, B3→§3.2, B4→§3.4, C1→§4.1, C2→§4.2, C3→§4.3, C4→§5(+§3.1 npm ci fallback), C5→§4.4). **보고서에 없는 이 가이드 고유 제안**: §3.4의 autopilot 10분 기본값, §3.1의 concurrency YAML, §5의 adapter 계약 세부.
**링크 주의:** 인용한 감사 보고서와 이 가이드는 둘 다 untracked다(`git ls-files .artibot/REPORTS` = 0건, 2026-10-05 실측). 가이드만 커밋하면 위 상대 링크가 깨진다.

이 문서는 업데이트 담당자를 위한 기술 설계다. 미션·실행 상태의 새 정본을 만들지 않는다. 구현할 때 최신 HEAD의 변경을 대조하고, 기존 프로젝트 상태 정본을 사용한다.

**목표는 기능 완성까지의 시간을 줄이면서 데이터 유실·잘못된 성공 판정·안전 경계 누락을 방지하는 것이다.** 작은 변경마다 전체 테스트와 중첩 리뷰를 반복하는 규칙부터 고친다. 검증 결과의 범위를 분명히 하고, 메모리와 비용 집계 결함을 해결한다(감사 당시 재현은 단일 프로세스 시뮬레이션이었고, 2026-10-05에 실제 두 프로세스·실제 transcript로 재측정됨 — §4.1·§4.2). 범용 테스트 캐시·새 오케스트레이터·새 QA 시스템은 만들지 않는다.

## 0. 검수 반영 요약 (2026-10-05)

이 문서는 검수자 7인이 HEAD `bc98327a` 기준으로 감사했다(현재 master `5a3bb327`은 테스트 수 문서 동기화 커밋만 추가). "기존 구현" 주장 대부분은 확인되었고, 확인된 오류는 본문에서 정정했다. 측정치는 모두 2026-10-05 KST 감사팀 측정이며, 판정은 repo 스킬 `problem-validation` 기준(NECESSARY / DEFER / REJECT)이다. **이 문서는 제안이며 정책 결정이 아니다.** 목표("기능 완성까지 시간 단축")는 기준선이 없다: 원장에 `review.completed`·`mission.completed`·`usage.receipt` 이벤트가 0건이고 시간·회차 기준선이 존재하지 않는다(§7도 절감 미측정을 인정). 따라서 경제성 목표 전체는 problem-first의 "하드 증거" 검사를 통과하지 못하며, 결함 수정 묶음(3, 4, 1의 일부)만 통과한다.

### 0.1 제안별 판정

| 제안 | 판정 | 근거 한 줄 |
|---|---|---|
| §2 §11 tsc/prebuild/build 제거 | NECESSARY (범위는 오너 결정) | artibot repo에 해당 스크립트 없음, 단 규칙은 TS/Next 스택용 전역 규칙 |
| §2 §11 전체 vitest 완화 + 증거 재사용 | 오너 결정 (DEFER) | 설치본 §10.5(a)·VD §6·v5 설계 "완화 0"과 충돌 |
| §2.2 tdd `!` 줄 제거 | NECESSARY (조건부) | 줄 존재 확인. 호스트의 `!` 실행 여부 미확인 |
| §2.2 REFACTOR 5분 삭제 | REJECT (제안 형태로는) | 규칙이 아니라 참고용 표의 반박 셀. 선택적 문구 완화로만 |
| §2.2 Checkpoint→Self-check | DEFER | stage-b 분류 표 동시 수정 없으면 RED |
| §2.2 test-patterns 3분리 | NECESSARY | |
| §2.2 plan/ultraplan expand 문구 | NECESSARY | `expand` 소비처는 문구뿐 |
| §2.2 session-sizer 무변경 | null-result 정당 | 코드 소비자 없음 |
| §2.3 Cross-check/Inspection 분리 | NECESSARY | team.md에 정의 없는 `[Cross-check Mode]` 표식이 이미 매달려 있음 |
| §2.3 WARN+WARN→APPROVE | DEFER / 오너 | 판정 완화 |
| §2.3 재검수 2회 한도 | DEFER | 기존 '최대 2회' 없음, 기록 위치 미지정 |
| §2.4 설치본 3파일 병합 | NECESSARY (오너 파일 수정은 오너 승인 필요) | 설치본·소스 양방향 차이 실측 |
| §2.4 설치기 보존 동작 | 이미 참 | 변경 불요 |
| §3.1 coverage 4→1 | DEFER | 절감은 러너 분 단위뿐, Windows 임계값 신호 상실 |
| §3.1 `--ignore-scripts` fallback | NECESSARY | 현재 두 정책이 공존 |
| §3.1 concurrency | REJECT (현재) | 최근 ci 20/20 `push`, 취소할 PR run 없음 |
| §3.3 릴리스 결과 재사용 | NECESSARY (job outputs 선호, 추론) | v4.71.2에서 tag SHA == master SHA(이전 릴리스는 미확인), 릴리스 절차상 정상 경로(추론) |
| §3.0 릴리스 대기창 (신규) | NECESSARY P1 | 대기 10분 < Windows 13분 |
| §3.4 autopilot 상한 | DEFER | 기본 비활성 기능, 기존 테스트가 RED가 됨 |
| §3.2 snapshot `completion` | NECESSARY | 라이브 재현 2건 |
| §3.2 selection/source/environment/runId | DEFER | 사고 증거 없음 |
| §4.1 마지막 snapshot 채택(last-wins) | NECESSARY | 서브에이전트 파일에서 first-wins 과소집계 실측 |
| §4.1 나머지 계약 행 | DEFER (현 동작 유지) | 해당 이상값 0건 실측 |
| §4.2 단일 writer + 실패 의미 | NECESSARY | 두 실프로세스 경합 실측 |
| §4.2 잠금 transaction | PARTIAL | summarizeSession 저장 경로만 NECESSARY |
| §4.2 watermark/dedupe | DEFER | 중복 1건/42세션 |
| §4.3 라벨·문서 정정 | NECESSARY | |
| §4.3 kind/scope 필드 | DEFER | 10+ 테스트가 `totalTokens` 형태를 고정 |
| §4.4 skill 사전 읽기 off | NECESSARY (낮은 우선) | |
| §5 shadow 배선 | NECESSARY / PARTIAL | 관측 채널 정의 전까지 부분 |
| §5 enforce adapter | DEFER / 오너 | |
| §5 호스트 재프로브 | NECESSARY | 증거가 오래·좁음 |

### 0.2 오너 결정 필요 (권고 없음)

| # | 결정 |
|---|---|
| 1 | verification-discipline §11 완화(범위, 교차검수 문장·lint-staged·정지 측정 유지 여부). v5 설계 §3.7 "완화 0" 및 `plugins/artibot/CLAUDE.md#Existence Audit` 의 VD 전문 면제와 충돌 |
| 2 | `~/.claude/rules/artibot/` 오너 전역 규칙 편집(§2.4), 설치본의 모델 정책 문구 변경 포함 |
| 3 | SPEC_WARN+QUALITY_WARN → APPROVE(판정 완화)와 재검수 한도 |
| 4 | HG-12/13 설정 오류 fail-closed 정책(검수된 L1 설계 선택을 뒤집음, R-5에 없음)과 읽을 수 없는 config 처리(a/b) |
| 5 | shipped config에 `permissions.humanGates` 키 추가 여부 |
| 6 | coverage 4→1에서 Windows 임계값 신호 상실 수용 여부 |

### 0.3 가이드 밖에서 새로 확인된 결함

| 결함 | 위치 |
|---|---|
| 릴리스 대기 10분 vs Windows CI 13분 (issue #121, 수동 착지로 해소) | §3.0 |
| handoff-builder가 `failed=0`을 lint OK로 표시 | §3.2 |
| dev-verify-gate가 범위와 무관하게 snapshot을 결정적 PASS로 수용. 단 shipped config는 `devProtocol.verifyMode="advisory"`(비차단 additionalContext) | §3.2 |
| usage-receipt 서브에이전트 파일 first-wins 과소집계 + 거짓 코드 주석 2건 | §4.1 |
| 메모리 두 프로세스 데이터 유실 + 손상 store 덮어쓰기 + 저장 실패인데 `summarized:true` | §4.2 |
| 토큰 UI 오표기 + 거짓 문서 2건 | §4.3 |
| team.md 정의 없는 `[Cross-check Mode]` 표식 | §2.3 |

### 0.4 미확인

| 항목 |
|---|
| Windows coverage-off 시 소요 시간, coverage 오버헤드 단독 A/B |
| SKILL.md의 `!` 동적 문맥을 호스트가 실행하는지 |
| 23:47 sync가 실제로 무엇을 복사했는지 |
| 반복 전체 테스트·리뷰 루프의 실세션 빈도(원장에 없음) |
| stage-a/stage-b 테스트의 현재 그린 여부(읽기만 함, 실행 안 함) |
| 호스트 SessionEnd payload의 `project` 필드 |
| tracker-only 12세션의 원인 |
| snapshot 합계 62건 불일치 원인 |
| 호스트 2.1.287의 대화형 ask 동작 |
| `autopilot.execution.enabled:true`가 goal 모드 실행을 허용하는지 |
| last-wins가 청구 실측과 일치하는지(서버 청구 oracle 없음, 추론) |
| `session-aggregator.js#normalizeMetrics`의 `totalOutput` 입력이 `token-usage-session.json`에서 오는지(호출 경로 미추적) |
| v4.70.0~v4.71.1 릴리스 run 시점의 tag SHA == master SHA 여부(Actions 로그 미조회) |

## 1. 적용 순서와 범위

| 묶음 | 변경 내용 | 완료 기준 | 선행 조건 |
|---|---|---|---|
| 1. 운영 규칙 | 자동 전체 테스트·시간 채우기 제거, 리뷰 모드와 종료조건 정리, 활성 규칙 병합 | 작은 작업이 수락기준 달성 후 종료되고, 같은 검증을 리뷰어가 다시 실행하지 않음 | **없음이 아니다(정정, §0 참조):** Self-check 전환·code-reviewer 편집 전에 테스트 기준선 갱신 필요(`tests/firewall/constitution-stage-b*.test.js`, `constitution-stage-a-rules.test.js#A-8`). §2.4는 로드되는 플러그인 갱신 필요(`installed_plugins.json`: 로드 4.57.0 vs 소스 4.71.2, 설치된 agents/commands 사본이 소스와 다름, 설치된 tdd-workflow 사본은 있으나 4.57.0 시점 본이라 소스와 다름(플러그인 캐시 `~/.claude/plugins/cache/artibot/artibot/4.57.0/skills/tdd-workflow`와 `~/.claude/artibot/skills/tdd-workflow`, 재검수 실측 2026-10-05; 앞선 "사본 없음" 서술은 오류였다) — 나머지는 감사 보고 기준, 재열람 안 함) |
| 2. CI·증거 | coverage 계산 4환경→1환경(§0.1 **DEFER**, 오너 결정 6 이후), 4환경 테스트 유지, 결과 범위 표시, 릴리스의 같은 SHA 결과 재사용 | 필수 체크 이름·임계값 유지, 부분 결과의 전체 통과 오인 방지 | 1의 검증 정책 |
| 3. 런타임 정합성 | usage 집계 통일, SessionEnd 저장 소유자 통합과 잠금, 토큰 표시 정정, skill 사전 읽기 off(§4.4) | 두 소비자 집계 일치, 병렬 저장 보존, 추정치를 실측으로 표시하지 않음 | 다른 묶음과 독립 구현 가능 |
| 4. 안전 훅 연결 | 기존 안전 판정 코어를 기존 훅에 연결, shadow와 제한된 활성화 | 실제 호스트에서 deny/ask 동작 확인 후 선택적으로 enforce | 실제 호스트 계약 검증 |

1을 먼저 적용한다. 2와 3의 독립 영역은 병렬 구현할 수 있다. 4의 호스트 검증이 끝나지 않아도 1~3의 배포를 막지 않는다. 표의 항목마다 별도 팀·전체 테스트·승인 절차를 만들지 않는다. 변경 묶음이 안정된 통합 시점에 필요한 전체 검증을 실행한다.

**유지할 조건:** Phase 0 문제 검증, 작업 격리, 독립 검수, 최종 Phase 4.5 및 기존 v2 검수 산출물·claim_audit 계약, 보안 검사, 실제 실패의 차단, 커밋 대상 확인, 실패를 성공으로 표현하지 않는 원칙. 경제성을 이유로 coverage 임계값이나 보호 규칙을 낮추지 않는다.

## 2. 묶음 1 — 작업이 끝나면 검증도 끝나는 운영 규칙

### 2.1 검증 정책의 단일 기준 (A2)

정본은 `plugins/artibot/rules/verification-discipline.md`의 §11이다. 기존 다른 절을 통째로 재작성하지 않는다. §11의 모든 커밋 대상 전체 테스트·없는 빌드 명령 강제를 아래 문구로 대체한다.

**정정 — 대체 범위(§2.2 표와의 모순 해소):** 대체되는 것은 정확히 세 항목이다: `npx tsc --noEmit`, 커밋마다의 전체 vitest, `npm run prebuild`/`npm run build`. 새 §11 본문에 **그대로 유지해야 하는 것**: `git diff --cached --stat`(§7에도 있음), 경로 명시 add / `git add -A` 금지(§7에도 있음), lint-staged가 파일을 고친 뒤 커밋 상태로 게이트 재실행, 정지 확인 측정(§10.5(a) 참조 — 오너의 **설치본**에만 존재), 그리고 문장 "교차검수 + 최종 검수 — 자기 작업은 자기가 검수하지 않는다"(VD에서 자기검수 금지를 담은 유일한 문장이며, 빠지면 위 §1의 유지 조건과 충돌). "§11만 교체"(§2.2)는 이 범위의 교체를 뜻한다.

**도메인 진술:** "없는 빌드 명령"은 artibot repo에 대해 참이다(`package.json` scripts에 build/prebuild/typecheck/tsc 없음, 감사 보고 기준). 그러나 verification-discipline은 오너의 **전역** 규칙이고 TS/Next 스택용으로 쓰였다(§9에 next build·EXPLAIN·RLS 언급). 다른 스택 프로젝트에서의 적용은 이 문서가 검증하지 않았다.

**오너 결정 — 이 제안은 오너의 always-on 규칙을 완화한다.** (i) 아래 "증거 재사용" 문구는 설치본 §10.5(a)의 "트리 스냅샷이 다르면 버리고 재측정"보다 느슨하다. (ii) VD §6 "작업자 보고 + 내 재확인, 둘 다"와 긴장한다. (iii) `plugins/artibot/CLAUDE.md#Existence Audit`가 "verification-discipline 전문"을 면제하고 `.artibot/guides/v5-design/ARTIBOT-5.0-DESIGN.md` §3.7/A-8이 "완화 0"을 기록했는데, 이 가이드는 그 결정을 바꾼다. 이 문서는 찬반을 주장하지 않는다.

> 검증은 변경 위험도와 영향 범위에 맞춰 실행한다. 먼저 프로젝트에 실제로 존재하는 검사 명령을 확인한다. 없는 typecheck·prebuild·build 명령을 만들거나 다른 프로젝트의 체크리스트를 그대로 적용하지 않는다.
>
> 개발 중에는 변경 기능과 직접 소비자의 관련 검사를 실행한다. 작업 묶음을 완료할 때 기존 필수 통합 검사를 한 번 실행한다. 공유 런타임·설정·보안·의존성·테스트 실행환경이 변경되었거나 영향 범위가 불명확하면 전체 검사를 실행한다. 검사를 실행하지 않아도 되는 문서·주석 변경은 그 근거와 확인한 범위를 기록한다.
>
> 같은 코드·의존성·실행환경·명령 옵션에 대한 유효한 통과 증거는 검수자가 재사용한다. 커밋 생성이나 검수자 교체 자체는 재실행 사유가 아니다. 검증 후 파일이 바뀌면 영향을 받은 검사를 다시 실행하며, 영향 범위를 판단할 수 없으면 전체 검사를 실행한다. 필요한 원격 CI 게이트는 그대로 통과해야 한다.
>
> 관련 검사가 통과하고, 미해결 필수 결함·후속 변경·새로운 위험 근거가 없으면 작업을 종료한다. 정보·스타일 제안을 구현하려고 완료 범위를 늘리지 않는다. 부분 검증을 전체 검증으로 보고하지 않는다.

실행 선택은 다음처럼 적용한다. 각 행의 검사를 중복해서 더하는 체크리스트가 아니다.

| 변경 | 개발 중 | 통합 시점 |
|---|---|---|
| 일반 설명·주석 | 링크·렌더링·내용 대조 등 직접 필요한 검사 | 런타임 테스트 생략 가능. CI 기존 필수 조건은 유지 |
| 명령·스킬·리뷰 규칙 | 해당 구조 validator와 충돌 규칙 대조 | 실제 동작을 바꾸는 정책·프롬프트이면 관련 계약 검사도 실행 |
| 단일 모듈 로직 | 해당 모듈과 직접 소비자 테스트 | 영향이 좁으면 관련 검사 증거 사용, 요구되는 CI 실행 |
| 공용 런타임·훅·보안·의존성·검증 기반 | 관련 단위·경계 검사 | 전체 테스트·lint·해당 구조/eval 게이트 |
| 영향 불명확·새 실패 | 원인 범위를 좁히는 검사 | 원인이 해소된 뒤 필요한 전체 검사 |

새로운 작은 문서 수정 때문에 이미 통과한 런타임 테스트를 다시 돌리지 않는다. 반대로 보안·훅 동작을 바꾼 Markdown을 단순 문서로 분류하지 않는다.

### 2.2 수정 파일과 정확한 변경 (A1·A2·A4·A5)

이 절의 상대 경로는 저장소 루트 기준이다.

| 파일 | 적용할 변경 | 판정 |
|---|---|---|
| `plugins/artibot/rules/verification-discipline.md` | §11만 위 정책으로 교체(§2.1의 대체 범위·유지 항목 준수). 증거·스테이징·안전 관련 나머지 절 유지. `constitution-stage-a-rules.test.js#A-8`이 §13을 마지막 heading으로 요구하므로 heading 구조 유지 | 범위·완화는 오너 결정 |
| `plugins/artibot/skills/tdd-workflow/SKILL.md` (A1) | 동적 문맥의 `npm test … tail -5` 제거(`## Current State` 아래 `!` 줄, 존재 확인: 2026-10-05 grep). **줄만 제거하고 `## Current State` heading은 유지**(stage-b 기준선에 포함). 호스트가 SKILL.md의 `!` 동적 문맥을 실행하는지는 미확인(실행된다면 전체 스위트 1회, 감사 기록 ~317,884 ms). 기존 snapshot은 날짜·범위와 함께 참고로 읽고, 테스트는 변경 범위를 정한 뒤 실행 | NECESSARY (조건부) |
| 같은 TDD 스킬 — "REFACTOR 최소 5분" | **정정:** 이것은 규칙이 아니라 `## Common Rationalizations` 표의 반박 셀이며, 그 표 자체가 참고 자료이고 게이트가 아니라고 선언한다(SKILL.md의 해당 표 머리말). "삭제"가 아니라 **선택적 문구 완화**로 표기. 지워도 깨지는 것은 없다(anti-rationalization 테스트는 heading만 검사) | REJECT (삭제안), 문구 완화만 선택 |
| 같은 TDD 스킬 — Checkpoint→Self-check | 기술적 사실을 묻는 사람 체크포인트는 `testing-standards`의 Self-check 방식으로 전환. 요구사항·선호·실제 승인 질문은 유지. **주의:** `tests/firewall/constitution-stage-b.test.js`가 fail-closed로 22파일/66 체크포인트, unchanged 9 vs Self-check 13파일, 안내 문장 정확히 1회를 고정한다 → 같은 변경에서 분류 표를 갱신하지 않으면 RED (감사 보고 기준, 재열람 안 함) | DEFER (분류 표 동시 갱신 시에만 변경 목록에 포함) |
| `plugins/artibot/rules/test-patterns.md` (A5) | 권장 목표 / 로컬 게이트 / CI 게이트를 구분. 실제 게이트는 설정·validator를 참조하며 또 다른 숫자 정본을 만들지 않음 | NECESSARY |
| `plugins/artibot/commands/plan.md`, `plugins/artibot/commands/ultraplan.md` (A4) | 시간 밴드에 맞추려고 테스트·문서·하드닝을 추가하라는 지시 제거. 부족한 수락기준이나 확인된 위험이 있을 때만 범위 추가 | NECESSARY |
| `plugins/artibot/lib/planning/session-sizer.js` (A4) | 이번에는 API/enum 변경 없음. 기존 `recommendation: expand`는 추정 밴드 미달 정보로 해석하고 소비 명령에서 작업량 확대 의무로 사용하지 않음. **사실:** `SIZE_BANDS.quick`의 minHours가 0.5라 `--size quick`이어도 15분 작업이 `recommendation:'expand'`가 된다. `expand`의 소비처는 plan.md/ultraplan.md 문구와 테스트 1건뿐(JS 소비자 없음) → 문구 수정이 유일한 경로이고 session-sizer 무변경이 맞다(null-result 정당, 감사 보고 기준) | 무변경이 정답 |

CI 수치와 로컬 수치가 서로 다른 기존 의도는 유지한다. 테스트 파일 개수·coverage 숫자를 올리기 위한 신규 테스트는 만들지 않는다. 새 테스트는 깨질 때 사용자 동작·데이터·안전 계약의 결함을 식별해야 한다.

### 2.3 리뷰 구조와 종료조건 (A3)

`plugins/artibot/agents/code-reviewer.md`에 **Cross-check / Inspection** 모드를 명시한다. 기본값은 기존 Inspection이다. (현재 code-reviewer.md에는 `## Inspection Mode (Sub-Agent 검수)` 절만 있고 Cross-check 모드는 없다 — 2026-10-05 grep, 분리는 **아직 존재하지 않음**.) 판정: NECESSARY.

**하드 증거:** `commands/team.md`(~:336, 스폰 프롬프트 `prompt="[Cross-check Mode]…`)는 이미 `[Cross-check Mode]` 표식을 쓰지만 `agents/code-reviewer.md`는 이를 정의하지 않는다(dangling 표식, 2026-10-05 grep). 이는 "항상 위임" 규칙과도 충돌한다. 또 team.md는 검수 체크리스트를 "5개 항목"(~:361, ~:364)이라 하는데 code-reviewer.md의 Inspection 체크리스트 행 수는 6이라는 감사 보고가 있다(재열람 안 함) — 두 파일을 고칠 때 맞춘다.

| 모드 | 담당 범위 | 실행 방식 |
|---|---|---|
| Cross-check | 다른 작성자의 할당 변경, 직접 소비자와의 계약, 실제 회귀 | reviewer가 직접 검수. spec-reviewer/quality-reviewer 재위임 없음. 기존 증거 읽기 |
| Inspection | 최종 요구사항 충족, 통합 경계, 잔여 결함 | 기존 2단계 spec→quality 유지. 이미 확인한 변경·검증은 다시 실행하지 않고 증거 평가 |

`commands/team.md` Phase 4 스폰 프롬프트에 기존 `[Cross-check Mode]` 표식과 변경 파일·수락기준·검증 증거·검수 경계를 전달한다. 새 Agent 도구 인자를 추가하지 않는다. Phase 4.5는 유지한다. `code-reviewer.md`의 팀원 검수에도 항상 2단계를 적용한다는 문장, Stage 1 필수 QA 행, `## Anti-Patterns`의 충돌 규칙도 **Inspection에 해당**하도록 함께 고친다. **정정:** 충돌하는 것은 "마지막" Do NOT이 아니라 `## Anti-Patterns`의 **첫 bullet**(:254 "Do NOT review code directly — always delegate to spec-reviewer and quality-reviewer")이며, :255 "Do NOT skip Stage 1…"·:256 "Do NOT proceed to Stage 2 if Stage 1 returns SPEC_FAIL…"도 충돌한다(2026-10-05 열람, 줄번호는 썩음). 마지막 bullet은 무관하다. 첫 문장만 추가해 하단 규칙과 충돌시키지 않는다. 이 편집은 stage-a/stage-b 테스트 기준선 갱신이 선행된다(§1).

판정은 경고의 개수가 아니라 결함으로 결정한다.

- `SPEC_WARN + QUALITY_WARN` → 필수 결함이 없으면 `APPROVE`와 권고사항. **[오너 결정 · 판정 DEFER — 판정 완화]**
- 요구사항 미충족·데이터 유실·보안 우회 등 필수 결함은 근거와 함께 FAIL로 분류한다. WARN으로 이름을 바꿔 통과시키지 않는다.
- 작성자 자신을 독립 검수자로 배정하지 않는다. 검수자의 직접 실행은 기존 증거가 부족하거나 새 결함을 재현해야 할 때만 한다.

**재검수 한도:** 최초 검수 이후 수정→재검수는 같은 작업 묶음에서 최대 2회. 첫 결과에서 필수 결함을 모아 전달하고 이후에는 수정분·회귀·아직 열린 결함만 본다. 에이전트를 다시 생성해도 회수는 초기화하지 않는다. 같은 결함이 반복되거나 한도에 도달하면 **실패 상태를 유지**하고 원인 분석·범위 재계획으로 전환한다. 자동 승인하지 않으며 단순히 회수 소진을 이유로 사용자에게 확인을 요구하지 않는다. 새 상태 파일 없이 기존 작업 기록에서 관리한다.

**검수 반영 (판정 DEFER / 오너 결정):** 기존에 "최대 2회" 한도는 어디에도 없다(관련 없는 clarify 스킬 한 줄 제외, 감사 보고 기준). "기존 작업 기록에서 관리"는 파일·필드를 지정하지 않았다 → 어느 기록의 어느 필드인지 정하기 전에는 구현 불가. 지정하거나 DEFER로 둔다.

재계획·작업 분할도 동일 수락기준의 수정 회차를 초기화하지 않는다. 한도 소진 후 동일 결함이 남으면 해당 묶음의 자동 수정을 중단하고 실패·근거·남은 작업을 보고한다. 독립된 다른 묶음은 계속할 수 있다. 단순한 에이전트 재호출을 원인 분석이라고 바꿔 부르지 않는다.

### 2.4 소스 변경이 실제 활성 규칙에 도달하도록 하기 (A2·A5)

감사 당시 `agent-coordination`, `dev-protocol`, `verification-discipline`의 소스와 설치본이 달랐다. `.artibot-new`는 적용 완료를 뜻하지 않는다. 판정: NECESSARY (단 2단계는 오너 파일 편집 — 오너 결정).

**감사팀 실측(2026-10-05, 감사 보고 기준 — 이 문서 작성자는 재열람 안 함):**

| 항목 | 사실 |
|---|---|
| 설치본 VD | §10.5 (a)~(e)와 9번째 §11 항목(정지 확인 측정)이 있고 소스에는 없음. 반대로 **소스**에는 `## 13. 충돌 기록 우선순위`가 있고 설치본에는 없음. `constitution-stage-a-rules.test.js#A-8`은 §13이 마지막 heading일 것을 요구 → 양방향 병합 필요 |
| 설치본 agent-coordination | 옛 2티어 fable 문구(`fable.enabled=true`). 소스와 라이브 config는 단일 티어 opus(`fable.enabled=false`, phaseRoles opus/opus) → 병합하면 "정책 불변"이어도 **모델 문구가 바뀐다** |
| dev-protocol | 소스에만 있는 한 줄 차이 |
| `.artibot-new` | `~/.claude/rules/artibot/`에 3개, 소스와 byte 동일, 2026-10-04 23:47 작성. 설치기는 사용자 수정 파일을 유지하고 새 버전을 옆에 둔다(이미 참, 변경 불요) |
| 로드된 플러그인 | `installed_plugins.json`: artibot 4.57.0 로드 vs 소스 4.71.2. 설치된 agents/commands 사본이 소스와 다름. 설치된 tdd-workflow 사본은 있으나 4.57.0 시점 본이라 소스와 다름(플러그인 캐시 4.57.0과 `~/.claude/artibot/skills/`, 재검수 실측 2026-10-05) |
| `npm run sync:local` | agents/commands를 복사하는지 **미확인**(23:47 sync는 rules/config/install.sh를 건드렸으나 agents/commands 사본은 2026-09-09 날짜 그대로) |

1. 소스 변경을 먼저 확정한다.
2. 설치된 `~/.claude/rules/artibot/`의 해당 세 파일과 새 소스를 내용 단위로 병합한다. 설치본에만 있는 §10.5 등의 안전 지침은 보존한다. **이 단계는 오너의 비공개 전역 지침 파일을 편집하므로 오너의 명시적 승인이 필요하다.**
3. 실제 활성 파일에 §11 새 정책·리뷰 정책이 존재하고, 예전 강제 지시가 남지 않았는지 확인한다. 모델 정책은 이번 설계로 변경하지 않는다(위 표처럼 병합이 모델 문구를 바꿀 수 있음을 승인 시 알린다).
4. 수정한 commands·agents·skills도 정상 플러그인 갱신 경로로 반영하고 실제 로드되는 설치본을 확인한다. 규칙 세 파일만 병합하고 TDD·리뷰 수정까지 반영됐다고 판단하지 않는다. (위 표: 로드 4.57.0 vs 소스 4.71.2가 실측된 현재 상태다.)

`plugins/artibot/install.sh`와 `plugins/artibot/install.ps1`의 사용자 수정 보존 동작은 유지한다. 자동 3-way updater나 전역 파일 일괄 덮어쓰기는 이번 범위에서 제외한다. 소스 개선 후 활성 설치본 병합까지 해야 사용자가 체감하는 반복 검증이 줄어든다.

## 3. 묶음 2 — CI 비용 절감과 검증 증거의 정직한 범위

이하 `lib/`, `scripts/`, `schemas/`, `tests/`, `hooks/`, `commands/`, `artibot.config.json` 경로는 별도 표시가 없으면 `plugins/artibot/` 기준이다. `.github/workflows/`는 저장소 루트 기준이다.

### 3.0 (신규, 가이드 밖) 릴리스 대기창이 Windows CI보다 짧다 — 판정 NECESSARY P1

감사 보고서는 "원격 Actions 실행 미확인"이라 적었고 이 결함을 놓쳤다. 감사팀 실측(2026-10-05 KST, 감사 보고 기준 — 이 문서 작성자는 Actions를 재조회하지 않음):

| 사실 | 값 |
|---|---|
| `release.yml`의 `wait_for_green` | 40회 × 15 s = 10분에서 포기, Windows 포함 모든 check run을 집계. 설계 근거는 2026-08-15 측정(matrix wall 3m33s)이며 주석이 `release.yml` ~:779에 있음(열람 확인: 2026-10-05 grep, 줄번호는 썩음) |
| CI `Validate (Node 22) on Windows` | 약 13분 (run 37211594759: job 13m17s, coverage-test step 10m19s; ci/release run 13m25s; v4.71.1 13m18s) |
| 마지막 성공 배지 착지 | v4.66.0, 9m59s |
| 2026-10-04 v4.71.2 | 배지 동기 착지 실패: issue #121 생성, 브랜치 `ci/sync-badges-v4.71.2` 잔존. 2026-10-05 00:40 KST에 수동 fast-forward로 착지(master `bc98327a`→`5a3bb327`, Windows 완료 후 7/7 checks success), #121 종료 |

대기창은 그대로이므로 재발한다. 선택지(추론, 미측정): 상한 상향 / 필수가 아닌 Windows를 대기에서 제외 / coverage 없는 Windows A/B(**미측정**). 어느 쪽이든 §3.1의 coverage 변경 판단과 연결된다.

### 3.1 CI: 전체 실행 환경은 유지하고 coverage 계측만 한 곳으로 (B1·C4) — 판정 DEFER

주 수정 대상은 저장소 루트 `.github/workflows/ci.yml`이다. 플러그인 내부의 동명 파일은 루트 Actions의 실행 경로가 아니다. 독립 배포용 복사본을 동기화해야 한다면 동일 정책만 반영하고 별도 검증 경로를 늘리지 않는다.

| 환경 | 전체 테스트 | coverage + 임계값 검사 | 기존 lint·구조·runtime eval |
|---|---|---|---|
| Linux Node 22 | 유지 | 유지 | 유지 |
| Linux Node 20 / 24 | 유지 | 생략 | 유지 |
| Windows Node 22 | 유지 | 생략 | 유지 |

**'CI 비용' 재서술 (감사팀 실측 2026-10-05, run 37211594759, 감사 보고 기준):** repo는 PUBLIC이라 Actions 과금이 없다. coverage step 소요: Node 20 5m05s / 22 5m38s / 24 5m29s / Windows 10m19s; job 총계 7m42 / 8m13 / 7m59 / 13m17. Node 22/24가 required이고(`gh api repos/Yoodaddy0311/artibot/branches/master/protection` 실측 2026-10-05: Validate (Node 22)·(Node 24)·plugin.json 구조 2개, strict) 이미 Windows보다 약 5분 빠르므로 required-green wall-clock은 거의 변하지 않는다 — 절감은 **러너 분 단위뿐**이다(추정: 3개 leg × 1.5~3분, reporter·cache를 통제한 A/B가 아님; Windows의 coverage 외 시간은 **미측정**). 또 Windows coverage를 끄면 유일한 Windows 임계값 신호가 사라진다(현재 Windows coverage 리포트는 업로드되지 않고 Windows는 required가 아님) — **오너 결정**.

**fail-open 위험:** 조건부 step은 자기 게이트를 끌 수 있다 — ci.yml은 과거 shell `if [ -d tests ]` 가드가 테스트 0회로 녹색을 허용하던 형태를 제거했다(`ci.yml` ~:137-150 주석; 그 가드는 workflow `if:` 쌍과 다른 기제이므로 유비일 뿐이다). 상호 배타적 `if:` 쌍은 식 하나가 틀리면 두 step이 모두 건너뛰어진 채 녹색이 될 수 있다. 구현하려면 `tests/firewall/workflow-branch-lockstep.js`의 expander로 matrix를 전개해 4개 조합 각각에서 두 테스트 step 중 정확히 하나만 참임을 단언하는 테스트를 요구한다. 현재 테스트 중 ci.yml step 본문·concurrency·artifact 이름을 고정하는 것은 없다(lockstep은 push.branches + job 이름/matrix ⊇ required 4를, marketplace-version-sync는 cache-dependency-path를 고정).

구현 시 테스트 step을 Linux 22 coverage / 나머지 일반 실행으로 상호 배타적으로 분기한다. `matrix.os`와 `matrix.node-version`을 모두 조건에 포함한다. 어느 환경도 테스트 0회로 녹색이 되지 않도록 한다. `Validate (Node …)` 이름, Windows suffix, 기존 required checks, coverage 임계값, `runtime-evals-node-22`와 `coverage-report-node-22` artifact 이름은 유지한다.

각 테스트 명령은 verbose와 기존 `./tests/reporters/test-status-reporter.js`를 함께 사용한다. 예: `npx vitest run --reporter=verbose --reporter=./tests/reporters/test-status-reporter.js`; Linux 22에만 `--coverage`를 추가한다. 별도로 `npm test`를 한 번 더 실행하지 않는다.

**concurrency — 판정 REJECT (현재):** 최근 ci run 20개가 20/20 `push`, `pull_request` 0건이라 취소할 것이 없다(감사팀 실측 2026-10-05). push/dispatch의 run_id 그룹 안전성은 정적 추론이며 라이브로 실행하지 않았다. 아래 YAML은 가이드 고유 제안이다.

중복 PR 실행 취소는 아래와 같이 **PR에만** 적용한다. push/수동 실행은 run_id로 구분해 서로 취소하거나 큐에서 밀어내지 않는다. `ci/**` SHA를 기다리는 기존 landing 흐름을 보존한다.

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.run_id }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

**`--ignore-scripts` fallback — 판정 NECESSARY (한 줄):** 위치는 `ci.yml` :102와 `self-control.yml` :98(2026-10-05 grep). `release.yml` :82/:520은 이미 `|| npm install --ignore-scripts`를 쓴다 → **현재 두 정책이 공존**한다. 가이드는 하나를 골라 명시해야 한다(아래는 fallback 제거안).

`npm ci --ignore-scripts || npm install`은 `npm ci --ignore-scripts`로 바꿔 설치 실패를 그대로 알린다. fallback으로 lifecycle scripts를 다시 허용하지 않는다. 같은 패턴의 self-control workflow도 같이 수정하되 action 버전·권한·배포 흐름을 불필요하게 바꾸지 않는다.

### 3.2 테스트 snapshot v2: 먼저 범위를 표시하고 자동 생략은 하지 않음 (B3)

**판정 분할:** `completion` 부분(`reason`과 `unhandledErrors.length`를 둘 다 읽고 미완료를 센다) = **NECESSARY**. selection/source/environment/runId = **DEFER**(사고 증거 없음; 원장의 라이브 전체 통과 PASS 1건은 878모듈 전체 실행이었고, 지시 표면이 필터된 `npm test`를 돌리는 경우는 없음). §3.2.6의 deterministic-source 수정은 completion에 의존하므로 함께 출하한다. (감사팀 판정, 2026-10-05)

수정 대상:

- `plugins/artibot/tests/reporters/test-status-reporter.js`
- `plugins/artibot/lib/core/test-status.js`
- `plugins/artibot/lib/verification/deterministic-source.js`
- 관련 reporter/consumer 테스트와 결과를 표시하는 소비처

기존 8개 필드와 의미를 유지하며 아래 정보를 추가한다. **아래 구조는 제안 API**이며 기존 구현을 설명하는 것이 아니다.

```text
schemaVersion: 2
runId: 실행마다 고유한 값
source: { headShaAtStart, headShaAtEnd, cleanAtStart, cleanAtEnd }
selection: { kind: "full" | "targeted" | "unknown", collectedFiles, filters }
environment: { node, platform, arch, vitestVersion, configHash, lockHash }
completion: { reason, unhandledErrorCount, unfinishedCount }
```

범위는 파일 개수가 아니라 실행 옵션과 Vitest 실행 문맥으로 판단한다. **정정(감사팀 실측, 설치된 Vitest 4.0.18, 2026-10-05):** `onInit(vitest)`는 존재하나 그 시점에 CLI 경로 필터는 **얻을 수 없다**(`config.filters`는 선언만 되고 채워지지 않으며, `vitest.filenamePattern`은 onInit 이후에 할당되고 공개 타입에 없음). 수집된 파일은 `onTestRunStart(specifications)`에서 얻는다. 경로 필터는 `unknown`으로 분류하고, config에서 읽을 수 있는 것은 testNamePattern·related·changed·project·shard다. Vitest API에서 의미가 확실하지 않은 값은 추측하지 않는다. `onTestRunEnd(testModules, unhandledErrors, reason)`가 존재하고 reason ∈ passed|interrupted|failed이지만 **reason은 unhandledErrors를 반영하지 않는다 → 둘 다 기록한다.** todo/pending/정체불명 상태를 passed에 포함하지 않는다.

**라이브 재현(스크래치 마이크로 스위트, ASCII 경로, 감사팀 2026-10-05 — 재측정, 본 문서 작성자가 재현하지 않은 감사팀 측정치):** 아래는 vitest 4.0.18 + 실제 reporter 사본으로 만든 격리 마이크로 스위트 결과이며, `beforeAll` throw는 **배치 위치에 따라 갈린다**(초판의 "beforeAll throw → failed:0"은 `describe` 안쪽 배치에만 해당하므로 정정).

| 케이스 | vitest exit | snapshot | 판정 |
|---|---|---|---|
| `describe` 안쪽 `beforeAll` throw | 1 | total 3 / passed 0 / failed 0 / skipped 3 | 합성 exitCode 0 → PASS (불일치) |
| 파일 최상위 `beforeAll` throw | 1 | failed 1 | FAIL (불일치 없음) |
| unhandled rejection | 1 | passed 1 / failed 0 | PASS (불일치) |
| 타이머 uncaught exception | 1 | (감사 보고에 snapshot 수치 없음) | PASS (불일치) |
| `afterAll` throw | 1 | (감사 보고에 snapshot 수치 없음) | PASS (불일치) |
| 수집 오류만 있는 실행 | 1 | total 0 / failed 1 | UNMEASURED (FAIL 아님) |
| 수집 오류 + 통과 파일 동시 | 1 | total 1 / passed 1 / failed 1 | FAIL (불일치 없음) |
| 실패한 테스트 | 1 | failed ≥ 1 | FAIL |
| 선언된 skip+todo만 | 0 | — | PASS (불일치 없음) |

exit 1이었던 8케이스 중 PASS 4 · UNMEASURED 1 · FAIL 3. **손으로 만든 케이스에서의 도달 비율이지 실제 세션의 발생률이 아니다.**

**현재 구현 사실(감사 보고 기준, 재열람 안 함):** 현 reporter는 8개 키(timestamp, durationMs, modules, totalTests, passed, failed, skipped, failedFiles)를 mkdirSync+writeFileSync로 쓴다(**원자적 아님**). 원자 유틸 `lib/core/file.js#atomicWriteJsonSync`는 있으나 `tests/reporters/test-status-reporter.test.js`가 reporter 파일 하나만 임시 root에 복사하므로 reporter에서 `../../lib/...`를 import하면 그 하네스가 깨진다 → inline tmp+rename / 주입 writer / 하네스 변경 중 선택. 같은 테스트가 **정확히 8개 키**를 고정한다(필드를 추가하면 RED). `tests/verification/deterministic-source.test.js`는 REASONS 길이 6 + 해시 인라인 스냅샷 7개 + 정확한 evidence-note 문자열을 고정한다.

`unfinishedCount` 정의(감사팀): `options.mode==='run'`이면서 결과 state가 passed/failed가 아닌 테스트 수이며, 선언된 skip/todo는 따로 센다. 정직한 공백: 현재 실제 snapshot의 totalTests 26574 vs passed 26464 + skipped 48 → **62건이 설명되지 않는다**(원인 미확인, 마이크로 스위트에서 재현 못 함).

`cleanAtStart/End` 정의: 이 repo는 항상 untracked 항목이 있어 '깨끗함'이 로컬에서 늘 false가 된다 → tracked만(`--untracked-files=no`)인지 `??` 포함인지 정의해야 한다. git 비용(Node execFileSync 실측, 감사팀): rev-parse 19~24 ms, status --porcelain 40~67 ms(4회 ≈ 100~200 ms vs 전체 실행 ~317,884 ms); git 아닌 컨텍스트는 exit 128 → null.

`unfinishedCount`는 실제 실행 완료 여부를 확인할 수 없는 테스트 수다. 의도적으로 선언된 skip/todo와 실행 중단을 구분한다. 선언된 todo가 존재한다는 이유만으로 기존 성공 실행 전체를 실패로 바꾸지 않으며, 그 사례를 passed로 세지도 않는다.

소비 규칙:

1. v1은 계속 읽되 “범위 미확인”으로 표시한다. 파일 수가 많다고 full로 승격하지 않는다.
2. v2 targeted는 “부분 검증”, unknown은 “범위 미확인”으로 표시한다. clean/SHA 정보를 얻지 못하면 null/unknown으로 표현한다.
3. `failed=0`을 프로세스 exit 0·coverage 통과·lint 통과·`npm run ci` 전체 통과로 확대 해석하지 않는다. reporter는 이러한 최종 상태를 증명할 수 없다.
4. 실행 전후 dirty이거나 SHA가 달라졌다면 현재 변경 전체의 통과 증거로 재사용하지 않는다. 시작·끝 clean도 실행 중 변동이 없었다는 완전한 증명은 아니므로 **이 v2만으로 테스트를 자동 생략하지 않는다.**
5. snapshot 쓰기는 기존 원자적 파일 저장 유틸을 사용한다. 실패 시 테스트 결과를 바꾸지는 않지만, 오래된 snapshot의 날짜/runId를 현재 실행처럼 표시하지 않는다.
6. `deterministic-source.js`의 현재 `failed===0 → exitCode:0` 처리를 그대로 두지 않는다. v2의 중단·미처리 예외·실행 미완료는 failed=0이어도 PASS로 변환하지 않는다. 확인된 테스트 실패/미처리 실행 오류는 실패로, 중단·범위/완료 미확인은 기존 UNMEASURED 표현(합성 exitCode 생략)으로 전달한다. 전체 성공이 필요한 판단에 targeted·unknown·v1을 전체 PASS 증거로 공급하지 않는다. 관련 사유와 범위는 결과 표시에도 남긴다.

**dev-verify-gate 모드(본 문서 작성 시 직접 열람, 2026-10-05):** shipped `plugins/artibot/artibot.config.json#devProtocol.verifyMode`는 `"advisory"`다. `scripts/hooks/dev-verify-gate.js#loadVerifyMode`가 `resolveConfigPath('artibot.config.json')`로 읽은 config를 `lib/core/dev-verify-output.js#resolveDevVerifyMode`에 넘기며(환경변수 `ARTIBOT_DEV_VERIFY_MODE` 우선, 읽기 실패 시 기본값 `enforce`), advisory에서는 `decision:"block"` 대신 `{suppressOutput:true, hookSpecificOutput:{hookEventName, additionalContext}}`를 낸다. 즉 이 게이트의 snapshot PASS 수용 결함은 shipped 설정에서는 **차단이 아니라 비차단 안내**에 영향을 준다. 미확인: 특정 머신에서 hook이 실제로 어느 config 사본을 읽는지(플러그인 캐시/설치본/repo)와 그 사본의 값. 추론(실행 안 함): `getChangedFiles`는 `git diff --name-only -z HEAD`와 `--cached`만 보므로 untracked 파일만 새로 만든 턴은 변경 파일 0건으로 잡힌다.

**변경 목록에 추가할 하드 증거(감사 보고 기준, 재열람 안 함):** `lib/handoff/handoff-builder.js#renderStateTable`(~:653-656)이 `lintCell = summary.failed === 0 ? 'OK' : '(check)'`로 테스트 failed=0을 lint OK로 표시한다(위 소비 규칙 3의 라이브 사례). `scripts/hooks/dev-verify-gate.js#recordVerifyDenominator`는 snapshot을 범위와 무관하게 결정적 PASS로 수용한다. snapshot의 런타임 소비처: `session-start.js#appendTestStatus`(failed>0일 때만 경고), handoff-builder, dev-verify-gate, `commands/save.md`. 소비처가 **아닌** 것: statusline, doctor, tdd-workflow SKILL(`!` 줄이 npm test를 새로 실행), /verify.

범용 fingerprint 계산·의존성 그래프 기반 테스트 선택·자동 캐시 엔진은 이번 업데이트에 넣지 않는다. 검수자가 실행 명령·작업 범위·결과를 재사용하는 정책과, 다음 릴리스의 좁은 artifact 재사용이면 먼저 줄일 수 있는 낭비가 충분하다.

### 3.3 릴리스: 같은 실행·같은 소스의 결과만 재사용 (B2) — 판정 NECESSARY

대상 `.github/workflows/release.yml`. 현재 validate는 tag를, sync-readmes는 master를 checkout하므로 두 SHA가 같다고 가정하면 안 된다. (validate=tag / sync-readmes=master는 §3 검수자가 확인: `release.yml` ~:63-66 / ~:255-260, 감사 보고 기준.)

**감사팀 실측(2026-10-05, 감사 보고 기준):** sync-readmes는 `ref: master`를 checkout하고 **두 번째** 전체 `npx vitest run --reporter=json`으로 테스트를 센다(4.71.2에서 ~2m43s, 4.71.1에서 2m48s; validate 자체 테스트는 3m59s/3m21s). v4.71.2에서는 **tag SHA == master SHA**(`bc98327a`, 릴리스 직후 `git rev-parse v4.71.2^{commit}`과 `origin/master` 비교, 2026-10-04)였다. v4.70.0~v4.71.1에서도 같았는지는 **미확인**이다(태그 이후 master 이력만 봤고 릴리스 run 시점 SHA는 조회하지 않았다. 릴리스 뒤 배지 동기화 커밋이 master에 붙으므로 — v4.71.2의 `5a3bb327` — "다음 커밋이 fix"라는 근거는 쓰지 않는다). 이 repo의 릴리스 절차(RELEASE.md: 착지한 SHA에 태그)상 두 SHA가 같은 것이 정상 경로이므로 재사용이 매 릴리스에서 발화할 수 있다(추론).

**선행 조건:** validate에 `if [ -d "tests" ]` guard(`release.yml` ~:139)가 남아 있어 테스트 0건이 녹색으로 통과할 수 있다 → manifest 완결성에 의존하기 전에 제거한다. **대안 설계(추론, 미측정):** artifact+manifest 대신 SHA를 job `outputs:`로 넘기고 개수를 센다(needs 체인 validate→release→sync-readmes). `badge-stall-sync-order.test`는 step **순서**(Count < Sync marketplace < Sync README prose < Decide landing)만 고정한다.

1. validate의 기존 전체 테스트 1회에 JSON reporter 출력을 추가한다. 실제 프로세스가 끝난 뒤 결과 파일과 manifest를 같은 workflow run의 artifact에 보관한다.
2. manifest에는 schemaVersion, 실제 `git rev-parse HEAD`, run id/attempt, Node·OS·Vitest 버전, full 범위 여부, 완료 여부와 실제 exit code를 기록한다. 테스트 파일 개수를 테스트 케이스 수로 쓰지 않는다.
3. artifact 이름은 예를 들어 `release-tests-${{ github.run_id }}-${{ github.run_attempt }}`처럼 이번 실행을 특정한다. JSON의 count와 manifest를 모두 검사한다.
4. sync-readmes는 README나 버전 파일을 수정하기 **전** checkout의 실제 SHA를 얻는다. SHA·실행 환경·범위·완료·성공이 일치하는 유효한 artifact이면 기존 test count 생성 단계에서 재사용한다.
5. 다른 SHA, 누락·손상 artifact, 실패·중단·부분 실행이면 현재의 전체 테스트 기반 count fallback을 사용한다. fallback도 실패하면 기존 수치를 유지하고 불확실성을 남긴다. 0이나 추정값으로 바꾸지 않는다.
6. count → marketplace/badge → README prose 순서와 현재 informational failure 정책은 유지한다. 성공 여부와 수치 집계의 의미를 바꾸지 않는다.

이 재사용은 master와 tag가 다른 릴리스에서는 실행 횟수를 줄이지 못한다. **정정:** 이 repo에서는 v4.71.2에서 두 SHA가 같았고(위 실측; 이전 릴리스는 미확인) 릴리스 절차상 같은 것이 정상 경로이므로 재사용이 매 릴리스 발화할 수 있다(추론). 안전하게 재사용할 수 있는 경우에만 절약한다. 테스트를 세기 위한 추가 독립 실행·다른 SHA에서 온 “마지막 성공값” 사용은 금지한다.

### 3.4 Autopilot 검증의 대기 상한 (B4, 가이드 고유 제안 일부) — 판정 DEFER

**검수 반영:** `goal-evaluator.js`의 기본 runner는 `execSync(command,{encoding,stdio})`로 cwd/timeout이 없다(확인). 그러나 `tests/autopilot/goal-evaluator.test.js`(~:65)가 `toHaveBeenCalledWith('echo ok')`(단일 인자)를 단언하므로 둘째 options 인자를 추가하면 RED가 된다 → 그 테스트 변경을 목록에 넣는다. "기본 비활성"은 **부분적으로만 참**이다: 최상위 `autopilot.enabled=false`, `suggest.enabled=false`이나 `autopilot.execution.enabled=true`다(consent-gate가 소비; goal 모드가 실제로 실행 가능한지는 **미확인**). "초기 제안 10분"은 측정 근거가 없는 임의의 초기값이다.

`lib/autopilot/goal-evaluator.js`의 기본 runner에 작업 cwd와 유한 timeout을 전달하고 `goal-loop.js` 호출부까지 연결한다. 기존 DI runner의 첫 인자(command)는 유지하고 options를 선택적인 둘째 인자로 확장한다. 남은 작업 예산이 없으면 실행하지 않고 미충족으로 반환한다. 예산이 없던 호출에는 문서화한 기본 상한을 둔다(초기 제안 10분, 실제 운영 시간에 따라 조정).

timeout·실행 실패·경로 불명확 상태를 `met=true`로 만들지 않는다. 지원 환경에서 하위 프로세스 정리가 가능한지 확인하고, shell timeout만으로 전체 process tree가 반드시 종료된다고 주장하지 않는다. 이번 단계에서 VERIFY/EVALUATE를 통째로 합치거나 EVALUATE를 제거하지 않는다. IMPROVE가 코드를 바꿨다면 재검증이 필요하다. 기본 비활성 기능이므로 주요 경제성 개선과 분리 가능한 후순위다.

## 4. 묶음 3 — 정확한 비용과 안전한 메모리

### 4.1 비용: 동일 요청의 마지막 유효 snapshot을 공통으로 사용 (C1)

**판정:** **한 행만 NECESSARY** — 같은 requestId에 누적 snapshot이 여러 개이면 **마지막**을 채택. 아래 계약 표의 나머지 행은 DEFER / "현 동작 유지": 파손된 마지막 행, 비정수·음수 값, requestId 누락, timestamp 누락, 모델 충돌은 83,453행 / 35,401그룹에서 **0건** 실측됐다(감사팀 2026-10-05).

**실측 증거(감사팀 2026-10-05, 프로젝트 5개, 메인 37 + 서브에이전트 327 transcript, 통계만 읽고 내용은 읽지 않음):**

| 항목 | 값 |
|---|---|
| 메인 파일 다행 그룹 | 6,831/6,831 byte 동일 |
| 서브에이전트 파일 다행 그룹 | 18,732 중 11,178(59.7%)이 서로 다름, 모두 last>=first output이고 단조 비감소 |
| output 토큰 first-wins vs last-wins | 합계 17,202,446 vs 38,964,169 (first-wins = last-wins의 44.1%; 서브에이전트 파일만 5.30배) |
| input/cache 필드도 증가한 그룹 | 120개 (cache_read +24.06M) |
| 실제 `buildUsageReceipts` vs 독립 last-wins, 세션 4030d1a1 | output 309,509 vs 379,011 (1.225배), 비용 $86.80 vs $89.40 (+3.0%) |
| 같은 비교, 세션 a1399ab2 | output 102,858 vs 141,403 (1.375배), 비용 $28.92 vs $30.77 (+6.4%) |

메인 스레드 run은 정확히 일치하고 차이는 전부 서브에이전트 run에서 나며 요청 수는 같다. 이로써 v4.71.2 CHANGELOG의 '미측정'("이 세션 합산은 1.22배" = 4030d1a1의 1.225배)이 닫힌다(CHANGELOG는 수정하지 않음). 단 "마지막 행이 진짜 값"은 서버 청구 oracle이 없어 **추론**이다.

**현재 동작(계약 표의 "제외" 서술 정정):** receipt는 잘못된 숫자를 0으로 바꾸고 `estimate`로 강등한다("제외"가 아님); census는 요청 전체를 제외한다; 모델 충돌 시 receipt는 **첫 행의 모델을 조용히 유지**한다(`tests/economics/usage-receipt.test.js` ~:530-535는 dedup 1건·`duplicateRequestIds` 1만 단언하고 어느 모델이 남는지는 단언하지 않는다 — 바꿔도 그 테스트는 그린이라 회귀 방지 장치가 아니다; 바꾸는 것은 결정); `(runId, requestId)` 키는 receipt가 이미 그렇게 동작한다; requestId 없는 행은 두 소비자 모두 이미 개별 유지한다; 커버리지 카운터(entries, duplicateRequestIds, entriesWithoutRequestId, parseFailures, coverage)는 이미 있다.

**구현 주의:** `foldUsage`는 즉시 더하므로 run이 끝날 때까지 (run, requestId)별 최신 snapshot을 보관하거나 replace-and-subtract 해야 한다.

**이 데이터에 비춰 거짓인 코드 주석 2건(보고만, 수정 안 함):** `usage-receipt.js#foldEntry`의 "repeat the same usage object verbatim"(서브에이전트 그룹 59.7%에서 거짓), `context-roi-census.mjs` 헤더의 "input/cache fields repeat"(120그룹에서 증가). 부수 발견(범위 밖, 보고만): 모든 usage 행이 `cache_creation:{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`를 갖고 있어 usage-receipt 헤더의 "no TTL → lower bound" 주장은 이 호스트 버전에서 더는 참이 아니다.

기존 `lib/economics/usage-receipt.js`와 `scripts/evals/context-roi-census.mjs`의 서로 다른 중복 제거를 하나의 순수 reducer로 통합한다. 제안 신규 파일은 `plugins/artibot/lib/economics/request-usage.js` 한 개다. 파일 읽기·가격표·UI를 이 모듈로 옮기지 않는다.

공통 계약:

| 입력 상황 | 집계 방식 |
|---|---|
| 같은 run의 같은 requestId에 누적 snapshot 여러 개 | 마지막 유효 snapshot 1개 채택. 행들을 합산하지 않음 |
| 마지막 행이 파손되거나 값이 비정상 | 앞의 유효한 행 보존, 불완전함 표시. 조용히 완전한 실측으로 승격하지 않음 |
| requestId 누락 | 근거 없이 합치지 않고 개별 기록으로 유지. ID 누락 수 별도 표시 |
| 모델 이름 별칭 | 기존 alias 정규화 후 비교 |
| 같은 요청에서 정규화 후에도 모델 충돌 | 충돌 표시, 해당 요청의 확정 모델별 비용 귀속에서 제외. 임의 모델 선택 금지 |
| 음수·NaN·Infinity·잘못된 타입 | 유효 실측에서 제외. 필드 누락과 0을 구분 |
| timestamp 없음 | 시간·latency는 unknown. 0ms를 만들어 넣지 않음 |

키는 가능한 경우 `(runId, requestId)`다. caller가 이미 run 단위로 읽는 경우 그 경계를 넘겨야 한다. 파일이 섞였다는 이유만으로 서로 다른 run의 요청을 합치지 않는다. 순서는 입력의 원래 관측 순서를 유지한다. 누적 snapshot이라는 현재 관측 계약을 지원하며, 미래의 delta 형식은 명시적인 입력 타입/adapter 없이 같은 방식으로 처리하지 않는다.

완전성은 input/output/cache-read/cache-creation 네 필드의 존재·유효성으로 판단한다. 0은 유효하지만 누락은 0이 아니다. 부분 정보로 계산한 금액은 estimate/partial로 남긴다. 중복 제거 전 행 수·요청 수·중복 수·불완전 수를 구분해 coverage를 계산한다. 시간 범위는 해당 요청의 유효 관측 timestamp 최솟값/최댓값을 사용하되 실제 서버 latency로 과장하지 않는다.

unknown/partial은 reducer 내부 상태다. 영수증 출력에서는 부분 사용량을 기존 `source: "estimate"`로 매핑하고 새 `partial` enum을 만들지 않는다. `schemas/attempt-receipt.schema.json`은 유효 시각과 숫자 latency를 요구하므로 시각이 없는 영수증은 기존 `no-timestamp` 생략·사유 집계를 유지한다. 임의 현재시각·0ms·null을 넣어 스키마를 통과시키지 않는다. census도 같은 내부 결과를 받아 시간 미확인을 유지한다.

완료 예: 동일 요청 output 10→160의 두 snapshot에서 두 소비자 모두 160을 사용하며 합산 170이나 첫 값 10을 사용하지 않는다. (실측상 실제 서브에이전트 그룹은 첫 output 2~20, 마지막이 16배 이상인 모양이므로 테스트 픽스처를 현실적으로 만든다 — 감사팀 2026-10-05.) 두 소비자의 등급·충돌·누락 처리도 같아야 한다. 가격표와 모델 라우팅은 변경하지 않는다.

### 4.2 메모리: 한 소유자와 파일 단위 transaction (C2)

**판정:** 단일 writer + project/cwd 연결 + 실패 의미 = **NECESSARY**; 잠금 transaction = **PARTIAL**(`summarizeSession` 저장 경로만 NECESSARY; `searchMemory` accessCount(MCP 전용)·prune(휴면)·clear(호출자 0)는 DEFER); watermark/dedupe = **DEFER**(수요: 42세션 중 중복 1건; 최소안은 정확히 동일한 중복의 no-op).

**'이미 재현됨'의 정정:** 감사 당시 재현은 단일 프로세스 Map 시뮬레이션이었다. 감사팀이 격리된 임시 HOME에서 **실제 두 프로세스**로 측정했다(2026-10-05, 스크래치 한정, 사용자 데이터 해시 불변):

| 조건 | 결과 |
|---|---|
| barrier-release 50라운드 | 49/50에서 ≥1 레코드 유실(tracker 48, summarizer 1), store 전체 삭제 1회(26→1) |
| 일반 동시 spawn(dispatcher와 유사) | 1/30, 1/50(전체 삭제 28→1), 3/100, 6/200 (100개 초과 시 tracker의 101 cap 축출이 카운트를 가림) |
| 손상된 JSON store | 두 writer 모두 **덮어씀** |
| 저장 실패 | `saveMemory`는 `persisted:false`인데 `shutdownLearning`은 `summarized:true` 보고 |
| store 경로가 디렉터리 | tracker가 fail-open exit 0 |
| 실제 store 표본 | tracker 42세션 / summarizer 31 / 둘 다 25 / tracker만 12 / summarizer만 5 |

**정합성 점검(미해소):** tracker-only 12세션은 경합으로 설명되지 **않는다**(경합은 summarizer가 아니라 tracker 기록을 지운다) → 제3의 원인은 **미확인**(예: session-end가 10초 예산 안에 summarize에 도달하지 못함). 단일 writer만으로는 이 12세션이 회복되지 않으므로 실패 전파가 함께 출하되어야 한다. 실제 memory 디렉터리의 `project-contexts.json.tmp.*`(9/23) 잔존물은 과거 원자 쓰기 실패를 시사한다(추론).

**사실(감사 보고 기준, 재열람 안 함):** SessionEnd는 `_sessionend-dispatcher.js`에서 7개 핸들러를 병렬(Promise.allSettled) 실행한다(헤더 주석은 5라고 해 stale). `memory-tracker.js#handleSessionEnd`(writeFileSync, 비원자, 100으로 자르고 +1 = 101)와 `memory-manager.js#summarizeSession`(원자)이 같은 `~/.claude/artibot/memory/project-contexts.json`을 쓰며, 둘 다 withFileLock을 import하지 않고 memory-manager의 모든 변경 경로가 잠금 없는 read-modify-write다. `withFileLock`(`lib/core/file-lock.js`)은 동기이며 O_EXCL `<file>.lock`, 2초 대기 후 ELOCKTIMEOUT, 10초 stale이다. `atomicWriteJsonSync`는 있으나 `readAndValidateStoreSync`는 **없다**(`readJsonFileSync`가 손상을 삼킴) → **새 helper가 필요**(ENOENT만 빈 store, 나머지는 throw). `tracker.handleCommand`는 라이브 트리거가 **없다**(죽은 경로); 오류 기록은 PostToolUseFailure(hooks.json)로 흐른다. prune은 휴면(`initLearning` 비테스트 호출자 0)이라 보존 한도는 saveMemory의 slice cap뿐이다. `shutdownLearning`은 summarizeSession 뒤에 self-eval·lifelong learning·hot-swap을 try 분리 없이 실행한다. `session-end.js#buildSessionData`에는 project/cwd가 없다(그래서 'unknown'으로 저장). tracker는 `hookData.project || basename(resolveProjectRoot(hookData.cwd))`와 `cwd: process.cwd()`(payload cwd 무시)를 쓴다. 호스트 SessionEnd payload에 `project`가 있는지는 **미확인**. `summarizeSession`은 `lib/autopilot/replay.js`에도 있으므로 아래 다이어그램은 `lib/learning/memory-manager.js#summarizeSession`을 뜻한다.

대상은 `hooks/dispatch-table.json`, `scripts/hooks/_sessionend-dispatcher.js`, `scripts/hooks/memory-tracker.js`, `scripts/hooks/session-end.js`, `lib/learning/pipeline.js`, `lib/learning/memory-manager.js` 및 그 호출부다. **제거할 것은 중복 SessionEnd 요약 writer**이며 tracker 전체나 SessionStart·오류 기록을 삭제하지 않는다. (정정: "명령 기록"은 뺐다 — `tracker.handleCommand`는 라이브 트리거가 없는 죽은 경로이고 오류 기록은 PostToolUseFailure 경로다.)

저장 흐름을 다음으로 고정한다.

```text
SessionEnd dispatcher
  → session-end: cwd/project/session signals 수집
  → shutdownLearning
  → summarizeSession   (lib/learning/memory-manager.js#summarizeSession)
  → memory-manager의 저장 transaction
  → 성공/실패를 원래 호출자에게 전달
```

tracker를 끊기 전에 tracker가 제공하던 project/cwd를 session-end의 `buildSessionData`에 먼저 연결한다. `resolveProjectRoot(hookData.cwd)` 등 기존 해석 경로를 재사용하며 project가 없는 레코드를 잘못된 프로젝트로 귀속시키지 않는다. SessionEnd 등록/dispatch에서 요약은 한 번만 호출되게 한다.

**중요: 기존 `withFileLock`은 동기 API다.** `withFileLock(file, async () => …)`는 await 동안 잠금을 유지하지 못한다. 아래 구조처럼 잠금 안에서 읽기→갱신→원자 저장을 동기로 끝낸다. 기존 외부 async API는 유지할 수 있다.

```js
// 개념 코드. 실제 저장 schema와 기존 return 계약에 맞춰 구현한다.
return withFileLock(storePath, () => {
  const latest = readAndValidateStoreSync(storePath); // ENOENT만 빈 store
  const next = applyMutation(latest);                // 부작용 없는 짧은 연산
  atomicWriteJsonSync(storePath, next);
  return mutationResult(next);
});
```

같은 store를 바꾸는 save/prune/clear, 검색 접근 통계 업데이트, 남아 있는 tracker 기록은 모두 같은 잠금/transaction 경로를 사용한다. 잠금은 **파일 경로 기준**이며 한 프로세스의 mutex만으로 대체하지 않는다. 잠금을 잡기 전에 읽은 store를 저장하지 않는다. 네트워크·LLM·긴 분석·중첩 동일 파일 잠금은 임계 구간 밖으로 뺀다. 검색의 accessCount는 ranking 소비처가 있으므로 이번에 삭제하지 않는다.

실패 의미:

- 파일 없음만 빈 store 생성 허용. JSON 파손·권한 오류·알 수 없는 schema를 빈 store로 덮어쓰지 않는다.
- lock timeout/쓰기 실패는 기존 파일 보존 + 저장 실패로 전달한다. pipeline은 저장이 실패했는데 `summarized: true`로 보고하지 않는다.
- 요약 저장 실패가 독립적인 다른 학습 종료 작업까지 무조건 중단시키지 않게 실패 범위를 분리한다.
- TTL·최대 보존 수는 memory-manager 기존 정책 하나로 통일한다. tracker의 별도 100/101개 잘라내기 경로를 남기지 않는다.

중복 SessionEnd는 project+sessionId가 알려진 요약을 같은 논리 레코드로 취급한다. 기존 `signals.lastTs`처럼 신뢰할 수 있는 이벤트 watermark를 저장해 같은 watermark+내용은 no-op, 더 새 watermark는 갱신, 오래된 watermark는 최신 것을 덮어쓰지 않게 한다. 생성 시각 `Date.now()`는 이벤트 watermark나 중복 식별자로 사용하지 않는다. ID/watermark가 부족하면 정확히 동일한 안정 내용의 중복만 제거하고 서로 다른 내용을 임의로 삭제하지 않는다. 기존 데이터 일괄 정리·마이그레이션은 이번 범위에서 제외한다.

### 4.3 토큰: 추정치의 이름과 범위를 바로잡기 (C3)

**판정:** 라벨·문서 정정 = **NECESSARY**; `kind`/`scope` 필드 추가 = **DEFER**(10+ 테스트가 `totalTokens` 형태를 고정; 라벨 교정만으로 과장이 제거됨).

**사실(감사 보고 기준, 재열람 안 함):** `runtime-prompt.js#persistTokenUsage`가 `{totalTokens,totalInput,totalOutput:0,requestCount}`를 쓴다(`token-usage.js` ~:250 `const outputTokens = 0`). 실제 파일은 totalTokens 214 / requestCount 1(프롬프트마다 새 프로세스). `statusline.sh`(~:479-491)가 이를 'Session token usage'로 표시하고, dashboard `pickTokens`는 `totalTokens`를 읽는다(`contextLimit`도 읽지만 writer가 쓰지 않아 dashboard의 total은 항상 null). kind/scope 필드와 스키마 파일은 없다. UI는 `totalOutput`을 읽지 않는다(`lib/observability/session-aggregator.js#normalizeMetrics`만 읽을 가능성이 있으나 그 입력 경로는 **미확인**) → 아래 "0 output을 실제 0으로 읽지 않는다"는 그 검사로 한정한다. 거짓인 문서: `docs/cache-roi-guide.md` ~:13,16('input + output / billing volume'), `plugins/artibot/marketplace.json` ~:205의 'auditLog' 호칭(루트 `.claude-plugin/marketplace.json`에는 없음, 재검수 실측 2026-10-05).

대상 `scripts/hooks/runtime-prompt.js`, `lib/runtime/middleware/token-usage.js`, `lib/tui/dashboard.js`, `scripts/hooks/statusline.sh`.

- 현재 writer의 값을 `kind: prompt-estimate`, `scope: current-input` 같은 명시적 의미와 함께 저장한다. 최종 키 이름은 기존 schema 호환성에 맞추되 의미는 유지한다.
- UI는 “현재 입력 추정 토큰 ≈ …”로 표시한다. 이를 세션 누적·실제 output 토큰·청구액·전체 컨텍스트 사용률로 표시하지 않는다.
- 기존 파일에 kind/scope가 없으면 legacy/범위 미확인으로 다룬다. 0 output을 실제 모델 output 0으로 읽지 않는다.
- 실측 세션 사용량과 비용은 usage-receipt의 transcript 집계 경로를 사용한다. 새 누적 카운터를 하나 더 만들지 않는다.

표시 교정의 목적은 절약을 과장하지 않는 것이다. 문자 기반 입력 추정기를 정밀 tokenizer로 교체하는 별도 프로젝트는 만들지 않는다.

### 4.4 소비되지 않는 skill 사전 읽기는 기본 경로에서 비활성화 (C5) — 판정 NECESSARY (낮은 우선)

**사실:** `skills.lazyLoading.enabled`는 **현재 true**다(`artibot.config.json` ~:1284-1287, 감사 보고 기준). 비용(함수 수준, Node 22, 감사팀 2026-10-05): `loadSkillIndex`가 SKILL.md 114개를 통째로 읽음(980,484 B) ≈ 28~31 ms, `loadSkillsByNames(5)` ≈ 2~3 ms; 로드된 본문의 소비처 없음; **훅 E2E 지연은 미측정**. 감사 C5 자체 수치(117 reads/1.02 MB/41 ms)는 같은 규모이나 동일하지 않다. `tests/runtime/middleware/skills.test.js`에 enabled:false 케이스가 이미 있다.

대상 `artibot.config.json`의 `skills.lazyLoading.enabled`와 `lib/runtime/middleware/skills.js`의 실제 소비 관계다. 우선 기본 config를 false로 바꾸고 기존 명령·의도 기반 이름 추천 및 네이티브 skill 활성화가 유지되는지 확인한다. 기능 전체 삭제나 새 영속 캐시는 만들지 않는다.

~~현재 factory의 명시적 `lazyEnabled: true`는 config false보다 우선할 수 있으므로 이 설정을 전역 kill switch라고 문서화하지 않는다.~~ **정정(감사 보고 기준):** 위 문장은 틀렸다. 옵션은 `createSkillsMiddleware({lazyLoading:{enabled}})`이고 `lazyEnabled || runtimeLazy.enabled===true`의 OR 로직이지만, **어떤 프로덕션 호출자도 이를 넘기지 않는다**(`create-artibot-agent.js`는 `middlewareOptions.skills`를 그대로 통과시키고 `runtime-prompt.js`는 `{}` 또는 `{memory:{enabled:false}}`를 공급) → 기본 경로에서는 config가 결정한다. 따라서 config false로 기본 경로의 불필요 본문 읽기가 중단된다. 이 작업은 수십 ms 규모의 낮은 우선순위이며 1~3의 주요 결함 수정을 지연시키지 않는다.

## 5. 묶음 4 — 기존 안전 판정과 실제 훅을 연결 (C4, adapter 계약 세부는 가이드 고유 제안)

**판정:** shadow 배선 = NECESSARY이나 관측 채널이 정의되기 전까지 **PARTIAL**; enforce adapter = **DEFER**(오너 결정 필요); 호스트 재프로브 = **NECESSARY**.

**범위 주의:** V5-BACKLOG CA-04와 겹친다(L1은 `e1fa6ef6`로 착지; L2 훅 enforcement, L0b shadow 카운팅, A1 대화형 프로브는 **미착수**). 오너 결정 R-5 O1~O3(host-ask 우선 / HG-07은 shadow 이후 / HG-12·13은 L2 smoke 이후)은 이 절과 일관된다. 그러나 **설정 오류 fail-closed 정책은 R-5에 없고** 검수된 L1 설계 선택(코어 헤더 '설계 선택 (1)')을 뒤집는다 → **오너 결정**. (감사 보고 기준, 재열람 안 함)

**확인된 참(유지):** 코어는 존재하며(738줄, `wc -l` 재검수 실측) 프로덕션 importer가 **0**이다; pre-bash/pre-write의 block→record 순서; Write|Edit 5개 훅과 Bash 2개 훅은 별도 Node 프로세스다(PreToolUse dispatcher 슬롯 없음); L2 security는 runtime ledger를 import하면 안 된다(eslint 강제); `host-payload-contract.test.js`는 route-observe-pre(Agent matcher)만 다루며 ask/deny에 대해 아무것도 증명하지 않는다.

**추가해야 할 공백 (감사 보고 기준, 재열람 안 함):**

| # | 공백 |
|---|---|
| 1 | **관측 채널:** `lib/runtime/human-asked-record.js#recordHumanAsked`는 BLOCK만 기록하고 원장 allowlist의 `human.*`는 human.asked/human.resolved뿐 → shadow의 would-deny가 기록될 곳이 없다. 채널(볼륨 캡이 있는 새 allowlist 이벤트 또는 stderr 카운터)을 CA-04 L0b와 묶어 정의해야 한다 |
| 2 | **출력 형식:** ask는 `hookSpecificOutput.permissionDecision:"ask"`가 필요한데 현 훅은 legacy 최상위 `decision:'block'`을 낸다(그 어휘에 ask 없음). `tests/hooks/pretooluse-passthrough` ratchet은 주석 포함 approval 리터럴을 금지한다 |
| 3 | **읽을 수 없는 config:** `readJsonFile`→null→`loadConfig`의 deepMerge(DEFAULTS,{})로 조용히 OFF가 된다. 가이드는 (a) stderr 진단을 붙여 알려진 fail-open으로 문서화 / (b) 코어의 `isClaudeConfigPath`를 재사용해 HG-12/13 일치를 차단(새 matcher 없음) 중 **결정**해야 한다 — **오너 결정** |
| 4 | **shipped config에 `permissions.humanGates` 키가 없고** `config-schema.js`도 `permissions`를 선언하지 않는다 → 키 추가(+스키마 선언; shipped-off pin 테스트는 그린 유지)와 기본값 의존 중 결정 — **오너 결정** |
| 5 | **호스트 증거가 오래되고 좁다:** `.artibot/guides/v5-design/evidence/ca04-host-ask-probe.md`(2026-09-29, 호스트 2.1.284, Bash matcher만, `-p` 비대화형: deny 10/10 차단(bypass/auto 포함), ask 10/10 미실행, legacy approve는 프롬프트 우회). 현재 설치된 호스트는 2.1.287이고 바이너리에 allow용 새 auto-mode classifier 문자열이 있다. 빠진 칸: 대화형 A1(ask 프롬프트가 표시되는지), Write/Edit matcher, plan mode, 실제 HG-12/13 대상 경로, 버전 pin |
| 6 | **입력 매핑:** `pluginRoot`는 절대 경로여야 하고 `permissionMode`는 payload의 `permission_mode`에서 온다 |
| 7 | 동적 `import()`는 eslint `no-restricted-imports` L2→L5 규칙을 우회한다 |
| 8 | §6 safety 행에 `tests/firewall/hook-decision-invariance.test.js`(stdout byte pin)와 `human-gate-matrix-selfcheck` 게이트도 필요하다 |

대상 `lib/security/human-gate-enforce.js`, `scripts/hooks/pre-bash.js`, `scripts/hooks/pre-write.js`, 기존 human-asked 기록 경로와 설정이다. 현재 코어만 있다고 호스트에서 enforce된다고 간주하지 않는다.

1. 기존 두 PreToolUse 훅에서 기존 안전 검사와 함께 순수 판정 코어를 호출한다. 별도 Node 훅 프로세스를 추가하지 않는다. 기존 block을 새 allow/record로 덮어쓰지 않는다.
2. 보안 계층은 runtime ledger를 import하지 않는다. 판정 코어는 순수하게 유지하고 훅/runtime 층에서 기록한다. 먼저 호스트의 차단 응답을 보낸 뒤 기록 실패를 처리하는 기존 안전 순서를 보존한다.
3. 설정은 기존 코어가 읽는 `permissions.humanGates.enforce` 계약을 사용한다. 초기값은 `enabled: false`, `mode: shadow`, `gates: [HG-12, HG-13]`, `askHonoredModes: []`. 새 HG-07 정책까지 함께 활성화하지 않는다.
4. OFF는 기존 stdout·종료코드 유지. shadow는 would-deny/사유를 관측하되 기존 판정을 바꾸지 않는다. 이 단계의 로그만으로 보호 완료를 선언하지 않는다.
5. HG-12/HG-13 대상 설정 파일 변경을 제한된 테스트 프로젝트에서 실제 호스트로 확인한다. 지원한다고 확인된 호스트/permission mode만 askHonoredModes에 등록한다. 모르는 모드에서 ask를 보냈다는 이유로 차단 성공을 가정하지 않는다.
6. enforce에서 ask 보장이 없으면 deny한다. log/ledger 실패가 이미 내려진 deny를 allow로 바꾸면 안 된다. 설정 오류 처리는 다음 adapter 계약을 따른다.

**설정 오류 adapter 계약 — 기존 코어와 의도적으로 다른 부분 [오너 결정]:** ~~현재 코어는 `configErrors`가 있으면 예외 없이 `record/config-invalid`를 반환한다.~~ **정정(감사팀이 실제 코어를 13 config × 6 요청으로 실행해 확인, 2026-10-05):** 코어는 `enabled`가 true로 해석되고 **게이트가 범위 안에서 hit**일 때만 record/config-invalid를 반환한다; boolean이 아닌 `enabled`나 객체가 아닌 `enforce`는 `enforce-disabled`를 낸다(configErrors는 그래도 채워짐); hit이 없으면 pass. 사례 `gates:"HG-13"` 문자열 → wouldDecide 'record'이지만 hits에는 HG-12/HG-13이 범위 안으로 남는다 — 아래 "wouldDecide만 보지 말고 hits의 id/inScope를 쓴다" 규칙이 필요함을 입증한다. 또 `gh pr merge`(HG-07만)가 config 오류 하에서 범위 안으로 나타나므로 id ∈ {HG-12,HG-13}로 걸러야 한다. shadow 볼륨 집계는 `decision==='record'`가 아니라 wouldDecide ∈ {ask,deny}를 센다(`ls -la`조차 record/row-not-enforceable). 단순 try/catch 연결만으로 fail-closed가 되지 않는다. 코어의 순수 판정과 기존 기본값을 보존하고, 훅 adapter에서 원본 설정과 반환된 configErrors를 함께 확인한다.

- 설정 부재/`enabled !== true`: 기존 OFF 동작. 잘못된 타입은 진단하며 자동 활성화하지 않는다.
- `enabled === true` + 명시적 shadow(또는 mode 부재의 기존 shadow 기본값): 관측만 한다.
- `enabled === true && mode === "enforce"`: configErrors가 있으면 탐지된 HG-12/HG-13 보호 범위의 호출을 설정 오류로 deny한다. `wouldDecide`만 보지 말고 `hits`의 id/inScope를 사용한다. gates 자체가 잘못된 경우에도 조용한 record로 통과시키지 않는다.
- enabled true인데 명시한 mode가 허용값 밖인 경우: enforce나 OFF로 간주하지 않고 설정 오류로 표시한다. 탐지된 HG-12/HG-13 보호 대상 변경은 차단하고 일반 호출은 기존 검사 결과를 유지한다. 이 오류 차단을 정상 enforce 활성화로 보고하지 않는다.
- 명시적 enforce에서 코어 실행/로딩 실패로 보호 범위를 판정할 수 없으면 해당 Bash/Write/Edit 호출을 판정 불가로 차단한다. 설정 읽기 실패를 OFF 기본값으로 조용히 숨기지 않도록 호출자의 오류 전달도 확인한다. 이때 임의 경로 매처를 새로 만들지 않는다.

이 동작 변경은 기존 코어의 설정 오류 정책과 구분해 문서화하고 adapter 검사에 넣는다. OFF/shadow에서 기존 응답을 유지한다는 조건을 함께 확인한다. 알려진 Bash 간접 쓰기·경로 별칭 등의 탐지 한계는 남아 있으며, 배선만으로 완전한 보안 경계를 만들었다고 주장하지 않는다.

검증은 순수 함수 테스트만으로 끝내지 않는다. 보호 대상에 대한 Bash와 Write/Edit 실제 호출, 정상 허용 동작, 호스트의 ask/deny 반응을 본다. 실제 사용자 설정 대신 격리된 대상 파일을 사용한다. `tests/firewall/host-payload-contract.test.js`의 routing 관측만으로 모든 훅의 ask 동작이 증명된다고 보지 않는다.

활성화 조건이 충족되기 전에는 OFF/shadow로 남기며 “배선 구현, enforce 미검증”으로 보고한다. 기존 보호는 계속 유지한다. 안전 활성화를 검증 경제성 개선과 한 번에 강제로 묶지 않는다.

## 6. 최소 검증 설계 — 파일별 QA를 만들지 않는다

기존 테스트를 확장하고, 실제 경계가 없는 경우에만 작은 통합 사례를 추가한다. 아래는 **검증 대상 지도**이며 각 행마다 전체 suite를 실행하라는 뜻이 아니다. 파일 경로는 `plugins/artibot/` 기준이다.

| 변경 묶음 | 우선 사용할 기존 검사 | 반드시 확인할 대표 경계 |
|---|---|---|
| 규칙·리뷰 | **정정:** `scripts/ci/validate-{agents,commands,skills}.js`는 frontmatter만 검사한다. 실제 prose 고정: `constitution-stage-a-rules.test.js`(VD heading ## 0–## 12 + §13 마지막 + `git add -A` 포함 앵커 5개), `constitution-stage-b.test.js`·`constitution-stage-b-rationalizations.test.js`(스킬 heading 기준선), `tests/replay/claim-audit-join.test.js`·`tests/commands/verify-record-steps.test.js`(team.md의 `### Phase 4.5: INSPECTION`, `#### Phase 4.5 마감 — 검증 기록`, `### 중계 계약` heading), `tests/firewall/command-body-tool-parity.test.js`(team.md 본문에 명명된 도구는 allowed-tools에 있어야 함), `tests/skills/anti-rationalization.test.js`. §11의 tsc/prebuild/build 문구를 고정하는 테스트는 없다 (감사 보고 기준, 재열람 안 함) | Cross-check의 재위임 금지와 Inspection 유지가 문서 전체에서 일관됨; 두 WARN만으로 차단하지 않음; 필수 결함은 계속 차단 |
| CI/릴리스 | `tests/firewall/workflow-branch-lockstep.test.js`, `tests/firewall/badge-stall-sync-order.test.js` | 4환경 테스트 유지, 1환경 coverage, 체크 이름 유지; 동일 SHA 재사용/다른 SHA fallback; count→badge→prose 순서 |
| snapshot | `tests/reporters/test-status-reporter.test.js`, `tests/verification/deterministic-source.test.js` | v1 호환, targeted/unknown, 중단·미처리 예외, 합계 밖 상태, reporter를 전체 CI 증거로 오인하지 않음 |
| usage | `tests/economics/usage-receipt.test.js`, `tests/evals/context-roi-census.test.js`, 기존 schema guard | 10→160, 손상된 마지막 행, run 분리, ID/필드 누락, 모델 충돌, 두 소비자의 결과 일치 |
| memory | `tests/learning/memory-manager.test.js`(lib/core/file.js 부분 mock — withFileLock을 추가하면 실제 ARTIBOT_DIR에 **실제 `.lock`**이 생기므로 ARTIBOT_STATE_DIR(+ARTIBOT_STATE_DIR_HOME) 격리 필요; tracker는 그 seam을 무시), `tests/hooks/session-end.test.js`, `tests/hooks/memory-tracker.test.js`(SessionEnd 쓰기를 단언하는 3개 테스트 → 그 경로를 제거하면 RED), `tests/learning/pipeline-success-experience.test.js`(~:381, summarize mock이 undefined를 반환하는데 `summarized:true`를 단언). 두 실제 자식 프로세스를 쓰는 기존 테스트는 없다 (감사 보고 기준, 재열람 안 함) | **두 실제 자식 프로세스가 같은 임시 store를 갱신해 둘 다 보존**; 손상 파일 보존; 한 writer; project 전달; 중복 이벤트; 실패 전파 |
| 토큰·skill | `tests/hooks/runtime-prompt.test.js`와 해당 middleware/UI 기존 검사 | 추정/실측 표시 구분, legacy 처리, 기본 prompt·추천 계약 유지, 불필요 본문 읽기 없음 |
| 안전 | `tests/security/human-gate-enforce.test.js`, `tests/hooks/pretooluse-passthrough.test.js`, `tests/firewall/hook-decision-invariance.test.js`(stdout byte pin), `human-gate-matrix-selfcheck` 게이트와 실제 host probe | OFF/shadow 기존 응답, enforce deny/ask, 보호 경로, 기존 block 우선, 기록 실패에도 차단 유지 |
| 선택적 autopilot | `tests/autopilot/goal-evaluator.test.js`와 호출부 기존 검사 | cwd/timeout 전달, timeout은 미충족, 남은 예산 없음, 변경 후 재검증 유지 |

비용 reducer 테스트와 두 소비자 테스트에 같은 수십 개 사례를 복제하지 않는다. 순수 함수에 경계 사례를 모으고 소비자에는 연결을 증명하는 대표 사례만 둔다. 메모리 경합은 같은 프로세스 mock만으로 통과시키지 않는다. 훅 안전은 core 단위 테스트만으로 통과시키지 않는다.

실행 원칙:

1. 구현 중 관련 테스트를 묶어서 실행한다. 실패를 고쳤다면 실패 관련 검사와 직접 회귀부터 다시 실행한다.
2. 공유 런타임 변경이 모두 모인 통합 상태에서 전체 suite·lint·기존 필수 게이트를 실행한다. 리뷰어는 이 결과를 읽고 새 위험이 없는 한 같은 명령을 반복하지 않는다.
3. 마지막 검증 후 영향을 주는 변경이 생겼을 때만 해당 증거를 무효화한다. required CI를 생략하거나 로컬 결과로 대체하지 않는다.
4. 문서 수치·테스트 수·예쁜 형식만을 위해 기능 완료 후 QA 범위를 추가하지 않는다. 수락기준의 결함은 반드시 해결한다.

이 설계 작성 자체에는 전체 테스트·coverage·빌드 실행이 필요하지 않다. 제품 코드를 바꾸지 않았기 때문이다.

## 7. 되돌리기와 완료 판정

| 변경 | 이상 발생 시 되돌리기 |
|---|---|
| 운영 규칙 | 변경 절만 되돌린다. 소스/활성 설치본을 함께 확인하고 사용자 안전 추가사항은 보존 |
| CI coverage 분리 | 기존 4환경 coverage로 복구 가능. required check 이름은 계속 유지. lifecycle script 허용 fallback은 복구하지 않음 |
| 릴리스 재사용 | 재사용 조건을 끄고 기존 count fallback 사용. 다른 SHA artifact를 억지로 사용하지 않음 |
| snapshot v2 | 추가 메타정보 소비를 중지해도 기존 8필드 소비 가능. unknown을 full로 승격하지 않음 |
| usage reducer — **되돌리기 불가 — 대신 정확도 저하를 표시** | 구버전으로 되돌리면 서브에이전트 과소집계(§4.1 실측)와 집계 불일치가 재발하므로 되돌리지 않고 정확도 저하를 표시. 가격표·기존 transcript는 수정하지 않음 |
| 메모리 — **되돌리기 불가 — 대신 실패를 보고하고 원본을 보존** | 한 요약 writer는 유지. 이중 writer로 복귀하지 않음. 안전 저장이 불가능하면 해당 저장 실패를 보고하고 원본을 보존. 백업을 최신 사용자 데이터 위에 덮어쓰지 않음 |
| 토큰/skill | 기본 사전 읽기 설정은 독립 복귀 가능. 추정치를 실측으로 표시하는 문구는 복구하지 않음 |
| 안전 연결 | 새 enforce만 OFF/shadow로 되돌림. 기존 pre-bash/pre-write 보호는 유지 |

완료 판정은 다섯 관점에 연결한다.

- **확장성:** 팀원이 늘어도 각 교차검수가 하위 리뷰 팀을 만들지 않는다. 같은 파일의 저장은 프로세스 수와 무관하게 직렬 transaction으로 보존된다.
- **안정성:** 실제 병렬 저장 사례가 보존되고, 손상 데이터는 덮어쓰지 않는다. 부분 테스트·shadow 안전 상태를 전체 성공으로 표시하지 않는다.
- **효율성:** 스킬 활성화와 커밋 생성만으로 전체 테스트가 추가 실행되지 않는다. 시간 채우기·정보성 경고로 완료 작업을 다시 열지 않는다.
- **경제성:** 두 usage 소비자의 집계가 같고, CI coverage 계측은 한 환경에서 한다. 같은 릴리스 결과를 안전한 경우에만 재사용한다.
- **미래지향성:** 범위가 표시된 결과·순수 usage reducer·한 저장 경계로 확장 지점을 정리한다. 소비되지 않는 기능과 범용 캐시를 추가하지 않는다.

실제 절감률은 아직 미측정이다. 적용 전후 비슷한 규모의 완료 작업 각각 5개 정도를 기존 기록에서 비교한다. 수락된 결과까지 걸린 시간, 전체 테스트 횟수, 리뷰 수정 회차, CI 실행시간, 실측 가능한 사용량, 재개방 결함을 본다. 표본이 작다는 한계를 남기고 정해진 절감률을 약속하지 않는다. 새 상시 telemetry·회고 자동화·평가 팀은 만들지 않는다.

## 8. 업데이트 담당자에게 전달할 실행 요약

> 이 문서의 1→2/3→4 순서로 구현한다. 먼저 반복 전체 테스트·시간 채우기·중첩 리뷰를 유발하는 정책을 수정하고 활성 설치본까지 병합한다. coverage 1환경화는 §0.1 DEFER(오너 결정 6 이후)이며, 적용한다면 Linux Node 22만 계측하되 네 환경 전체 테스트와 기존 필수 체크는 유지한다. snapshot은 범위를 표시하는 데 사용하며 범용 자동 캐시는 만들지 않는다. 릴리스는 같은 실행·같은 SHA·완료된 전체 성공 결과만 재사용한다. 비용 집계는 마지막 유효 요청 snapshot으로 통일하고, 메모리는 한 SessionEnd writer와 동기 파일 잠금 transaction으로 보호한다. 토큰 추정치 표시를 교정하고 skill 사전 읽기를 끈다(§4.4, 묶음 3). **단 §0.1 판정을 따른다:** DEFER/REJECT 항목과 §0.2 오너 결정 항목은 오너 결정 전에 구현하지 않는다. 안전 훅은 기존 코어/훅을 연결하되 실제 호스트 계약 확인 전에는 enforce를 활성화하지 않는다. 기존 검사를 관련 변경별로 묶고 통합 시점에 전체 검증한다. 결과에는 적용 파일, 검증 범위, 남은 결함과 미활성 안전 조건을 보고한다.

우선 제외: 대량 테스트 삭제, coverage 하향, 모델 일괄 하향, 새 DB·새 오케스트레이터, 범용 검증 캐시, 자동 전역 규칙 덮어쓰기, 기존 메모리 일괄 마이그레이션, 모든 observer/shadow 기능의 일괄 활성화.
