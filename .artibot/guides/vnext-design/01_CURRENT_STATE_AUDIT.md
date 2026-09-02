# 01. Current State Audit — 실제 Artibot repo 기준

## 조사한 핵심 경로

| 현재 경로 | 현재 역할 | vNext 판단 |
|---|---|---|
| `plugins/artibot/commands/split.md` | plan/open/status/dispatch/run/integrate/handoff/resume 절차 | 유지. markdown은 UX/계약, 제어 로직은 lib로 이동 |
| `plugins/artibot/lib/git/split-dispatch.js` | worktree/session/messaging 관측을 fail-closed로 해석 | 유지. session identity mapping만 개선 |
| `plugins/artibot/lib/observability/split-telemetry.js` | split run/phase/wall-clock 기록 | 핵심 재사용. RECORD ONLY → Supervisor input으로 연결 |
| `plugins/artibot/scripts/hooks/pre-compact.js` | summary + git/cwd + state snapshot | 매우 좋은 기반. PostCompact/rehydrate와 연결 |
| `plugins/artibot/hooks/dispatch-table.json` | hook fan-out 정본 | Supervisor lifecycle hooks를 additive 등록 |
| `plugins/artibot/agents/orchestrator.md` | CTO / Team Leader | session 내부 팀 leader로 유지. cross-session Supervisor와 역할 분리 |
| `plugins/artibot/artibot.config.json` | agent/team/split/model 정책 | `supervisor`, `contextLifecycle`, `scheduler`, `budget` additive 제안 |
| `plugins/artibot/skills/strategic-compact/SKILL.md` | context compaction timing strategy | Context Manager의 advisory input으로 재사용 |
| `plugins/artibot/lib/autopilot/fast-profile.js` | fan-out 계획 | DAG scheduler의 초기 planner로 재사용 |
| `runtime/split/*.events.ndjson` | split 관측 로그 | event source로 승격 가능 |

## 이미 잘 되어 있는 것

### A. 병렬화의 진실원

`/split`은 Agent 메시지를 완료 증거로 쓰지 않고 git/worktree/trailer를 사용한다. 이 선택은 vNext에서도 보존해야 한다.

### B. fail-closed dispatch

`split-dispatch.js`는:
- worktree 실재
- 세션 개수
- messaging availability

를 명시적으로 판정하고 애매하면 refuse한다. Supervisor가 들어와도 이 fail-closed 원칙을 약화시키면 안 된다.

### C. telemetry contract

현재 telemetry는 “기록만 하고 판단하지 않는다”고 의도적으로 분리되어 있다. 구조적으로 매우 좋다. vNext에서는 기록 모듈을 수정해 판단을 넣기보다, 별도 `metrics-reader`/`supervisor-policy`가 event stream을 읽어 결정해야 한다.

### D. PreCompact

현재 `pre-compact.js`는 이미:
- 최근 사용자 요청
- pending work
- decisions
- key files
- current work
- tool mentions
- cwd
- git branch
- git status
- Artibot state

를 보존한다. 따라서 “context persistence를 처음부터 만든다”는 잘못된 접근이다.

## 현재 구조적 병목

### 1. Main session이 사람이 있는 동안만 Supervisor 역할을 한다
`status → dispatch → wait → integrate`를 main session이 절차적으로 수행한다. 별도 durable control loop가 없다.

### 2. 사람만 할 수 있도록 남겨둔 window open 단계
현재 `/split run` 설계는 창을 사람이 열게 멈춘다. 당시 permission laundering을 피하기 위한 안전한 결정이었다. vNext에서는 이를 바로 제거하지 않고 **explicit opt-in background launcher**를 별도 단계로 둔다.

### 3. Session ↔ Worktree mapping이 휴리스틱
Claude session list에 cwd가 없어서 session 이름을 기반으로 추정한다. 공식 `WorktreeCreate/WorktreeRemove`, Session lifecycle hook을 활용해 local ledger에 실제 매핑을 기록하면 휴리스틱 의존을 크게 낮출 수 있다.

### 4. telemetry가 adaptive하지 않다
`humanWaitPct`, plannedParallelism 등을 기록하지만 다음 run의 concurrency/model/context 정책으로 환류하지 않는다.

### 5. context lifecycle이 절반만 자동화
PreCompact 보존은 있으나:
- PostCompact rehydrate
- proactive pressure detection
- fresh-session rotation
- lane resume

가 하나의 loop로 닫혀 있지 않다.

### 6. orchestrator와 supervisor 역할이 섞일 위험
현재 orchestrator는 **한 Claude Team 내부의 CTO**다. vNext Supervisor는 **여러 세션/워크트리/라운드를 관리하는 runtime**이다. 같은 agent로 합치면 context와 책임이 다시 비대해진다.

## 역할 경계 제안

```text
Cross-session / durable
  Supervisor Runtime
      ↓
Session-level
  Orchestrator (CTO)
      ↓
Task-level
  Specialist Agents
```

Supervisor는 구현 내용을 직접 쓰지 않는다. 상태·자원·정책·복구·승인만 책임진다.
