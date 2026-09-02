# Artibot 5.0 — Model Switching & Terminal Scorecard
## Final Benchmark-Backed Implementation Design

**Status:** Canonical Final Supplement  
**Base Document:** `Artibot 5.0 Model Switching & Terminal Scorecard Addendum`  
**Research window:** 2026-08-03 ~ 2026-09-02  
**Purpose:** 모델 Switching, Routing Epoch, Terminal Scorecard, Replay, Benchmark, Context/Memory, Checkpoint/Resume를 최근 오픈소스 구현과 연구를 참고해 실제 구현 가능한 수준으로 확정한다.

---

# 0. Executive Decision

Artibot v5의 Model Routing은 다음 원칙으로 최종 확정한다.

> **Score every Action, switch only when expected gain exceeds transition cost, and preserve model/context continuity within a Routing Epoch.**

짧게:

> **Route aggressively, switch conservatively.**

그리고 Router를 Black Box로 두지 않는다.

모든 Routing / Switching / Pinning / Escalation / Downgrade 의사결정은:

```text
Route Receipt
+
Attempt Telemetry
+
Context Receipt
+
Outcome
```

으로 기록하고,

Mission 완료 또는 `/save` 후 Terminal Scorecard로 사용자가 확인할 수 있어야 한다.

최종 구조:

```text
Intent
 ↓
Execution Profile
 ↓
Mission Reflection
 ↓
Context Package
 ↓
Context Receipt
 ↓
Action Router
 ↓
Route Receipt
 ↓
Switch Controller
 ↓
Routing Epoch
 ↓
Execution Attempts
 ↓
Attempt Receipts
 ↓
Independent Fable 5.1 Review
 ↓
Unified Verification
 ↓
Accepted Outcome
 ↓
Final Terminal Scorecard
 ↓
Router Replay / RouteBench / Shadow Learning
```

---

# 1. 최근 1개월 리서치 결론

최근 공개된 자료 중 Artibot v5에 직접 가치가 높은 것은 다음 네 축이다.

| Reference | Freshness | Artibot Value | Decision |
|---|---:|---|---|
| vLLM Semantic Router | Aug 2026 | Switching, Replay, Session state, Anti-thrashing, Attempt telemetry | **채택** |
| LLMRouter / xRouteBench | Aug 7, 2026 | Router benchmark, fixed baseline, cost-quality evaluation | **채택** |
| Hindsight 0.9.x / Agent Memory Benchmark | Aug 6~14, 2026 | Mission-level reflection, project knowledge projection, human correction metric | **변형 채택** |
| Microsoft Agent Framework | Current Aug 2026 code + recent issues | Checkpoint/Resume, step caching, continuation isolation | **변형 채택** |
| Cross-model KV cache reuse | Aug 22, 2026 roadmap/research | 미래 Switching Cost 절감 | **Watch only** |

중요:

vLLM의 일부 최신 내용은 **roadmap/epic**이므로 구현 완료 기능으로 간주하지 않는다.

Artibot은:
- 실제 구현 코드에서는 pattern을 참고하고,
- roadmap에서는 architecture direction만 참고한다.

---

# 2. Reference 1 — vLLM Semantic Router

Repository:

```text
https://github.com/vllm-project/semantic-router
```

License:

```text
Apache License 2.0
```

## 2.1 가장 중요한 최신 방향

### Safe model/workflow switching

Issue:

```text
https://github.com/vllm-project/semantic-router/issues/2973
```

Opened:

```text
2026-08-22
```

핵심 범위:

- session objective
- session state
- phase signals
- candidate constraints
- switching cost
- token / latency / cost
- failures
- tool state
- cache state
- session outcome
- fallback
- anti-thrashing
- shadow
- canary
- rollback

### Artibot 적용

이 방향은 Artibot의 다음 구조와 정확히 대응한다.

```text
vLLM concept
            → Artibot

session objective
            → Intent + Execution Profile

phase signal
            → Routing Epoch

switching cost
            → Switch Economics

anti-thrashing
            → Minimum Residency + Cooldown + Hysteresis

session outcome
            → Mission Outcome

shadow/canary
            → Shadow Router / Canary Routing
```

**직접 채택한다.**

---

# 3. vLLM 코드에서 실제 참고할 부분

## 3.1 Router Replay recording pattern

File:

```text
src/semantic-router/pkg/extproc/recorder.go
```

URL:

```text
https://github.com/vllm-project/semantic-router/blob/main/src/semantic-router/pkg/extproc/recorder.go
```

현재 코드에서 확인할 수 있는 패턴:

- selected model tracking
- routing latency recording
- Replay 시작
- Session ID 연결
- Routing decision metadata
- selected/original model 기록
- Replay lifecycle finalize
- response/tool trace attachment
- persistence failure handling

### Artibot에 대응

```text
vLLM recorder.go
      ↓ concept adaptation
Artibot:
  routing/route-receipt.js
  telemetry/routing-recorder.js
  replay/router-replay-store.js
```

### 권장 인터페이스

```ts
interface RouteReceipt {
  routeReceiptId: string
  missionId: string
  taskId: string
  actionId: string
  runId?: string

  routingEpochId: string

  originalModel?: ModelIdentity
  recommendedModel: ModelIdentity
  selectedModel: ModelIdentity

  decision:
    | "route"
    | "pin"
    | "switch"
    | "escalate"
    | "downgrade"

  signals: RoutingSignals
  predicted: RoutePrediction
  transition: TransitionEstimate
  reason: string[]

  createdAt: string
}
```

**코드 구조는 참고하되 Artibot Mission/Task/Action ontology에 맞춰 새로 구현한다.**

---

# 4. vLLM Per-attempt Trace

Issue:

```text
https://github.com/vllm-project/semantic-router/issues/2855
```

Opened:

```text
2026-08-11
```

핵심:

aggregate metric만으로는 다음을 설명하기 어렵다는 문제를 다룬다.

- verifier regret
- early stopping
- failures
- wasted work
- attempt별 model/role/token/latency

## Artibot 적용

현재 Scorecard가:

```text
Opus 63K tokens
Sonnet 84K tokens
```

만 보여주면 부족하다.

다음 구조가 필요하다.

```text
Action A-018

Run R-001
  model: Sonnet
  result: fail
  cost: ...

Run R-002
  model: Opus
  result: pass
  cost: ...

Selected / Accepted:
  R-002
```

