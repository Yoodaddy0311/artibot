# Architecture Decision Framework

## ADR Template (Architecture Decision Record)

```markdown
# ADR-{number}: {Title}

## Status
Proposed | Accepted | Deprecated | Superseded by ADR-{n}

## Context
What is the issue that we're seeing that is motivating this decision?

## Decision
What is the change that we're proposing and/or doing?

## Options Considered

| Option | Maintainability | Scalability | Modularity | Simplicity | Score |
|--------|:-:|:-:|:-:|:-:|:-:|
| Option A | 8 | 7 | 9 | 6 | 7.65 |
| Option B | 6 | 9 | 7 | 8 | 7.25 |

Weights: maintainability=0.30, scalability=0.25, modularity=0.20, simplicity=0.15, extensibility=0.10

## Consequences
What becomes easier or more difficult because of this change?

## Reversibility
[ ] Easily reversible | [ ] Costly to reverse | [ ] Irreversible
```

## Architecture Evaluation Criteria

| Criterion | Good (8-10) | Acceptable (5-7) | Poor (1-4) |
|-----------|-------------|-------------------|------------|
| Coupling | No shared state, clear contracts | Some shared types | Direct dependencies |
| Cohesion | Single domain per module | Related domains grouped | Mixed responsibilities |
| Testability | Fully unit-testable in isolation | Needs some mocks | Requires integration env |
| Extensibility | Plugin/strategy pattern | Subclass/override | Modify existing code |
| Failure Isolation | Circuit breaker, bulkhead | Timeout/retry | Cascading failure risk |

## Dependency Direction Rules

```
UI Layer → Application Layer → Domain Layer → Infrastructure Layer
                                    ↑ (interfaces only)
                              Persistence Layer
```

- Higher layers depend on lower layers
- Lower layers never import from higher layers
- Cross-cutting concerns use dependency injection
- Domain layer has zero external dependencies
