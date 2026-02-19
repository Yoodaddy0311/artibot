# Architecture Decision Framework

## Multi-Criteria Decision Matrix

For significant architectural choices, score each option:

| Criterion | Weight | Option A | Option B | Option C |
|-----------|--------|----------|----------|----------|
| Complexity | 30% | Score 1-5 | Score 1-5 | Score 1-5 |
| Coupling | 25% | Score 1-5 | Score 1-5 | Score 1-5 |
| Extensibility | 20% | Score 1-5 | Score 1-5 | Score 1-5 |
| Risk | 15% | Score 1-5 | Score 1-5 | Score 1-5 |
| Reversibility | 10% | Score 1-5 | Score 1-5 | Score 1-5 |

**Scoring**: 5 = Excellent, 4 = Good, 3 = Acceptable, 2 = Poor, 1 = Unacceptable

**Decision**: Choose highest weighted total. If within 10%, prefer the simpler option.

## Reversibility Classification

| Category | Examples | Decision Speed |
|----------|---------|---------------|
| Easily Reversible | API parameter naming, UI layout | Fast, iterate |
| Costly to Reverse | Database schema, API contracts | Careful, prototype first |
| Irreversible | Data deletion, public API removal | Maximum analysis |

## Time Horizon Analysis

| Horizon | Question | Weight |
|---------|----------|--------|
| Now | Does this solve the immediate problem? | 40% |
| 6 Months | Will this accommodate known roadmap items? | 35% |
| 2 Years | Could this become a scaling bottleneck? | 25% |

## Common Trade-Offs

| Trade-Off | Lean Toward A When | Lean Toward B When |
|-----------|-------------------|-------------------|
| Simplicity vs Flexibility | Requirements are clear, team is small | Requirements evolving, multiple consumers |
| Performance vs Readability | Measured bottleneck exists | No measured performance issue |
| DRY vs Decoupling | Shared logic is truly identical | "Similar" logic serves different domains |
| Monolith vs Microservices | Team <10, single deployment | Independent scaling needed, team >20 |
