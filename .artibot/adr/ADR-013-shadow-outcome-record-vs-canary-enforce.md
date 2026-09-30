---
status: active
created: 2026-09-29
number: 13
---

# ADR-013: Shadow 의 outcome.md(accepted:null) 생성은 기록 산출 — Canary #14 완료 게이트 강제(CA-13)와 분리

## 추천 결론 (TL;DR)

> **Shadow 단계의 outcome.md(accepted:null) 생성은 기록 산출이며, Canary §48 #14 완료 게이트 강제(CA-13)와 다르다 — 이 해석을 채택한다.** 정본은 둘을 같은 파일·같은 핸들러("outcome.md 생성기")로 가리키지만 **거부하는 대상이 다르다.** Shadow 쪽은 *기록물*을 거부한다: 조건이 안 서면 파일을 쓰지 않고 그 사실을 센다(세션·도구·훅 결정은 건드리지 않는다). Canary 쪽은 *작업 흐름*을 거부한다: 근거 없는 REPORT 를 받지 않고 세션을 PAUSED 로 되돌린다. 코드도 이미 그렇게 갈라져 있다 — 킬스위치 2개, 모듈 2벌, 입력 2종, 실패 표면 2종(§1-3). 이 ADR 은 V5-BACKLOG §4-b 의 SH-01 플립 조건 **d** 의 증거이고 **백로그 §4-h D3(Shadow 진입 플립)를 열지 않는다**: a-④ 를 포함한 나머지 조건은 그대로다.

## Status

Accepted — 2026-09-29. 결정 문구(§5-1)는 리더(artibot-68)가 R2-10 으로 승인해 이 줄기에 지시한 문장을 글자 그대로 옮겼다(웨이브 2 계획서의 R2-10 항목은 같은 취지에 괄호 보충이 붙은 판본이다). 계획서는 리더의 로컬 문서(미추적)라 여기서는 경로를 인용하지 않는다. **오너의 개별 확인은 받지 않았다(미확인).** 이 ADR 은 문언을 확정할 뿐 코드·config·V5-BACKLOG 행 status 를 하나도 바꾸지 않는다.

**번호 확인**: ADR-013 은 비어 있었다(2026-09-29T06:01Z 실측, 이 문서의 기준 커밋 `eae2cf09`). `git log --all --diff-filter=A --name-only -- ".artibot/adr/ADR-013*"` 0건, `git ls-tree` 로 본 master·origin/master 의 `.artibot/adr/` 는 001~012 + INDEX.md, 다른 워크트리 22곳과 메인 체크아웃의 `.artibot/adr/` 에 `ADR-013*` 없음. `artifact-governance` #2 의 ADR 번호 계열 충돌 게이트와도 겹치지 않는다(계열 1개).

작성일: 2026-09-29
작성자: v5 마무리 웨이브 2 · 줄기 W2-4 `sh01-d-outcome-adr` (SH-02, §4-b 조건 d)
검수: architect 1차 검수 = REVISE (결정 A 유지, 문서 수정 전용·코드 0). 작성자는 이 문서를 스스로 검수하지 않았다. 재검수 여부는 리더가 정한다.
개정 1 (2026-09-29, architect REVISE 반영): (R1) CA-13 비고를 "이 선을 그은 것" 이 아니라 **읽기 1 의 근거**로 귀속을 바로잡았다(§1-2·§1-3·§6). (R2) 파일명 grep 이 못 잡던 **디렉터리 존재 소비자**(`worktree-manager` 의 보존)와 **LLM 매개 소비자**를 §1-4 에 축으로 추가하고 §5-3 을 "완료의 뜻으로 읽는" 효과로 한정했다. (이름) 백로그 §4-h D3 와 설계 §5 D3 를 표기로 갈랐다. (선택) 설계 :406 괄호의 읽기, 설계 §7.3 Observe #2, 설계 :222 앵커를 더했다. 결정은 바뀌지 않았다.

관련 ADR: ADR-011(원장 위치 — 이 ADR 이 센 중앙 원장의 물리 위치 `<git-common-dir>/artibot/ledger.jsonl`).

---

## 1. Context (컨텍스트와 제약사항)

표기: **설계** = `.artibot/guides/v5-design/ARTIBOT-5.0-DESIGN.md`, **백로그** = `.artibot/guides/v5-design/V5-BACKLOG.md`. 아래 `:NN` 은 기준 커밋 `eae2cf09` 의 줄번호이고 줄번호는 편집되면 썩는다 — 심볼을 함께 적었다. 이미 움직인 곳도 있다: 이 ADR 을 쓰는 사이 master 가 `491a4de8` 로 나아가 백로그는 :252 뒤가 +1줄, 설계는 :323 뒤가 +2줄 밀렸고 `lib/runtime/artifact-lifecycle-gates.js` 는 W1-2 로 파일 안쪽이 크게 이동했다(`git diff eae2cf09 master -U0` 실측). 이 표기는 기준 커밋 좌표를 그대로 쓴다. 등급은 **실측**(이 줄기가 직접 실행·열람) / **추론** / **미확인** 이다.

### 1-1. 무엇이 막혀 있나

백로그 §4-b(:269)는 `runtime.artifactLifecycle.enabled`(SH-01, Shadow 진입 릴리스)의 단독 플립을 NO-GO 로 두고, 플립 전에 참이어야 할 것을 a~g 로 열거한다(:275). 그중 **d** 는 "outcome.md(`accepted:null`) writer 개방이 Canary '#14 생성기'와 다르다는 해석 확정" 이다. §4-c 는 "SH-01 d 해석 문서" 를 미확인 항목으로 남겼다(:298). 그래서 오너 결정 D3(§4-h, :400)는 "조건 a(Observe ③④)·d·e·f 미충족. 강제 플립은 게이트 위반이다" 로 보류돼 있다. master `491a4de8` 의 백로그 §4-j 도 "R-10 의 d(해석 문서)는 이 batch-1 시점 미반영" 이라 적는다 — 이 ADR 이 그 d 의 산출이다.

> 용어 주의: 이 문서의 "D3"는 백로그 §4-h D3(Shadow 진입 플립)다. 설계 §5 결정표의 D3(설계 :308, "Accepted Outcome 최소 정의 + 관측창 7일")와 이름만 같다. 코드 헤더가 말하는 "design §D3"(`scripts/hooks/mission-complete-record.js` 헤더 ③)는 후자다.

### 1-2. 정본 안에서 같은 이름이 어디에 붙어 있나

