# 00. Executive Summary

## 현재 판단

Artibot `/split`은 이미 다음을 갖고 있다.

- cross-session multi-worktree 병렬화
- file ownership 기반 충돌 회피
- `buildFastFanoutPlan` 재사용
- worktree를 git porcelain으로 확인하는 fail-closed dispatch
- git trailer `Split-Limb: done` 기반 완료 판정
- append-only split telemetry
- human-wait 측정
- PreCompact snapshot
- orchestrator + 전문 agent roster
- reviewer / quality / security agent
- 각종 firewall / gate

따라서 문제는 **agent 능력 부족이 아니라 control plane 부재**다.

### 현재 운영 모델

```text
User
  ↓
Main Claude session
  ↓
/split plan
  ↓
사람이 창 N개 열기
  ↓
각 창 상태 순찰
  ↓
필요 시 '계속', compact, clear, retry
  ↓
review / integrate / gate
```

### 목표 운영 모델

```text
User Goal
   ↓
Supervisor Control Plane
   ├─ Planner / Dependency Graph
   ├─ Adaptive Scheduler
   ├─ Worker Sessions / Worktrees
   ├─ Context Lifecycle Manager
   ├─ Reviewer Pool
   ├─ Budget Governor
   ├─ Recovery Engine
   └─ Durable Run Ledger
           ↓
      Human only on Exception
```

## 핵심 업그레이드 5개

| 우선 | 업그레이드 | 현재 → 목표 | 기대 효과 |
|---|---|---|---|
| 1 | Autonomous Supervisor | 사람이 status 순찰 → 이벤트 기반 자동 감시 | human wait 대폭 감소 |
| 2 | Context Lifecycle Manager | 사람이 compact/clear → checkpoint/rehydrate/rotation 자동 | context 오염·중단 감소 |
| 3 | Durable Workflow | 터미널 session 중심 → run ledger 중심 | crash/session 종료 후 정확히 resume |
| 4 | Adaptive Scheduler | maxWindows=4 hard ceiling 중심 → 자원/위험 기반 동적 병렬도 | CPU/API/token 효율 향상 |
| 5 | Cost/Model Router | agent 정적 model policy → lane별 effort/model/budget | 경제성 및 확장성 향상 |

## 가장 중요한 설계 결정

### 1. 새 DB부터 만들지 않는다
초기에는 기존 `runtime/split/*.events.ndjson`을 append-only event source로 유지한다. 파생 상태만 `*.state.json`으로 둔다. SQLite/Postgres/Temporal은 다중 머신/상시 daemon이 실제로 필요해질 때 승격한다.

### 2. `/compact` 자체를 억지로 자동 입력하지 않는다
현재 PreCompact가 이미 snapshot을 잘 만든다. vNext는:

- native auto/manual compact 발생 시 `PreCompact → checkpoint`, `PostCompact → rehydrate`
- compact 이전에 context pressure가 높으면 **fresh worker rotation**을 선택

한다. 즉 slash command를 자동 입력하는 brittle automation보다 session 교체를 durable state로 안전하게 처리한다.

### 3. 현재 완료 증거를 버리지 않는다
`Split-Limb: done`, worktree branch, gate 결과를 계속 정본으로 쓴다. Agent 메시지는 최적화일 뿐 완료 증거로 승격하지 않는다.

### 4. Human-in-the-loop가 아니라 Human-on-exception
자동 가능:
- status polling
- retry
- read-only probe
- test rerun
- compaction checkpoint
- context rotation
- no-conflict rebase
- reviewer 재요청

사람 승인 필요:
- owner decision
- destructive DB/file action
- production deploy
- credential/permission escalation
- security policy 변경
- merge conflict의 의미적 해소

## 경제성 목표

현재 split pilot에서 human-wait 16.3%가 측정된 적이 있다. vNext의 초기 성공 기준은 **humanWaitPct < 8%**, 장기 목표는 **< 5%**다.

추가 목표:
- context-related manual intervention: 80% 감소
- lane crash recovery: 90% 이상 자동 복구
- merge conflict: 현재 수준(낮음) 유지
- first-pass approval: 악화 금지
- cost per completed lane: 20~35% 감소
- planned parallelism 대비 실제 유효 병렬효율: 70% 이상

## 추천 버전명

`Artibot v5 — Autonomous Engineering Runtime`

`/split`은 계속 사용자 명령으로 남기되 내부 엔진은 `Split Supervisor Runtime`으로 승격한다.