### Attempt Receipt

```yaml
attempt:
  run_id: R-002
  mission_id: M-024
  task_id: T-006
  action_id: A-018

  model:
    family: claude
    tier: opus
    model_id: exact-provider-id

  usage:
    fresh_input_tokens:
    cached_input_tokens:
    output_tokens:
    thinking_tokens:

  latency:
    total_ms:

  result:
    status: success
    verification: pass

  accepted: true
```

이 데이터로:

```text
Success@1
Retry Waste
Escalation Effectiveness
Effective Cost
Useful Switch
```

를 계산한다.

**P0 채택.**

---

# 5. vLLM Agent Recipe — Switching Stability Pattern

File:

```text
config/recipes/agent/config.yaml
```

URL:

```text
https://github.com/vllm-project/semantic-router/blob/main/config/recipes/agent/config.yaml
```

현재 recipe에 다음과 같은 session switching tuning 개념이 존재한다.

```text
idle timeout
minimum turns before switch
switch margin
stability weight
```

Artibot은 이를 그대로 값 복사하지 않고 다음 개념으로 변환한다.

```yaml
switching:
  minimum_residency:
    actions: 3

  cooldown:
    actions: 2

  switch_margin:
    policy: adaptive

  stability_weight:
    cache_aware: true

  idle_epoch_timeout:
    configurable: true
```

### 핵심

vLLM의 수치 자체를 가져오지 않는다.

Artibot RouteBench 결과로 초기값을 튜닝한다.

---

# 6. Router Replay를 Artibot에 정식 Core 기능으로 추가

vLLM은 Replay를 실제 persistence layer와 연결하고 있다.

Artibot도 Scorecard와 Learning을 각각 별도 시스템으로 만들면 안 된다.

```text
Execution Events
      ↓
Route / Attempt Receipts
      ↓
Replay Store
      ├→ Terminal Scorecard
      ├→ /why
      ├→ RouteBench
      └→ Shadow Learner
```

## Replay Record

```yaml
replay:
  replay_id:
  mission_id:
  session_id:
  task_id:
  action_id:

  intent_revision:
  execution_profile_version:

  route_receipt_id:
  context_receipt_id:

  attempts: []

  selected_attempt:
  final_outcome:

  review:
  verification:
```

---

# 7. Replay Security는 처음부터 포함

vLLM Router Replay는 request/response body를 저장할 수 있기 때문에 access/retention이 실제 보안 문제가 된다.

참고:

```text
https://github.com/vllm-project/semantic-router/issues/1146
```

2026-08-31 기준 Router Replay read API의 explicit authorization/redaction 관련 작업이 main에 반영되었다고 기록되어 있다.

## Artibot 정책

Replay는 기본적으로 full raw prompt 저장 시스템이 아니다.

### 저장 우선순위

```text
metadata
→ IDs
→ usage
→ route signals
→ hashes/pointers
→ bounded content only when explicitly enabled
```

### Redaction

자동 제거:

```text
API Key
Access Token
Password
Cookie
Secret
Credential
Sensitive Payload
```

### Access

향후 multi-user:

```text
Viewer
Contributor
Mission Owner
Admin
```

에 따라 Replay 상세 접근 권한을 구분한다.

**P0 data model에 포함, UI authorization은 team 기능 시 확장.**

---

# 8. Context Transformation Receipt

vLLM Agentic & Context workgroup:

```text
https://github.com/vllm-project/semantic-router/issues/2987
```

Opened:

```text
2026-08-23
```

핵심 방향:

- context compression
- tool-output pruning
- retrieval/memory selection
- prompt restructuring
- protected instructions
- versioned transformation plans
- transformation receipts
- replay/evaluation

이건 Artibot에 매우 중요하다.

모델 성능 문제와 Context 문제를 구분할 수 있어야 한다.

## Context Receipt

```yaml
context_receipt:
  id: CR-024-018

  mission_id: M-024
  action_id: A-018

  based_on:
    intent_revision: 3
    plan_revision: 7

  input:
    tokens: 84000

  transformations:
    deduplicated_tokens: 18000
    tool_output_compressed_tokens: 12000
    memory_added_tokens: 8000
    history_removed_tokens: 4000

  protected:
    - system_instructions
    - user_intent
    - tool_contracts
    - security_policy

  output:
    tokens: 58000

  strategy_version: 2
```

## Scorecard 연계

향후:

```text
Context Compression     31%
Context Rebuilds         2
Context Churn          12%
```

등을 볼 수 있다.

**P0/P1 사이에 채택.**

---

# 9. Cross-model KV Cache Reuse

vLLM Issue:

```text
https://github.com/vllm-project/semantic-router/issues/2976
```

Opened:

```text
2026-08-22
```

목표:

모델/tokenizer/architecture/layer/precision/prefix 등의 compatibility 조건을 검증하여 cross-model computation reuse 가능성을 연구한다.

## Artibot 판단

지금 구현하지 않는다.

Artibot은 Anthropic/외부 provider의 managed model을 주로 사용하므로 underlying KV cache를 직접 제어할 수 없는 경우가 많다.

하지만 Router schema에 미래 capability는 넣는다.

```yaml
model_capabilities:
  cache_transfer:
    supported: false
    mode: none
```

향후 provider가 cross-model cache handoff를 공식 지원하면:

```text
Switch Cost
↓↓
```

가 될 수 있다.

**Watch only.**

---

# 10. Reference 2 — LLMRouter / xRouteBench

Paper:

```text
https://arxiv.org/abs/2608.06867
```

Published:

```text
2026-08-07
```

Repository:

```text
https://github.com/ulab-uiuc/LLMRouter
```

Benchmark:

```text
https://github.com/ft2023/xRouteBench
```

License (LLMRouter):

```text
MIT
```

## 핵심 프레임

LLM routing을 sequential decision process로 보고 다음 요소로 분리한다.

```text
Context Encoder
Model Encoder
Scoring Function
Decision Rule
Learning Signal
```

Artibot 대응:

```text
Intent/Context Features
       ↓
Model Catalog / Capabilities
       ↓
Route Scorer
       ↓
Switch Controller
       ↓
Outcome / Review / Scorecard
```

---

# 11. LLMRouter Benchmark Pipeline에서 참고할 코드

