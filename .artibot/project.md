---
schema_version: 1
created_by: agent:autopilot-tyc5j4-T02
updated_by: agent:autopilot-tyc5j4-T02
created_at: 2026-09-02
updated_at: 2026-09-02
revision: 1
based_on:
  - .artibot/guides/v5-design/ARTIBOT-5.0-DESIGN.md
  - .artibot/guides/v5-design/package-v1.1/18_PROJECT_TEMPLATE.md
  - .artibot/guides/v5-design/package/01_PHILOSOPHY_CONSTITUTION.md
evidence_refs:
  - .artibot/guides/v5-design/ARTIBOT-5.0-DESIGN.md:261
  - .artibot/guides/v5-design/ARTIBOT-5.0-DESIGN.md:227
  - .artibot/guides/v5-design/ARTIBOT-5.0-DESIGN.md:267
  - plugins/artibot/lib/security/human-gates.js:77
actor:
  type: agent
  id: autopilot-tyc5j4-T02
---

# Project

정본 선언 문서. 프로젝트 전체의 목적·불변식·원칙·승인 경계를 한 곳에 둔다.
`ARTIBOT.md` 읽기 순서 1번이 가리키는 파일이다. 강제는 코드·훅이 하고, 이 문서는
**선언**만 한다 — 둘이 어긋나면 파이어월 게이트가 레드가 된다.

## Purpose

Artibot 은 Claude Code 위에서 도는 플러그인이자 오케스트레이션 층이다. 자연어 의도를
받아 적절한 커맨드·스킬·에이전트·토폴로지로 자동 배선하고, 실행 결과를 실제 도구로
검증한다. 비개발자도 슬래시 문법 없이 쓸 수 있어야 한다는 것이 제품 가치다.

구성(2026-09-02 17:03 KST 실측, 분모는 `plugins/artibot/`):

| 표면 | 개수 | 재현 명령 |
|---|---|---|
| commands | 79 | `ls commands/*.md \| wc -l` |
| skills | 114 | `ls -d skills/*/ \| wc -l` |
| agents (md) | 29 | `ls agents/*.md \| wc -l` |
| lib 1-depth 디렉터리 | 34 | `ls -d lib/*/ \| wc -l` |
| firewall 테스트 | 57 | `ls tests/firewall/*.test.js \| wc -l` |

요약 이전원: `plugins/artibot/CLAUDE.md:5-9`(스택·표면). 원문은 개발자층 정본으로 남는다.

## Product / System Definition

런타임은 5계층이고 상위가 하위만 import 한다(5 → 4 → 3 → 2 → 1).

| 계층 | 디렉터리 | 책임 |
|---|---|---|
| 5 Runtime | `lib/runtime/` | 기본 미들웨어 체인, 에이전트 팩토리 |
| 4 Cognitive | `lib/cognitive/` | System 1/2 라우팅, EFFORT_POLICY |
| 3 Learning | `lib/learning/` | memory, lifelong, knowledge-transfer, swarm sync |
| 2 Auxiliary | `lib/{adapters,swarm,privacy,visual,git,...}/` | 도메인 서비스 |
| 1 Core | `lib/core/` | Config, I/O, cache, event-bus, guards |

정본 상태·산출물 레이아웃(v5 설계 package-v1.1 `02_CANONICAL_PROJECT_STATE.md`):
`ARTIBOT.md` → `.artibot/{project.md, state.yaml, missions/, adr/, memory/, runtime/ledger.jsonl}`.
2026-09-02 기준 착지한 것은 `ARTIBOT.md` 와 이 파일 둘뿐이고 나머지는 미착지다
(표기 정본은 `ARTIBOT.md` 읽기 순서의 `not yet landed`).

요약 이전원: `plugins/artibot/CLAUDE.md:11-21`.

## Core Principles

v5 헌법 14원칙(`.artibot/guides/v5-design/package/01_PHILOSOPHY_CONSTITUTION.md`).
각 줄 끝은 **현행 정본 위치**이며, 판정은 레인 7 대조표(성문화 / 부분 / 없음 / 충돌)를 따른다.
경로 접두 `p/` = `plugins/artibot/`.

