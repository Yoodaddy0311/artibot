# 04. 설계 문서 검증 보고 — 01·02·03 의 주장을 소스·호스트 문서·격리 재현으로 대조 (2026-10-23)

- **기준**: master `6149446e`(01 이 인용한 기준 SHA 와 같다. 이 검증의 체크아웃 HEAD 도 같은 커밋이다 — `git rev-parse HEAD`).
- **방법**: 인용된 소스를 파일·줄 단위로 직접 열어 확인 · 격리 HOME 에서 훅을 호스트가 띄우는 방식(`node <hook>` + stdin payload)으로 재현 4건(EXP-A~D, 모델 API 호출 0) · 호스트 공식 문서 3페이지 조회(hooks · cli-reference · monitoring-usage, 2026-10-23 curl — URL 은 §7).
- **등급 표기**는 `rules/verification-discipline.md` §0 의 세 등급(실측 / 추론 / 미확인)이다. 설계 후보의 판정은 `skills/problem-validation/SKILL.md` 의 어휘(NECESSARY / PARTIAL / DEFER / REJECT)다.
- **이 문서가 하는 일**: 01~03 이 "[코드 확인]" 으로 표시한 주장이 2026-10-23 트리에서 참인지, 이미 고쳐졌거나 이미 기록된 것은 없는지, 기존 정본([ARTIBOT-5.0-DESIGN](../ARTIBOT-5.0-DESIGN.md) · [V5-BACKLOG](../V5-BACKLOG.md) · [MEASUREMENT-RUNBOOK](../MEASUREMENT-RUNBOOK.md) · [VERIFICATION-ECONOMICS-DESIGN](../../VERIFICATION-ECONOMICS-DESIGN.md) · [NEXT-SESSION](../../NEXT-SESSION.md))과 겹치거나 어긋나는 곳이 어디인지 가린다. 설계는 [05](05_REVISED_DESIGN.md) 가 한다.
- **변경 0**: 소스·설정·원장·v5 진행률을 바꾸지 않았다(03 Step 0 계약). 재현에 쓴 HOME 은 전부 임시 디렉터리다.
- **라이브 수치 없음**: 이 체크아웃에는 `runtime/`·원장·세션 스토어가 없다(gitignore). 라이브 빈도는 전부 **미확인**이고 §8 에 모았다.

## 1. 판정 한눈에

| ID | 01 의 주장 | 판정 | 핵심 근거 | 재현 |
|---|---|---|---|---|
| IMP-01 | 루프 이력이 프로세스 지역 카운터라 저장되지 않는다 | **실측 확인** · 이미 기록됨(NEXT-SESSION 2026-10-20) | `scripts/hooks/tool-tracker.js:41-42,257-260` · 호출마다 자식 spawn `scripts/hooks/_posttooluse-dispatcher.js:105-123` | EXP-A: 6회 동일 호출 → 파일 없음, 경고 0 |
| IMP-02 | `LOOP BLOCKED` 는 호스트가 차단했다는 증거가 아니다 | **실측 확인, 문서보다 강함** — 모델에게도 닿지 않는다 | `scripts/hooks/tool-tracker.js:262-269` stderr·exit 0 · 호스트 문서 "exit 0 훅의 stderr 는 Claude 가 절대 보지 못한다" · PreToolUse `*` 매처 0 · 소비처 0 | grep |
| IMP-03 | 미분류 Bash 호출이 학습·루프·통계에서 빠진다 | **실측 확인** · 코드 주석이 자인 | `scripts/hooks/tool-tracker.js:232-233,338-342,522-538` · 자인 주석 `:177-185` | EXP-B: 6문형 중 4 NO ROW |
| IMP-04 | 빈 verifyResult·임의 객체가 REPORT 를 통과한다 | **실측 확인** · 게이트 헤더가 자인 · **enforce 출하 true(라이브 영향)** | `lib/autopilot/report-verify-gate.js:258-262,322-340` · 헤더 `:140,170-175` · `artibot.config.json#autopilot.reportVerifyGate.enforce` | EXP-C: 비-FAIL 7형 전부 `ok` |
| IMP-05 | 설정 읽기 실패와 명시적 OFF 가 구분되지 않는다 | **실측 확인** · 주석 자인 · 오너가 fail-closed 를 보류한 영역 | `lib/autopilot/report-verify-gate.js:286-293` · 주석 `:199-204` · VERIFICATION-ECONOMICS §0.2 결정 #4 | EXP-D |
| IMP-06 | 추정 토큰·힌트와 실제 usage 를 분리해야 한다 | **부분 — 분리는 이미 구현** · 남은 것은 라벨 정정(C3)과 02 의 비용 컬럼 지정 | `lib/economics/usage-receipt.js` 헤더 · `schemas/attempt-receipt.schema.json:38-41` · `scripts/hooks/statusline.sh:479` | grep |
| IMP-07 | 네이티브 기준선 오염을 차단해야 한다 | **타당, 벡터 1종 누락** · 호스트 격리 수단 미반영 | `install.sh:472-475,845-857` · cli-reference(`--bare` `--setting-sources` `--plugin-dir`) · settings(`CLAUDE_CONFIG_DIR`) | — |
| IMP-08 | SessionStart 부하 MEASURE → TUNE | **이미 측정·결정됨(유지, 2026-10-20)** → 신규 작업 아님 | NEXT-SESSION v4.71.11 「다음 할 일」 | — |
| IMP-09~13 | MEASURE 5건 | 측정 도구가 대부분 존재 — §3 매핑 | — | — |
| IMP-14 | ID 불일치 | **타당** — 봉투 ID 7종 밖에 attemptId·autopilot sessionId | `schemas/ledger-envelope.schema.json` | — |
| IMP-15 | config 키와 소비처 대조 | **부분 — 도구 존재** | `scripts/ci/triage-wiring-gaps.mjs` · `tests/firewall/v5-config-firewall.test.js` | — |
| IMP-16 | 중복 리뷰 | **중복 제안** — VERIFICATION-ECONOMICS §2.3(A3) 이 이미 NECESSARY | — | — |
| IMP-17 | 모델 선택 이득 | **중복 제안** — MODEL-SWITCHING-SCORECARD · `scripts/ledger/route-compare.mjs` · CA-18 0/0 unmeasured | — | — |
| IMP-18 | 문서 드리프트 | **타당 — 구체 2건 지목**(§2.8) | `scripts/hooks/tool-tracker.js:34-40` · `scripts/hooks/_posttooluse-dispatcher.js:18` | — |

