# Implementation Blueprint

## Proposed modules

```text
plugins/artibot/lib/

  intent/
    intent-runtime.js
    intent-classifier.js
    intent-artifact.js
    intent-refinement.js

  project-state/
    state-manager.js
    state-schema.js
    state-lock.js
    project-navigation.js

  mission/
    mission-controller.js
    mission-contract.js
    problem-boundary.js

  planning/
    plan-engine.js
    ultraplan-engine.js
    adr-engine.js
    question-gate.js

  routing/
    execution-profile.js
    adaptive-model-router.js
    model-switcher.js
    escalation-controller.js
    route-hysteresis.js

  artifacts/
    artifact-registry.js
    artifact-policy.js
    artifact-validator.js
    archive-manager.js
    memory-promoter.js

  topology/
    topology-router.js
    split-state.js
    worker-ownership.js

  review/
    independent-reviewer.js
    fable-reviewer.js

  runtime/
    ledger.js
    event-writer.js
    mission-runner.js
```

## P0

1. `ARTIBOT.md` entry contract
2. `.artibot/project.md`
3. `.artibot/state.yaml`
4. mission `intent.md`
5. mission `plan.md`
6. no-derived-artifact validator
7. central runtime ledger
8. Intent-aware execution profile
9. Model routing/switching separation
10. Fable 5.1 review against canonical intent

## P1

11. ADR question gate
12. context compiler reads canonical state
13. worker ownership
14. Split state integration
15. mission archive
16. memory promotion

## P2

17. conflict prevention / locks
18. state dashboard
19. multi-user ownership/permissions
20. artifact health checks