1. **Foundation Before Autonomy** — 자율은 기반 뒤에 온다. [성문화] `docs/ORCHESTRATION-ROUTING.md:76-79` · `p/lib/autopilot/consent-gate.js`
2. **Think Deep Before Acting** — 중요 작업은 시행착오 전에 실패확률을 줄인다. [성문화] `p/commands/ultraplan.md:32-43` Phase 0 VALIDATE · `p/CLAUDE.md:31-35` Problem-First Gate
3. **Adaptive Depth** — 기본 최대추론이 아니라 필요한 만큼의 최대추론. [부분] `p/lib/cognitive/effort-policy.js` · `p/artibot.config.json#effort` — 깊이 축이 셋(effort·팀 레벨·plan/ultraplan)으로 흩어져 단일 규칙 문장 없음
4. **Intent Fidelity** — 더 정교한 해석을 좇다 사용자의 명시 요청을 잃지 않는다. [성문화] `p/rules/dev-protocol.md:41-45` Zero-Skip · `p/rules/quality-gates.md:22-26`
5. **Systemic Reasoning** — 지목된 대상을 문제 전체로 취급하지 않는다. [부분] `~/.claude/rules/artibot/verification-discipline.md` §5 · `p/commands/blindspot.md` — "직접+상류+하류" 를 한 문장으로 요구하는 규칙 없음
6. **Bounded Proactivity** — 인과적·작고·가역·검증가능한 근접 사각지대는 자율 수정 가능. [충돌] 현행은 `p/commands/blindspot.md:10,29` recommend-only · `p/rules/quality-gates.md:20` · karpathy Rule 3 이 일관되게 비요청 변경 금지. **결정 A1 = 미채택 유지** — Observe 원장(보고 건수·수용률) 후 저위험 bounded 만 재론
7. **Evidence-driven Recovery** — 실패는 리뷰→플랜수리→재실행. 울트라플랜은 기본 재시도가 아니다. [부분] `p/commands/autopilot.md:334` classifyFailure — 복구 사다리를 적은 규칙 없음
8. **Independent Review by Default** — Builder ≠ Final Reviewer. [성문화] `p/commands/team.md:294,302-330` Phase 4.5 · `p/artibot.config.json` `phaseRoles.review=fable`
9. **Context Quality > Context Quantity** — 결정에 필요한 만큼만 준다. [부분·역행] `p/CLAUDE.md:92-96` Context Efficiency — 규칙은 있으나 계약 인라인 복제가 반대로 간다
10. **Outcome Economics** — 주지표는 Cost per Accepted Outcome. [없음] `p/lib/autopilot/cost-tracker.js` 는 토큰·달러 합계뿐. 수락결과당 비용 산식·저장처 리포 전역 0건
11. **Natural Language First** — 자연어가 커맨드·스킬·설정·토폴로지·리뷰를 자동 활성. [부분·범위충돌] `p/CLAUDE.md:57-75` Auto-invoke 는 성문화, 그러나 `docs/ORCHESTRATION-ROUTING.md:76-79` 가 orchestrate/autopilot 자동발화를 하네스 제약으로 금지. **결정 A3 = Shadow 원장 1릴리스 후 재론**
12. **Ask Humans for Decisions, Not Missing Research** — 모르는 것은 먼저 조사하고, 사람에게는 가치 결정만 묻는다. [규칙층 채택 / 스킬층 미적용] 규칙층은 정합(`~/.claude/rules/artibot/verification-discipline.md` §0 · `p/skills/problem-validation/SKILL.md`). 스킬층은 반대 — `## Human Checkpoints` 22/114 스킬의 사실확인형 "Skippable: No". **결정 A4 = 채택, 단계 B 대기**(Observe 원장 1릴리스 후 적용)
13. **Complexity Must Earn Its Existence** — 수락 결과를 더 못 올리는 기계장치는 제거한다. [부분] `p/CLAUDE.md#Existence Audit` · problem-validation 4-check — 신규에는 게이트가 있으나 기존의 존재 증명 주기는 이제 막 생겼다
14. **Reason with AI, Act with Reality** — "Deterministic First" 를 대체한다. 지능은 공격적으로 쓰되 환경 사실은 실제 도구에서 온다. [성문화] `~/.claude/rules/artibot/verification-discipline.md` §0·§2·§4·§9 · §10 "게이트는 vitest 로만"

> 충돌·미적용 항목(6·11·12)은 **여기서 채택된 것으로 읽지 마라.** 결정 A1·A3·A4 의
> 현재 상태가 곧 이 문서의 상태다. 결정이 움직이면 이 절이 먼저 바뀐다.

## Non-goals

