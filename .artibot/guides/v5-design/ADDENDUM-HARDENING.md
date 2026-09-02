# Artibot 5.0 — Final Architecture Hardening Addendum

**Status:** Pre-implementation hardening document  
**Purpose:** Close remaining architectural gaps before further v5 implementation  
**Applies to:** Artibot v5.0 core runtime, multi-human collaboration, multi-agent execution, Split, Autopilot, model routing, artifact governance

---

# 0. Executive Conclusion

Artibot v5의 핵심은 단순히 Fable 5.1 지원이나 모델 라우팅 추가가 아니다.

v5의 본질은 다음 6개가 하나의 런타임으로 연결되는 것이다.

```text
Intent
  ↓
Execution Profile
  ↓
Canonical Project State
  ↓
Task Graph / Execution Topology
  ↓
Adaptive Intelligence Routing
  ↓
Independent Review + Verified Outcome
```

그리고 이 모든 과정은 자동으로 다음을 남겨야 한다.

```text
Canonical Artifacts
+
Transactional State
+
Append-only Event History
```

최종적으로 Artibot v5는 다음 문장으로 정의한다.

> **Intent-first, state-coherent, adaptively-routed, artifact-governed autonomous runtime.**

---

# 1. 가장 먼저 수정해야 할 기존 설계

## 1.1 `state.yaml`은 진짜 Source of Truth가 되어서는 안 된다

멀티유저, multi-agent, Split, worktree 환경에서는 각 branch/worktree에 `state.yaml` 사본이 생길 수 있다.

따라서:

```text
state.yaml = Canonical Live Truth
```

는 폐기한다.

대신:

```text
Transactional State Store = Canonical Live Truth
state.yaml = Human-readable Projection / Snapshot
```

으로 정의한다.

### 권장 초기 구현

```text
Local / Single-host
→ SQLite

Multi-host / Team
→ Remote transactional backend
  (Postgres 등으로 교체 가능한 adapter)
```

런타임 인터페이스는 storage backend에 독립적이어야 한다.

```text
StateStore
 ├ getMission()
 ├ updateMission()
 ├ claimTask()
 ├ releaseTask()
 ├ heartbeatWorker()
 ├ appendEvent()
 └ reconcile()
```

---

# 2. Natural Language → Command가 아니라 Execution Profile

비개발자가 주요 사용자라는 Artibot 철학을 지키려면 자연어와 command를 직접 1:1 매핑해서는 안 된다.

잘못된 구조:

```text
"빨리 해줘"
→ /autopilot --fast
```

권장 구조:

```text
Natural Language ─┐
Command ──────────┼→ Execution Profile → Runtime
Skill ────────────┤
Explicit Setting ─┘
```

## Execution Profile 예시

```yaml
execution_profile:
  reasoning:
    depth: deep

  autonomy:
    level: full

  performance:
    priority: speed_accuracy
    budget: generous

  parallelism:
    strategy: aggressive

  planning:
    mode: ultraplan

  context:
    strategy: sufficient

  review:
    independent: true
    strictness: high
    model: fable-5.1

  completion:
    verified_outcome_required: true
```

### 핵심 철학

> **Command는 Runtime의 본질이 아니라 Power User용 Shortcut이다.**

따라서 향후 `/split`, `/team`, `/autopilot` 명령어 이름이 변하거나 제거되어도 내부 Architecture는 유지되어야 한다.

---

# 3. Project / Mission / Task / Action / Run Ontology 확정

이 계층을 구현 전에 반드시 고정한다.

| Level | 정의 | 예 |
|---|---|---|
| Project | 장기간 유지되는 제품/저장소 | Artibot |
| Mission | 사용자가 원하는 하나의 Outcome | Split 개선 |
| Task | Mission을 달성하기 위한 작업 단위 | Context handoff 개선 |
| Action | Router가 지능을 선택하는 최소 단위 | 관련 파일 탐색 |
| Run | Action의 실제 실행 시도 | Opus 실행 #1 |

구조:

```text
Project
  ↓
Mission
  ↓
Task
  ↓
Action
  ↓
Run
```

## 규칙

- `intent.md`는 Mission 단위로만 존재한다.
- Task별 `intent.md`는 만들지 않는다.
- Worker별 `intent.md`도 만들지 않는다.
- Task/Worker는 canonical mission intent를 참조한다.
- Model routing은 Action 단위로 결정한다.
- Usage/Cost/Retry 기록은 Run 단위로 남긴다.