| 위치 | 문구(요지) | 이 ADR 의 읽기 |
|---|---|---|
| 설계 §7.3 Observe 행 (:404) | "#2 Mission Controller(기록 전용 — 전이 결정은 Canary)" · "#14 completion gate(카운트)" … "산출물 파일 생성 0" | 같은 표가 기록과 전이 결정을 단계로 가른다. #14 의 1단은 카운트다 |
| 설계 §7.3 Shadow 행 (:405) | "#10 artifact-lifecycle(이벤트→intent/plan/review/outcome.md — Shadow 에서 시작 …)" | outcome.md 를 쓰는 것은 Shadow 항목이다 |
| 설계 §7.3 Canary 행 (:406) | "#14 완료 게이트 강제(outcome.md 생성기)" — 행동 변화, config 1키 되돌림 | 같은 "생성기" 가 Canary 항목으로도 나온다 |
| 설계 §8.4 (:504, :505) | Shadow "#11 Final Scorecard(outcome.md 트리거)" / Canary "#15 Completion Gate 강제" | Shadow 의 스코어카드가 outcome.md 를 요구한다 |
| 설계 §3.4 ① (:180) | "완료 정의 = outcome.md 생성 조건 … 원장만 있고 outcome.md 가 없으면 완료가 아니라 원장 오염" | 존재=완료의 강제형 서술 |
| 설계 §3.4 (:184) | "Shadow 는 'outcome.md 조건을 적용했다면 막혔을 건수 / 완료 선언 총수'" | Shadow 의 척도는 계수다 |
| 설계 §3.6 (:222) | `mission.completed{accepted:null}` 먼저, 창 만료 시 `{accepted:true\|false, supersedes}` 덧붙임, KPI 분모는 non-null 만 | null 줄은 판정 유예 선언이다 |
| 백로그 CA-13 제목·선행 (:150) | 제목 "완료 게이트 강제 = outcome.md 생성기(§48 #14 · §55 #15)", 비고 첫머리 "SH-02·SH-20 선행" | 이름은 같아도 선행 순서는 SH-02 → CA-13 |
| 백로그 CA-13 비고 (:150) → 읽기 1 | evidence 칸은 outcome-md-emitter(`686df95b`, 줄기 `6d612dbf`)를 "생성기 + gates `requiredLayers`(C4 (i)) 착지" 로 CA-13 에 세고, 비고의 2026-09-29 정정은 종전 "강제(생성 거부)는 미적용" 을 틀렸다고 하며 `processMission` 이 이미 파일을 쓰지 않는다고 적는다 | **읽기 1 의 근거** — 생성 거부를 CA-13 의 강제로 센다. 이 ADR 채택 시 그 문구는 갱신 대상이다 |

정본은 #14 를 **두 단**(Observe 카운트 → Canary 강제)으로 놓았고 outcome.md 파일 자체는 #10 으로 Shadow 에 놓았다. 침묵하는 곳은 하나다 — **Shadow 에서 outcome.md 를 실제로 쓰는 것이 #14 '강제'에 해당하는가.** 두 읽기가 다 가능하다.

- 읽기 1: 생성기의 거부가 곧 강제다. 설계 :180 은 생성기 하나가 오판 경로 A·A′·B·C 를 동시에 무력화한다고 쓰고, 백로그 CA-13 evidence·비고(:150)도 생성 거부를 CA-13 의 강제로 센다.
- 읽기 2: 강제는 그 산출을 근거로 흐름을 바꾸는 소비자 쪽에 있다. 설계 :184 는 Shadow 의 척도를 "적용했다면 막혔을 건수" 로 쓴다. 설계 :406 의 괄호 "(outcome.md 생성기)" 는 두 번째 생산자가 아니라 Canary 소비자가 읽을 **증거**를 가리킨다고 읽는다 — 설계 문구가 스스로 그렇게 말하지는 않는다(이 ADR 의 해석, 추론).

이 ADR 은 읽기 2 를 택한다(§5). 근거는 아래 1-3~1-5 와 §2.

### 1-3. 코드는 이미 두 갈래다 (실측, `eae2cf09`)

| 축 | Shadow 기록 경로 (SH-02) | Canary 강제 경로 (CA-13) |
|---|---|---|
| 실행 지점 | SessionEnd 디스패처 자식 `scripts/hooks/mission-complete-record.js` (`hooks/dispatch-table.json:79`) | `lib/autopilot/engine.js:560` (`runPhase6Report` 안 `gateReportOnVerify`) 와 `lib/autopilot/engine-state.js:159` (`recordPhaseResult` 안 `refuseRecordedReport`) |
| 입력 | 원장 행(`verify.completed`·`review.completed`·`human.*`) + StateStore 행 + 디스크의 `plan.md`·`review.md` | `state.attemptJournal`(VERIFY·EXECUTE 시작 행과 ACK 행) + 열린 `activePhaseAttempt` 슬롯뿐 (`lib/autopilot/report-verify-gate.js` 헤더 "Evidence rule") |
| 스위치 | `runtime.artifactLifecycle.enabled`(출하 false) **AND** 프로젝트 마커 `.artibot/artifact-lifecycle.optin` (`lib/runtime/artifact-lifecycle.js#resolveArtifactGate`) | `autopilot.reportVerifyGate.enforce`(출하 false, 리터럴 true 만 ON) |
| OFF 일 때 | 파일 0. 원장의 선언 줄과 stderr 사유 줄은 계속 남는다 (`declareCompletion` 은 게이트와 무관, `writeOutcome` 만 게이트를 본다) | 평가 자체를 안 한다 — 틱·persist 없이 바이트 불변 (`gateReportOnVerify` 가 null 반환) |
| 거부의 결과 | 파일을 안 쓴다 + `block=<코드>` 한 줄. stdout 0바이트, exit 0 (헤더 :32-35) | 세션이 PAUSED (`pausedReason report-verify-evidence-missing:<code>`, `pendingPhase VERIFY`) — 재개하면 VERIFY 부터 다시 |
| 측정 | `scripts/ledger/outcome-census.mjs` — 완료 선언 대비 막혔을 건수, 읽기 전용 | 저장된 세션 상태에 오프라인으로 `lib/autopilot/report-verify-gate.js#evaluateReportVerifyEvidence` |
| 정본 위치 | 설계 :405 · 백로그 SH-02 (:104) | 설계 :406, :505 · 백로그 CA-13 (:150) |

