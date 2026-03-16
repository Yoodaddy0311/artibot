---
context: forked
description: "Parallel team execution with cross-check — leader delegates, all opus teammates work independently then verify each other. Use when parallel independent work with cross-verification is needed."
triggers:
  - team
  - 팀
  - parallel team
  - 병렬 팀
  - cross-check
  - 크로스체크
  - 팀원들
  - 병렬로
---

# /team — Parallel Team with Cross-Check

Leader delegates work to opus-only teammates running in parallel. After completion, teammates cross-check each other's output.

## Activation
Auto-activates when: user mentions "team", "팀", "병렬로", "cross-check", or requests parallel independent work with verification.

## Workflow

### 1. Leader Decomposes (no file reading — from request text only)
```
요청 분해:
1. [work unit] → [agent-type]
2. [work unit] → [agent-type]
```

### 2. Team Setup + Parallel Spawn
```javascript
TeamCreate({ team_name: "team-{slug}" })

// Spawn ALL in single message (parallel):
Task({ subagent_type: "artibot:{type}", model: "opus", team_name: "team-*", name: "{role}" })
```

### 3. All Teammates Work Independently
- NO blockedBy between peer tasks
- Each teammate follows DEV Protocol (Decompose-Execute-Verify)
- Leader monitors but does NOT do work

### 4. Cross-Check Phase
After main work completes:
- Teammate A reviews B's work
- Teammate B reviews C's work
- Teammate C reviews A's work (circular)

Each cross-checker verifies:
- Requirements met
- Code correctness
- Tests pass
- No regressions

### 5. Leader Reports Results
Present combined results with cross-check outcomes to user.

## Workflow Checklist

Copy this checklist and track progress:

```
Progress:
- [ ] Step 1: Leader decomposes request into work units + agent types
- [ ] Step 2: TeamCreate — set up named team
- [ ] Step 3: Spawn ALL teammates in parallel (opus model)
- [ ] Step 4: Teammates work independently (DEV protocol)
- [ ] Step 5: Cross-check phase — circular peer review
- [ ] Step 6: Leader aggregates results + cross-check outcomes
- [ ] Step 7: Report combined results to user
```

## Human Checkpoints

### Checkpoint 1: 작업 분해 검토 (After Step 1)
**Context**: 리더가 요청을 분해한 직후, 팀원 소환 전에 확인하는 시점입니다. 이 단계에서 수정하지 않으면 잘못된 작업 단위로 모든 팀원이 병렬 실행됩니다.
**Ask**: "작업 분해가 **올바른가요**? 모든 작업 단위와 에이전트 배정을 확인해 주세요."
**Options**:
1. Approve — 분해 결과가 정확하고 배정도 적절함
2. Add missing units — 누락된 작업 단위를 추가해야 함
3. Reassign agents — 에이전트 유형 재배정이 필요함
**Default**: 1 (리더가 요청 텍스트를 기반으로 분해했으므로 대부분 적절함)
**Skippable**: No — 잘못된 분해는 모든 후속 작업을 무효화함
**Freedom**: MEDIUM

### Checkpoint 2: 팀원 결과물 검토 (After Step 4)
**Context**: 모든 팀원이 독립적으로 작업을 완료한 후, 크로스체크 단계 진입 전 사용자가 중간 결과물의 품질을 판단하는 시점입니다.
**Ask**: "팀원들의 결과물이 **수용 가능한 수준인가요**? 크로스체크로 넘어갈지, 재작업을 요청할지 결정해 주세요."
**Options**:
1. Proceed to cross-check — 결과물이 충분히 완성되어 크로스체크 진행
2. Request rework — 특정 팀원에게 재작업 요청 후 다시 검토
**Default**: 1 (팀원들이 DEV 프로토콜을 따랐으므로 기본적으로 진행)
**Skippable**: No — 품질 미달 결과물로 크로스체크를 진행하면 시간 낭비임
**Freedom**: MEDIUM

### Checkpoint 3: 크로스체크 이슈 처리 (After Step 5)
**Context**: 순환 피어 리뷰가 완료된 후, 발견된 이슈를 어떻게 처리할지 결정하는 시점입니다. 이슈의 심각도와 범위에 따라 처리 방식이 달라집니다.
**Ask**: "크로스체크에서 **이슈가 발견되었나요**? 어떻게 처리할지 선택해 주세요."
**Options**:
1. Fix issues — 관련 팀원이 이슈를 수정하고 재검증
2. Accept as-is — 이슈가 미미하거나 허용 범위 내에 있음
3. Escalate to user — 이슈가 중대하여 사용자 판단이 필요함
**Default**: 1 (발견된 이슈는 기본적으로 수정하는 것이 원칙)
**Skippable**: Yes (이슈 없음이 명확한 경우 자동으로 Accept as-is 처리)
**Freedom**: HIGH

### Checkpoint 4: 최종 결과물 승인 (After Step 7)
**Context**: 리더가 모든 결과물과 크로스체크 결과를 종합하여 사용자에게 보고하는 최종 단계입니다. 전체 팀 작업의 완료 여부를 공식 확인합니다.
**Ask**: "최종 결과물이 **요구사항을 충족하나요**? 팀 작업을 완료로 처리할지 결정해 주세요."
**Options**:
1. Accept — 요구사항이 모두 충족되어 완료 처리
2. Request revisions — 특정 부분 수정 후 재보고 요청
**Default**: 1 (크로스체크까지 통과한 결과물은 일반적으로 수용 가능)
**Skippable**: No — 명시적 승인 없이 완료 처리하면 미완성 작업이 묻힐 수 있음
**Freedom**: LOW

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Decompose request | HIGH | Work unit boundaries and agent assignment are design decisions |
| TeamCreate | LOW | Must create team, naming convention defined |
| Spawn teammates | LOW | All opus, all parallel — constraints are strict |
| Teammates work | MEDIUM | Each follows DEV protocol, but implementation approach is flexible |
| Cross-check | LOW | Circular review mandatory, cannot review own work |
| Aggregate results | HIGH | Synthesis and conflict resolution require judgment |
| Report to user | MEDIUM | Must include cross-check outcomes, format flexible |

## Key Constraints
- Leader = delegation ONLY (never implements)
- ALL teammates = opus model
- ALL work = parallel (unless true dependency)
- Cross-check = mandatory (unless --skip-crosscheck)
- Cross-checker cannot review own work
