# 05. Durable Workflow & Self-Healing

## Run State Machine

```text
CREATED
  ↓
PLANNED
  ↓
PROVISIONING
  ↓
READY
  ↓
EXECUTING
  ↓
REVIEWING
  ↓
INTEGRATING
  ↓
GATING
  ↓
STAGING
  ↓
E2E
  ↓
PROMOTING
  ↓
COMPLETED
```

어느 단계에서든:
- `BLOCKED`
- `PAUSED`
- `FAILED_RECOVERABLE`
- `FAILED_TERMINAL`
- `CANCELLED`

로 갈 수 있다.

## Lane State Machine

```text
PENDING → READY → CLAIMED → RUNNING
                          ├→ CHECKPOINTING → RUNNING
                          ├→ WAITING_INPUT
                          ├→ REVIEW_REQUIRED → FIXING → REVIEW_REQUIRED
                          ├→ DONE
                          └→ FAILED_RECOVERABLE → READY
```

## Event Sourcing

기존 `runtime/split/{runId}.events.ndjson`를 유지하고 event vocabulary를 확장한다.

### 새 이벤트 후보

- `run-created`
- `run-state-changed`
- `lane-created`
- `lane-state-changed`
- `lane-heartbeat`
- `lane-progress`
- `worker-attached`
- `worker-detached`
- `context-pressure`
- `checkpoint-written`
- `checkpoint-restored`
- `review-requested`
- `review-result`
- `retry-scheduled`
- `budget-warning`
- `budget-exhausted`
- `human-required`
- `human-resolved`
- `gate-started`
- `gate-result`

## Idempotency

모든 명령은 `(runId, actionId)`로 중복 방지.

예:
```text
retry:split-abc:work-ui:attempt-2
review:split-abc:work-ui:head-a1b2
checkpoint:split-abc:work-ui:4
```

동일 actionId는 같은 결과를 반환하고 부작용을 반복하지 않는다.

## Recovery Matrix

| Failure | 자동 복구 | 방법 |
|---|---|---|
| session 사라짐, worktree intact | O | fresh worker attach + checkpoint |
| test flaky | O | max 2 selective retry |
| rate limit | O | exponential backoff / 다른 lane 실행 |
| context exhaustion | O | checkpoint + rotate |
| reviewer requests changes | O | worker에 structured feedback 재할당 |
| branch behind, conflict 0 | O | update/rebase 정책에 따라 자동 |
| merge conflict | 제한 | mechanical conflict만 auto, semantic은 human |
| permission prompt 필요 | X background | foreground escalation |
| owner decision | X | exception queue |
| prod destructive operation | X | explicit approval |

## Restart 이후 복구

PC가 꺼져도:

1. `artibot supervise --resume <runId>`
2. events replay
3. current git worktrees scan
4. lane head/trailer scan
5. checkpoint reconcile
6. 이미 완료된 lane 재실행 금지
7. 살아있는 lane attach
8. 죽은 lane만 재생성

## “성공한 병렬 작업 재실행 금지”

LangGraph의 pending-writes 아이디어를 차용한다. 같은 wave에서 C lane이 실패했어도 A/B가 완료됐다면 A/B 결과를 durable completion으로 유지하고 C만 재시작한다.