- Shadow 쪽 헤더의 이 문장이 ADR 의 핵심이다: "THE PRODUCT OF THIS HOOK IS A DISTRIBUTION OF BLOCK REASONS, NOT FILES" (`scripts/hooks/mission-complete-record.js` 헤더 :23-30). 막힘은 산출물이 아니라 **센 값**이다.
- `lib/runtime/artifact-lifecycle.js` 헤더(:34-38)도 같다: "Blocked writes stay in `writes[]` … because 'what would have been blocked' is the Shadow metric". `apply()` 의 오류 문구(:569-574)는 산출 파일 생성 전체를 "Shadow-stage work (design §7.3 §48 #10)" 라고 부른다.
- 게이트 모듈은 스스로를 이렇게 정의한다: 게이트는 `BlockCode` 나 `undefined` 를 돌려줄 뿐 "never throws, never writes" 이고 "only whether a requested one may proceed" 를 판정한다 (`lib/runtime/artifact-lifecycle-gates.js` 헤더 :23-28). 같은 파일의 `blockCodeFor` JSDoc(기준 커밋 :503-514, master 에서는 :634 부근으로 이동)는 `intent.md`·`plan.md` 를 "*record* a revision" 이라 절대 막지 않고(`review.md` 는 intent 가 움직였을 때만 막힌다) **완료 게이트 전체는 `outcome.md` 만** 지닌다고 적는다. 막는 대상이 기록물이라는 뜻이다.
- CA-13 비고는 생성 거부를 **강제로 부른다**(읽기 1): 종전 비고 "강제(생성 거부)는 미적용" 을 2026-09-29 에 틀렸다고 정정하면서 `processMission` 이 이미 막힘 코드가 있으면 파일을 쓰지 않는다고 적었다(백로그 :150, `59dafab4` 재측정). 이 ADR 채택 시 그 문구는 **갱신 대상**이다(§6). 다만 결론은 같다 — 생성 거부가 이미 Shadow 생산자 안에 있으므로 **Canary 가 새로 더하는 것은 생성 거부일 수 없고**, 새로 생긴 강제는 REPORT 게이트(`5bf05a25`, fold `d914eda0`)뿐이다. 바뀐 것은 귀속이다: 이 사실은 CA-13 행이 읽기 2 를 지지해서가 아니라 **코드가 그렇게 되어 있어서** 성립한다.
- `accepted:null` 은 코드에서도 완료가 아니다: "`{accepted: null}` IS A TRIGGER, NOT A COMPLETION" (`mission-complete-record.js` 헤더 ③ :46-51), 파일 본문에도 "accepted: null — 판정 유예. 완료 선언이지 완료가 아니다" (`outcomeSections` :568-571), `lib/runtime/ledger.js#currentMission`(:477-493)은 null `accepted` 미션을 **열린 것으로** 읽는다.

### 1-4. 소비자 계수 — 완료의 뜻으로 outcome.md 를 읽어 흐름을 바꾸는 코드는 없다 (실측, 세 축)

**축 1 — 파일명으로 읽는 소비자.**

```
git grep -l -E 'outcome\.md|parseOutcomeMd|outcomeArtifactPath' -- . ':!plugins/artibot/tests' ':!.artibot/guides' ':!.artibot/adr' ':!CHANGELOG.md' ':!plugins/artibot/CHANGELOG.md'
```

기준 `eae2cf09`, 2026-09-29T05:4xZ: 추적 파일 **22개**. 코드 12 + 문서·스키마 10(`README.md` 1 · `commands/` 3 · `docs/completion-block-spec.md` 1 · `schemas/` 5). 코드 12개의 분류:

- 쓰기·직렬화·재수출 5: `lib/runtime/artifact-lifecycle.js` · `lib/runtime/artifact-lifecycle-gates.js` · `lib/mission/outcome-artifact.js` · `lib/mission/index.js`(재수출) · `scripts/hooks/mission-complete-record.js`
- 읽기 전용 계수·진단·렌더 4: `lib/mission/outcome-gate-census.js` · `scripts/ledger/outcome-census.mjs` · `lib/project-state/doctor-checks.js`(`/doctor` Check 9 항목 6, FAIL 은 보고일 뿐) · `lib/scorecard/mission-scorecard.js`(존재 여부는 호출부가 `outcome_present` 로 넘긴다)
- 주석에서만 언급 3: `lib/review/verdict-writer.js` · `lib/verification/verify-writer.js` · `lib/verification/unified-verifier.js`

`mission.completed` 도 같다: 읽는 쪽은 `lib/runtime/ledger.js`(`applyOutcomeEvent`·`currentMission`), `lib/runtime/artifact-lifecycle-gates.js#foldGateState`, `lib/scorecard/mission-scorecard.js`, `lib/mission/outcome-gate-census.js` 이고, **`currentMission` 의 프로덕션 호출자는 0**(`git grep currentMission -- plugins/artibot/lib plugins/artibot/scripts plugins/artibot/hooks`, 정의·주석뿐). 전이·PAUSE·도구 허용·훅 stdout/exit 를 이 값들로 정하는 코드는 이 축의 범위에 없다.

**축 2 — 디렉터리 존재 소비자.** 축 1 의 grep 은 파일명을 쓰지 않는 코드를 못 잡는다. `.artibot/missions/` 를 경로로 읽는 코드를 따로 셌다.

```
git grep -n -E "['\"]missions['\"]|[./]missions[/'\"]|MISSIONS_DIR|missionsDir|missionsPresent|missions-present" -- plugins/artibot/lib plugins/artibot/scripts plugins/artibot/hooks
```

기준 `eae2cf09`: 47줄·16파일. 분류: **디렉터리를 읽는 코드 1**, 경로 조립·쓰기·래치 5(`lib/mission/outcome-artifact.js` · `lib/planning/plan-artifact.js` · `lib/review/review-artifact.js` · `lib/runtime/artifact-lifecycle.js` · `scripts/hooks/intent-observe-pre.js`), intent.md 를 파일 단위로 읽는 Shadow 내부 읽기 1(`scripts/hooks/_review-stop-record.js#resolveIntentBinding` 이 `missionDir` 을 바인딩 읽기에 넘긴다), 주석·무관한 키 9. 디렉터리를 읽는 1곳:

- `lib/autopilot/worktree-manager.js#hasMissions`(:511-519)가 `.artibot/missions` 가 비어 있지 않은지 보고, 그 값이 `describeWorktreeHead`(:551) → `reapLiveWorktree`(:664)의 `keep('missions-present')` 로 이어져 autopilot 워크트리를 **지우지 않고 보존**한다. 호출은 `lib/autopilot/engine-cleanup.js#reapSessionArtifacts` 이고, REPORT 가 COMPLETED 로 기록된 **뒤**(`lib/autopilot/engine.js:583`, 기록은 :564-565)와 abort(:970)에서 best-effort·비차단으로 부른다. 보존이면 `cleanup-preserved` warn 한 줄을 남긴다.
- 파일 종류를 가리지 않는다 — intent·plan·review·outcome 중 아무 파일이나 하나면 충분하다. outcome.md 의 존재나 값(`accepted`)을 읽지 않는다.
- **보존 전용**이다. 지우는 쪽으로 기울지 않고, 완료가 이미 기록된 뒤에 도는 정리라 완료 보고·전이·도구 허용을 건드리지 않는다 — 완료 게이트가 아니다.
- 그러나 Shadow 산출이 autopilot 워크트리의 수명에 닿는 **흐름 효과**다. 그래서 축으로 기록한다. SH-01 플립 조건 c(clean-tree)의 이웃이며 `tests/firewall/missions-clean-tree.test.js` 헤더(:11-17)가 `describeWorktreeHead` 를 "여기서 재지 않는다 — 미확인"으로 남겼다. 플립 뒤 보존되는 워크트리의 수(누적 규모)는 미측정이다.