---

# 4. `intent.md`를 First-Class Artifact로 확정

## 생성 기준

Substantive Mission이면 반드시 생성한다.

생성하지 않는 예:
- 단순 대화
- 짧은 문장 수정
- 일회성 설명
- 프로젝트 상태를 변경하지 않는 매우 작은 질의

## 역할

`intent.md`는 다음 질문에만 답한다.

> **무엇을 성공시켜야 하고, 왜 하는가?**

다음 내용은 포함한다.

```text
Original Request
Interpreted Goal
Explicit Scope
Systemic Scope
Success Criteria
Constraints
User Decisions
Intent Refinements
```

## 금지

```text
intent-v2.md
intent-final.md
intent-agent-a.md
interpreted-intent.md
```

한 Mission에는 하나의 `intent.md`만 존재한다.

---

# 5. Artifact Dependency Graph를 반드시 넣는다

문서가 존재하는 것만으로는 부족하다.

각 Artifact가 **어느 revision을 기준으로 만들어졌는지** 알아야 한다.

예:

```yaml
plan:
  revision: 5
  based_on:
    intent_revision: 2
```

```yaml
review:
  revision: 1
  based_on:
    intent_revision: 2
    plan_revision: 5
```

```yaml
outcome:
  based_on:
    intent_revision: 2
    plan_revision: 5
    review_revision: 1
```

## Staleness propagation

Intent가 2 → 3으로 바뀌면 자동으로:

```text
Plan → STALE
Review → INVALID
Outcome → NOT ACCEPTABLE
```

가 되어야 한다.

이것을 Runtime이 판단해야 한다.

> **Stale artifact가 최신 Truth처럼 사용되는 것을 시스템적으로 차단한다.**

---

# 6. Documentation은 Agent 책임이 아니라 Runtime Side Effect

Agent에게 매번:

```text
intent.md 갱신
plan.md 갱신
state 업데이트
ledger 기록
```

을 지시하면 언젠가 누락된다.

따라서 다음 이벤트를 Runtime이 직접 관리한다.

```text
mission.created
→ intent.md 생성

plan.accepted
→ plan.md 생성/갱신

adr.accepted
→ ADR 저장

review.completed
→ review.md 생성

mission.completed
→ outcome.md 생성

all runtime events
→ ledger append
```

핵심 원칙:

> **Documentation is a Runtime Side Effect.**

정상적으로 작업하면 문서가 자동으로 남아야 한다.

---

# 7. Manus식 todo 철학은 유지하되 `todo.md`는 만들지 않는다

가져와야 할 것은 파일명이 아니라 원리다.

필요한 상태:

```text
무엇이 끝났는가
무엇이 남았는가
무엇이 막혔는가
누가 작업 중인가
다음 작업은 무엇인가
```

이를 별도 `todo.md`가 아니라 **Structured Task Graph**로 관리한다.

```yaml
tasks:
  T-001:
    title: inspect context handoff
    status: done
    owner: worker-a

  T-002:
    title: redesign worker lifecycle
    status: executing
    owner: worker-b
    depends_on:
      - T-001

  T-003:
    title: regression tests
    status: queued
    depends_on:
      - T-002
```

필요하면 UI나 Markdown으로 렌더링할 수 있지만 canonical truth는 Task Graph다.

---

# 8. Task Graph에 반드시 필요한 필드

최소한 다음을 포함한다.

```yaml
task:
  id:
  mission_id:
  title:
  status:
  owner:
  dependencies:
  blockers:
  file_ownership:
  retry_count:
  created_at:
  updated_at:
  heartbeat_at:
  verification:
  evidence_refs:
```

## 상태

```text
queued
claimed
executing
blocked
reviewing
done
failed
cancelled
```

---

# 9. Claim / Lease / Heartbeat가 필요하다

다중 Agent 환경에서 Task ownership은 단순 문자열이 아니다.

Worker가 죽었는데 Task가 영원히 `executing`이면 안 된다.

따라서 **lease 기반 claim**이 필요하다.

```text
Worker claims Task
  ↓
Lease expires in N minutes
  ↓
Heartbeat renews lease
  ↓
Heartbeat stops
  ↓
Task becomes reclaimable
```

권장 필드:

```yaml
lease:
  owner:
  acquired_at:
  expires_at:
  heartbeat_at:
```

