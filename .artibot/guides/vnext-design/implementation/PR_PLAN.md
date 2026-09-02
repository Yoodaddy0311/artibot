# Implementation PR Plan

## PR-SV01 — Run Event Contract + Reducer

**Goal**: 기존 split NDJSON을 durable state로 replay할 최소 spine.

Files:
- `lib/supervisor/event-types.js`
- `lib/supervisor/contracts.js`
- `lib/supervisor/state-reducer.js`
- tests

Acceptance:
- 같은 event stream → byte-equivalent derived state
- unknown event fail-safe(ignore with warning, state transition 금지)
- terminal state 역행 금지

## PR-SV02 — RunStore + Observe Supervisor

- append event
- atomic derived state write
- reconcile read-only
- `/supervise status`
- 행동 자동화 0

## PR-CX01 — PostCompact Rehydrate

- existing PreCompact snapshot 보존
- PostCompact hook 추가
- latest lane checkpoint inject
- compact summary 저장

## PR-CX02 — Context Pressure + Fresh Worker Rotation (shadow)

- pressure score 계산
- recommendation event만 발생
- 실제 rotation OFF

## PR-DR01 — Durable Checkpoint + Action Idempotency

- checkpoint schema
- actionId ledger
- same action replay no duplicate side effects

## PR-DR02 — Crash Reconcile

- session absent + worktree/branch/head 검산
- recoverability 분류
- auto restart는 OFF

## PR-DR03 — Auto-Reversible Recovery S2

- transient retry
- reviewer reassign
- context rotation
- no-conflict continuation

## PR-SC01 — Conflict/Resource Graph

- existing affectedPaths/dependsOn input
- CPU/DB/server/high-risk class
- deterministic output

## PR-SC02 — Adaptive Scheduler + Work Stealing

- capacity calculation
- backpressure
- hardMax 4 default

## PR-BD01 — Budget Governor

- wall/token/attempt budget
- soft/hard limits
- no model changes yet

## PR-BD02 — Effort/Model Router

- existing modelPolicy authority preserved
- effort/maxTurns first
- optional model choice inside eligible set

## PR-WP01 — WorkerProviderPort + Manual Provider

- current behavior를 adapter로 감쌈
- behavior change 0

## PR-WP02 — Claude Background Provider (opt-in)

- official background/worktree flow
- permission escalation 금지
- unsupported → manual provider fallback

## PR-UX01 — Supervisor Dashboard

- run/lane/context/budget/exception
- read-only first

## PR-DL01 — Combined Gate Automation

- lane approval complete → gate auto start
- gate failure → owning lane mapping

## PR-DL02 — Staging Adapter

프로젝트별 adapter; core에는 port만.

## Dependency

```text
SV01 → SV02
        ├→ CX01 → CX02
        ├→ DR01 → DR02 → DR03
        ├→ SC01 → SC02
        └→ BD01 → BD02

SV02 → WP01 → WP02
SV02 → UX01
DR03 + SC02 → DL01 → DL02
```