**축 3 — LLM 매개 소비자** (코드가 아니라 커맨드 산문을 읽은 모델이 실행한다).

- `commands/resume.md:97` — opt-in `--read-order` 의 6단계가 outcome.md 를 resume 컨텍스트로 읽게 한다. 부재이면 `부재:` 단계가 생겨 HANDOFF 폴백(:99)이 켜진다(본문상) — 출력 선택만 바꾼다.
- `commands/scorecard.md:145` — outcome.md 가 없으면 throw 해서 최종 카드를 그리지 않는다. 존재만 보고 내용은 안 본다(:155).
- 둘 다 **코드 가드가 없다.** `accepted:null` 을 완료로 오독하지 않게 막는 것은 파일 본문의 문구("accepted: null — 판정 유예. 완료 선언이지 완료가 아니다", `outcomeSections`)뿐이다. (카드 안에서는 `lib/scorecard/mission-scorecard.js` 가 '완료 선언' 행과 'Result(수락 여부)' 행을 나누지만 그것은 내용 쪽 가드이고 트리거 쪽은 아니다.)

**이 계수가 못 보는 것**: 테스트·설계 문서·CHANGELOG 는 뺐다. 런타임에 경로를 동적으로 조립해 읽는 코드는 grep 으로 안 잡힌다 — 미확인(축 2 의 grep 이 그 틈을 좁혔을 뿐 닫지는 못한다). 위 분류는 파일 단위로 훑은 것이지 호출 그래프 증명이 아니다(추론). 축 3 은 커맨드 파일을 열어 읽은 것이고, 모델이 실제로 어떻게 실행하는지는 미확인이다.

### 1-5. 정본 안에 남아 있는 장력 3건 (해소가 아니라 기록)

1. **발행 순서**: `schemas/ledger-events.allowlist.json:677` 의 `mission.completed` spec 은 "This line is a fact derived AFTER outcome.md exists -- a ledger entry with no outcome.md is ledger contamination, not a completion (design §3.4)" 라 적고, 설계 :180 도 "원장 `mission.completed{accepted}` 는 파일이 쓰인 **뒤**의 파생 사실" 이라 적는다(= 파일이 먼저). 그런데 설계 :370(§7.2 §6)은 `mission.completed→outcome.md` — 이벤트가 파일을 낳는다 — 로 적고, 설계 :5 는 충돌 시 §7 이 §1~§5 를 덮어쓴다고 정했다. 라이브 코드는 §7.2 §6 을 따른다: `declareCompletion` 이 `{accepted: null}` 선언 줄을 **먼저, 게이트와 무관하게** 쓰고 파일은 게이트가 열렸고 막히지 않았을 때만 그 뒤에 쓴다(오너 결정 W11-Q4 (a), 설계 :1095, 2026-09-15: "SessionEnd 유도 판정. 세션 미션 중 `verify.completed ≥1 ∧ mission.completed 0` 이면 발행"). 앞 두 문장은 갱신되지 않았다. 이 ADR 은 순서를 바꾸지 않는다. **읽는 법**: 그 두 문장은 *수락된* 완료(비-null `accepted` 줄)와 Canary 의 소비자 측 읽기에 해당하고, Shadow 의 null 줄은 "선언"(분모)이다. 앵커는 설계 :222 다 — accepted 의 정의가 "`verify.completed=pass ∧ review.completed=pass ∧ 관측창 내 미되돌림 ∧ outcome.md 존재`" 이고 `mission.completed{accepted:null}` 이 **먼저** 온다. 곧 outcome.md 의 존재는 *수락*의 구성 조건이지 *선언*의 조건이 아니다.
2. **존재=완료**: `lib/mission/outcome-artifact.js` 헤더(:17-25)는 설계 :180 이 "this file's EXISTENCE the definition of completion" 이라 옮기고, 같은 헤더 :32-34 는 `{accepted: null}` 이 트리거일 뿐이라고 적는다. 두 문장은 **서로 다른 단계의 문장**이다 — 전자는 Canary 규칙, 후자는 Shadow 파일의 성격이다(앵커: 위 1 의 설계 :222).
3. **이름 충돌**: §1-1 의 D3 두 개.

### 1-6. 라이브 상태 (실측, 2026-09-29T05:58~05:59Z)

- 설정: `plugins/artibot/artibot.config.json#runtime.artifactLifecycle.enabled` = `false` (:1120), `plugins/artibot/artibot.config.json#autopilot.reportVerifyGate.enforce` = `false` (:768). JSON 파싱으로 확인. `review.verify.requiredLayers` = `["deterministic"]`, `unmeasuredBlocksOutcome` = `true` (:893-894).
- 파일: 메인 체크아웃의 `.artibot/` 에 `missions/` 디렉터리가 없다(`ls`, 05:4xZ) → 라이브 outcome.md 는 0 이다. 출하 false 이므로 정답이다.
- 원장 줄: `.git/artibot/ledger.jsonl` 에서 Grep 계수(05:59Z) `"event":"mission.completed"` **39줄**, 그중 `.*"accepted":null` **39**, `.*"accepted":(true|false)` **0**. 프로덕션과 프로브 출처는 구분하지 않았다. 비-null `accepted` writer 도 코드에 없다(`git grep -E "accepted:\s*(true|false)\b" -- plugins/artibot/lib plugins/artibot/scripts plugins/artibot/commands plugins/artibot/hooks` 0건; `lib/scorecard/mission-scorecard.js` :255-266 도 "non-null writer 는 리포에서 확인되지 않았다"고 적는다).
- **Shadow 척도** — `node plugins/artibot/scripts/ledger/outcome-census.mjs` (리포 루트 cwd, 읽기 전용) 05:58:56Z: missions **194**, declared **39**, blocked **39**, would_write **0**, by_block_code `STATE_ROW_ABSENT` 30 · `ARTIFACT_ABSENT` 9, blocked_ratio **1**. 곧 완료 선언 39건 전부가 "outcome.md 조건을 적용했다면 막혔을" 건이고, 이것이 Shadow 가 지금 내는 산출이다 — 파일 0, 분포 1개. 이전 값(백로그 §4-c, 2026-09-21, 인용·재측정 아님): declared 16 / blocked 16 (STATE_ROW_ABSENT 14 · ARTIFACT_ABSENT 2) (:298).
- **D3 조건 a-④** — `node plugins/artibot/scripts/ledger/session-coverage.mjs` (리포 루트 cwd) 05:58:28Z: ended **59**, with_receipts **46**, coverage **0.780**, skipped 13(전부 `no-receipts`). 임계 95% 미달이다(§4-c 결정 (2): "95% 유지 + ended ≥50 재판정", 백로그 :296).