- **완전 자율을 먼저 만들지 않는다.** 기반(Core→Intent→Plan→Context→Execution→Review→Verify→Recover) 뒤에 온다. 약한 기반 위의 자율은 더 크고 빠른 실패다.
- **파생 파일을 만들지 않는다.** intent·plan·todo·progress·status 의 파생본 금지(`ARTIBOT.md` Canonical Rules). 렌더 뷰는 `derived-from:` 헤더를 달고 비정본임을 선언한다.
- **정본을 복제하지 않는다.** 이 문서는 라우팅·명명·개발 규율의 정본이 아니다 — 가리킬 뿐이다.
- **훅으로 새 차단을 만들지 않는다(Observe 단계).** 사람 게이트 표는 분류·기록만 한다. `decision` 은 불변이다.
- **게이트를 통과시키려 게이트를 깎지 않는다.** 두 게이트가 서로 충족 불가면 설계를 고친다.
- **비개발자 전용 별도 UI 를 만들지 않는다.** 자연어 표면은 기존 커맨드·스킬 위에 얹는다.

## Architecture Invariants

- **계층 방향 불변** — 상위 계층이 하위만 import 한다(5 → 4 → 3 → 2 → 1). 역참조는 레이어 등록 게이트가 잡는다.
- **ESM only** — `"type": "module"`, 런타임 의존성 0, Node >= 20.
- **단일 진실원(모델)** — 티어 해석은 `p/lib/core/model-policy.js#resolveModel`, 티어→모델 ID 는 `p/lib/core/model-catalog.js#MODELS`. 문서·프롬프트에 모델 ID 를 하드코딩하지 않는다.
- **단일 진실원(사람 게이트)** — `p/lib/security/human-gates.js#HUMAN_GATE_MATRIX`. 이 문서의 Human Approval Boundaries 는 그 표의 **선언 사본**이며, 파이어월이 양쪽을 대조한다.
- **게이트는 vitest 로만** — 스크립트형 게이트 금지(자기 기준선을 파괴하며 통과한 선례가 있다). 게이트 파일이 없으면 red = fail-closed.
- **읽기 후 쓰기** — 대상 파일을 읽지 않고 수정하지 않는다.
- **함수 < 50줄 · 파일 < 800줄 · 불변 패턴**(spread/신규 생성, 변형 금지).

요약 이전원: `plugins/artibot/CLAUDE.md:11-21, 79-82`.

## Collaboration Rules

정본은 `docs/ORCHESTRATION-ROUTING.md` 다. 여기 3줄은 요약이다.

- **오케스트레이터는 위임한다.** 2개 이상 독립 하위작업 또는 2개 이상 파일·도메인이면 병렬 팀원으로 간다. 인라인은 30줄 미만 단일 파일·무위험일 때만.
- **자기 작업은 자기가 검수하지 않는다.** 교차검수와 최종 검수를 분리하고, 리뷰 phase 는 fable 티어로 간다.
- **네 메커니즘은 다른 것이다** — Artibot `team`/Auto-Team · 결정형 `orchestrate` · 하네스 `Workflow` 도구 · 플랫폼 Dynamic Workflows. 산문에서 맨 "workflow" 는 금지어다.

## Naming / Repository Conventions

- 명명 정본: `docs/ORCHESTRATION-GLOSSARY.md#canonical-naming-convention`.
- 산출물 파일명: 회차 접미(`-2` `-final` `-new` `plan-v2` `todo` `progress` `status`) 금지. 시점 접미(`-YYYY-MM-DD`)는 허용된다. 게이트는 `p/tests/firewall/artifact-governance.test.js`.
- ADR 은 `ADR-NNN-...` 단일 계열. 현재 `docs/adr/` 와 `plugins/artibot/docs/adr/` 두 계열이 병존하며 번호가 겹친다 — 통합은 **결정 B2 대기**.
- 원장은 중앙 `.artibot/runtime/ledger.jsonl` 하나. 분산 원장은 게이트가 잡는다.
- mission id 는 `M-YYYYMMDD-NNN`.
- 추적 경계: 추적 = `ARTIBOT.md`·`project.md`·`missions/`·`adr/`·`memory/`·설계 세트 / 로컬 = `runtime/ledger.jsonl`·raw 로그·렌더 핸드오프 / `state.yaml` = 로컬(재생성 가능 투영, 결정 B1).

## Human Approval Boundaries

