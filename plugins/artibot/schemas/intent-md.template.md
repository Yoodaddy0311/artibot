---
# ─────────────────────────────────────────────────────────────────────────────
# 파생 파일 금지 (Hardening §4 "금지", v1.1 04 "Intent history")
#
#   한 Mission 에는 `intent.md` 하나만 존재한다. 아래 이름은 전부 금지한다.
#     intent-v2.md · intent-final.md · intent-agent-a.md · interpreted-intent.md
#
#   Intent 가 바뀌면 새 파일을 만들지 말고 이 파일을 고친 뒤
#   `intent_revision` 을 올리고 `## Intent Refinements` 에 사유·근거·갱신자를
#   기록한다. 상세 이력은 git 이 갖는다.
#
#   `mission-contract.schema.*` 는 디스크 정본이 아니라 파서 출력의 메모리 내
#   검증기다(설계 §3.1 "Mission Contract vs intent.md 판정"). 계약을 디스크에
#   따로 떨어뜨리는 순간 정본이 둘이 된다.
# ─────────────────────────────────────────────────────────────────────────────

# ── 공통 메타 (Hardening §29 schema_version · §24 provenance · T-19 조각) ──
schema_version: 1
mission_id: M-YYYYMMDD-XXX
# status 허용값은 `schemas/mission-contract.schema.json` 의 7종이 정본이다:
#   queued | planning | executing | blocked | reviewing | completed | failed
status: queued
intent_revision: 1

# Provenance (Hardening §24). `revision` 은 위 `intent_revision` 이 겸한다.
created_by:
updated_by:
created_at:
updated_at:

# actor — 이 개정을 만든 주체 (T-19 공통 메타 조각).
#   type: human | agent | runtime
#   id:   사람이면 식별자, 에이전트면 에이전트명, 런타임이면 컴포넌트명
actor:
  type:
  id:

# based_on — intent 는 아티팩트 의존 그래프의 **최상위**라 상위 개정이 없다.
# 따라서 이 파일에는 `based_on` 키를 두지 않는다(Hardening §5).
# plan / review / outcome / execution_profile 이 역방향으로 이 파일의
# `intent_revision` 을 `based_on` 에 적고, 이 값이 오르면 그것들이 stale 이 된다.

# ── explicit_requests (보강: 원문에서 분리한 보호 대상 목록) ──
# 사용자가 **명시적으로** 요구한 것만 적는다. 추론한 결과는 여기 넣지 않는다
# (그것은 `## Interpreted Goal` 과 아래 Systemic Scope 소관).
# 이 목록은 보호된다 — systemic 해결책이 조용히 이것을 대체할 수 없다
# (v1.0 01 §4 헌법, 설계 §3.1 "finding ↔ explicit_requests 보호").
#   text: `## Original Request` 원문의 **verbatim 부분문자열**. 요약·정규화·번역
#         금지 — `originalRequest.slice(start, end) === text` 가 항상 성립해야
#         한다. 정규화한 문장을 여기 넣으면 보호 대상이 원문에서 떨어져 나가
#         "조용한 대체" 를 잡을 수 없게 된다.
#   span: 그 원문에서의 문자 오프셋 [start, end) — 0-based, end 배타.
#         **필수이며 null 을 허용하지 않는다.** 원문에서 찾을 수 없는 문장은
#         explicit_request 가 아니다 — 그것은 추론 결과이므로
#         `inferred_outcomes` 로 간다.
explicit_requests:
  - text: ""
    span: [0, 0]

# ── autonomy (보강) ──
#   mode: guided | agent_led | autonomous
#     guided     — 단계마다 사람 확인
#     agent_led  — 에이전트가 주도하고 게이트에서만 멈춤
#     autonomous — 게이트 없이 완료까지 (human_gates 는 비어도 된다)
#   human_gates: 사람이 반드시 판단해야 하는 지점의 목록.
#     질문은 confidence 만으로 만들지 않는다 — 사람의 가치 판단 + 하류 영향 +
#     증거로 결정 불가 + 틀렸을 때 비용이 유의미, 네 조건이 모두 설 때만
#     (Hardening §18). 질문은 산발적으로 던지지 말고 모아서 한 번에 낸다.
autonomy:
  mode: agent_led
  human_gates: []

