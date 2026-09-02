# Blindspot & Systemic Reasoning

> **Solve the request, inspect the system.**

A request has multiple impact layers:

```text
Requested target → Direct behavior → Upstream causes → Downstream effects → Adjacent system
```

| Class | Meaning | Default action |
|---|---|---|
| Direct | target itself | always inspect |
| Upstream | causes target behavior | inspect when causal |
| Downstream | may regress from change | verify |
| Adjacent | relevant but weakly causal | optional |
| Unrelated | not part of mission | exclude |

## Blindspot Resolution

Artibot may fix unrequested issues when scope is close, small and clearly improves the current mission.

```text
Causal? yes
Small? yes
Reversible? yes
Intent clear? yes
No new product decision? yes
Verifiable? yes
→ Auto-fix bounded blindspot
```

Otherwise record as a Future Opportunity.

## Anti-patterns

Too narrow: “Split was requested, so only edit split.js.”  
Too broad: “Split has an issue, therefore redesign the entire runtime.”  
Desired: inspect Split directly, fix causal upstream problems, verify downstream behavior, stop where causality becomes weak.
