# 10. Implementation Roadmap

## P0 — Baseline Freeze & Measurement

목표: 지금 성능을 잃지 않게 기준선 고정.

- split run KPI snapshot
- current manual intervention taxonomy
- context compact/clear 횟수 기록
- existing tests/gates pin
- no behavior change

완료 기준:
- 최소 5 real runs baseline
- humanWait, rework, context intervention 값 확보

## P1 — Supervisor Observe Mode

신규:
- event types
- state reducer
- run state cache
- `supervise status/watch`
- stale lane detector

자동 행동 0.

**가장 먼저 구현 권장.**

## P2 — Context Lifecycle

- PostCompact handler
- checkpoint contract
- rehydration bundle
- SessionEnd recovery marker
- context pressure advisory
- proactive fresh-worker rotation은 feature flag

목표:
manual `/compact`/`clear` 후 재설명 요구를 크게 줄임.

## P3 — Durable Resume & Self-Healing

- action idempotency
- retry policy
- crash reconcile
- completed lane skip
- reviewer feedback loop

목표:
PC/session crash 후 `--resume` 한 번으로 정확한 위치 재개.

## P4 — Adaptive Scheduler

- dynamic capacity
- resource class
- conflict graph
- work stealing
- backpressure

기본 hard cap은 기존 4 유지. 데이터로 6/8 실험.

## P5 — Cost / Effort Governor

- per-lane budget
- effort routing
- retry budget
- cost telemetry
- model routing은 현재 modelPolicy 안에서만

## P6 — Background Worker Provider + Control Center

- official background/worktree session adapter
- explicit opt-in
- Session↔Worktree durable mapping
- attach/log/stop
- dashboard

이 단계에서 사람이 터미널 N개를 직접 여는 병목을 실질적으로 제거.

## P7 — Delivery Extension

- combined gates 자동화
- staging deploy
- real E2E
- promotion readiness
- rollback hook

Ontology에서 현재 발생한 “main은 빠른데 live가 느린” 병목을 여기서 해소.

## 추천 일정 단위

기간보다 PR 기준으로 관리:
- P1: 2~3 PR
- P2: 2~3 PR
- P3: 3 PR
- P4: 2~3 PR
- P5: 2 PR
- P6: 3~4 PR
- P7: 프로젝트별 adapter

## Kill Switch

각 Phase는 독립 config로 OFF 가능해야 한다.

```text
supervisor.enabled
contextLifecycle.enabled
scheduler.adaptive
budget.enforce
backgroundWorkers.enabled
staging.auto
```