Repository path:

```text
benchmark_pipeline/
```

README:

```text
https://github.com/ulab-uiuc/LLMRouter/blob/main/benchmark_pipeline/README.md
```

실제 패턴:

```text
download data
generate embeddings
run router sweep
aggregate results
resume completed pairs
```

특히 benchmark가 재실행 가능하고 completed pair를 skip하는 패턴이 유용하다.

## Artibot RouteBench

```text
plugins/artibot/benchmarks/routing/

  datasets/
  fixtures/
  baselines/

  run-routebench.js
  replay-runner.js
  evaluator.js
  aggregate.js

  results/
```

### Baselines

반드시 비교:

```text
B0 Fixed Sonnet
B1 Fixed Opus
B2 Current v4 Policy
B3 v5 Static Heuristic
B4 v5 Adaptive Router
```

선택:

```text
B5 Fixed Fable
B6 Hindsight Oracle / offline hindsight policy
```

---

# 12. Artibot RouteBench Task Classes

최소:

```text
simple_edit
repo_exploration
routine_implementation
complex_implementation
debugging
repeated_failure
architecture
long_context
memory_dependent
intent_revision
high_risk_review
autopilot_fast
split
```

## Metrics

```text
Accepted Outcome
Success@1
Attempts
Retry Waste
Total Tokens
Total Cost
Cost / Accepted Outcome
Wall-clock
Routing Latency
Switch Count
Transition Cost
Transition Time
Avoided Switches
Human Corrections
Human Decisions
Review Findings
Context Churn
```

---

# 13. Offline Replay를 비용 없이 최대한 활용

LLMRouter의 benchmark pipeline은 pre-recorded model execution을 replay해 router 평가 비용을 줄이는 패턴을 사용한다.

Artibot도 실제 과거 Run을 재사용한다.

```text
Historical Missions
       ↓
Captured Model Outcomes
       ↓
New Router Candidate
       ↓
Offline Routing Replay
       ↓
Predicted Score
```

주의:

과거에 실제 실행하지 않은 Model의 결과는 알 수 없기 때문에 완전한 counterfactual은 아니다.

따라서 Replay mode를 나눈다.

```text
Exact Replay
→ 실제 recorded candidate outcome이 존재

Partial Replay
→ 후보 중 일부만 실제 결과 존재

Simulation
→ learned/predicted outcome 사용
```

UI에서 구분한다.

---

# 14. Router Learning은 Shadow → Replay → Canary 순서

최근 vLLM 방향과 Artibot 철학 모두 같은 결론을 지지한다.

처음부터 online RL을 적용하지 않는다.

```text
Heuristic Router
 ↓
Receipts
 ↓
RouteBench
 ↓
Shadow Candidate
 ↓
Router Replay
 ↓
Canary
 ↓
Production
```

## Learning 대상

```text
model selection
switch threshold
minimum residency
escalation timing
downgrade timing
context budget
cache affinity weight
latency weight
topology preference
```

## Production safety

Learner가 다음을 직접 수정하지 않는다.

```text
security policy
secret handling
external destructive action boundaries
human approval boundaries
```

---

# 15. Reference 3 — Hindsight 0.9.x

Repository:

```text
https://github.com/vectorize-io/hindsight
```

Benchmark Repository:

```text
https://github.com/vectorize-io/agent-memory-benchmark
```

Release analysis:

```text
https://hindsight.vectorize.io/blog/2026/08/06/hindsight-0-9-0
```

Published:

```text
2026-08-06
```

License:

```text
MIT
```

---

# 16. Hindsight에서 가져올 가장 중요한 교훈

Hindsight 팀은 coding-agent benchmark에서 **매 Prompt마다 자동 memory retrieval/injection**이 오히려 no-memory baseline보다 악화되는 실험을 보고했다.

그들이 이후 강조한 방향:

```text
scattered retrieval every turn
        ❌

goal-oriented synthesis / reflection
        ✅
```

## Artibot 적용

기존:

```text
Every Action
→ retrieve memory
→ inject
```

를 기본값으로 하지 않는다.

권장:

```text
Mission Start
      ↓
Project Reflection
      ↓
Mission Knowledge Package
      ↓
Cache for Routing Epoch
```

재-reflect 조건:

```text
Intent Revision
Repeated Failure
New Domain
Major Phase Change
Evidence Contradiction
```

### 원칙

> **Reflect at Mission boundaries, not every turn.**

---

# 17. Hindsight Knowledge Pages → Artibot Generated Project Knowledge

Hindsight 0.9.0에서 Knowledge Pages는 underlying memory에서 생성되는 living documents이며, 원본 data가 Source of Truth이고 page는 projection으로 취급된다.

Artibot에 매우 잘 맞는다.

## Canonical Truth

```text
intent.md
ADR
outcome.md
git history
ledger
validated evidence
```

## Generated Projection

```text
Architecture Overview
Current Conventions
Known Failure Patterns
Active Initiatives
Component Map
```

구조:

```text
Canonical Artifacts
      ↓
Knowledge Projector
      ↓
Generated Project Knowledge
```

Generated knowledge는 삭제되어도 재생성 가능해야 한다.

### 매우 중요

```text
Generated Knowledge
≠ Canonical Truth
```

이 원칙은 Artibot의 문서 파생/혼란 방지 철학과 일치한다.

---

# 18. Hindsight Agent Memory Benchmark에서 참고할 코드

File:

```text
src/memory_bench/modes/coding.py
```

URL:

```text
https://github.com/vectorize-io/agent-memory-benchmark/blob/main/src/memory_bench/modes/coding.py
```

참고 패턴:

- coding agent 실행 자체를 benchmark mode로 추상화
- agent/model identity 명시
- test-feedback intervention 기반 평가
- 실제 pytest grade 사용
- 환경변수로 agent/model 교체

Harness:

```text
sdebench/harness/run.py
```

URL:

```text
https://github.com/vectorize-io/agent-memory-benchmark/blob/main/sdebench/harness/run.py
```

참고:

- repo build
- coding agent pluggability
- git-history-derived project decisions
- repeatable task environment

## Artibot 적용

```text
RouteBench
+
real repo fixture
+
test-feedback
+
actual completion verifier
```

형태로 구현한다.

---

# 19. Human Correction Metric을 정식 KPI로 추가

