# Release Roadmap

## Phase 0 — Baseline

Measure v4.x accepted outcome, cost, retries, human interventions, wall clock, review misses and Split monitoring burden.

## Phase 1 — Observe

v5 components generate decisions but do not control all production behavior. Collect inferred command, skill, plan depth, model and topology.

## Phase 2 — Shadow

Compare old runtime decision vs v5 recommended decision and outcome.

## Phase 3 — Canary

Enable v5 auto-compilation for low-risk work. Prioritize natural-language activation, independent review, unified verification and cost truth.

## Phase 4 — GA

Default path:

```text
Natural language → Artibot decides internal runtime
```

Advanced commands remain available.

## v5.0 exit criteria

Suggested:

- no Accepted Outcome regression,
- natural-language activation accuracy ≥ 90% on curated evals,
- actual usage measurement coverage ≥ 95%,
- review coverage of substantive tasks ≥ 95%,
- Fable reviewer catch-rate measured against seeded defects,
- reduced human intervention/outcome,
- reduced retry waste,
- improved cost/accepted outcome in balanced mode,
- measurable `autopilot --fast` Time-to-Verified-Outcome improvement,
- measurable Split wall-clock improvement without unacceptable merge/review regression.