이 기능은 Split의 수동 모니터링을 줄이는 핵심이다.

---

# 10. File Ownership / Conflict Prevention

Split이나 Team에서는 두 Worker가 같은 파일을 동시에 수정할 수 있다.

이를 사전에 줄여야 한다.

## 권장

Task claim 시 파일/디렉터리 ownership을 선언한다.

```yaml
file_ownership:
  - plugins/artibot/lib/routing/**
```

Runtime은 다음을 감지한다.

```text
Exclusive overlap
→ block or renegotiate

Read-only overlap
→ allowed

Unknown overlap
→ warning / planner resolution
```

단, ownership은 Git lock이 아니라 **coordination policy**로 시작해도 된다.

---

# 11. Idempotency를 Runtime 원칙으로 추가

Autonomous recovery에서는 같은 Action이 재실행될 수 있다.

따라서 가능한 모든 Runtime operation은 idempotent해야 한다.

예:

```text
mission.created
task.claimed
review.saved
artifact.updated
ledger.append
```

에는 event/action id가 있어야 한다.

```yaml
idempotency_key: mission:M-001:review:rev-2
```

재시도해도 artifact가 중복 생성되지 않아야 한다.

---

# 12. Event Ledger는 Append-only + Reconciliation 가능해야 한다

Ledger는 단순 로그가 아니다.

최소 이벤트:

```text
mission.created
intent.revised
plan.created
plan.revised
task.created
task.claimed
task.completed
worker.heartbeat
model.routed
model.switched
action.started
action.completed
review.completed
verification.completed
mission.completed
mission.failed
```

## 중요한 기능

State Store와 Ledger가 충돌할 때:

```text
reconcile()
```

을 수행할 수 있어야 한다.

즉 Artibot이 자기 상태를 복구할 수 있어야 한다.

---

# 13. Crash Recovery / Resume Contract 필요

장기 Agent 실행에서 process crash는 정상적인 상황으로 본다.

재시작 시 Runtime은:

```text
Load State Store
 ↓
Read latest ledger position
 ↓
Find active Missions
 ↓
Find expired worker leases
 ↓
Reconcile Tasks
 ↓
Revalidate artifact revisions
 ↓
Resume safe Actions
```

을 수행해야 한다.

`/resume` 명령어가 있더라도 핵심 기능은 Runtime Resume Contract다.

---

# 14. Fable 5.1 Review는 Clean-room 방식

Builder와 Reviewer가 동일한 긴 reasoning/context를 공유하면 독립 검토의 의미가 약해진다.

Fable reviewer 기본 입력:

```text
Canonical intent.md
Relevant ADRs
Current plan.md
Diff / changed artifacts
Tests
Evidence
Constraints
```

기본적으로 제외:

```text
Builder의 긴 chat history
Builder의 self-assessment
불필요한 시행착오 로그
오래된 discarded plans
```

목표:

> **Fresh Eyes Review**

Reviewer는 canonical intent를 기준으로 결과를 다시 판단한다.

---

# 15. Fable Reviewer 권한

Reviewer는 강해야 하지만 Truth를 직접 바꾸면 안 된다.

권장 권한:

```text
PASS
REPAIR_REQUIRED
REPLAN_REQUIRED
INTENT_REVIEW_REQUIRED
BLOCK
```

Reviewer는:
- intent 직접 수정 불가
- plan 직접 수정 불가
- finding과 severity를 제출
- Mission Controller가 후속 상태 전이를 결정

---

# 16. Intent 수정 권한

다중 Agent 환경에서 매우 중요하다.

| Actor | Intent 수정 권한 |
|---|---|
| User | 가능 |
| Mission Controller | Evidence 기반 refinement 가능 |
| Planner | 제안 가능 |
| Worker | Finding 제출만 가능 |
| Reviewer | 문제 제기 가능 |
| Tool | 불가 |

Worker가 자기 작업을 편하게 만들기 위해 Goal을 바꾸는 것을 차단한다.

---

# 17. Mission Controller를 명시적으로 둔다

현재 설계에는 Planner/Router/Worker는 있지만 전체 Mission의 Truth를 관리하는 권한 주체가 더 명확해야 한다.

Mission Controller 책임:

```text
Intent lifecycle
Plan acceptance
Task Graph ownership
Artifact staleness
Human question gate
Worker findings
Review verdict handling
Mission completion decision
```