Hindsight의 coding benchmark는 단순 solve rate 외에 **human correction rounds**를 중요한 평가 지표로 사용한다.

Artibot에서도 다음 세 개를 분리한다.

```text
Human Corrections
Human Decisions
Human Approvals
```

왜냐하면:

```text
Correction
→ Agent 실패 신호

Decision
→ 정상적인 Product/ADR 의사결정일 수 있음

Approval
→ Risk policy에 따른 정상 Gate일 수 있음
```

Scorecard 예:

```text
HUMAN

Corrections        0
Decisions          1
Approvals          0
```

Primary autonomy KPI:

```text
Human Corrections / Accepted Outcome
```

---

# 20. Exact Model Identity를 반드시 저장

Hindsight benchmark 문서에서도 최근 Claude Sonnet version의 ambiguity를 제거하기 위한 수정이 있었다.

Artibot의 Terminal에는:

```text
Opus
Fable 5.1
```

처럼 보여도 되지만 Ledger에서는 정확히 저장한다.

```yaml
model_identity:
  provider: anthropic
  family: claude
  tier: opus
  model_id: exact-provider-model-id
  snapshot_or_version:
  catalog_version: 2026-09-02
```

Scorecard 재현성과 Router Benchmark를 위해 필수다.

**P0.**

---

# 21. Reference 4 — Microsoft Agent Framework

Repository:

```text
https://github.com/microsoft/agent-framework
```

License:

```text
MIT
```

Artibot에서는 주로:

```text
Checkpoint
Resume
State Isolation
Per-step result reuse
Continuation semantics
```

패턴을 참고한다.

---

# 22. Microsoft Checkpoint Core

File:

```text
python/packages/core/agent_framework/_workflows/_checkpoint.py
```

URL:

```text
https://github.com/microsoft/agent-framework/blob/main/python/packages/core/agent_framework/_workflows/_checkpoint.py
```

참고:

- CheckpointStorage abstraction
- in-memory/file storage
- checkpoint IDs
- latest checkpoint retrieval
- serialization restrictions
- file path validation

## Artibot 대응

```text
checkpoint/
  checkpoint-store.js
  checkpoint-service.js

adapters/
  sqlite-checkpoint-store.js
  remote-checkpoint-store.js
```

Interface:

```ts
interface CheckpointStore {
  save(checkpoint: Checkpoint): Promise<void>
  load(id: string): Promise<Checkpoint | null>
  latest(missionId: string): Promise<Checkpoint | null>
  list(missionId: string): Promise<string[]>
}
```

---

# 23. Microsoft `@step` Pattern → Expensive Action Resume

File:

```text
python/samples/03-workflows/functional/steps_and_checkpointing.py
```

URL:

```text
https://github.com/microsoft/agent-framework/blob/main/python/samples/03-workflows/functional/steps_and_checkpointing.py
```

핵심:

완료된 expensive step의 결과를 저장하여 resume 시 다시 실행하지 않는다.

Artibot에서:

```text
Action completed
+
idempotent
+
result still valid
```

이면 Resume 시 재실행하지 않는다.

특히:

```text
LLM expensive action
External API read
Long test suite
Repo exploration
```

에 효과가 크다.

---

# 24. Microsoft Superstep Boundary → Artibot Checkpoint Boundary

Checkpoint resume sample:

```text
python/samples/03-workflows/checkpoint/checkpoint_with_resume.py
```

URL:

```text
https://github.com/microsoft/agent-framework/blob/main/python/samples/03-workflows/checkpoint/checkpoint_with_resume.py
```

이 sample은 workflow superstep completion 이후 중단/복원하는 패턴을 보여준다.

Artibot 적용:

**모델 호출마다 checkpoint하지 않는다.**

Checkpoint trigger:

```text
Task Complete
Routing Epoch Complete
Plan Revision
Human Decision
/save
Before Risky External Action
```

원칙:

> **Checkpoint per meaningful state transition, not per model call.**

---

# 25. Checkpoint State Isolation — 최근 버그도 참고

Recent Microsoft issue:

```text
https://github.com/microsoft/agent-framework/issues/7683
```

2026년 8월 공개된 이슈에서 in-memory checkpoint load 결과가 live object와 분리되지 않아 저장 snapshot이 mutation될 수 있는 silent corruption 문제가 지적되었다.

## Artibot에서 반드시 방지

Checkpoint load는:

```text
immutable snapshot
or
deep clone / copy-on-write
```

이어야 한다.

금지:

```text
loadedCheckpoint.state
  ===
storedInternalReference
```

Test:

```text
load checkpoint
mutate loaded object
reload checkpoint
assert original unchanged
```

**P0 regression test.**

---

# 26. Session Continuation과 Single-writer

Microsoft architecture/docs에서도 stable conversation/session head를 mutable key로 사용할 때 single-writer coordination이 필요하다는 점을 강조한다.

Artibot Mission State에도 동일하게 적용한다.

```text
Mission Controller
=
single logical writer
```

Worker는:

```text
event/findings submit
```

만 한다.

Intent/Plan/Completion의 canonical transition은 Controller가 직렬화한다.

이것은 이미 Artibot Hardening 설계에서 잡은 방향을 유지한다.

---

# 27. Final Switching Architecture

```text
Action Created
      ↓
Action Feature Extraction
      ↓
Adaptive Model Router
      ↓
Ideal Model Recommendation
      ↓
Switch Controller
      ↓
┌──────────────────────────────┐
│ Transition economics         │
│ Cache/context affinity       │
│ Minimum residency            │
│ Cooldown                     │
│ Failure state                │
│ Execution Profile            │
└───────────────┬──────────────┘
                ↓
         Actual Decision
      ┌─────────┼──────────┐
      ↓         ↓          ↓
     PIN      SWITCH    ESCALATE
      ↓
 Route Receipt
      ↓
 Execution Attempt
      ↓
 Attempt Receipt
```

---

# 28. Switching Economics

## Switch Benefit

```text
SwitchBenefit =
  ExpectedQualityGain
+ ExpectedFutureCostSaving
+ ExpectedLatencyGain
+ ExpectedFailureReduction
```

## Switch Cost

```text
SwitchCost =
  ContextSerializationCost
+ ContextRebuildCost
+ CacheLossCost
+ HandoffTokenCost
+ HandoffLatency
+ ReorientationRisk
+ ExpectedRetryCost
```