**관측치 정합성**: (1) Grep 39줄 = census declared 39 — 중복 선언 줄은 없다. (2) blocked 39 = 30 + 9 ✓. (3) would_write 0 은 설정 false·`missions/` 부재와 함께 성립한다. (4) 비-null 0 은 writer 부재와 정합한다. (5) ended 59 − with_receipts 46 = skipped 13 ✓. 모순 없음. 다만 막힘 사유 2종(StateStore 행 부재, 상류 plan/review 산출 부재)은 outcome 스위치가 아니라 상류 산출에 달려 있으므로, 플립만으로 파일이 생긴다고 기대하면 안 된다(추론).

---

## 2. Alternatives Considered (검토한 선택지)

이 ADR 을 쓰는 동안 비교한 선택지다. 리더·오너가 다른 안을 따로 검토했다는 뜻이 아니다.

### 선택지 A: 기록과 강제를 분리한다 (읽기 2) — **채택**
- **내용**: Shadow 의 outcome.md 는 기록물이다. 생성 조건이 안 서면 쓰지 않고 센다. 강제는 그 산출(또는 다른 근거)을 읽어 흐름을 바꾸는 소비자에 있고 Canary 에서 자기 스위치로 켠다.
- **장점**: 설계의 단계 정의와 맞는다(Shadow 행동 변화 0 — 설계 :256, Canary 행동 변화·1키 되돌림 — 설계 :257). 코드가 이미 이렇게 갈라져 있어(§1-3) 변경이 0이다. 두 플립이 독립으로 검증·롤백된다. 백로그가 이미 CA-13 의 선행을 SH-02·SH-20 으로 적었다(:150).
- **단점**: 설계 :180 "존재=완료"·allowlist :677 의 문구와 이 해석 사이의 장력은 해소되지 않고 관리된다(§1-5).