Mission Controller는 반드시 하나의 logical authority여야 한다.

구현은 하나의 process일 필요는 없지만, 동시에 두 Controller가 동일 Mission을 지배하면 안 된다.

---

# 18. Human Question Gate를 Execution Profile과 연결

질문 여부는 단순 confidence threshold만으로 결정하면 안 된다.

질문 조건:

```text
Human value judgment required
+
Material downstream impact
+
Evidence cannot decide
+
Cost of wrong assumption is meaningful
```

ADR 초기에는 필요한 질문을 빠르게 모아서 한 번에 제시하는 방식을 우선한다.

질문을 여러 차례 산발적으로 던지는 것은 피한다.

---

# 19. Routing / Switching / Escalation / Downgrade / Pinning 분리

v5에서 반드시 별도 개념으로 구현한다.

## Routing
다음 Action을 어느 모델이 수행하는가?

## Switching
현재 Phase/Session에서 모델을 변경할 가치가 있는가?

## Escalation
성공 확률이 낮아 더 강한 모델이 필요한가?

## Downgrade
고급 reasoning이 끝나 더 저렴한 모델로 내려갈 수 있는가?

## Pinning / Hysteresis
Cache/context handoff 손실 때문에 현재 모델을 유지하는 것이 더 이득인가?

이것들을 하나의 `selectModel()`에 뭉개지 않는다.

---

# 20. Execution Profile은 명시적으로 버전 관리

Intent와 Router 사이의 핵심 계약이다.

```yaml
execution_profile:
  version: 1
  derived_from:
    intent_revision: 3
```

Intent가 바뀌면 Execution Profile도 stale 여부를 확인한다.

---

# 21. `autopilot --fast`와 `split`은 별도 경제 목적함수

일반 실행:

```text
Quality constraint 만족
+
Cost per Accepted Outcome 최소화
```

`autopilot --fast`:

```text
Time to Verified Outcome 최소화
+
Accuracy 최대화
+
Generous budget
```

`split`:

```text
Wall-clock 최소화
+
Parallel throughput 최대화
+
Accepted Quality 유지
```

따라서 Router/Economics layer에 **mode-specific objective**가 있어야 한다.

---

# 22. Context 역시 Versioned Dependency로 취급

Context Package가 어느 Intent/Plan을 기반으로 만들어졌는지 기록한다.

```yaml
context_package:
  based_on:
    intent_revision: 3
    plan_revision: 7
```

Plan 변경 후 오래된 Context Package가 Worker에게 전달되지 않아야 한다.

---

# 23. Evidence Registry를 별도 개념으로 둔다

중요한 근거를 Markdown에 반복 복사하지 않는다.

Evidence는 ID로 참조할 수 있어야 한다.

```yaml
evidence:
  E-001:
    type: test
    source: ...
    hash: ...
    created_at: ...
```

Intent refinement, Review, Outcome은 다음처럼 참조한다.

```yaml
evidence_refs:
  - E-001
  - E-008
```

이렇게 하면:
- 중복 감소
- provenance 강화
- review 재현 가능
- context 비용 감소

---

# 24. Artifact Provenance가 필요하다

각 Artifact에는 최소한 다음 메타데이터를 둔다.

```yaml
created_by:
updated_by:
created_at:
updated_at:
revision:
based_on:
evidence_refs:
```

다중 사용자/Agent 환경에서는 “누가 왜 바꿨는지”가 필수다.

---

# 25. Secret / Sensitive Data는 Artifact에 자동 저장하지 않는다

문서화를 자동화하면 오히려 secret/token/PII가 Markdown이나 ledger에 남을 위험이 있다.

따라서 Artifact layer에 redaction policy를 둔다.

자동 제거 대상 예:

```text
API keys
access tokens
passwords
session cookies
private credentials
sensitive payloads
```

Ledger도 동일하다.

---

# 26. Retention Policy가 필요하다

모든 로그를 영원히 보존하면 비용과 노이즈가 증가한다.

권장 분리:

## Permanent
```text
project.md
intent.md
ADR
outcome.md
accepted review
```

## Long-lived
```text
ledger summary
validated evidence
```

## Short-lived / GC 대상
```text
raw shell logs
temporary tool outputs
discarded context packages
failed speculative worker outputs
```

GC는 accepted outcome을 훼손하지 않아야 한다.

---

# 27. Memory Promotion은 자동 저장이 아니라 Promotion Pipeline