02 (기준선·ROI): 산식은 타당하다. §4 의 attempt 레코드는 기존 영수증 스키마와 겹치고(둘째 진실원), §2 의 CLI 플래그 목록은 보강이 필요하며, 오염 벡터 1종이 빠졌고, MEASUREMENT-RUNBOOK 과의 관계를 명문화해야 한다(§4). 03 (인수인계): Step 0 의 1~4 는 이 보고로 수행됐고, 최종 산출물 계약 1(D0~D6 연결성 감사표)은 §5 다.

## 2. P0 항목별 상세

### 2.1 IMP-01 — 반복 호출 이력 영속화

**실측(EXP-A)**: 빈 HOME 에서 같은 `Read` payload 로 `tool-tracker.js` 를 6회 띄웠다. 6회 모두 exit 0, stderr 0바이트, `loop-state.json` 미생성. 같은 프로세스가 `tool-history.json`·`daily-experiences.json` 두 파일은 썼다(§7).

**메커니즘(코드)**: `scripts/hooks/_posttooluse-dispatcher.js:105-123` 가 핸들러마다 `spawnHook` 으로 새 node 를 띄우고, 디스패처 자신도 PostToolUse 마다 호스트가 띄운다. `scripts/hooks/tool-tracker.js:42` 의 `let loopCallCounter = 0` 은 모듈 변수라 매 프로세스 1 에서 끝난다 → `:258` 의 `loopCallCounter % 10 === 0` 은 참이 될 수 없다. `loopResult.detected` 는 복원된 이력이 없어 거짓 → `saveLoopState` 호출 0 → 파일 생성 0 → 다음 프로세스의 `loadLoopState()`(`:79`) 도 null. 파일이 생기려면 감지가 있어야 하고, 감지가 있으려면 파일이 있어야 하는 교착이다.

**왜 생겼나**: `:34-40` 주석은 v4.7.3 perf 가 "N 번에 1회 flush, 최악 N-1 개 손실" 을 전제했다고 적는다. 그 전제(장수 프로세스)는 이 훅에 성립하지 않는다. 같은 파일 `:282-285` 주석은 정반대 사실("This process is spawned per tool call … SIGTERM'd at … 3000ms")을 이미 적고 있다 — 한 파일 안의 두 주석이 모순이다(verification-discipline §5).

**이미 기록됨**: NEXT-SESSION v4.71.11 「다음 할 일」 — "호출마다 새 프로세스라 이력 저장 조건 … 코드상 충족되기 어렵고, 이 PC 의 실제 `~/.claude/artibot/loop-state.json` 이 없다(2026-10-20 측정)". 01 의 발견은 오너 기록과 독립적으로 같은 결론이다.

**기존 테스트가 왜 초록인가**: `tests/hooks/tool-tracker-loop-state.test.js`(d969ee64, 2026-10-20) 는 상태 파일을 **미리 심어** 1회 spawn 으로 warn 임계를 넘긴다(헤더 "pre-seeded by the real detector so that ONE more identical call crosses the warn threshold"). cold start 는 검사하지 않는다. 01 의 "기계적 시뮬레이터 PASS 는 host 통합 PASS 를 대체하지 못한다" 는 정확하다.

**01 이 놓친 것**
1. 상태 파일이 상태 디렉터리에 **전역 1개**다(`loopStateFile()` `:27-29`). 호스트 문서는 서브에이전트 안에서도 PreToolUse·PostToolUse 가 같은 훅을 `agent_id` 와 함께 발화한다고 적는다 → 메인 스레드와 서브에이전트, 동시 세션들이 한 이력을 공유한다. 01 의 "실행 세션 격리" 요구는 타당하고, 그 관례는 이미 있다 — `lib/core/runtime-state.js#resolveScopedStatePath`(O2, `current-effort.json`·`token-usage-session.json` 이 쓰는 세션 경로).
2. `:233` 의 조기 반환이 `:252` 의 `detectLoop` 보다 **앞**이라, 미분류 Bash 는 학습뿐 아니라 루프 감지에서도 빠진다. IMP-01 과 IMP-03 은 한 수정이다.
3. 01 의 수용 기준 "8개 프로세스 동시 기록에서 loss 0" 은 문제를 과대 설정한다. 루프는 **순차 동일 호출**이고 거기엔 경합이 없다. 경합은 한 턴의 병렬 **상이한** 호출에서만 나며, 그때 손실은 이력 **누락**(미탐 방향)이지 오탐이 아니다. loss 0 을 요구하면 append 전용 저장소나 잠금이 필요해지는데, 소비처가 없는 복잡도다 → 05 D-01.

