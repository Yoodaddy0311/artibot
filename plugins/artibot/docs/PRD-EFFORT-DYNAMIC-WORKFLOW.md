# PRD: Effort × Dynamic-Workflow Fusion

> **Status**: Approved · **Created**: 2026-05-29 · **Owner**: Artibot core
> **Target**: v4.18.0 (P1+P2), v4.19.0 (P3) · **Task list**: #1 (P1), #2 (P2), #3 (P3)

## 1. 배경

v4.17.0에서 Claude Opus 4.8 native effort 레벨(`max|xhigh|high|medium|low`)을 도입했다.
그러나 effort는 **명령어 이름만으로 결정되는 정적 매핑**이고, dynamic workflow(자동 팀 트리거)
및 GRPO 학습 인프라와 분리되어 있다. 본 PRD는 이 두 기능을 확장적·효율적·미래지향적으로
결합/발전시키는 3개 제안을 정의한다.

### 현재의 핵심 갭

| # | 갭 | 증상 |
|---|----|------|
| G1 | effort가 정적 | `classifyComplexity()`의 `score`를 `getEffortForCommand()`가 무시. 사소한 `/implement`와 대형 `/implement`가 동일 `xhigh`. `runtime-prompt.js:91`의 손실 `xhigh→high` 다운그레이드 |
| G2 | effort ↔ dynamic workflow 분리 | 자동 팀 트리거(Operator-Waits DNA)와 effort 결정이 별개 경로. teammate가 부모 effort flat copy |
| G3 | 피드백 루프 부재 | GRPO 보상 인프라가 effort/budget 정책을 튜닝하지 않음 |
| G4 | budget이 컨텍스트-무관 | 남은 1M 컨텍스트·실사용량과 무관한 고정 맵 |

## 2. 목표 / 비목표

**목표**
- effort를 `명령어 × 복잡도 × 컨텍스트(× 학습된 성과)`의 함수로 진화
- 단일 복잡도 계산이 팀 트리거와 per-teammate effort/budget를 동시 구동
- 정적 정책을 byte-identical fallback으로 보존(zero-risk 점진 채택)

**비목표**
- EFFORT_POLICY 정적 베이스라인 자체의 재분류(56개 명령 매핑은 유지)
- native effort API 스펙 변경 (Anthropic 측 기능)
- 외부 데이터 송신 일체 (DATA POLICY 엄수 — 모든 학습은 로컬 GRPO)

## 3. 제안 3종 (구현 스펙 요약)

### P1 — Score-Aware Effort Resolution `resolveEffort()` [강점: 효율성 / quick-win]

effort를 `명령어 × 복잡도 score × 남은 컨텍스트`의 함수로. `EFFORT_POLICY`를 베이스라인으로
±1 밴드 시프트. **신호 없으면 현재와 byte-identical.** P2·P3가 재사용하는 토대.

- **핵심 발견**: `router.js`가 816줄 → file<800 위반. 신규 sibling `lib/cognitive/effort-resolver.js`로
  추출 후 router.js 하단 re-export(ESM live binding, 순환참조 회피). hookData의 `context_window`로
  `remainingContextRatio` 도출.
- **Phase 1** (effort-resolver.js 신규): `EFFORT_BANDS` frozen + `resolveEffort(command, signals)` →
  `{effort, baseline, shift, reason}`. shift: score≥0.7→+1, ≤0.25→−1, ctxRatio<0.15→−1, [−1,+1] clamp,
  히스테리시스 ±0.05.
- **Phase 2** (runtime-prompt.js): `resolveEffortMeta`에 hookData 추가, `deriveEffortSignals`/`resolveScoredEffort`
  헬퍼, 손실 다운그레이드 제거(NATIVE_API_FALLBACK 맵), current-effort.json에 score/shift/reason.
- **Phase 3** (tasks.js): readEffortMeta/task.meta에 shift/reason 전파.
- **검증**: `tests/cognitive/router-resolve-effort.test.js`(~30 it), `tests/runtime/effort-signals.test.js`,
  기존 56-key assertion 무변경. 생성 3 / 수정 3, prod +120 / test +210 LOC. 리스크 Low-Medium.

### P2 — Unified Effort×Team Trigger `workflow-plan.js` [강점: 확장성 / 중규모]

복잡도 계산을 한 번만 해서 (1) 자동 팀 트리거 + (2) per-teammate effort/budget를 같은 소스로.
**P1 재사용(없어도 getEffortForCommand fallback으로 독립 동작).**

- **핵심 발견**: live `intent`에 subObjectives 없음 → `intent.recommendations[]`에서 파생(각 rec=1
  서브목표, `commands[0]`이 effort 구동, count가 subtasks/files proxy). Layer 무결성: workflow-plan은
  순수 L4(router만 import), budgetResolver는 L5(tasks.js)가 주입.
- **Phase 1** (workflow-plan.js 신규): `buildWorkflowPlan(classification, intent, config, deps)` →
  frozen `WorkflowPlan{runner, effort, perAgentBudget, teammates[], trigger}`. team.autoApplyTriggers 재사용.
