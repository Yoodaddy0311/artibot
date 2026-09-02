# Intent & Mission Compiler

Every substantive request is compiled into a Mission Contract.

```text
Raw User Request → Intent Interpreter → Problem Boundary → Mission Contract
```

## Mission Contract

```yaml
mission:
  goal: ""
  explicit_requests: []
  inferred_outcomes: []
  success:
    functional: []
    behavioral: []
    regression: []
    evidence: []
  scope:
    requested_target: []
    direct: []
    upstream: []
    downstream: []
    bounded_blindspots: []
    excluded: []
  constraints: []
  autonomy:
    mode: auto
    human_gates: []
  performance:
    priority: balanced
    fast_mode: false
  planning:
    mode: auto
  completion:
    expected_actions: []
```

## Intent Fidelity Rule

Maintain a protected `explicit_requests` list. A systemic solution cannot silently replace the explicit request.

## Problem Boundary

Classify findings as `direct`, `upstream`, `downstream`, `adjacent`, or `unrelated`. Scope may expand only with a causal justification.

## Blindspot classes

```yaml
findings:
  mission_blockers: []
  bounded_blindspots: []
  future_opportunities: []
```

`bounded_blindspots` may be fixed autonomously. `future_opportunities` are recorded but do not automatically become a large refactor.

## Intent confidence

Represent uncertainty rather than hiding it. Low confidence first triggers investigation, not a user question.

```yaml
intent_confidence:
  goal: 0.97
  scope: 0.81
  completion_expectation: 0.93
  product_decision_required: false
```

## Automatic command synthesis

```yaml
command_activation:
  plan: true
  ultraplan: false
  review: true
  autopilot: true
  autopilot_fast: false
  split: false
  skills:
    - repo-analysis
    - debugging
    - test-validation
```