사람이 승인해야 하는 것의 정본 선언. **선언은 여기, 강제는 훅**(설계 §3.5 층 분리).
행 자체의 단일 진실원은 `p/lib/security/human-gates.js#HUMAN_GATE_MATRIX` 이고,
`p/tests/firewall/project-md-contract.test.js` 가 아래 13행의 id·행동·기본값을 그 표와 대조한다.

**allowlist 형이다.** 매칭되지 않은 행동은 "안전" 이 아니라 **미분류**다. 이 표는 미분류를
통과로 해석하지 않는다.

`강제` 열은 2026-09-02 **현행 실측**이지 설계 목표가 아니다 — `hook` = PreToolUse 훅이 실제로
막는다(부분 강제 포함), `prose` = 문서·프롬프트에만 있고 코드 0, `none` = 강제도 산문도 없다.

| id | 행동 | 기본 | 강제(현행) | policyRef |
|---|---|---|---|---|
| HG-01 | 읽기·검색·분석 | auto | none | — |
| HG-02 | 로컬 되돌릴 수 있는 편집 | auto | none | — |
| HG-03 | 테스트·빌드·린트 | auto | none | — |
| HG-04 | 워크트리·브랜치 생성 | auto | none | — |
| HG-05 | 로컬 커밋 | auto | none | — |
| HG-06 | PR 생성 | policy | none | `policy:ago.selfControl.autoPR.enabled` |
| HG-07 | 외부 시스템 쓰기 | human | none | `policy:autopilot.safety.blockExternalSend` |
| HG-08 | 프로덕션 배포 | human | hook | — |
| HG-09 | 되돌릴 수 없는 파괴적 행동 | human | hook | — |
| HG-10 | 제품·비즈니스 선택(유효한 값이 둘 이상) | human | prose | — |
| HG-11 | 시크릿·크리덴셜 변경 | human | hook | — |
| HG-12 | 권한 상승 (설정·훅·디스패치 자기수정) | human | none | — |
| HG-13 | 보안 정책 비활성화 | human | none | — |

**주의 — 이 표가 말하지 않는 것.** `기본` 은 "무엇이 사람 승인을 요구하는가" 이고
`강제` 는 "오늘 코드가 실제로 무엇을 막는가" 다. 둘이 어긋난 자리(HG-07·HG-12·HG-13 =
human 인데 강제 none)는 **알려진 구멍**이지 승인 면제가 아니다. 훅 block 은 "묻기" 의
트리거이지 대체물이 아니다 — 대화형이면 즉시 질문, 비대화형이면 PAUSE 한다.

## References

- **진입 계약** — `ARTIBOT.md`(읽기 순서·정본 규칙). parity 게이트 `p/tests/firewall/artibot-entry-parity.test.js`.
- **v5 설계 세트(정본)** — `.artibot/guides/v5-design/`
  - `ARTIBOT-5.0-DESIGN.md` — 통합 설계. §3.5 사람 게이트 · §3.7 정본 착지·헌법 채택 순서
  - `ADDENDUM-HARDENING.md` — §24 Artifact provenance · §29 schema_version · §41 actor
  - `package/` — v1.0 런타임 파이프라인·경제·헌법(`01_PHILOSOPHY_CONSTITUTION.md` 14원칙)
  - `package-v1.1/` — 정본 상태·산출물·물리 형식(`02_CANONICAL_PROJECT_STATE.md`, `18_PROJECT_TEMPLATE.md` = 이 파일의 골격)
  - 충돌 시 v1.1 이 산출물·상태·형식의 정본, v1.0 이 런타임 단계·경제·헌법의 정본
- **vNext 설계** — `.artibot/guides/vnext-design/`(`09_SECURITY_GOVERNANCE.md` Action Risk Matrix = HG-11~13 의 출처)
- **ADR** — `docs/adr/` · `plugins/artibot/docs/adr/` **두 계열 병존, 번호 충돌 있음.** 단일 계열 통합은 **결정 B2 대기** — 그때까지 어느 쪽도 단독 정본이 아니다.
- **라우팅 정본** — `docs/ORCHESTRATION-ROUTING.md` · 명명 정본 `docs/ORCHESTRATION-GLOSSARY.md`
- **개발자층** — `plugins/artibot/CLAUDE.md`(DEV 프로토콜 · Problem-First Gate · Quality Gates · Context Efficiency · Testing). 이 파일은 그것을 대체하지 않는다.
- **전역 규율** — `~/.claude/rules/artibot/{verification-discipline,agent-coordination,question-recommendations}.md`
