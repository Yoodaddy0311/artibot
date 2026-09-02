# 12. File-by-File Patch Map

## 기존 파일 — 최소 수정

| 파일 | 변경 |
|---|---|
| `plugins/artibot/commands/split.md` | `watch/supervise`, `--autonomous`, lifecycle 설명만 additive; 절차 로직 더 넣지 않음 |
| `plugins/artibot/artibot.config.json` | supervisor/context/scheduler/budget config 추가 |
| `plugins/artibot/hooks/dispatch-table.json` | PostCompact/SessionEnd/TeammateIdle/TaskCompleted 관련 handler additive |
| `plugins/artibot/scripts/hooks/pre-compact.js` | checkpoint writer adapter 호출 추가. 현재 summary logic 유지 |
| `plugins/artibot/lib/observability/split-telemetry.js` | 기존 event contract 무변경. 새 generic events는 별도 모듈 권장 |
| `plugins/artibot/agents/orchestrator.md` | cross-session supervisor와 책임 경계 1절 추가 |
| `plugins/artibot/skills/strategic-compact/SKILL.md` | context manager와 역할 관계 설명 |

## 신규 파일 — P1 Supervisor

```text
plugins/artibot/lib/supervisor/contracts.js
plugins/artibot/lib/supervisor/event-types.js
plugins/artibot/lib/supervisor/state-reducer.js
plugins/artibot/lib/supervisor/run-store.js
plugins/artibot/lib/supervisor/lane-monitor.js
plugins/artibot/lib/supervisor/exception-policy.js
plugins/artibot/lib/supervisor/supervisor-engine.js
plugins/artibot/commands/supervise.md
plugins/artibot/agents/supervisor.md
plugins/artibot/skills/supervisor/SKILL.md
```

## 신규 파일 — P2 Context

```text
plugins/artibot/lib/context/checkpoint-store.js
plugins/artibot/lib/context/context-pressure.js
plugins/artibot/lib/context/rehydration.js
plugins/artibot/lib/context/rotation-policy.js
plugins/artibot/scripts/hooks/post-compact-rehydrate.js
plugins/artibot/scripts/hooks/session-end-checkpoint.js
```

## 신규 파일 — P3 Recovery

```text
plugins/artibot/lib/supervisor/reconcile.js
plugins/artibot/lib/supervisor/recovery-policy.js
plugins/artibot/lib/supervisor/idempotency.js
```

## 신규 파일 — P4 Scheduler

```text
plugins/artibot/lib/scheduler/resource-model.js
plugins/artibot/lib/scheduler/conflict-graph.js
plugins/artibot/lib/scheduler/adaptive-scheduler.js
plugins/artibot/lib/scheduler/work-stealing.js
```

기존 `lib/autopilot/fast-profile.js`를 planner input으로 사용하고 scheduler가 대체 정본을 만들지 않는다.

## 신규 파일 — P5 Budget

```text
plugins/artibot/lib/budget/budget-policy.js
plugins/artibot/lib/budget/budget-governor.js
plugins/artibot/lib/budget/effort-router.js
plugins/artibot/lib/budget/model-router.js
```

## 신규 파일 — P6 Provider

```text
plugins/artibot/lib/workers/worker-provider-port.js
plugins/artibot/lib/workers/claude-background-provider.js
plugins/artibot/lib/workers/manual-window-provider.js
plugins/artibot/lib/workers/session-worktree-registry.js
```

manual provider는 삭제하지 않는다. fallback이자 permission-safe mode다.

## 테스트

```text
plugins/artibot/tests/supervisor/*
plugins/artibot/tests/context/*
plugins/artibot/tests/scheduler/*
plugins/artibot/tests/budget/*
plugins/artibot/tests/integration/split-supervisor-*.test.js
plugins/artibot/tests/firewall/supervisor-policy-boundary.test.js
plugins/artibot/tests/firewall/context-rehydrate-contract.test.js
plugins/artibot/tests/firewall/background-worker-permission.test.js
```

## 건드리지 말아야 할 것

초기 P1/P2에서:
- 기존 git trailer 완료 규약
- split branch naming
- existing split dispatch fail-closed semantics
- existing model hard pin
- write guard
- security policy
- live deployment behavior

을 변경하지 않는다.