### 선택지 B: 동일시한다 (읽기 1) — 기각
- **내용**: Shadow 플립을 #14 강제의 시작으로 본다. 생성기가 파일을 안 쓰는 것 자체가 강제다.
- **장점**: 설계 :180 의 문구에 가장 글자 그대로 맞는다.
- **단점**: (1) Shadow 에 행동 변화를 들이는 해석이라 설계 :256 과 충돌한다. (2) CA-13 은 SH-02·SH-20 이 선행인데(:150) B 는 D3 를 CA-13 의 플립 선행 조건(W29 후속 #15·#22, 백로그 :244·:251 모두 todo)에 묶어 **순환**이 된다. (3) 그러면 D3 는 CA-13 플립 전까지 열 수 없다.
- **적합한 경우**: 오너가 "파일 미생성 자체가 강제"라고 명시적으로 결정할 때. §7 의 재검토 트리거다.

### 선택지 C: outcome.md 를 Shadow 쓰기 목록에서 빼 Canary 로 이월한다 — 기각
- **장점**: 플립 한 번에 파일 3종(intent·plan·review)만 생기므로 d 를 물을 필요가 없다.
- **단점**: (1) 설계 :405, `apply()` 의 문구(`lib/runtime/artifact-lifecycle.js` :569-574), 설계 :504(Shadow 의 Final Scorecard 가 outcome.md 를 트리거로 씀)에 어긋난다. (2) SH-20 의 done 조건(백로그 :122 "outcome.md 실재 + 라이브 렌더 1회")이 Canary 뒤로 밀린다. (3) 4개 산출 훅 중 하나만 빼려면 결국 D 가 필요하다.

### 선택지 D: outcome 전용 킬스위치를 신설한다 — 보류
- **내용**: `runtime.artifactLifecycle` 아래에 outcome 만 따로 여는 키를 둔다.
- **장점**: 폭발 반경을 더 잘게 나눈다.
- **단점**: d 는 반경이 아니라 **해석**을 묻는다 — 키를 나눠도 "같은 것인가" 는 남는다. `apply()` 의 게이트 2(전역+마커; 게이트 셋은 dryRun · 전역+마커 · `write===true`, `lib/runtime/artifact-lifecycle.js` :516-538)를 산출 종류별로 갈라야 하고 `resolveArtifactGate` 와 산출 훅 4곳을 고쳐야 한다(추론: 호출부 4곳은 `write: true` 를 넘기는 프로덕션 훅 수 — `git grep -n "write: true" -- plugins/artibot/scripts` 실측).
- **적합한 경우**: 오너가 Shadow 진입을 산출 종류별로 단계 개방하기를 원할 때. 이 ADR 이 막지 않는다.

| 기준 | A | B | C | D |
|---|---|---|---|---|
| Shadow 행동 변화 0 (설계 :256) | 충족 | 위반 소지 | 충족 | 충족 |
| SH-20 트리거(설계 :504) 보존 | 충족 | 충족 | 위반 | 충족 |
| D3 가 CA-13 에 종속되지 않음 | 충족 | 위반 | 충족 | 충족 |
| 코드 변경 | 0 | 0 | 산출 훅·`apply` | 스위치·훅 4곳 |
| d 에 답하는가 | 답함 | 답함(반대로) | 우회 | 우회 |

---

## 3. 확장성 관점 평가

| 시나리오 | 이 결정 아래에서 | 근거 |
|---|---|---|
| 옵트인 프로젝트 10배 | 전역 스위치가 켜져도 마커 파일이 있는 프로젝트에서만 쓴다 — 폭발 반경은 옵트인 프로젝트다 | `apply()` 문서 :526-534 |
| 미션 10배 | 미션당 선언 줄 1 + 파일 최대 1(exclusive create, `ALREADY_EXISTS` 는 덮어쓰지 않음). 다만 writer 는 `idempotency_key` 를 비교하지 않아 동시에 두 프로세스가 같은 미션에 닿으면 선언 줄이 2줄일 수 있다 — 재읽기는 창을 좁힐 뿐이다 | `scripts/hooks/mission-complete-record.js#declareCompletion` (주석 :171-177) |
| 소비자 10배 (Canary 이후) | 소비자마다 §5-3 허용 목록으로 심사한다. 허용 목록 밖은 새 스위치·새 결정이 필요하다 | §5-3 |
| 선언 누적 | 비-null writer 가 없어 선언은 전부 null 로 남고 KPI 분모(non-null 만, 설계 :222)에 안 들어간다. `currentMission` 호출자가 0 이라 오늘은 무해하다. 호출자가 생기면 열린 미션이 늘기만 한다(추론) | §1-6 |
| autopilot 워크트리 (플립 뒤) | mission 파일이 하나라도 있으면 reap 이 `missions-present` 로 워크트리·브랜치를 보존한다 — autopilot 세션이 늘면 보존분이 쌓일 수 있다(추론, 누적 규모 미측정). 정리는 사람 몫이다 | §1-4 축 2 (`lib/autopilot/worktree-manager.js#reapLiveWorktree`) |

---

## 4. 숨겨진 비용

| 비용 | 설명 |
|---|---|
| "gate" 한 단어의 3중 의미 | (a) 산출 조건 `BlockCode`, (b) 산출 스위치 `resolveArtifactGate`, (c) REPORT 근거 게이트. 정본·코드 헤더가 섞어 쓴다 → 독자가 (a)를 (c)로 오독하면 Shadow 파일에 강제 의미를 얹는 소비자가 생긴다 |
| 정본 문구 장력의 잔존 | 설계 :180 의 존재=완료, allowlist :677 의 발행 순서 서술은 그대로다. 이 ADR 은 읽는 법을 정할 뿐 문구를 고치지 않는다(리더 몫) |
| 파일 오독 | 사람이 `outcome.md` 를 보고 "끝났다"로 읽을 수 있다. 본문이 "완료 선언이지 완료가 아니다"를 싣는 이유다(`outcomeSections`). 자동 소비자의 오독은 §5-3 이 막는다 |
| 회귀 핀 없음 | 경계는 지금 문서와 코드 헤더로만 유지된다. 소스 스캔 firewall 은 후속 후보일 뿐 만들지 않았다(§6). 만들어도 동적 경로 조립·다른 언어 소비자는 못 본다 |

---

## 5. Decision (추천안)

> ## ✓ **추천: 선택지 A — 기록과 강제를 분리한다**

### 5-1. 결정 문구 (R2-10, 리더 승인 원문)

> Shadow 단계의 outcome.md(accepted:null) 생성은 기록 산출이며, Canary §48 #14 완료 게이트 강제(CA-13)와 다르다.

### 5-2. 이 ADR 이 코드로 확인해 덧붙이는 풀이 (승인 문구 밖)

1. **생성기 = SessionEnd `mission-complete-record`.** outcome.md 의 프로덕션 산출 경로는 `scripts/hooks/mission-complete-record.js#processMission` 하나다(선언 `#declareCompletion` → 분류 `#classifyMissionOutcome` → 쓰기 `#writeOutcome`). `apply` 에 outcome 내용을 넘기는 곳이 이 훅뿐이다(`git grep -n "content: { outcome" -- plugins/artibot/scripts plugins/artibot/lib` 실측 1건, `write: true` 를 넘기는 프로덕션 훅은 4곳 중 이것이 outcome 담당).
2. **게이트 거부는 유지된다.** 게이트(`lib/runtime/artifact-lifecycle-gates.js#blockCodeFor`)나 훅 자신의 코드(`HOOK_BLOCK_CODES`)가 막힘 코드를 돌려주면 `processMission` 은 `write=blocked` 로 기록하고 파일을 쓰지 않는다. 다만 이 거부의 대상은 **기록물**이다. 그 결과는 stderr 한 줄과 `outcome-census` 의 분포이고, stdout 은 비고 exit 는 0이다.
3. **Canary #14 = 소비자 측 강제.** CA-13 의 강제는 REPORT 전에 VERIFY 근거를 요구해 세션을 PAUSED 로 되돌리는 `lib/autopilot/report-verify-gate.js` (`autopilot.reportVerifyGate.enforce`) 이고, 앞으로 "outcome.md 없음/`mission.completed` 없음/BlockCode" 를 **완료의 근거로 삼아** 흐름을 바꾸는 모든 소비자가 여기에 속한다.

### 5-3. 경계 판정 규칙 — 허용 목록

Shadow 에서 outcome.md·`mission.completed`·`BlockCode` 를 **완료의 뜻으로 다루는** 효과(만들기·쓰기·판정·읽기)는 **아래 넷뿐이다.** "완료의 뜻" 이란 그 존재·부재·값을 완료(또는 완료 조건)의 증거로 읽는다는 것이다.

1. 원장에 `mission.completed{accepted:null}` 선언 줄 1개를 더한다(`declareCompletion`).
2. 게이트가 열려 있고(전역 스위치 AND 프로젝트 마커) 막히지 않았을 때 `outcome.md` 1개를 exclusive create 한다(`writeOutcome` → `apply`).
3. 닫힌 어휘의 사유 줄을 stderr 로 낸다. stdout 은 0바이트, exit 는 0.
4. 위 값들을 **읽기만** 하는 계수·진단·렌더. 오늘의 구성원: `outcome-census.mjs`, `lib/runtime/ledger.js` 의 fold(`foldMissions`·`currentMission`), `/doctor` Check 9, `/scorecard --mission`, 그리고 LLM 매개 둘(`commands/resume.md:97` · `commands/scorecard.md:145`, §1-4 축 3 — 코드 가드가 없고 파일 본문의 문구가 유일한 오독 방지다). 새 읽기 전용 소비자도 "읽기만" 을 지키면 이 항목이다.

**이 목록 밖의 효과는 Canary #14 다.** 특히 outcome.md 나 `mission.completed`, BlockCode 의 존재·부재·값을 **완료의 근거로 읽어** (a) 페이즈 전이, (b) PAUSE·재개, (c) 도구·훅의 허용/거부(stdout 결정 채널·종료 코드), (d) 완료 보고 허용 여부 중 하나라도 바꾸는 변경은 자기 config 키, 1키 되돌림, 별도 결정, 그리고 이 ADR 을 개정하는 새 ADR 없이는 들어올 수 없다.

**이 규칙의 범위 밖 — 등재 대상.** 완료의 뜻 없이 `missions/` 디렉터리에 뭔가 있는지만 읽는 소비자(§1-4 축 2 의 `worktree-manager` 보존)는 이 목록의 대상이 아니다. 다만 (i) §1-4 에 축으로 **등재**해야 하고, (ii) **보존·경고 방향**(지우지 않는 쪽)으로만 작용할 때에 한해 목록 밖에 둔다. 삭제·차단·거부로 이어지는 디렉터리 소비자가 생기면 (a)~(d) 에 해당하는지 따져 Canary 로 심사한다.

### 5-4. 상태 전환 규칙

- 조건 d 는 이 ADR 이 착지하면 **증거가 생긴다.** 백로그 행 status 는 리더가 §4-i 규칙으로 정한다. 조건 증거는 행 전환 근거가 아니다 — SH-02·SH-20 은 플립 전까지 in-progress 로 남는다.
- CA-13 플립(`autopilot.reportVerifyGate.enforce`)은 이 ADR 과 무관하게 백로그 W29 후속 #15·#22 (:244, :251)의 조건에 따른다.
- 두 플립은 서로의 선행 조건이 아니다. 두 행 사이의 순서로 백로그가 적은 것은 :150 의 "SH-02·SH-20 선행"(= CA-13 이 뒤) 뿐이고, 이 ADR 은 새 순서 제약을 만들지 않는다.

**가정과 전제 조건**: 위 §1-4 의 소비자 계수(축 1·3 은 읽기 전용, 축 2 는 보존 전용 1곳)가 유지되는 동안 이 해석이 유효하다. 무효가 되는 조건은 §7 의 재검토 트리거다.

---

## 6. Consequences (의사결정의 결과)

**좋아지는 점**
- §4-b 조건 d 의 증거가 생겨 D3 의 미충족 항목이 하나 준다. 나머지(a-③·a-④·c·e·f·g)는 각자 상태 그대로다.
- Shadow 산출(SH-02·SH-20)과 Canary 강제(CA-13)가 독립으로 검증되고 독립으로 되돌려진다.
- 경계가 허용 목록이라 완료의 뜻으로 읽는 새 소비자는 자동으로 Canary 심사 대상이 되고, 디렉터리 존재 소비자는 §1-4 등재 대상이 된다.

**나빠지는 점 / 새로 떠안는 부담**
- 정본 문구(설계 :180, allowlist :677)와 이 해석의 장력은 관리될 뿐 사라지지 않는다.
- 이 ADR 이 "생성기 거부 = 강제" 로 읽는 독자의 유일한 해독 장치다. 발견성은 INDEX 행 하나에 달렸다.
- 비-null `accepted` writer 가 없어 선언은 영구 null 이다 — 이 ADR 이전부터의 상태이고 이 ADR 이 만들거나 고치지 않는다.
- Shadow 플립 뒤 autopilot 워크트리가 `missions-present` 로 보존되어 쌓일 수 있다(§1-4 축 2, 규모 미측정). 조건 c 의 이웃 문제이고 이 ADR 은 그 동작을 바꾸지 않는다.

**필수 후속 작업** (이 줄기는 아래 파일들을 수정하지 않았다 — 소유 밖)
- [ ] 리더(제안): 백로그 §4-b 조건 d 셀에 "충족 — ADR-013 (2026-09-29)" 표기, SH-02·CA-13 비고에 포인터 1줄. architect 검수 뒤에.
- [ ] 리더: 백로그 CA-13 evidence·비고(:150)의 "강제(생성 거부)" 문구를 갱신한다 — 생성 거부는 Shadow 생산자의 일이고 CA-13 의 강제는 REPORT 게이트라는 구분을 반영해야 한다. 지금 문구는 읽기 1 이고, 이 ADR 채택 시 갱신 대상이다(§1-2·§1-3).
- [ ] 리더: allowlist `mission.completed` spec(:677)의 "파일이 먼저" 서술과 W11-Q4 (a) 발행 순서의 어긋남을 정리할지 결정한다(문구 정정 또는 유지).
- [ ] architect: 이 ADR 검수(계획서 W2-4 행).
- [ ] 후보, 미배정: 경계 회귀 핀 — "outcome.md·`mission.completed` 를 읽는 코드가 훅 결정 채널에 닿지 않는다" 를 소스 스캔으로 핀하는 firewall. 만들면 못 보는 것(동적 경로, 호출 그래프)을 게이트 옆에 적을 것.

**되돌리기 비용 (Reversibility)**: ☑ 쉬움 — 문서 결정이며 코드·config 변경이 0이다. 번복은 이 ADR 을 Superseded 로 돌리는 새 ADR 이다.

---

## 7. 2년 뒤 기술 부채 예상 포인트

| 부채 항목 | 발생 확률 | 영향도 | 완화 전략 |
|---|---|---|---|
| "gate" 3중 의미 때문에 신규 기여자가 Shadow 파일에 강제 의미를 얹는 소비자를 추가 | 높음 | 중 | §5-3 허용 목록을 리뷰 체크로 쓴다. firewall 핀 후보를 실행에 옮긴다 |
| Canary 소비자가 Shadow 산출에 의존하게 되면 두 스위치가 결합되어 Shadow 킬스위치가 롤백 장치로서 의미를 잃는다(추론) | 중 | 높음 | Canary 소비자를 들이는 ADR 이 "생산자 스위치 OFF 일 때 소비자가 어떻게 동작하는가"(바이트 불변인지 fail-closed 인지)를 먼저 명시한다 |
| 비-null `accepted` writer(관측 창 종료 줄) 설계 미정 상태에서 `currentMission` 호출자가 생김 | 중 | 중 | 창 종료 writer 결정 전에 호출자를 도입하지 않는다 |
| allowlist :677 문구와 발행 순서 drift 방치 | 중 | 낮음 | 리더 결정(§6 후속) |

**재검토 트리거**: (1) 오너가 "파일 미생성 자체가 강제" 라고 결정한다(→ 선택지 B, D3 와 CA-13 병합). (2) §5-3 밖의 소비자가 실제로 들어온다(완료의 근거로 읽는 소비자, 또는 보존 방향이 아닌 디렉터리 소비자). (3) 비-null `accepted` writer(설계 §5 D3 의 관측 창 종료 줄)가 착지한다. (4) 설계 §7.3 표가 개정된다. (5) CA-13 플립을 결정할 때. (6) D3 플립 직전 — 조건 a-④ 충족 시점.

---

## 이 ADR 이 결정하지 않는 것

1. **D3(Shadow 진입 플립)**: 보류 유지. 남은 조건은 a(③ self_report, ④ 영수증 커버리지 95% 임계) · c(미추적 `missions/` 가 clean-tree 게이트를 견디는지 — 백로그 :310 은 코드 읽기로 "preflight 는 warn, land 에 전역 검사 없음"이라 적었고 라이브 실측은 없다) · e(핀 3곳 + config 주석 동반 수정) · f(플립 배치 CI green) · g(EC-01 — 기준 커밋 `eae2cf09` 에는 없었다. master `491a4de8` 의 백로그는 웨이브 1 W1-2 가 fold `6976b696` 으로 코드 충족했다고 적는다; 이 줄기는 그 코드를 열어 검증하지 않았다). b 는 충족(`5ab0dcbe`). ④ 는 백로그 §4-c 결정 (2)가 "95% 유지 + ended ≥50 재판정"으로 정했고(:296), §1-6 실측(05:58Z)은 ended 59 · with_receipts 46 = 0.780 이라 표본 조건(≥50)은 충족하고 임계는 미달이다. 빈 세션 6건을 제외한 46/53 = 86.8% 는 웨이브 2 계획서(05:1xZ)의 인용값이라 이 ADR 이 재측정하지 않았다(제외 목록이 로컬 문서에 있다). 어느 쪽이든 95% 미달이다.
2. **CA-13 플립**(`autopilot.reportVerifyGate.enforce`)과 그 선행 조건(W29 후속 #15·#22).
3. **관측 창 종료 writer**(두 번째 `accepted` 줄, 설계 :222 · 설계 §5 D3).
4. **Shadow 의 새 소비자**(SH-20 렌더 정책 등) — 지금의 읽기 전용 소비자만 허용 목록에 있다.
5. **킬스위치 분리**(선택지 D).
6. **문구 수정**: 설계 :180·:406, allowlist :677, 백로그 셀(CA-13 evidence·비고 :150 의 "강제(생성 거부)" 포함).
7. **행 status**: SH-02·SH-20·CA-13 모두 이 ADR 로 바뀌지 않는다.
8. **autopilot 워크트리 보존 정책**(`worktree-manager` 의 `missions-present`) — 이 ADR 은 그 동작을 바꾸지도 평가하지도 않는다. 조건 c 에서 다룬다.

## 인용 검증 기록

이 줄기가 직접 열어 확인한 인용이다. 백로그·정본의 인용 오류는 **발견하지 못했다(검증한 항목 한정)**. 다만 이 줄기 자신의 읽기 오류 둘이 architect 검수에서 나왔고 개정 1 이 바로잡았다: CA-13 비고의 귀속(R1)과 디렉터리 존재 소비자 누락(R2 — 파일명 grep 하나로 "소비자 없음" 을 말한 것이 틀렸다).

| 인용 | 결과 |
|---|---|
| 백로그 :275(§4-b 조건 a~g), :104(SH-02), :150(CA-13), :122(SH-20), :400(D3), :296·:298(§4-c) | 열어서 원문 확인. 조건 d 문언 = "outcome.md(`accepted:null`) writer 개방이 Canary '#14 생성기' 와 다르다는 해석 확정" |
| 설계 :5(우선 규칙), :404·:405·:406(§7.3), :504·:505(§8.4), :180·:184(§3.4), :222(§3.6), :256·:257(§4 표), :308(D3), :370(§7.2 §6), :1095(W11-Q4) | 열어서 원문 확인. CA-13 행이 인용한 "§7.3 · §8.4 · §3.4"·"§48 #14 · §55 #15" 와 SH-02 행의 "§7.3 · Hardening §6" 이 모두 해당 줄에 실재 |
| 커밋 `6d612dbf`(SessionEnd outcome-md emitter), `686df95b`(그 fold), `5bf05a25`(REPORT 게이트 "(CA-13)"), `d914eda0`(그 fold), `59dafab4`, `caaafa08`, `5ab0dcbe` | `git show -s` 로 존재·제목 확인. `59dafab4` 는 CA-13 행이 "재측정" 시점으로 인용한 fold 커밋이다 |
| 코드 심볼: `processMission` · `declareCompletion` · `classifyMissionOutcome` · `writeOutcome` · `policyFromConfig` (`mission-complete-record.js`), `plan` · `apply` · `resolveArtifactGate` · `APPLY_GATE_PATH` (`artifact-lifecycle.js`), `BlockCode` · `blockCodeFor` (`artifact-lifecycle-gates.js`), `gateReportOnVerify` · `refuseRecordedReport` · `evaluateReportVerifyEvidence` (`report-verify-gate.js`), `currentMission` (`ledger.js`), `foldOutcomeGateCensus` (`outcome-gate-census.js`) | 전부 정의를 열어 확인. `citation-resolution` 게이트가 이 문서의 `path#symbol` 을 판정한다 |
| 개정 1 의 인용: `worktree-manager.js` :511-519(`hasMissions`) · :536-552(`describeWorktreeHead`) · :647-683(`reapLiveWorktree`, :664 `keep('missions-present')`), `engine-cleanup.js`(`reapSessionArtifacts`), `engine.js` :564-565·:583·:970, `tests/firewall/missions-clean-tree.test.js` :11-17, `commands/resume.md` :90·:97·:99, `commands/scorecard.md` :145·:155 | 열어서 원문 확인. architect 가 준 "~:511"·"~:664" 는 실제와 일치한다. 백로그 CA-13 evidence·비고(:150)의 문구도 다시 열어 R1 의 귀속을 확인했다 |

관측치 정합성: 소비자 22 = 코드 12 + 문서·스키마 10 ✓, 코드 12 = 5 + 4 + 3 ✓, missions 디렉터리 grep 16파일 = 읽기 1 + 조립·쓰기·래치 5 + intent 읽기 1 + 주석·무관 9 ✓, `mission.completed` 39 = null 39 + 비-null 0 ✓ = census declared 39 ✓, blocked 39 = 30 + 9 ✓, ended 59 − with_receipts 46 = skipped 13 ✓.

재현 명령(리포 루트 cwd, 전부 읽기 전용): `node plugins/artibot/scripts/ledger/outcome-census.mjs` · `node plugins/artibot/scripts/ledger/session-coverage.mjs` · §1-4 의 두 `git grep`(파일명 축·`missions` 디렉터리 축). 원장 계수는 원장이 자라므로 값이 달라질 수 있다.

## 미확인

- 오너의 개별 확인(이 해석을 오너가 직접 승인했는지).
- 런타임에 경로를 동적으로 조립해 outcome.md 를 읽는 코드의 유무(grep 한계 — 축 2 의 grep 이 좁혔을 뿐이다).
- Shadow 플립 뒤 `missions-present` 로 보존되는 autopilot 워크트리의 실제 수(누적 규모), 그리고 `describeWorktreeHead` 의 미추적 파일 영향(`tests/firewall/missions-clean-tree.test.js` 가 재지 않는다).
- `commands/resume.md`·`commands/scorecard.md` 의 산문을 모델이 실제로 어떻게 실행하는지.
- `mission.completed` 39줄의 프로덕션 대 프로브 출처, 그리고 09-21 census 16 과의 재조정.
- allowlist :677 문구를 쓴 시점의 의도(발행 순서가 파일 먼저였는지, 표현상의 것인지).
- 웨이브 1 배치 착지 후 `eae2cf09` 이후 트리에서 §1-3 표의 줄번호가 그대로인지 — 심볼 인용은 유효하나 `:NN` 은 재확인이 필요하다.