**판정**: NECESSARY (check 1 미구현 실측 · check 2 EXP-A + 오너 기록 · check 3 현재 결함 · check 4 수정 수 줄).

### 2.2 IMP-02 — 루프 경고와 실제 차단의 분리

**실측(코드)**: `scripts/hooks/tool-tracker.js:262-269` 는 라벨을 stderr 에만 쓴다. 정상 경로의 exit code 는 0 이다(`:561-563`). 디스패처도 모든 실패 경로에서 0 으로 끝난다(`_posttooluse-dispatcher.js:35`).

**실측(호스트 문서, hooks.md 2026-10-23)**: "Claude never sees stderr from a hook that exits 0. … To surface a warning to Claude from a `PostToolUse` or `PostToolUseFailure` hook, exit 2 instead". 즉 `[artibot:LOOP BLOCKED]` 는 모델에게도, 디버그 로그를 켜지 않은 사용자에게도 닿지 않는다.

**소비처 0(grep, `plugins/artibot` 전역, tests 제외)**: `loop-state` · `createLoopDetector` · `loop-detector` 를 읽는 파일은 `scripts/hooks/tool-tracker.js` 와 `lib/cognitive/loop-detector.js` 둘뿐이다. `hooks/hooks.json` 의 PreToolUse 등록 9건의 매처는 `Write|Edit`·`Bash`·`Agent`·`WebFetch` 조합이고 `*` 는 없다.

**결론**: 루프 감지의 D4(소비)·D5(행동)·D6(가치) 는 0 이다. 01 의 "차단 증거가 아니다" 는 과소 진술이고, 정확한 진술은 "**아무 효과도 없다**" 다.

**01 이 놓친 것**: PostToolUse 도 모델에 신호를 보낼 수 있다. 호스트 문서 PostToolUse decision control — `decision: "block"` + `reason`(도구 결과 옆에 reason 표시, 도구는 이미 실행됨) 과 `hookSpecificOutput.additionalContext`(도구 결과 옆에 시스템 리마인더로 삽입). 디스패처 `scripts/hooks/_dispatcher-utils.js#mergeResults`(`:427-432`) 는 자식들의 additionalContext 를 연결하고 첫 blocker 의 reason 을 노출한다 — PreToolUse deny 보다 훨씬 싼 전달 경로가 **이미 배선돼 있다**. 진짜 차단은 PreToolUse 의 `hookSpecificOutput.permissionDecision: "deny"` 이고, 이는 `.artibot/project.md` Non-goals "훅으로 새 차단을 만들지 않는다(Observe 단계)" 와 충돌하므로 오너 결정 사항이다. 선례: `scripts/hooks/route-observe-pre.js` 는 PreToolUse(Agent) 에 **stdout 0·관측 전용**으로 들어갔다([ROUTE-RECEIPT-PRETOOLUSE-DESIGN](../ROUTE-RECEIPT-PRETOOLUSE-DESIGN.md) §4 의 계약).

**판정**: PARTIAL — "경고를 모델에 전달" NECESSARY(Canary 키 뒤) · "PreToolUse 차단" DEFER(오탐률 측정 전, 오너 결정 전).

### 2.3 IMP-03 — Bash 분류 실패 시 원시 이벤트 유실

**실측(EXP-B)**:

| 명령 | 행 기록 | 기록된 context |
|---|---|---|
| `npm test` | 기록 | `bash:test:shell` |
| `cd plugins/artibot && npm test` | **NO ROW** | — |
| `CI=1 npm test` | **NO ROW** | — |
| `npx vitest run tests/x.test.js` | 기록 | `bash:execute:shell` (test 가 아니라 execute — 01 에 없는 오분류) |
| `bash scripts/run.sh` | **NO ROW** | — |
| `echo hi \| grep h` | **NO ROW** | — |

**코드**: `scripts/hooks/tool-tracker.js#classifyBashCommand`(`:522-538`) 는 선두 토큰 정규식 11종이다. null → `:341` null → `:233` 반환. 주석 `:177-185` 가 "`cd x && …` … return null … no row is written … since `cd x && …` is the dominant command shape in this repo the blind spot is large. Tracked separately" 라고 **자인**한다. 01 의 발견이 아니라 알려진 부채의 재발견이고, 그래서 더 신뢰할 수 있다.

**비밀 저장 우려(01)**: 현재 `tool-history.json` 은 context 키와 점수·타임스탬프만 저장한다(EXP-B 출력 원문 §7). 명령 본문은 저장되지 않는다. 01 의 "raw 라 해도 명령 본문을 무제한 저장하지 않는다" 는 현 설계가 이미 지키는 선이다.

**01 이 놓친 것**: 디스패치 분모는 이미 있다. `scripts/hooks/_hook-fired-record.js` 가 PostToolUse 디스패치마다 `hook.fired` 1행을 `data.tool` 과 함께 쓴다(슬롯 허용목록 `artibot.config.json#ledger.hookFired.slots` 에 PostToolUse 포함, 2026-09-15 측정 ≥679행/일). "raw execution receipt 저장소" 신설은 소비처 없는 셋째 저장소다. 최소 수정은 01 자신이 적은 category='unknown' — `buildContext('Bash')` 가 null 대신 `bash:unknown:shell` 을 돌려주는 것이다.