```text
Outcome
 ↓
Candidate Extraction
 ↓
Deduplication
 ↓
Validity Check
 ↓
Scope Check
 ↓
Promote
```

Memory에 올릴 가치가 있는 것:
- 검증된 장애 원인
- 프로젝트 관례
- 안정적인 architecture decision
- 반복되는 성공 패턴

올리지 않을 것:
- transient logs
- temporary assumptions
- discarded plan
- 실패한 speculative branch
- 중복 summary

---

# 28. Cross-project / Cross-repo Scope를 미리 고려

향후 하나의 Mission이 여러 Repo를 수정할 수 있다.

따라서 ID와 State schema는 repo-local assumption에 묶이지 않아야 한다.

예:

```yaml
resources:
  repositories:
    - artibot-core
    - artibot-ui
```

단 v5.0 초기 구현은 single-repo 우선이어도 된다.

Architecture만 막아두지 않는다.

---

# 29. Schema Version / Migration Strategy 필요

v5는 새로운 state/artifact schema를 많이 만든다.

반드시:

```yaml
schema_version: 1
```

을 둔다.

향후 schema 변경 시:

```text
v1 → v2 migration
```

이 가능해야 한다.

Old state를 읽지 못해 프로젝트가 깨지는 상황을 피한다.

---

# 30. Backward Compatibility Layer

기존:
- agents
- commands
- split
- autopilot
- hooks
- memory
- existing plan artifacts

를 한 번에 제거하지 않는다.

권장:

```text
Existing interface
 ↓
Compatibility Adapter
 ↓
v5 Execution Profile / Mission Runtime
```

즉 기존 command도 내부적으로 새 Execution Profile로 변환한다.

---

# 31. State Projection Regeneration

`state.yaml`이 손상되거나 삭제되어도 재생성 가능해야 한다.

```text
State Store
+
Ledger
→ state.yaml regenerate
```

Projection은 canonical truth가 아니므로 재생성 가능해야 한다.

---

# 32. Artifact Health Check 추가

`/doctor` 혹은 runtime health에서 다음을 검사한다.

```text
Missing intent.md
Broken based_on revision
Stale plan
Invalid review
Duplicate canonical artifact
Orphan mission
Expired task lease
Ledger/state mismatch
Missing evidence reference
Unsupported schema version
```

문서 관리도 runtime health의 일부다.

---

# 33. Completion Gate를 더 엄격하게 정의

Mission Complete 조건:

```text
Intent satisfied
+
All required Tasks resolved
+
Latest Plan not stale
+
Required Verification PASS
+
Independent Fable Review PASS
+
No unresolved critical findings
+
Outcome generated
+
State committed
```

하나라도 충족하지 않으면 `completed`가 아니다.

---

# 34. Accepted Outcome과 Technical Done 분리

코드는 완성됐지만 사용자가 원하는 결과가 아니면 실패다.

상태를 구분한다.

```text
technical_done
review_passed
accepted
```

가능하다면 자동 acceptance가 가능하되, 명확한 user-value 판단이 필요한 Mission은 human acceptance 단계가 있을 수 있다.

---

# 35. Replan Threshold를 명시

Plan 수정이 너무 빈번하면 무한 루프가 된다.

권장:

```text
implementation failure
→ repair

repeated same-class failure
→ replan

multiple replans / architecture contradiction
→ ultraplan

ultraplan still ambiguous
→ human decision
```

Retry count만이 아니라 **failure class**를 본다.

---

# 36. Infinite Agent / Recursive Delegation 방지

Multi-agent 기능이 커질수록 worker가 worker를 계속 생성할 수 있다.

필요 정책:

```yaml
delegation:
  max_depth:
  max_workers:
  max_parallel_actions:
  max_retries:
```

`autopilot --fast`와 `split`도 무한 병렬성은 허용하지 않는다.

---

# 37. Budget는 Token만이 아니다

Execution Budget에 다음을 포함한다.

```text
Token
Time
Parallel Workers
External API Calls
Retries
Context Size
Storage
Human Attention
```

특히 fast mode는 token ceiling이 높아도 다른 resource limit는 필요하다.

---

# 38. Observability에서 꼭 보여야 할 것

사용자는 기본적으로 복잡한 내부 상태를 볼 필요가 없다.

그러나 `/status`, `/why`, `/cost`, `/doctor`에서는 다음을 확인할 수 있어야 한다.

