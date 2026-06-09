---
description: (Artibot) Maximal evidence-grounded planning — deep-research grounding + multi-lens council + adversarial review + execution handoff
argument-hint: '[task] e.g. "결제 시스템 v2 마이그레이션" [--no-research] [--lenses N]'
allowed-tools: [Read, Glob, Grep, Bash, Task, TaskCreate, Skill]
toolset: team
lifecycle: plan
---

# /ultraplan

`/plan`의 **상위(ULTRA) 등급** 플래닝 모드. `/plan`이 단일 planner로 빠르게 단계를 분해한다면,
`/ultraplan`은 **근거 수집 → 다관점 의회(council) → 종합 → 적대적 검증 → 강화 → 실행 핸드오프**의
6단계로 "이름값 하는" 철두철미한 계획을 만든다.

> **언제 /plan, 언제 /ultraplan?**
> - **/plan** — 범위가 명확하고 빠른 단계 분해가 필요할 때 (단일 planner, 저비용).
> - **/ultraplan** — 위험·비용·장기부채가 큰 결정, 사전조사가 필요한 작업, 되돌리기 어려운 마이그레이션/아키텍처 변경.
> - **deep-research 스킬** — "무엇이 진실인가"(사실 조사) 자체가 목적일 때. /ultraplan은 이 스킬을 1단계 근거수집으로 **내부 호출**한다.

## Arguments

Parse $ARGUMENTS:
- `task`: 계획 대상 (필수)
- `--no-research`: 1단계(GROUND) 스킵 — 외부/코드 조사 없이 내부 지식만으로 계획 (토큰 절약)
- `--lenses N`: 2단계 council 관점 수 (기본 3, 범위 2~4)
- `--scope [file|module|project|system]`: 분석 범위 (기본 project)
- `--no-adversarial`: 4단계 적대적 검증 스킵 (비권장)

## 6-Phase Pipeline

### Phase 1 — GROUND (근거 수집)  ·  `--no-research` 시 스킵
- 작업 도메인을 **deep-research 스킬**로 조사한다: `Skill(deep-research, args="<task> 관련 최신 모범사례·함정·선행사례·벤치마크")`.
  - deep-research가 없거나 실패하면 WebSearch + 코드베이스 Grep으로 폴백.
- 코드베이스 컨텍스트도 수집(`/plan` Phase 2와 동일): 기존 패턴·영향 파일·테스트 커버리지·의존 그래프.
- 산출: **근거 노트**(출처/사실/제약) — 이후 모든 단계의 입력.

### Phase 2 — DIVERGE (다관점 의회, 병렬)
서로 다른 렌즈의 planner/architect를 **병렬 소환**(`--lenses` 개, 기본 3). 각자 독립 계획 후보를 낸다:
- `Task(subagent_type="artibot:planner", model="opus", name="lens-mvp", prompt="[ULTRAPLAN 렌즈: MVP·최단경로] 근거:{ground}\n작업:{task}\n가장 빠르게 가치 내는 단계 계획")`
- `Task(subagent_type="artibot:architect", model="opus", name="lens-risk", prompt="[ULTRAPLAN 렌즈: 위험·견고성 우선] ... 실패모드·롤백·테스트를 최우선으로 한 계획")`
- `Task(subagent_type="artibot:architect", model="opus", name="lens-arch", prompt="[ULTRAPLAN 렌즈: 장기 아키텍처] ... 2년 뒤 유지보수·확장성·기술부채 최소화 계획")`

### Phase 3 — JUDGE & SYNTHESIZE (종합)
리더가 후보 N개를 비교·채점(가치/위험/비용/장기성)하고 **최선안으로 종합**하되 각 후보의 강점을 접목한다.
단일 후보 채택이 아니라 **best-of-all** 합성.

### Phase 4 — ADVERSARIAL REVIEW (적대적 검증)  ·  `--no-adversarial` 시 스킵
공격자 관점 검증: `Task(subagent_type="artibot:code-reviewer", model="sonnet", name="plan-critic", prompt="[Plan 적대 검증] 이 계획의 순환 의존, 누락된 테스트 단계, 숨은 비용, 2년 뒤 기술부채, 실존하지 않는 파일 참조, 비현실적 의존 순서를 전부 찾아내라")`.
발견 항목은 종합안에 반영(재조정) 후 통과시킨다.

### Phase 5 — HARDEN (강화)
- 리스크 매트릭스(심각도×확률) + 단계별 mitigation + rollback + phase gate(검증 기준).
- 되돌리기 어려운 단계는 `/migrate` 체크리스트 또는 `/adr` 기록을 권고.

### Phase 6 — HANDOFF (실행 인계)
- `PlanTracker`(`lib/core/plan-tracker.js`)로 태스크 파싱 + `.plan-state.json` 저장 → 세션 간 추적.
- 실행 경로 추천(직교 2축):
  - **자리 비움/대형 무인작업** → `/autopilot "<task>" --goal "<검증가능 종료조건>"`
  - **병렬 협업/교차검증** → `/team` (Operator-Waits DNA로 자동 발화되기도 함)
  - **단순/단일 파일** → 인라인 즉시 구현

## Output Format

`/plan`의 IMPLEMENTATION PLAN 포맷을 그대로 쓰되 다음 섹션을 **추가**한다:

```
ULTRAPLAN
=========
Task:       [description]
Grounding:  [N sources, M facts]   (--no-research 시 "skipped")
Lenses:     mvp · risk · arch      (N candidates synthesized)
Adversarial:[X issues found → resolved]

[... /plan 의 PHASE 1..N 표준 출력 ...]

EVIDENCE (근거)
---------------
- [fact] — [source/file:line]

LENS SYNTHESIS (관점 종합)
--------------------------
| 렌즈 | 핵심 제안 | 채택 |
|------|-----------|------|
| mvp  | ...       | ✅ 부분 |
| risk | ...       | ✅ 전체 |
| arch | ...       | ✅ 부분 |

ADVERSARIAL FINDINGS (적대 검증)
--------------------------------
| 발견 | 심각도 | 반영 |
|------|--------|------|

RISKS / ROLLBACK
----------------
[severity] [risk] -> [mitigation] -> [rollback]

EXECUTION HANDOFF
-----------------
> 추천: /autopilot | /team | inline  +  근거
> PlanTracker: .plan-state.json 저장됨 (N tasks)
```

## Anti-Patterns

- 리더가 직접 후보 계획을 다 쓰기 — Phase 2는 반드시 병렬 에이전트 위임
- Phase 4(적대 검증) 스킵을 기본으로 — 되돌리기 어려운 작업에서 특히 금지
- deep-research를 재구현 — 빌트인/설치된 스킬을 **호출**만 (Artibot 자체 딥리서치 스킬 없음)
- `/plan`과 동일하게 동작 — ultraplan은 ground+council+adversarial가 본질. 빠른 계획은 `/plan` 사용

## Next Steps

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 자율 실행 | `/autopilot` | Goal Contract로 무인 실행 |
| 2 | 병렬 구현 | `/team` | 교차검증 병렬 팀 |
| 3 | 공수 산정 | `/estimate` | 계획 기반 산정 |
| 4 | 결정 기록 | `/adr` | 되돌리기 어려운 선택 ADR 기록 |