## Utility

```text
SwitchUtility =
  SwitchBenefit
- SwitchCost
```

Switch:

```text
only if SwitchUtility > threshold
```

---

# 29. Routing Epoch 최종 정의

> Routing Epoch = 하나의 Model/Context continuity가 유지되는 논리적 실행 구간.

예:

```text
Epoch E1 — Exploration
Sonnet

Epoch E2 — Implementation
Opus

Epoch E3 — Independent Review
Fable 5.1
```

## Rule

```text
Score per Action
Switch per Epoch
```

단 immediate escalation 가능:

```text
Capability Failure
Critical Verification Failure
Security/Risk Increase
Architecture Contradiction
Explicit User Override
```

---

# 30. Minimum Residency / Cooldown

초기 heuristic:

```yaml
switch_policy:
  minimum_residency:
    actions: 3

  cooldown:
    actions: 2
```

하지만 이 값은 **고정 규칙이 아니라 RouteBench로 calibration**한다.

실제 model family/provider별 다른 값을 가질 수 있다.

---

# 31. `/save` 최종 Runtime Contract

`/save`는 단순 파일 저장이 아니다.

```text
/save
 ↓
Flush Artifacts
 ↓
Persist Task Graph
 ↓
Persist Transactional State
 ↓
Persist Routing Epoch
 ↓
Write Checkpoint
 ↓
Validate Resume
 ↓
Append Ledger Event
 ↓
Render Session Snapshot Scorecard
```

## Checkpoint content

```yaml
checkpoint:
  mission_id:
  session_id:

  intent_revision:
  plan_revision:
  execution_profile_version:

  active_tasks:
  completed_action_results:

  routing_epoch:
  current_model:

  artifact_versions:
  replay_cursor:
  ledger_cursor:

  resumable: true
```

---

# 32. Session Completion vs Mission Completion

## Session

Terminal/runtime lifecycle.

한 Mission이 여러 Session을 가질 수 있다.

```text
M-024
 ├ S-01
 ├ S-02
 └ S-03
```

## Mission

하나의 Accepted Outcome.

따라서:

```text
Session Scorecard
≠
Mission Scorecard
```

---

# 33. Progress Bar 100% 최종 Semantics

현재 작업 진행 Bar는 유지한다.

그러나:

```text
100%
=
Execution Progress Complete
```

이다.

최종 완료:

```text
Progress 100%
+
Tasks Resolved
+
Current Plan
+
Fable 5.1 Review PASS
+
Verification PASS
+
No Critical Finding
+
Outcome Persisted
=
MISSION COMPLETE
```

UI:

```text
[████████████████████████████████] 100%

Execution complete.
Running independent review...
```

후:

```text
Execution     ✓ 100%
Review        ✓ Fable 5.1 PASS
Verification  ✓ PASS
Outcome       ✓ Saved

✓ MISSION COMPLETE
```

그 뒤 Final Scorecard.

---

# 34. Terminal Scorecard — Final

```text
╭──────────────── ARTIBOT v5 · MISSION SCORECARD ────────────────╮
│ Mission       Split runtime improvement                        │
│ Result        ✓ ACCEPTED                                       │
│ Progress      100%                                             │
│ Duration      18m 42s                                          │
│ Review        ✓ Fable 5.1 PASS                                 │
│ Verification  ✓ PASS                                           │
├─────────────────────────────────────────────────────────────────┤
│ MODEL USAGE                                                     │
│ Haiku        ███░░░░░░░░░░░░░░░░   6%                         │
│ Sonnet       ███████████████░░░░░  37%                         │
│ Opus         ███████████████████░  44%                         │
│ Fable 5.1    █████░░░░░░░░░░░░░░  13%                         │
├─────────────────────────────────────────────────────────────────┤
│ ROUTING                                                         │
│ Route Decisions       24                                        │
│ Model Switches         3                                        │
│ Avoided Switches      11                                        │
│ Useful Switches        3                                        │
│ Wasteful Switches      0                                        │
│ Switch Efficiency    100%                                       │
│ Transition Cost      $...                                       │
│ Transition Time      14.2s                                      │
├─────────────────────────────────────────────────────────────────┤
│ PERFORMANCE                                                     │
│ Success@1             87%                                       │
│ Attempts              27                                        │
│ Retries                3                                        │
│ Retry Waste          $...                                       │
│ Review Findings        2 fixed                                  │
│ Human Corrections      0                                        │
│ Human Decisions        1                                        │
├─────────────────────────────────────────────────────────────────┤
│ CONTEXT                                                         │
│ Context Compression    31%                                      │
│ Cache Hit Ratio        72%                                      │
│ Context Rebuilds        1                                       │
│ Context Churn          10%                                      │
├─────────────────────────────────────────────────────────────────┤
│ ECONOMICS                                                       │
│ Total Cost           $...                                       │
│ Cost / Outcome       $...                                       │
│ Baseline             available / insufficient                   │
╰─────────────────────────────────────────────────────────────────╯
```

---

# 35. `/save` Snapshot Scorecard

```text
╭──────────── ARTIBOT · SESSION SNAPSHOT ────────────╮
│ Mission       M-024                                │
│ Session       S-002                                │
│ Progress      64%                                  │
│ Status        SAVED · IN PROGRESS                  │
│ Elapsed       12m 41s                              │
│ Current Model Opus                                 │
│ Epoch         Implementation                       │
├─────────────────────────────────────────────────────┤
│ Sonnet       ... tokens                            │
│ Opus         ... tokens                            │
│ Fable 5.1    ... tokens                            │
│ Switches       2                                   │
│ Avoided        6                                   │
│ Transition     ...s                                │
├─────────────────────────────────────────────────────┤
│ Tasks         9 / 14                               │
│ Retries       1                                    │
│ Human Input   0                                    │
│ Checkpoint    ✓ resumable                          │
╰─────────────────────────────────────────────────────╯
```

Final Outcome metric은 확정하지 않는다.

---

# 36. Scorecard Data Source

Scorecard를 별도 manual document로 만들지 않는다.

```text
Route Receipts
+
Context Receipts
+
Attempt Receipts
+
Usage Receipts
+
Task Graph
+
Review
+
Verification
+
Outcome
=
Scorecard Projection
```