```text
Current Mission
Intent revision
Plan revision
Active Tasks
Workers
Current model
Why model switched
Review status
Verification status
Human blockers
Cost
Elapsed time
```

---

# 39. Audit Trail은 Human-readable Summary와 Raw Events 분리

Raw ledger만으로는 사람이 보기 어렵다.

따라서 필요 시:

```text
ledger.jsonl
→ audit summary
```

를 생성한다.

단 audit summary는 projection이고 source of truth가 아니다.

---

# 40. Single Writer / Logical Authority 규칙

같은 Mission의 핵심 상태 전이는 하나의 logical Mission Controller가 직렬화한다.

Worker들은 event/findings를 제출하고 Controller가 상태를 확정한다.

이를 통해:

```text
Intent revision conflict
Plan revision race
Completion race
```

를 방지한다.

---

# 41. Multi-user Identity / Attribution

다수 사람이 작업하면 Actor ID가 필요하다.

```yaml
actor:
  type: human | agent | runtime
  id:
```

모든 중요한 이벤트/artifact 변경에 attribution을 남긴다.

향후 permission과 audit 기반이 된다.

---

# 42. Permission Model을 향후 확장 가능하게

초기에는 단순해도 schema는 다음을 수용해야 한다.

```text
Viewer
Contributor
Planner
Mission Owner
Reviewer
Admin
```

특히 Intent 변경, ADR 승인, Production action은 역할 기반 제어가 가능해야 한다.

---

# 43. Offline / Branch Work에 대한 정책

Branch/worktree에서 Agent가 작업해도:

- Mission identity는 공유
- Worker/task ownership은 central state 기준
- branch-local files는 execution artifact
- canonical intent/plan truth는 logical Mission 기준

으로 유지한다.

Offline worker는 다시 연결될 때 reconcile이 필요하다.

---

# 44. Merge 이후 Artifact Drift 검사

코드 merge 후:

```text
Intent
Plan
ADR
Outcome
```

가 실제 main branch 상태와 맞는지 자동 점검해야 한다.

특히 plan이 완료됐지만 실제 merge에서 변경이 일부 누락될 수 있다.

---

# 45. "문서 생성 수" 자체를 최소화

v5의 기본 canonical artifacts는 다음으로 제한한다.

```text
ARTIBOT.md
project.md
intent.md
plan.md
ADR (조건부)
review.md
outcome.md
state projection
ledger
```

이 이상 새로운 기본 Markdown을 추가하려면 반드시 역할 중복 검토를 한다.

> **If a new artifact cannot answer a unique question, do not create it.**

---

# 46. 최종 Source of Truth Matrix

| 질문 | Source of Truth |
|---|---|
| 어디서 시작? | `ARTIBOT.md` |
| 프로젝트 목적/규칙? | `project.md` |
| 지금 실제 상태? | Transactional State Store |
| 사람이 보는 현재 상태? | `state.yaml` projection |
| Mission 목적? | `intent.md` |
| 현재 실행 방법? | `plan.md` |
| 중요한 결정 이유? | ADR |
| 작업 상태/의존성? | Task Graph |
| 실행 이벤트? | Ledger |
| 독립검토 결과? | `review.md` |
| 최종 결과? | `outcome.md` |
| 재사용 지식? | Validated Memory |

한 질문에 canonical source가 두 개 이상이면 구조를 다시 검토한다.

---

# 47. 최종 Runtime Architecture

```text
                         USER
                          │
                          ↓
                Natural Language Input
                          │
                          ↓
                ┌──────────────────┐
                │ INTENT COMPILER  │
                └────────┬─────────┘
                         ↓
                   canonical intent.md
                         ↓
                 Execution Profile
                         ↓
               Plan / Ultraplan / ADR
                         ↓
                    Task Graph
                         ↓
        ┌────────────────┼────────────────┐
        ↓                ↓                ↓
   Context Compiler   Model Router   Topology Router
        │                │                │
        └────────────────┼────────────────┘
                         ↓
                     Execution
                         ↓
                   Evidence Registry
                         ↓
               Clean-room Fable 5.1
                    Independent Review
                         ↓
                   Unified Verifier
                         ↓
                      Outcome
                         ↓
              Archive / Memory Promotion
```

항상 옆에서:

```text
Transactional State Store
+
Append-only Event Ledger
+
Artifact Lifecycle Manager
```

가 작동한다.

---