# ── execution_profile (Intent ↔ Router 계약, Hardening §2 8축) ──
# 허용값의 정본은 `schemas/execution-profile.schema.json`(T-18)이다.
# 아래 값은 **예시일 뿐**이며 이 템플릿은 허용값을 정의하지 않는다.
# Hardening §20: 이 프로필은 버전 관리 대상이고 `derived_from.intent_revision`
# 을 갖는다 — 그 필드도 T-18 스키마 소관이다.
# 참고: v1.1 17 의 `execution_profile.topology` 는 T-18 의 8키에 없다.
# 토폴로지는 mission-contract 쪽으로 이관된다(PRD T-13 제목의 `topology`).
execution_profile:
  reasoning:
    depth: deep
  autonomy:
    level: full
  performance:
    priority: balanced
    budget: generous
  parallelism:
    strategy: auto
  planning:
    mode: auto
  context:
    strategy: sufficient
  review:
    independent: true
    strictness: high
    model: fable-5.1
  completion:
    verified_outcome_required: true

# ── review (독립 검수 계약, v1.1 17 원본 키) ──
# execution_profile.review 가 라우터에 주는 값이라면, 이 절은 미션 자체가
# 요구하는 검수 조건이다. 독립 검수는 clean-room 이다(Hardening §14).
review:
  independent: true
  model: fable-5.1
---

<!--
  이 파일은 `.artibot/missions/<mission_id>/intent.md` 의 템플릿이다.

  intent.md 는 오직 한 질문에만 답한다:
      "무엇을 성공시켜야 하고, 왜 하는가?"

  사용자의 발화를 그대로 옮긴 전사본이 아니다. 해석되고, 경계가 그어지고,
  검증 가능한 미션 정의다. 실질(substantive) 미션에만 만든다 — 인사·사소한
  문장 수정·일회성 질의·프로젝트 상태를 바꾸지 않는 상호작용에는 만들지 않는다
  (Hardening §4 생성 기준, 설계 §3.1 substantive allowlist S1~S6).

  아래 8개 절은 v1.1 17 템플릿의 원본 골격이며 **하나도 지우지 않는다**.
  비어 있어도 절은 남긴다 — 빈 절은 "아직 안 채웠다"는 정보고, 없는 절은
  "이 축을 생각하지 않았다"는 정보라서 서로 다르다.
-->

# Intent

## Original Request

<!--
  사용자 발화를 **원문 그대로** 보존한다. 요약·정규화·번역 금지.
  frontmatter 의 `explicit_requests[].span` 이 이 본문의 문자 오프셋을 가리키므로
  이 절을 나중에 다듬으면 span 이 전부 깨진다.
-->

## Interpreted Goal

<!-- 원문을 해석한 결과. "무엇을" 이 아니라 "무엇을 성공시켜야 하는가". -->

## Explicit Scope

<!-- 사용자가 명시적으로 지목한 대상. `explicit_requests` 와 정합해야 한다. -->

### Bounded Blindspots

<!--
  인과적으로 연결되어 있고, 작고, 되돌릴 수 있고, 의도가 분명하고, 새 제품·
  아키텍처 결정을 요구하지 않으며, 검증 가능한 사각지대. 이 범주만 자율 수정
  대상이다(v1.0 01 §3, package 03 "Blindspot classes").
  여기 해당하지 않는 발견은 `future_opportunities` 로 기록만 하고 큰 리팩터링으로
  자동 승격시키지 않는다.
-->

### Excluded

<!--
  명시적으로 **하지 않는** 것. 이 목록이 비어 있으면 범위가 정의되지 않은 것과
  같다 — "안 하는 것"을 적어야 경계가 선다.