따라서 Scorecard는 삭제/재생성 가능하다.

---

# 37. Useful / Wasteful Switch Evaluation

## Useful

Switch 후 실제로:

```text
Success↑
Retry↓
Latency↓
Effective Cost↓
Review quality↑
```

가 예상 방향으로 개선.

## Wasteful

예:

```text
Opus → Sonnet

Expected saving:
small

Actual:
context rebuild cost > saving
+ retry

→ WASTEFUL
```

## Switch Efficiency

```text
Useful Switches
/
Total Switches
```

---

# 38. Avoided Switches도 성능이다

Router는 Sonnet을 추천했지만 Switch Controller가 Opus를 유지했다면:

```text
PIN
```

도 중요한 routing decision이다.

Scorecard:

```text
Avoided Switches 11

cache affinity          6
low expected benefit    3
minimum residency       2
```

---

# 39. Model Performance — Usage만 보지 않는다

모델별 기본 KPI:

```text
Usage Share
Success@1
Retry Waste
Accepted Contribution
Effective Cost
```

추가:

```text
Median Latency
Review Catch Contribution
Escalation Rescue Rate
```

## Fable 주의

Fable usage share가 낮다고 무조건 좋은 것이 아니다.

평가:

```text
Fable tokens spent on
high-value judgment?
```

를 본다.

---

# 40. Route Receipt 최종 Schema

```yaml
route_receipt:
  schema_version: 1
  route_receipt_id:

  project_id:
  mission_id:
  session_id:
  task_id:
  action_id:

  intent_revision:
  execution_profile_version:
  routing_epoch_id:

  action:
    type:
    phase:
    complexity:
    uncertainty:
    risk:

  models:
    current:
    recommended:
    selected:

  decision:
    type: pin | switch | route | escalate | downgrade

  predicted:
    success:
    cost:
    latency:
    retry_probability:

  transition:
    context_rebuild_tokens:
    cache_loss_estimate:
    handoff_tokens:
    predicted_time_ms:
    predicted_cost:

  reason: []

  timestamp:
```

---

# 41. Context Receipt 최종 Schema

```yaml
context_receipt:
  schema_version: 1
  context_receipt_id:

  mission_id:
  task_id:
  action_id:

  based_on:
    intent_revision:
    plan_revision:

  input_tokens:

  transforms:
    dedup:
    tool_compression:
    history_trim:
    memory_add:
    project_knowledge_add:

  protected_sections: []

  output_tokens:

  cache:
    provider:
    hit_tokens:
    created_tokens:

  strategy_version:
```

---

# 42. Attempt Receipt 최종 Schema

```yaml
attempt_receipt:
  schema_version: 1
  run_id:

  mission_id:
  action_id:

  model_identity:
    provider:
    family:
    tier:
    model_id:
    version:
    catalog_version:

  usage:
    fresh_input_tokens:
    cached_input_tokens:
    cache_creation_tokens:
    output_tokens:
    thinking_tokens:

  timing:
    started_at:
    completed_at:
    latency_ms:

  outcome:
    status:
    verifier_result:
    accepted:

  cost:
    total:
```

---

# 43. Router Replay Module

권장:

```text
plugins/artibot/lib/replay/

  replay-store.js
  replay-recorder.js
  replay-query.js
  replay-redactor.js
  replay-retention.js
  replay-runner.js
```

Persistence 초기:

```text
SQLite
```

향후:

```text
Postgres
```

adapter.

---

# 44. RouteBench Module

```text
plugins/artibot/benchmarks/routing/

  fixtures/
  scenarios/
  baselines/

  runner.js
  replay-runner.js
  evaluator.js
  scorer.js
  aggregate.js

  reports/
```

## CLI proposal

```text
artibot routebench
artibot routebench --baseline v4
artibot routebench --router adaptive-v5
artibot routebench --scenario split
artibot routebench --replay last-50
```

내부 command naming은 프로젝트 기존 conventions에 맞춰 조정 가능.

---

# 45. RouteBench Scoring

단일 score 하나로 처음부터 압축하지 않는다.

Primary:

```text
Accepted Outcome Rate
Cost / Accepted Outcome
Success@1
Human Corrections
Wall-clock
```

Routing:

```text
Switch Efficiency
Transition Cost
Avoided Switch Accuracy
Escalation Rescue Rate
```

Context:

```text
Context Churn
Context Rebuild Count
Cache Hit Ratio
```

향후 composite score는 가능하지만 raw metrics를 항상 보존한다.

---

# 46. Router Replay → Counterfactual Evaluation

3단계로 구분한다.

## Exact

같은 Action에 여러 model result가 실제 존재.

## Partial

일부 candidate만 실제 result 존재.

## Simulated

Prediction model 사용.

Scorecard/benchmark report에는 반드시 label:

```text
EXACT
PARTIAL
SIMULATED
```

을 표시한다.

가짜 “절감 예상”을 실제 값처럼 표현하지 않는다.

---

# 47. Mission Reflection Module

```text
plugins/artibot/lib/context/

  mission-reflection.js
  project-knowledge.js
  context-compiler.js
```

Trigger:

```text
mission.created
intent.revised
major_phase_change
repeated_failure
explicit_refresh
```

기본 every-turn retrieval은 하지 않는다.

---

# 48. Generated Project Knowledge

권장 tree:

```text
.artibot/generated/
  architecture.md
  conventions.md
  known-failures.md
  active-initiatives.md
```

주의:

이 파일들은:

```text
GENERATED
NON-CANONICAL
REGENERATABLE
```

frontmatter를 갖게 한다.

예:

```yaml
---
generated: true
canonical: false
derived_from:
  - ADR
  - outcomes
  - git
  - validated-memory
generated_at:
---
```

Canonical document와 혼동 금지.

---

# 49. Checkpoint Module

```text
plugins/artibot/lib/checkpoint/

  checkpoint-service.js
  checkpoint-store.js
  checkpoint-validator.js
  resume-controller.js

  adapters/
    sqlite-store.js
    file-store.js
```

P0에서는 SQLite 중심을 권장.

파일 기반은 debugging/export 용도로 활용 가능.

---

# 50. Checkpoint Trigger

자동:

```text
task.completed
routing_epoch.completed
plan.revised
human_decision.accepted
before_high_risk_action
```

