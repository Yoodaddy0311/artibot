# 03. Supervisor Control Plane

## 목표

사람이 각 터미널을 순찰하지 않아도 Supervisor가 다음을 수행한다.

1. 어떤 lane이 살아 있는지 확인
2. idle/blocked/failure 감지
3. 자동 retry 여부 판단
4. context pressure 감지
5. checkpoint 및 worker rotation
6. reviewer dispatch
7. combined gate 시작
8. budget 초과 차단
9. 오직 예외만 사람에게 질문

## Supervisor는 Agent인가, 코드인가?

**둘 다지만 정본은 코드다.**

- `SupervisorEngine`: deterministic state transition / policy / retry / scheduling
- `supervisor-agent.md`: 애매한 진단/요약/복구안 제시

중요한 상태전이는 LLM 자유판단에 맡기지 않는다.

## 제안 경로

```text
plugins/artibot/lib/supervisor/
  contracts.js
  event-types.js
  state-reducer.js
  run-store.js
  supervisor-engine.js
  lane-monitor.js
  exception-policy.js
  recovery-policy.js
  heartbeat.js

plugins/artibot/agents/supervisor.md
plugins/artibot/commands/supervise.md
plugins/artibot/skills/supervisor/SKILL.md
```

## Control Loop

```pseudo
while run not terminal:
    events = observe(run)
    state = reduce(events)

    for lane in state.activeLanes:
        health = assessHealth(lane)

        if health == CONTEXT_PRESSURE:
            contextManager.checkpointOrRotate(lane)

        if health == TRANSIENT_FAILURE:
            recovery.retryWithinBudget(lane)

        if health == REVIEW_READY:
            reviewer.dispatchIndependentReviewer(lane)

        if health == HUMAN_REQUIRED:
            exceptionQueue.raise(lane)

    scheduler.fillAvailableCapacity(state)

    if all required lanes approved:
        gates.runCombined()

    persist decisions as events
```

## 상태 감시 방식

### 우선순위 1 — 구조화 이벤트
Worker가 다음 이벤트를 기록:
- `lane-heartbeat`
- `lane-progress`
- `lane-blocked`
- `lane-result-ready`
- `context-pressure`
- `checkpoint-written`

### 우선순위 2 — Git evidence
- commit activity
- branch existence
- trailer
- working tree status

### 우선순위 3 — Claude session observation
- Session list / Agent View / hook mapping

메시지 텍스트 scraping은 최후 수단이다.

## Heartbeat

Worker가 tool call마다 heartbeat를 쓰면 I/O가 과하다. 다음 조건 중 하나에서만:
- 단계 전환
- 5분 경과
- blocking 발생
- checkpoint
- review ready

### Stuck 판정 예시

```text
ACTIVE + heartbeat < 8m        → healthy
ACTIVE + heartbeat 8~15m      → suspect
ACTIVE + heartbeat >15m       → inspect
session absent + dirty worktree → recoverable
session absent + clean/no commit → restart
```

시간값은 config로 두고 실데이터로 조정한다.

## Human Exception Queue

Supervisor가 사용자에게 묻는 질문은 반드시 구조화한다.

```json
{
  "kind": "OWNER_DECISION",
  "runId": "split-abc123",
  "lane": "db-schema",
  "question": "migration 전략 A/B 중 선택 필요",
  "options": ["A", "B"],
  "recommended": "A",
  "impact": "B는 live rollback 비용 증가",
  "blocking": true
}
```

사람은 전체 터미널 로그를 읽는 대신 이 큐만 처리한다.

## Supervisor Autonomy Level

| Level | 동작 |
|---|---|
| S0 Observe | 상태/경고만 표시 |
| S1 Assist | retry/compact/next action 추천 |
| S2 Auto-Reversible | reversible 작업 자동, owner 판단은 요청 |
| S3 Auto-Delivery | staging까지 자동 |
| S4 Controlled Prod | explicit policy 안에서 prod promotion까지 |

**출하 기본값: S0.** Ontology처럼 검증된 리포에서 S2로 올린다.
