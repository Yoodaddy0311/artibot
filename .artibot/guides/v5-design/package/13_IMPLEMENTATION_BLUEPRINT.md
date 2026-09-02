# Implementation Blueprint

## Proposed modules

```text
plugins/artibot/lib/

  intent/
    natural-language-runtime.js
    command-activator.js
    intent-classifier.js

  mission/
    mission-compiler.js
    mission-contract.js
    problem-boundary.js
    blindspot-scanner.js

  planning/
    plan-engine.js
    ultraplan-engine.js
    adr-engine.js
    question-gate.js

  context/
    context-compiler.js
    evidence-index.js
    context-deduper.js
    tool-output-compressor.js

  routing/
    action-classifier.js
    adaptive-model-router.js
    route-scorer.js
    route-hysteresis.js
    escalation-controller.js

  topology/
    topology-router.js
    solo-runtime.js
    team-runtime.js
    autopilot-runtime.js
    autopilot-fast-runtime.js
    split-runtime.js

  review/
    independent-reviewer.js
    fable-reviewer.js
    review-policy.js

  verification/
    unified-verifier.js
    deterministic-verifier.js
    behavioral-verifier.js
    operational-verifier.js

  recovery/
    recovery-controller.js
    failure-classifier.js
    plan-repair.js

  economics/
    model-catalog.js
    usage-receipt.js
    cost-ledger.js
    economics-scorer.js

  runtime/
    run-ledger.js
    mission-runner.js

  learning/
    routing-observer.js
    context-observer.js
    planning-observer.js
    shadow-learner.js
```

## Compatibility migration

Do not delete existing agents/commands at once. Existing commands remain callable for power users while natural language becomes the default path. Existing agent definitions remain compatibility wrappers while runtime shifts toward capability composition.

## P0 — Foundation

1. Mission Contract
2. Natural-language command/skill/setting activation
3. Actual provider Usage Receipt
4. Single model/pricing catalog
5. Unified Run Ledger
6. Independent Fable Review
7. Unified Verifier

## P1 — Intelligence

8. Plan / Ultraplan separation
9. ADR + questionUserAnswer gate
10. Context Compiler
11. Adaptive Model Router
12. Model hysteresis
13. Recovery Controller
14. Blindspot scan

## P2 — Topology

15. Topology Router
16. `autopilot --fast` performance policy
17. Split durable workers/context handoff
18. merge/conflict automation
19. parallelism telemetry

## P3 — Learning

20. shadow routing learner
21. context optimizer
22. plan-depth optimizer
23. topology outcome learning