수동:

```text
/save
```

너무 빈번한 checkpoint는 IO/serialization overhead를 만든다.

---

# 51. Resume Contract

```text
Load latest valid checkpoint
 ↓
Validate schema
 ↓
Validate Intent revision
 ↓
Validate Plan revision
 ↓
Restore Task Graph
 ↓
Restore completed Action results
 ↓
Find expired worker leases
 ↓
Reconcile Ledger
 ↓
Re-evaluate model/cache availability
 ↓
Resume
```

중요:

이전 model을 무조건 restore하지 않는다.

```text
Previous model
+
current cache availability
+
current provider health
+
new Action requirement
```

으로 re-evaluate.

---

# 52. Checkpoint Immutability

Checkpoint는 저장 이후 mutation되지 않는다.

Implementation options:

```text
deep clone
immutable serialization
copy-on-write
```

Test:

```text
save
load
mutate loaded copy
load again
assert persisted original unchanged
```

---

# 53. Terminal Commands / UX

비개발자가 command를 몰라도 기본 자동 동작.

자동:

```text
Mission Complete
→ Final Scorecard

/save
→ Snapshot Scorecard
```

Power-user inspection:

```text
/score
/score --session
/score --project
/score --models
/score --routing
/why model
```

명령어 naming은 기존 Artibot command registry와 충돌 여부 확인 후 확정한다.

---

# 54. Scorecard Levels

## Live Status

간결:

```text
Mission
Progress
Phase
Model
Epoch
Workers
Cost
Elapsed
Review
```

## Session Snapshot

`/save`

## Final Mission Scorecard

Mission accepted.

## Project Scorecard

기간 집계.

---

# 55. P0 Final Scope

v5 GA 전에 반드시:

1. **Exact Model Identity**
2. **Routing Epoch**
3. **Switch Controller**
4. **Switching Cost/Time**
5. **Route Receipt**
6. **Attempt Receipt**
7. **Context Receipt**
8. **Actual Usage Receipt**
9. **Replay Store**
10. **Terminal Session Snapshot**
11. **Terminal Final Scorecard**
12. **Checkpoint / Resume**
13. **Checkpoint immutability**
14. **Independent Fable 5.1 Review binding**
15. **Completion Gate**

---

# 56. P1

1. Artibot RouteBench
2. Fixed baselines
3. Replay evaluation
4. Mission Reflection
5. Generated Project Knowledge
6. Replay security/redaction
7. Routing `/why`
8. Project Scorecard
9. Context Churn metrics
10. Human Correction metrics

---

# 57. P2

1. Shadow Learner
2. Learned success prediction
3. Dynamic switching thresholds
4. Canary Router
5. Router rollback
6. Automated RouteBench CI
7. Multi-repo benchmark
8. Topology-aware routing evaluation

---

# 58. Watch / Experimental

Do not make v5 GA depend on:

```text
Cross-model KV-cache reuse
Online RL router
Fully dynamic recursive agent creation
Unbounded multi-model debate
Provider-specific hidden cache hacks
```

특히 cross-model cache reuse는 provider/platform 공식 capability가 생길 때 adapter로 추가한다.

---

# 59. Source-code Reference Matrix

| Artibot Component | Reference Repo | File / Area | What to Borrow |
|---|---|---|---|
| Route Receipt | vLLM Semantic Router | `pkg/extproc/recorder.go` | replay lifecycle, decision record |
| Session route state | vLLM Semantic Router | `request_context.go` | request/session routing context |
| Stability policy | vLLM Semantic Router | `config/recipes/agent/config.yaml` | min turns, margin, stability |
| Routing DSL | vLLM Semantic Router | `config/recipes/balance/recipe.dsl` | explicit routing predicates |
| Attempt telemetry | vLLM issue #2855 | design contract | attempt vs final |
| Context Receipt | vLLM issue #2987 | workgroup design | transform plans/receipts |
| Safe switching | vLLM issue #2973 | roadmap | anti-thrashing, shadow/canary |
| Router Benchmark | LLMRouter | `benchmark_pipeline/` | train/eval/aggregate/restart |
| Dataset schema | xRouteBench | repo dataset structure | standardized tasks |
| Coding benchmark | Agent Memory Benchmark | `modes/coding.py` | agent/model abstraction |
| Real repo harness | Agent Memory Benchmark | `sdebench/harness/run.py` | repo/test-feedback harness |
| Mission reflection | Hindsight | memory reflect pattern | synthesized memory |
| Generated knowledge | Hindsight 0.9 | Knowledge Pages | projection, not source |
| Checkpoint store | Microsoft Agent Framework | `_workflows/_checkpoint.py` | storage abstraction |
| Step result reuse | Microsoft Agent Framework | `steps_and_checkpointing.py` | expensive step caching |
| Resume | Microsoft Agent Framework | `checkpoint_with_resume.py` | durable continuation |
| State isolation | Microsoft issue #7683 | bug pattern | immutable snapshot test |

---

# 60. Repository URLs

## vLLM Semantic Router

```text
https://github.com/vllm-project/semantic-router
```

Important:

```text
https://github.com/vllm-project/semantic-router/issues/2973
https://github.com/vllm-project/semantic-router/issues/2855
https://github.com/vllm-project/semantic-router/issues/2987
https://github.com/vllm-project/semantic-router/issues/2976

https://github.com/vllm-project/semantic-router/blob/main/src/semantic-router/pkg/extproc/recorder.go
https://github.com/vllm-project/semantic-router/blob/main/src/semantic-router/pkg/extproc/request_context.go
https://github.com/vllm-project/semantic-router/blob/main/config/recipes/agent/config.yaml
https://github.com/vllm-project/semantic-router/blob/main/config/recipes/balance/recipe.dsl
```

## LLMRouter / xRouteBench

```text
https://github.com/ulab-uiuc/LLMRouter
https://github.com/ulab-uiuc/LLMRouter/tree/main/benchmark_pipeline
https://github.com/ft2023/xRouteBench
https://arxiv.org/abs/2608.06867
```

## Hindsight

```text
https://github.com/vectorize-io/hindsight
https://github.com/vectorize-io/agent-memory-benchmark
https://hindsight.vectorize.io/blog/2026/08/06/hindsight-0-9-0

https://github.com/vectorize-io/agent-memory-benchmark/blob/main/src/memory_bench/modes/coding.py
https://github.com/vectorize-io/agent-memory-benchmark/blob/main/sdebench/harness/run.py
```