**판정**: PARTIAL — unknown 수용 NECESSARY · 접두(`cd … &&`, `VAR=…`) 처리 NECESSARY(분모 측정 동반) · raw receipt 저장소 DEFER.

### 2.4 IMP-04 — 실제 검증 증거 없는 REPORT 통과

**실측(EXP-C)**: EXECUTE started → VERIFY started(v1) → acknowledged(v1, reason `done`) 저널에서 `evaluateReportVerifyEvidence` 를 돌렸다.

| verifyResult | 코드 |
|---|---|
| `null` (드라이버가 아무것도 안 씀) | `ok` |
| `undefined` | `ok` |
| `{}` | `ok` |
| `"FAIL"` (문자열) | `ok` |
| `{status:"fail"}` (소문자) | `ok` |
| `{mcp:{ok:false}}` (중첩 층 FAIL) | `ok` |
| `{summary:"tests not run"}` (산문) | `ok` |
| `{status:"FAIL"}` | `VERIFY_RESULT_FAILED` |
| `{ok:false}` | `VERIFY_RESULT_FAILED` |

**코드**: 규칙 6 = `lib/autopilot/report-verify-gate.js#hasExplicitVerifyFail`(`:258-262`) — 명시 FAIL 3형의 **부정 목록**. 게이트 헤더 `:140` "a re-run acknowledged `done` whose driver writes no `verifyResult` leaves the slot empty, and an empty slot passes rule 6", `:170-175` 는 통과하는 형을 전부 열거한다. 규칙 1~5 는 허용목록인데 규칙 6 만 부정 목록이라 verification-discipline §8("금지 목록이 아니라 허용 목록")과 어긋난다.

**라이브 영향**: `autopilot.reportVerifyGate.enforce` 는 2026-09-30 오너 결정으로 출하 true 다(`report-verify-gate.js:186-192`, `artibot.config.json`). 이 구멍은 출하 상태에서 열려 있다.

**이미 있는 부품(01 이 신설하려 한 것)**
1. 허용목록 fold: `lib/autopilot/recovery-record.js#foldVerify`(`:103-114`) — `status` 가 정확히 PASS/FAIL/UNMEASURED, `ok`·`passed` 가 진짜 불리언일 때만 측정, 그 외 전부 UNMEASURED, 모순도 UNMEASURED. SH-06 기록기가 VERIFY ACK 때 이미 읽는다. 게이트 헤더 `:173-175` 는 "얼마나 자주 드라이버가 신호를 안 쓰는지는 SH-06 기록기의 측정" 이라고 위임한다.
2. 결정적 증거 경로: `tests/reporters/test-status-reporter.js` → `runtime/last-test-result.json`(`:52`, schemaVersion 2 + `completion`) → `lib/verification/deterministic-source.js`(신선도 규칙 F1: 마지막 main-agent 편집보다 새로울 때만 · 통과는 허용목록 규칙 6 · 통과·실패 외는 UNMEASURED) → `scripts/hooks/dev-verify-gate.js`(Stop) 가 `verify.completed` 4행 기록(OB-07; writer `lib/verification/verify-writer.js`, 증거 4096바이트 상한).
3. VERIFY attempt 에는 `checkpointSha` 가 있다(`lib/autopilot/engine.js#runPhase4Verify` 의 attempt-started tick data).

따라서 01 의 VerifyEvidenceV1 10필드 중 기존 부품으로 덮이지 않는 것은 **SHA 결합 하나**다 — 리포터 스냅샷에 git SHA 가 없다(`test-status-reporter.js:52,134-135` 확인). 둘째 스키마를 만들면 설계 정본의 "두 번째 진실원 금지" 에 걸린다.

**현 인프라가 못 보는 것**: lint·tsc·build 층은 어디에도 exit code 가 남지 않아 UNMEASURED 다(`deterministic-source.js` 헤더 "WHY NOT THE OTHER LAYERS"). 01 의 "독립 수집된 테스트/검사 증거" 는 현재 **테스트 층만** 가능하다.

**판정**: PARTIAL — 규칙 6 의 허용목록 전환(기존 fold 재사용) NECESSARY(Canary 키 뒤) · SHA 결합(리포터 1키 + 규칙 7) NECESSARY · VerifyEvidenceV1 신규 스키마 REJECT(중복).

### 2.5 IMP-05 — 설정 읽기 실패와 명시적 OFF

**실측(EXP-D)**: `CLAUDE_PLUGIN_ROOT` 를 유효 설정 / 깨진 JSON / 파일 없음 디렉터리로 바꿔 `loadReportVerifyGateConfig()` 를 호출했다 → `{"enforce":true}` / `{"enforce":false}` / `{"enforce":false}`. 깨짐·누락·명시 false 가 같은 값이다.

**코드**: `lib/autopilot/report-verify-gate.js:286-293` catch → `{ enforce: false }`. 주석 `:199-204` "an unreadable file … reads OFF with no tick and no warning … nothing here can tell that from a deliberate OFF" 자인. 같은 패턴이 `lib/autopilot/recovery-transition.js#loadRecoveryTransitionConfig`(게이트 헤더 `:204` 언급).

