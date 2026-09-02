# Intent-aware Model Routing & Switching

## Why intent must come first

The same technical task can require different routing depending on the user's intent.

Example:

> “간단히 확인해줘.”

and:

> “토큰 아끼지 말고 최대한 빠르고 정확하게 끝내.”

must not compile to the same runtime profile.

## Runtime sequence

```text
Intent
 ↓
Execution Profile
 ↓
Action Classification
 ↓
Model Routing
 ↓
Model Switching / Pinning
```

## Distinct concepts

### Routing
Which model should handle the next action?

### Switching
Should the current action/session move to another model?

### Escalation
Move upward because success probability is too low.

### Downgrade
Move downward when frontier-level reasoning is no longer needed.

### Pinning / Hysteresis
Stay on the current model when cache/context/handoff costs outweigh expected gains.

## Initial model role policy

```text
Haiku
- intent classification
- metadata
- lightweight status

Sonnet
- exploration
- evidence collection
- routine work

Opus
- implementation
- complex debugging
- significant planning

Fable 5.1
- independent review
- architecture
- high uncertainty
- repeated failure arbitration
```

## Important v5 rule

**Agent != Model**

Do not permanently attach a model to a named agent.
Route by action and required intelligence.

## Special performance intent

### Balanced
Optimize cost per accepted outcome.

### Maximum / `autopilot --fast`
Optimize:
- time to verified outcome
- accuracy

Allow larger token and parallelism envelope.

### Split
Optimize:
- wall-clock reduction
- parallel throughput
- final accepted quality

Do not minimize token usage as the primary objective.