## Microsoft Agent Framework

```text
https://github.com/microsoft/agent-framework

https://github.com/microsoft/agent-framework/blob/main/python/packages/core/agent_framework/_workflows/_checkpoint.py
https://github.com/microsoft/agent-framework/blob/main/python/samples/03-workflows/functional/steps_and_checkpointing.py
https://github.com/microsoft/agent-framework/blob/main/python/samples/03-workflows/checkpoint/checkpoint_with_resume.py
https://github.com/microsoft/agent-framework/issues/7683
```

---

# 61. Source Reuse / License Rule

외부 코드를 참고할 때:

1. **Architecture/pattern adaptation 우선**
2. 실제 code copy가 필요하면 해당 repository LICENSE 확인
3. copyright/license notice 유지 조건 준수
4. 코드 전체 vendor는 특별한 이유가 없으면 피한다
5. Artibot conventions에 맞게 최소한의 concept만 재구현한다

현재 확인 기준:

```text
vLLM Semantic Router   Apache-2.0
LLMRouter              MIT
Hindsight              MIT
Microsoft Agent Framework MIT
```

단 release/branch에 따라 변경 가능하므로 실제 코드 편입 직전 LICENSE를 다시 확인한다.

---

# 62. 구현자에게 주는 코드 탐색 순서

Artibot model routing 구현을 시작할 때:

### Step 1 — vLLM recorder

먼저:

```text
semantic-router/.../extproc/recorder.go
```

를 읽는다.

목표:

```text
routing decision
→ replay record
→ lifecycle update
→ status/finalization
```

pattern 이해.

### Step 2 — vLLM agent config

```text
config/recipes/agent/config.yaml
```

에서 session/stability/learning configuration 구조 확인.

### Step 3 — LLMRouter benchmark_pipeline

Router 자체를 어떻게 baseline과 비교하는지 확인.

### Step 4 — Hindsight coding benchmark

실제 Agent + test feedback metric 구조 참고.

### Step 5 — Microsoft checkpoint

State storage / resume / step reuse 구현 패턴 참고.

그 후 Artibot 코드 작성.

---

# 63. Artibot Proposed Module Tree — Final

```text
plugins/artibot/lib/

  routing/
    execution-profile.js
    action-classifier.js
    adaptive-model-router.js

    routing-epoch.js
    switch-controller.js
    switch-economics.js
    residency-policy.js

    escalation-controller.js
    downgrade-controller.js
    route-hysteresis.js

    route-receipt.js
    routing-observer.js

  context/
    mission-reflection.js
    context-compiler.js
    context-receipt.js
    project-knowledge.js

  telemetry/
    attempt-receipt.js
    usage-receipt.js
    model-identity.js

  replay/
    replay-store.js
    replay-recorder.js
    replay-runner.js
    replay-redactor.js

  checkpoint/
    checkpoint-store.js
    checkpoint-service.js
    resume-controller.js
    checkpoint-validator.js

  scorecard/
    scorecard-service.js
    terminal-renderer.js
    session-scorecard.js
    mission-scorecard.js
    project-scorecard.js
    model-performance.js
    routing-performance.js

  review/
    fable-reviewer.js

  runtime/
    progress-controller.js
    completion-gate.js

benchmarks/
  routing/
    baselines/
    fixtures/
    scenarios/
    runner.js
    evaluator.js
    aggregate.js
```

---

# 64. Data Flow — Final

```text
Natural Language
       ↓
Intent
       ↓
Execution Profile
       ↓
Mission Reflection
       ↓
Context Compiler
       ↓
Context Receipt
       ↓
Action
       ↓
Adaptive Router
       ↓
Route Recommendation
       ↓
Switch Controller
       ↓
Route Receipt
       ↓
Routing Epoch
       ↓
Model Execution
       ↓
Attempt Receipt
       ↓
Verifier
       ├ fail → repair / escalation / new attempt
       ↓
Independent Fable Review
       ↓
Completion Gate
       ↓
Accepted Outcome
       ↓
Final Scorecard
       ↓
Replay Store
       ↓
RouteBench
       ↓
Shadow Learning
```

---

# 65. Terminal UX — Final Principle

사용자는:

```text
어떤 모델을 언제 바꿀지
```

몰라도 된다.

Artibot이 결정한다.

사용자는 완료 후:

```text
어떤 모델이 얼마나 일했고
왜 바뀌었으며
전환이 실제로 이득이었고
비용/시간/품질이 어떻게 나왔는가
```

만 이해하면 된다.

> **Routing is automatic. Performance is inspectable.**

---

# 66. 가장 중요한 신규 추가 7개

이번 최근 리서치까지 반영해서 기존 Addendum에 반드시 추가할 것은:

```text
1. Route Receipt
2. Context Receipt
3. Attempt Receipt
4. Router Replay
5. Artibot RouteBench
6. Mission-boundary Reflection
7. Checkpoint immutability / state isolation
```

이 7개가 추가되면 기존:

```text
Switch Controller
Routing Epoch
Scorecard
```

가 단순 아이디어가 아니라 **평가·재현·학습 가능한 시스템**이 된다.

---

# 67. Final Architecture Principle

기존:

> Route aggressively, switch conservatively.

에 하나를 더 추가한다.

> **Record every decision, replay every policy, and only learn from verified outcomes.**

전체:

```text
Score every Action.
Switch per Routing Epoch.
Measure transition cost.
Record the decision.
Verify the outcome.
Replay before learning.
```

---

# 68. Final Definition

> **Artibot v5 Adaptive Intelligence Runtime은 사용자의 Intent를 Execution Profile로 변환하고, 모든 Action의 최적 지능을 평가하면서 Routing Epoch 안에서는 Context continuity를 보존하며, Switching의 실제 비용·시간·Cache 손실보다 기대 이득이 클 때만 모델을 전환한다. 모든 Routing, Context 변환, Attempt와 Outcome은 Receipt/Replay 형태로 기록되며, Mission 완료 또는 `/save` 시 Terminal Scorecard로 성과를 보여준다. Router는 RouteBench와 Replay를 통해 검증된 후 Shadow→Canary 방식으로만 학습·개선된다.**