**정본 결정과의 관계**: [VERIFICATION-ECONOMICS-DESIGN](../../VERIFICATION-ECONOMICS-DESIGN.md) §0.2 #4 와 오너 결정 기록(2026-10-05) #4 — "HG-12/13 설정 오류 차단 정책 — 기존 일정(CA-04, R-5)대로, 지금 채택 안 함". 01 의 "최후 유효 정책 유지" 는 fail-closed 쪽 변형이라 이 결정과 충돌할 수 있다. 05 는 **가시화(상태 3분법 + 경고)만** 제안하고 정책 전환은 그 결정에 위임한다.

**판정**: PARTIAL — 상태 3분법 + 경고 NECESSARY(Observe, 행동 변화 0) · 정책 전환 DEFER(오너 결정 #4 종속).

### 2.6 IMP-06 — 추정 토큰과 실제 usage

**이미 구현(실측 코드)**: `lib/economics/usage-receipt.js` 가 `usage.receipt` 의 **단일 writer** 이고 입력은 호스트 transcript JSONL 의 `message.usage` 다(input · cache_read · cache_creation · output · thinking, 서브에이전트 파일 포함). `schemas/attempt-receipt.schema.json:38-41` 은 `usage.source ∈ {transcript, otlp, estimate}` 를 **필수**로 두고 "estimate values must never be mixed into a measured aggregate" 라고 적는다. 가격은 `lib/core/model-catalog.js` 단일 표에서 2026-09-14 부터 기본 ON 이며, coverage 지표가 v5 종료조건(≥95%) 이다 — 라이브 83.7%~92.3%(V5-BACKLOG §4 ④, 2026-09-21~28). `lib/runtime/middleware/token-usage.js#estimateTokens` 는 chars/4 추정이고 영수증과 분리돼 있다. `[artibot:task-budget max_tokens=…]` 는 산문 지시이고(`scripts/hooks/runtime-prompt.js:186-208`), `artibot.config.json#runtime.effort` 주석이 "the plugin has NO Messages API caller and never sets output_config.effort" 라고 01 의 지적을 이미 적고 있다.

**남은 것**: (a) C3 라벨 정정 — VERIFICATION-ECONOMICS §4.3 가 2026-10-05 NECESSARY 로 판정했고 **미착지**다: `scripts/hooks/statusline.sh:479` 의 'Session token usage (from runtime-prompt.js)' 그대로(2026-10-23 grep). (b) 02 의 비용 컬럼이 `usage.receipt`(source=transcript) 를 쓰고 `cost_basis` 를 '카탈로그 API 환산' 으로 표기해야 한다 — 구독 과금은 클라이언트에서 관측할 수 없다(VERIFICATION-ECONOMICS §0.4 "서버 청구 oracle 없음").

**판정**: REJECT(신규 분리 작업) · NECESSARY(C3 착지 — 기존 판정 인용) · NECESSARY(02 컬럼 정의).

### 2.7 IMP-07 — 네이티브 기준선 오염

**타당**. 보강 두 가지.

1. **누락 벡터**: `install.sh:472-475` 는 `~/.claude/agents`·`~/.claude/commands`·`~/.claude/rules/artibot`·`~/.claude/artibot` 을 만들고(`:837` 규칙 설치), **`:845-857` 은 프로젝트 `CLAUDE.md` 에 Artibot 절을 심는다**. B 군이 "프로젝트 규칙은 유지" 하면서 이 절을 그대로 두면 Artibot 지시가 B 에 남는다. 02 §2 체크리스트에 없다.
2. **호스트 격리 수단**(cli-reference.md · settings.md, 2026-10-23 조회 — 사용자 PC 바이너리의 `--help` 재확인은 02 그대로 유효): `CLAUDE_CONFIG_DIR`(설정·세션 이력·플러그인 저장 위치 이전) · `--setting-sources user,project,local`(어느 설정 계층을 읽을지) · `--bare`(훅·스킬·커맨드·서브에이전트·플러그인·MCP·자동 메모리·CLAUDE.md 자동 탐색을 전부 생략 = A 군) · `--safe-mode`(존재 확인) · `--restricted`(평가 하네스가 공유 PC 에서 돌릴 때) · `--plugin-dir <dir>`(세션 한정 플러그인 로드 = C/D 군의 고정 커밋) · `--max-budget-usd`(print 모드, **클라이언트 측 추정**이라 과금 보장이 아님) · `--effort` · `--output-format stream-json` + `--include-hook-events`(훅 발화 매니페스트). 02 §2 의 목록은 `--bare`·`--setting-sources`·`CLAUDE_CONFIG_DIR`·`--restricted` 를 모른다.
3. **사용량 2차 출처**: `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_METRICS_EXPORTER=console` 이면 `input_tokens`·`cache_read_tokens`·`cache_creation_tokens` 가 나온다(monitoring-usage.md). transcript 영수증과 교차 대조하면 verification-discipline §5 의 정합성 점검이 된다.

**판정**: NECESSARY(격리 런북) · 02 §2 정정 필요.

### 2.8 IMP-18 — 구체 드리프트 2건

- `scripts/hooks/tool-tracker.js:34-40` — "Recovery semantics unchanged … worst-case loss of N-1 entries at process kill" 은 거짓이다(호출마다 새 프로세스라 손실은 전부). 같은 파일 `:282-285` 와 모순.
- `scripts/hooks/_posttooluse-dispatcher.js:18` — "tool-tracker.js * (3s) — universal tracker" 는 Bash 의 미분류 형태를 기록하지 않으므로 과장이다.
- `tests/hooks/tool-tracker-loop-state.test.js` 헤더의 "The flush happens when a loop is detected (or at every 10th call inside one process)" 는 정확하나, 그 결과 cold start 가 영구히 flush 되지 않는다는 점은 적지 않는다.

## 3. P1/P2 항목 — 이미 있는 것과의 대조

| ID | 01 처분 | 이미 있는 것(실측) | 판정 |
|---|---|---|---|
| IMP-08 SessionStart | MEASURE → TUNE | NEXT-SESSION v4.71.11: 부하 조건별 4~8회 실측, "결정: 유지 — 코드 변경 없음", 규칙(`--maxWorkers=8`)·감시 조건(`session-digest` 3→5 s) 기록 | REJECT(이미 종결) |
| IMP-09 단순 질의 과팀 | MEASURE → BYPASS | `artibot.config.json#team.autoApplyTriggers`: OR · minSubtasks 3 · minFiles 3 · minComplexity high · bypassIntents 4종(2026-05-03) — 우회는 구현됨. "SIMPLE 에 팀 발화" 비율은 미측정 | DEFER(새 BYPASS) · MEASURE(원장 `topology.selected`) |
| IMP-10 /split 비용 | MEASURE → ON_DEMAND | RESCOPE §2: SH-12 는 진짜 `/split` 레인 필요 · ADR-011 worktree ledger · `scripts/ledger/topology-agreement.mjs` | MEASURE(기존) |
| IMP-11 메모리 재사용·오염 | MEASURE | 원장 어휘에 `memory.candidate/dedup/validated/promoted/rejected` 등재; 전용 판독기는 `scripts/ledger/` 에 없음 | MEASURE(판독기 1개 필요) |
| IMP-12 SessionEnd 학습 소비 | MEASURE → SHADOW | `scripts/hooks/session-end.js#runEvolutionLoop`(`:326-351`) 가 `lib/learning/evolution-loop.js` 호출 — 01 AS-IS 경로 3 정확. "다음 세션 소비" 는 Existence Audit 의 CARRIERS 에 `modules: null` 로 측정 불가 | DEFER(측정 설계 선행) |
| IMP-13 스킬 오탐 | MEASURE → TUNE | `scripts/ci/lint-skill-descriptions.js`(R1 trigger floor · R2) · nl-activation eval(SH-03) | MEASURE(기존) |
| IMP-14 ID 정합 | ALIGN | 봉투 `schemas/ledger-envelope.schema.json`: mission_id · session_id · action_id · task_id · run_id · routing_epoch_id · idempotency_key. autopilot `sessionId`(ap-…)·`attemptId` 는 봉투 밖(세션 스토어) | PARTIAL(05 D-04 가 attempt 결합 1키만 필요) |
| IMP-15 config 소비처 | AUDIT | `scripts/ci/triage-wiring-gaps.mjs`(config-only 분류) · `tests/firewall/v5-config-firewall.test.js` | PARTIAL(대상 키 목록 확장) |
| IMP-16 중복 리뷰 | EVIDENCE → MERGE | VERIFICATION-ECONOMICS §2.3(A3) NECESSARY, 수정 대상·순서 명시 | REJECT(중복 → 그 문서로) |
| IMP-17 모델 선택 | SHADOW → A/B | MODEL-SWITCHING-SCORECARD · `scripts/ledger/route-compare.mjs` · CA-18 `model.switched` 0 → 0/0 unmeasured | REJECT(중복 → 그 문서로) |
| IMP-18 드리프트 | FIX DOC DRIFT | §2.8 의 2건 | PARTIAL(05 Wave 1 에 동반) |

## 4. 02 프로토콜 검증

- **산식**: 검증 성공당 비용 ΣC/ΣS(ΣS=0 → N/A), 성공률 차이 병기, 월 순편익 V×u−F−E, 손익분기 (F+E)/u — 산술 오류 없음. 교육용 수치 검산: .80/1.40 → 1.75, .90/1.70 → 1.889 일치. `.artibot/project.md` 원칙 10 "Outcome Economics — Cost per Accepted Outcome [없음]" 을 직접 채우는 산식이라 가치가 있다.
- **§4 attempt 레코드는 둘째 진실원이다**. 기존 `usage.receipt`(`schemas/attempt-receipt.schema.json`)·봉투·`verify.completed` 와 겹친다:

| 02 §4 필드 | 기존 위치 |
|---|---|
| input_tokens · cache_read_tokens · cache_creation_tokens · output_tokens | `usage.fresh_input_tokens` · `cached_input_tokens` · `cache_creation_tokens` · `output_tokens` |
| cost_usd · cost_basis | `cost.total` · `cost.pricing_version`(+ 환산 라벨은 05 D-06) |
| model_id · run_id | 봉투 `model` · `run_id` |
| hook_timeout_count | `hook.fired.data.failed` |
| agent_count | `route.bound` 행 수 |
| wall_minutes | `wallclock.started/ended` |
| verified_pass | `verify.completed` result=pass(결정적 층) + 숨김 검사 결과(실험 매니페스트) |
| base_git_sha · final_git_sha · host_version · human_minutes · measurement_status | 기존 없음 → 실험 매니페스트(05 §4) |

결론: 새 스키마가 아니라 **실험 매니페스트(10여 필드) + 원장 조인**이다.

- **B 군(플러그인 미로드) 측정 가능성**: `scripts/ledger/usage-cost-table.mjs` 의 USAGE(`:26-28`) 에 `--live-session <id>` · `--projects-dir <dir>` 가 있고, "the session's transcript … is folded straight into receipts by the same builder SessionEnd uses"(`:49-66`) 라고 적는다 → B 군 프로필의 `projects/` 를 가리켜 사후에 **같은 영수증 형**을 얻을 수 있다(추론 — 실행은 미확인, 05 Wave 5 시운전 항목).
- **Phase 0 진행**: 항목 1(별도 프로세스 10회 루프)·2(`cd dir && npm test`·환경변수 prefix)·3(VERIFY done 증거 없음)·5(파손 JSON 에서 silently OFF)는 이 보고의 EXP-A~D 가 곧 그 재현이다(API 호출 0). 4·6~12 는 잔여.
- **예산**: NEXT-SESSION v4.71.11 에 오너의 "누적 $6 중단선"(promptfoo PoC 본 평가 보류) 이 기록돼 있다. 02 Phase 1(최대 24실행) 은 그 선을 넘으므로 "사용자가 상한을 정한 뒤" 는 이 결정의 재론으로 구체화한다.
- **RUNBOOK 과의 관계**: [MEASUREMENT-RUNBOOK](../MEASUREMENT-RUNBOOK.md) 은 **같은 프로젝트에서 T0(스위치 OFF) → ON 전후를 원장 판독기로 재는 관측 연구**(v5.1 트랙, [V5-RESCOPE-20260930](../V5-RESCOPE-20260930.md) §1 오너 결정)이고, 02 는 **격리 프로필을 짝지은 통제 실험**이다. 상충하지 않는다. C 군 측정은 RUNBOOK 의 판독기 5종(`verify-rate`·`session-coverage`·`route-compare`·`outcome-census`·`topology-agreement`)을 그대로 쓰고, 결과 보관은 [evidence/README](../evidence/README.md) 관례를 따른다. README 의 "수정하거나 대체하지 않는다" 는 참이지만 **왜 둘이 공존하는지**는 02 에 없다.

## 5. 연결성 감사표 (03 최종 산출물 계약 1)

D0 코드 존재 → D1 등록 → D2 발화 → D3 출력 → D4 소비 → D5 행동 → D6 검증된 가치. ✓ 참 · ✗ 거짓 · △ 부분 · ? 미확인.

| 사슬 | D0 | D1 | D2 | D3 | D4 | D5 | D6 |
|---|---|---|---|---|---|---|---|
| 루프 감지 | ✓ `lib/cognitive/loop-detector.js` | ✓ `hooks/dispatch-table.json` PostToolUse `tool-tracker` tools `*` + PostToolUseFailure 직접 등록 | ✓ 격리 EXP-A 6/6 실행(라이브는 `hook.fired` 행으로 셀 수 있으나 이 체크아웃엔 원장 없음 — ?) | ✗ 파일 미생성 · stderr 0 | ✗ 소비처 0 | ✗ | ✗ |
| Bash 학습 행 | ✓ | ✓ | ✓ | △ 선두 토큰 11종만 | ✓ `lib/learning/tool-learner.js` · `lifelong-learner.js` | ? 추천 소비 미확인 | ? 미측정 |
| REPORT 규칙 6 | ✓ | ✓ `lib/autopilot/engine.js` REPORT 경로 | ✓ enforce 출하 true | ✓ 코드 6종 | ✓ pause | △ 명시 FAIL 만 거부 | ✗ UNMEASURED 통과 |
| 게이트 config | ✓ | ✓ | ✓ | ✗ invalid 와 off 가 같은 출력 | — | △ fail-open | ✗ |
| 사용량 영수증 | ✓ `lib/economics/usage-receipt.js` | ✓ SessionEnd `session-end.js#recordUsageReceipts` | ✓ 라이브 PASS(OB-08) | ✓ `usage.receipt`(source 등급) | ✓ `usage-cost-table.mjs` · scorecard | — 관측 전용 | △ coverage 83.7~92.3% < 95% |

## 6. 문서 자체의 정합성

- 01 §1 AS-IS 경로 1~5 는 실측과 일치한다(경로 3 의 evolution-loop 호출은 `session-end.js:326-351` 확인).
- 01 §2 IMP-04 의 규칙 요약은 규칙 5(열린 VERIFY 슬롯 → `VERIFY_NOT_ACKED`)를 생략했다. 결론에는 영향 없다.
- 01 §3 표의 "[코드 확인]" 중 IMP-06 은 "결함 확인" 이 아니라 "이미 구현됨" 으로 읽어야 한다.
- README 의 "V5-BACKLOG 완료율에 합산하지 않는다" 는 정합하다. 다만 백로그 §3 "기술 부채·안전 결함 트랙(로드맵 밖, 진행률 불산입)" 이 IMP 항목의 자연스러운 거처이므로 05 §7 에서 오너 결정으로 올린다.
- 02 §7 의 URL 5개 중 hooks · cli-reference · monitoring-usage 3개는 2026-10-23 curl 로 응답을 확인했고, agent-teams · skills 2개는 조회하지 않았다(미확인).

## 7. 재현 — 스크립트와 출력 원문

실행 환경: Linux 컨테이너, Node v22.22.0, 체크아웃 `6149446e`. 모든 HOME 은 임시 디렉터리. 재생성 비용이 초 단위라 [evidence](../evidence/README.md) 폴더에 넣지 않고 여기 적는다.

**EXP-A (IMP-01)** — 빈 HOME, 같은 Read payload 6회:

```bash
PR=/path/to/plugins/artibot; H=$(mktemp -d)/home; mkdir -p $H/.claude
P='{"hook_event_name":"PostToolUse","tool_name":"Read","tool_input":{"file_path":"/tmp/x/loop-subject.js"},"tool_response":{"content":"a result that is long enough to count as substantive output"},"session_id":"sess-exp-a","cwd":"/tmp/x"}'
for i in 1 2 3 4 5 6; do env -i PATH="$PATH" HOME="$H" USERPROFILE="$H" CLAUDE_PLUGIN_ROOT="$PR" ARTIBOT_HOOK_FIRED_DIRECT=off node "$PR/scripts/hooks/tool-tracker.js" <<<"$P"; echo "exit=$?"; done
ls "$H/.claude/artibot/loop-state.json"; find "$H" -type f
```

출력: `exit=0` ×6, stderr 없음, `ls: cannot access '.../loop-state.json': No such file or directory`, 생성 파일 = `daily-experiences.json` · `tool-history.json`.

**EXP-B (IMP-03)** — Bash payload 6문형(`tool_response: {stdout, exit_code: 0}`), 각 호출 전후 `tool-history.json` 바이트 비교: `npm test` +377B · `cd plugins/artibot && npm test` 0 · `CI=1 npm test` 0 · `npx vitest run tests/x.test.js` +171B · `bash scripts/run.sh` 0 · `echo hi | grep h` 0. 기록된 contexts: `bash:test:shell`, `bash:execute:shell` (명령 본문 없음).

**EXP-C (IMP-04)** — `evaluateReportVerifyEvidence` 를 §2.4 저널(EXECUTE started/acknowledged, VERIFY started/acknowledged reason `done`, `activePhaseAttempt: null`)에 verifyResult 9형으로 호출. 결과는 §2.4 표 그대로(`ok` 7 · `VERIFY_RESULT_FAILED` 2).

```js
import { evaluateReportVerifyEvidence } from '<plugin>/lib/autopilot/report-verify-gate.js';
const journal = [
  { attemptId: 'e1', phase: 'EXECUTE', event: 'started', at: 1000 },
  { attemptId: 'e1', phase: 'EXECUTE', event: 'acknowledged', reason: 'done', at: 1001 },
  { attemptId: 'v1', phase: 'VERIFY', event: 'started', at: 1002 },
  { attemptId: 'v1', phase: 'VERIFY', event: 'acknowledged', reason: 'done', at: 1003 },
];
for (const vr of [null, undefined, {}, 'FAIL', { status: 'fail' }, { mcp: { ok: false } }, { summary: 'tests not run' }, { status: 'FAIL' }, { ok: false }])
  console.log(evaluateReportVerifyEvidence({ attemptJournal: journal, activePhaseAttempt: null, verifyResult: vr }).code);
```

**EXP-D (IMP-05)** — `CLAUDE_PLUGIN_ROOT` 를 (유효 플러그인 루트) / (`artibot.config.json` 이 깨진 JSON 인 디렉터리) / (파일 없는 디렉터리) 로 바꿔 `loadReportVerifyGateConfig()` 호출 → `{"enforce":true}` / `{"enforce":false}` / `{"enforce":false}`.

**호스트 문서(2026-10-23 curl)**: `https://code.claude.com/docs/en/hooks.md`(exit 0 stderr 비가시 · PostToolUse decision control · PreToolUse permissionDecision · 서브에이전트 훅 발화), `https://code.claude.com/docs/en/cli-reference.md`(`--bare` · `--safe-mode` · `--restricted` · `--setting-sources` · `--plugin-dir` · `--max-budget-usd` · `--effort` · `--output-format` · `--include-hook-events`), `https://code.claude.com/docs/en/monitoring-usage.md`(OTel 토큰 속성), `https://code.claude.com/docs/en/settings.md`(`CLAUDE_CONFIG_DIR`).

## 8. 미확인 (추측으로 메우지 않음)

- 사용자 PC(Windows)에서의 재현 — 여기는 Linux 컨테이너다. 경로·원자 쓰기·프로세스 기동 지연이 다를 수 있다.
- 라이브 분모 전부: 빈 verifyResult 로 REPORT 에 도달한 세션 비율 · `bash:unknown` 이 될 Bash 호출 비율 · PostToolUse 일일 디스패치 수(2026-09-15 의 ≥679 는 인용값) · 루프 warn/block 실빈도. 이 체크아웃에는 `runtime/`·원장·세션 스토어가 없다.
- 사용자 PC 의 `claude` 바이너리 버전과 위 플래그의 실제 존재 — 문서만 확인했다.
- `usage-cost-table.mjs --projects-dir` 로 B 군 transcript 를 실제로 접을 수 있는지 — 실행하지 않았다.
- PostToolUse `hookSpecificOutput.additionalContext` 가 설치본 호스트 버전에서 모델에 도달하는지 — 문서만.
- 호스트가 서브에이전트 PostToolUse payload 에 어떤 `session_id` 를 주는지(메인과 같은지, 다른지) — 픽스처 `tests/hooks/fixtures/host-payloads/PostToolUse.Skill.json` 은 메인 스레드 2행이다.
- 02 §7 의 agent-teams · skills 문서.