# 48. v5 구현 우선순위 — 최종 권장

## P0 — Foundation

1. Project/Mission/Task/Action/Run ontology
2. Mission Controller
3. Canonical `intent.md`
4. Execution Profile
5. Transactional State Store abstraction
6. Task Graph
7. Artifact Registry
8. Artifact Dependency / Staleness
9. Event Ledger
10. Runtime-managed Artifact Lifecycle
11. Intent-aware model Routing
12. Switching / Escalation / Downgrade / Hysteresis 분리
13. Clean-room Fable 5.1 Review
14. Completion Gate

## P1 — Multi-agent robustness

15. Claim / Lease / Heartbeat
16. File ownership
17. Crash recovery / Resume
18. Reconciliation
19. Idempotency
20. Evidence Registry
21. Context revision binding
22. Split integration
23. autopilot --fast objective
24. Artifact Health Check

## P2 — Team / Governance

25. Human/Agent identity
26. Role/permission model
27. ADR question gate
28. Audit summary
29. Retention / GC
30. Memory promotion
31. Schema migration
32. Cross-repo readiness

---

# 49. 반드시 피해야 할 구현

```text
todo.md를 canonical truth로 추가
state.yaml을 concurrent database처럼 사용
Agent마다 intent 생성
Plan revision마다 새 파일 생성
Worker가 Mission intent 직접 수정
Reviewer가 Builder chat history 전체를 그대로 사용
모델 선택을 Agent 이름에 고정
자연어를 command 문자열에 직접 매핑
Retry마다 Mission을 새로 생성
모든 로그를 Memory에 저장
모든 Artifact를 영구 보존
Split worker가 무한 재귀 생성
```

---

# 50. 최종 설계 철학

Artibot v5에서 가장 중요한 것은 기능 숫자가 아니다.

### 1. Intent는 하나여야 한다
모든 사람과 Agent가 같은 목표를 본다.

### 2. Current State는 하나여야 한다
동시 작업에서도 현재 Truth가 분기되지 않는다.

### 3. Plan은 바뀔 수 있다
하지만 어느 Intent를 기반으로 했는지 항상 알 수 있어야 한다.

### 4. Agent는 문서를 관리하지 않는다
Runtime이 작업의 side effect로 관리한다.

### 5. Router는 모델을 고르는 기능이 아니다
Intent에 맞는 지능·비용·속도·context continuity를 선택하는 Runtime이다.

### 6. Parallelism은 coordination infrastructure 위에서만 의미가 있다
Split이 강해질수록 Task Graph, ownership, lease, reconciliation이 더 중요해진다.

### 7. Review는 독립적이어야 한다
Fable 5.1은 canonical intent와 evidence를 기준으로 fresh-eye review한다.

### 8. Memory는 Archive와 다르다
모든 기록을 기억하지 않는다. 재사용 가치가 검증된 것만 승격한다.

### 9. 문서는 최소여야 한다
새 문서는 고유한 질문 하나에만 답해야 한다.

### 10. Autonomy는 Foundation의 결과다
Intent, State, Plan, Evidence, Review가 견고해질수록 사람에게 묻는 횟수는 자연스럽게 줄어든다.

---

# 51. 최종 한 문장

> **Artibot v5는 사용자의 Intent를 하나의 Canonical Truth로 고정하고, 이를 실행 가능한 Profile과 Task Graph로 컴파일하며, 여러 사람·Agent가 하나의 Transactional State를 공유한 상태에서 최적의 모델과 실행 토폴로지를 선택하고, 독립 Fable 5.1 Review와 실제 Evidence를 통해 검증된 Outcome까지 자율적으로 완수하는 Runtime이다.**

---

# 52. Implementation Gate

이 문서의 P0 항목을 구현 설계에 반영하기 전에는 v5의 대규모 기능 확장을 진행하지 않는 것을 권장한다.

특히 다음 8개는 **architecture freeze 전에 반드시 결정/구현**한다.

```text
1. Mission Controller
2. Execution Profile
3. Transactional State Store
4. Task Graph
5. Artifact Dependency / Staleness
6. Runtime-managed Documentation
7. Clean-room Fable Review
8. Resume / Reconciliation Contract
```

이 8개가 닫히면 이후:
- Split
- Autopilot
- Model Learning
- Dynamic Agents
- Multi-user collaboration

을 확장해도 구조가 크게 흔들리지 않는다.
