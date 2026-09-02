# 04. Automatic Context Lifecycle

## 문제

현재 사용자가 직접:
- context가 찬 것 같은지 판단
- `/compact`
- 필요하면 `/clear`
- 새 세션에 이전 상태 설명
- lane별 진행상황 재주입

을 한다.

Artibot에는 이미 `pre-compact.js`가 structured summary + state + git snapshot을 만든다. vNext의 목표는 이 자산을 **닫힌 lifecycle loop**로 만드는 것이다.

## 핵심 원칙

**대화 transcript는 cache, run ledger가 state.**

Worker가 context를 잃어도 다음만 있으면 재개 가능해야 한다.
- task/brief
- owned paths
- base/head
- current phase
- completed checkpoints
- pending decisions
- test/gate evidence
- last meaningful summary

## 3가지 Context 전략

### A. Native compact path
Claude Code가 manual/auto compact를 실행:

```text
PreCompact
  → durable checkpoint
  → existing structured summary
Compact
PostCompact
  → compact_summary 저장
  → lane state + brief + pending actions rehydrate
  → resume guard
```

신규 제안:
`plugins/artibot/scripts/hooks/post-compact-rehydrate.js`

### B. Proactive rotation path
직접 `/compact` 명령을 자동 입력하지 않는다.

ContextPressureScore가 높아지면:

```text
checkpoint
→ clean commit or explicit dirty-state snapshot
→ current worker stop/background detach
→ fresh worker session on SAME worktree/branch
→ checkpoint rehydrate
→ continue
```

이 방식은 slash-command 자동화보다 테스트 가능하고 provider-neutral하다.

### C. Session clear/end path
Claude Code `SessionEnd` reason이 `clear`, crash, other라면:
- lane을 실패로 확정하지 않는다.
- git/worktree/checkpoint를 보고 `RECOVERABLE` 여부 판정
- fresh session을 붙일 수 있으면 resume

## ContextPressureScore

직접 token usage API가 없거나 provider마다 다르므로 composite signal 사용:

```text
score =
  0.30 * transcriptBytesRatio
+ 0.20 * turnCountRatio
+ 0.15 * toolResultVolumeRatio
+ 0.15 * elapsedTimeRatio
+ 0.10 * phaseComplexity
+ 0.10 * preCompactRecentness
```

Provider가 정확한 context usage를 제공하면 해당 신호에 우선권을 준다.

### 기본 threshold
- < 0.60: no action
- 0.60~0.74: advisory
- 0.75~0.89: checkpoint soon
- >= 0.90: rotate at next safe boundary

## Safe Boundary

자동 rotation은 다음에서만:
- file write 중 아님
- git operation 중 아님
- migration 적용 중 아님
- test process 종료/분리 가능
- uncommitted diff snapshot 생성 성공

## Checkpoint 내용

```json
{
  "runId": "split-abc123",
  "laneId": "work-ui",
  "seq": 4,
  "phase": "IMPLEMENT",
  "branch": "worktree-split-ontology-work-ui",
  "head": "abc123...",
  "dirty": false,
  "completedTaskIds": ["T1", "T2"],
  "pendingTaskIds": ["T3"],
  "decisions": [],
  "lastTests": [{"command":"npm test -- work-ui","exitCode":0}],
  "resumeInstruction": "T3부터 진행. API 계약 변경 금지."
}
```

## Rehydrate 순서

1. verify repo/worktree identity
2. verify branch/head
3. load immutable lane brief
4. load latest checkpoint
5. replay post-checkpoint events
6. verify owned paths
7. inject only current phase context
8. ask worker to restate next action in one line
9. continue

## Context 비용 최적화

새 worker에 전체 transcript를 넣지 않는다.

**Minimal Rehydration Bundle**:
- 1~2KB lane brief
- <=4KB checkpoint
- relevant decisions
- changed file list
- failing tests only

목표: fresh context의 초기 payload를 10KB 이하로 유지.
