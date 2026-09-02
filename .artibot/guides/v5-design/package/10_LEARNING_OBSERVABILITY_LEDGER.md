# Learning, Observability & Run Ledger

## Learning target

Artibot learns **how to work better** from outcomes.

```text
Task features
+ chosen plan
+ model route
+ context package
+ topology
+ cost
+ latency
+ retries
+ review findings
+ accepted outcome
+ human corrections
→ better routing/context/planning/topology/recovery
```

## Initial learning mode

Use **shadow learning** first.

```text
Current production decision executes
+
Learner predicts alternative
+
Compare outcome offline
```

Do not immediately let learned policy mutate production behavior.

## Unified Run Ledger

```yaml
run:
  mission_id: ""
  action_id: ""
  intent:
    type: ""
    confidence: 0.0
  plan:
    mode: plan
    revision: 0
  route:
    model: opus
    effort: high
    reason: []
  topology:
    mode: solo
  context:
    supplied_tokens: 0
    cache_hit_tokens: 0
    evidence_refs: []
  economics:
    fresh_input: 0
    cached_input: 0
    output: 0
    thinking: 0
    total_cost: 0
  execution:
    tools: []
    files: []
    retries: 0
  review:
    model: fable-5.1
    verdict: pass
    findings: []
  verification:
    result: pass
    evidence: []
  human:
    questions: 0
    interventions: 0
  outcome:
    accepted: true
```

## Core KPIs

Primary: **Cost / Accepted Outcome**.

Supporting: Success@1, Human Intervention/Outcome, Time/Accepted Outcome, Tokens/Accepted Outcome, Retry Waste Ratio, Context Duplication Ratio, Cache Hit Ratio, Routing Accuracy, Model Switch Cost, Review Catch Rate, Regression Rate, Split wall-clock gain, autopilot--fast speedup.