-->

## Systemic Scope

<!--
  직접적인 인과관계가 확인될 때만 확장한다. 확장에는 근거가 붙어야 한다.
  발견 분류: direct · upstream · downstream · adjacent · unrelated.
  범위를 **넓히는** finding 은 plan 개정으로 족하다. `explicit_requests` 를
  **좁히거나 대체하는** finding 만 intent 개정을 요구하고, 그것도 증거가 있을
  때만 가능하다(설계 §3.1, Hardening §16). 증거 없는 finding 은 rejected.
-->

## Success Criteria

<!--
  4소절 전부 채운다. 하나라도 비면 "무엇이 되면 끝인가"가 정의되지 않은 것이다.
-->

### Functional

<!-- 기능적으로 무엇이 되어야 하는가. 관측 가능한 서술로. -->

### Behavioral

<!-- 사용자·시스템의 행동이 어떻게 달라져야 하는가. -->

### Regression

<!-- 무엇이 깨지지 않아야 하는가. 명시하지 않으면 아무도 안 본다. -->

### Evidence

<!--
  위 셋을 **무엇으로** 증명하는가. 재현 명령·산출물·분모를 적는다.
  "테스트 그린" 은 그 자체로 증거가 아니다 — 픽스처가 현실과 다르면 아무것도
  증명하지 않는다. 무엇을 재는지와 못 보는 것을 함께 적는다.
-->

## Completion

<!--
  이 미션이 **어디까지 갔을 때** 끝인가. 기대 행동 7종에서 고른다
  (package 02 "completion expectation"):

    answer · artifact · implement · test · commit · PR · deploy

  뒤로 갈수록 앞의 것을 포함한다고 가정하지 말고, 기대하는 것만 체크한다.
  체크하지 않은 행동은 **하지 않는다** — 특히 commit·PR·deploy 는 사용자가
  요구하지 않았으면 수행하지 않는다.

  완료 게이트 자체(intent 충족 · 태스크 해소 · plan 비-stale · 검증 PASS ·
  독립 검수 PASS · 미해결 critical 없음 · outcome 생성 · state 커밋)는
  Hardening §33 이 정의하며 런타임이 판정한다. 이 절은 "무엇을 기대하는가"만
  선언한다. technical_done / review_passed / accepted 는 서로 다른 상태다
  (Hardening §34).
-->

- [ ] answer
- [ ] artifact
- [ ] implement
- [ ] test
- [ ] commit
- [ ] PR
- [ ] deploy

## Constraints

<!-- 하지 말아야 할 것, 지켜야 할 호환성, 예산·시간 제약. -->

## User Decisions

<!--
  사람이 실제로 답한 값만 적는다. 추론한 기본값은 여기 넣지 않는다.
  각 항목에 질문·답·시각·근거를 남긴다.
-->

## Intent Refinements

<!--
  Intent 는 안정적이되 불변은 아니다. 구현이 불편해졌다는 이유로는 바꾸지
  않는다. 바꿀 수 있는 경우는 넷뿐이다 — 문제가 잘못 규정됐다는 증거가 나왔을
  때, 사용자가 방향을 명시적으로 바꿨을 때, 필요한 제품 결정이 바뀌었을 때,
  미션 범위를 공식적으로 재정의해야 할 때.

  개정할 때마다 아래 형식으로 누적한다. `intent_revision` 을 올리는 것을 잊지
  말 것 — 이 값이 오르면 plan 은 STALE, review 는 INVALID, outcome 은
  NOT ACCEPTABLE 이 된다(Hardening §5 staleness propagation).
-->

### Revision N

<!--
  Reason:   왜 바꾸는가
  Evidence: 근거 (file:line · 명령 출력 · 사용자 발화)
  Updater:  누가 바꿨는가 (frontmatter `actor` 와 일치해야 한다)
-->