- **Phase 2** (tasks.js): `deriveTeammateEfforts(subObjectives, parentEffort, resolveFn)` — [parent−1, parent]
  clamp. mode==='agentTeam'일 때 task.meta.workflowPlan 첨부.
- **Phase 3** (orchestrator.md, CLAUDE.md): teammate spawn 시 workflowPlan.teammates[i].effort/budget를
  prefix, 없으면 parent fallback. canonical evaluator = workflow-plan.js, 수치는 config에만.
- **검증**: `tests/cognitive/workflow-plan.test.js`(~28 it). 생성 2 / 수정 3, ~290 LOC. 리스크 Medium. **선행: P1**

### P3 — GRPO-Tuned Adaptive Effort/Budget Policy [강점: 미래지향 / 야심]

기존 GRPO 보상으로 effort 베이스라인 + budget map을 야간 튜닝. 학습된 per-command `bandShift` +
per-effort `budgetMultiplier`를 `~/.claude/artibot/policies/effort-policy-v1.json`에 영속화,
정적 정책 위 bias로 소비. **기본 disabled = zero-risk dormant.** `grpo-routing-config.js` 패턴 그대로.

- **Phase 1** (reward-metrics.js): recordReward에 optional meta{effort,command,budget,tokensUsed},
  recentEpisodes additive, coerceState 무변경.
- **Phase 2** (effort-policy-config.js 신규 L4): `getEffortPolicyOverlay()` frozen identity defaults,
  60s memo, never-throws. version!=1/손상/없음→identity. clamp [−1,+1] / [0.5,1.5]. config 블록 추가.
- **Phase 3** (router.js, task-budget.js): resolveEffort에 overlay.bandShifts 블렌딩(combined ladder clamp),
  getTaskBudgetForEffort에 overlay multiplier + ceiling 재clamp.
- **Phase 4** (effort-policy-updater.js 신규 L3): rollupEffortEpisodes/deriveOverlay/saveEffortPolicy 순수
  집계. KL-style deltaL1Cap=1.5, coldStart=150, minPerKey=20, snapshot 3. config cron
  `nightlyEffortPolicyTrainer "30 3 * * *"`. **오픈 이슈: 야간 스케줄러 dispatch 등록 지점 grep 필요**
  (`nightlyJointPolicyTrainer` 핸들러).
- **5-layer 검증**: 트레이너(L3 write)↔reader(L4 read)는 디스크 JSON으로만 통신(import cycle 없음).
  task-budget(L5)은 overlay를 인자로 받아 L4 import 안 함 — hook이 composition root.
- **검증**: config(disabled→identity)/updater(synthetic→−1, idempotent, coldStart no-write, snapshot 회전)/
  back-compat/multiplier 테스트. 생성 2 lib + 2 test(~660) / 수정 6(~126 LOC). 리스크 Low(dormant). **선행: P1**

## 4. 실행 계획 (의존성)

```
P1 (foundation, 공유 파일 router.js/tasks.js)
 ├──► P2 (tasks.js attach + orchestrator/CLAUDE 문서)   ┐
 └──► P3 (router blend + task-budget + reward-metrics)  ┘ ← P2∥P3 편집 파일 비충돌, 진짜 병렬 가능
```

**릴리스 묶음**: v4.18.0 = P1 + P2 / v4.19.0 = P3(dormant 머지 후 A/B로 활성화)

## 5. 위험 / 완화

| 위험 | 완화 |
|------|------|
| router.js > 800줄 | resolveEffort를 sibling effort-resolver.js로 추출 |
| 순환 import (router↔resolver) | router 하단 re-export(ESM live binding) + import 테스트 |
| 무신호 경로 행동 회귀 | 56개 EFFORT_POLICY 키 byte-identical 스냅샷 테스트 |
| P2 subObjectives proxy 약함 | recommendations.length fallback + 향후 intent.subObjectives 훅 |
| P3 overlay+P1 시프트 overshoot | 합산 후 단일 ladder clamp [0,4] |
| P3 학습 정책 품질 저하 | flag-gated disabled 기본 + snapshot 롤백 + coldStart 게이팅 + A/B |

## 6. 수락 기준

- [ ] P1: 무신호 시 `resolveEffort(cmd,{})` === `getEffortForCommand(cmd)` (56키 전부), router.js<800줄, 순환참조 없음
- [ ] P2: teammate effort ∈ [parent−1, parent], perAgentBudget 합 ≤ ceiling, workflow-plan L4 clean
- [ ] P3: `enabled:false` 시 행동 무변경(dormant 증명), 모든 clamp 보장, 트레이너 deterministic
- [ ] 전체: `npm run ci` 통과, 커버리지 90/85/88/90 유지

## 7. 참조

- ADR: `docs/adr/ADR-001-effort-workflow-fusion.md`
- 관련 코드: `lib/cognitive/router.js`, `lib/runtime/task-budget.js`, `lib/runtime/middleware/tasks.js`,
  `lib/cognitive/grpo-routing-config.js`(패턴), `lib/learning/grpo/reward-metrics.js`
- 태스크: #1 P1 / #2 P2 (blockedBy #1) / #3 P3 (blockedBy #1)
