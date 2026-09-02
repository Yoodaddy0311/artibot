# Review, Verification & Recovery

## Builder ≠ Final Reviewer

Selected canonical policy: **independent review**.

```text
Plan → Implementation → Self-check → Independent Fable 5.1 Review → Unified Verification
```

The builder may self-check, but this does not replace final independent review.

## Fable reviewer responsibilities

Inspect original user intent, Mission Contract, Plan/ADR, diff/changes, tests, behavior, architecture impact, blindspots, regressions, over-engineering, missing requirements and unnecessary scope expansion.

```yaml
review:
  verdict: pass | repair | replan
  severity: low | medium | high | critical
  findings: []
  evidence: []
  recommended_action: ""
```

## Completion definition

Done = intent satisfied + success criteria + actual execution evidence + tests/verification + independent review + no unacceptable regression.

## Verification layers

- **Deterministic:** tests, typecheck, lint, build, invariants, git diff checks.
- **Behavioral:** expected user-visible behavior, instruction compliance, UX correctness, scenarios.
- **Operational:** latency, retries, cost waste, concurrency, regressions, runtime health.

## Recovery controller

```text
FAIL
 ↓
Review failure evidence
 ↓
Classify
 ├─ implementation defect → repair under current Plan
 ├─ Plan defect           → revise Plan
 ├─ systemic framing defect → Ultraplan
 └─ human-value decision  → questionUserAnswer / Human Gate
```

Typical intelligence escalation: Sonnet → Opus → Fable → Human.
