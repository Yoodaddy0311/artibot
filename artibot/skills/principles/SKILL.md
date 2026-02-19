---
name: principles
description: |
  Core development principles and decision-making frameworks for Artibot.
  SOLID, DRY, KISS, YAGNI, and evidence-based engineering practices.

  Use proactively when making architectural decisions,
  reviewing code quality, or planning implementations.

  Triggers: architecture, design decision, principle, pattern,
  SOLID, quality, maintainability, scalability, trade-off,
  아키텍처, 설계, 원칙, 품질, 유지보수,
  アーキテクチャ, 設計, 原則, 品質

  Do NOT use for: simple bug fixes, documentation-only tasks,
  or trivial single-line changes.
---

# Development Principles

> Evidence over assumptions. Code over documentation. Simplicity over cleverness.

## When This Skill Applies

- Architectural decisions requiring trade-off analysis
- Code review evaluating design quality
- Implementation planning for new features
- Refactoring or modernization work
- Any decision with long-term maintainability impact

## Core Design Principles

### SOLID (see `references/solid.md`)

| Principle | Rule | Violation Signal |
|-----------|------|-----------------|
| Single Responsibility | One reason to change per module | Class >300 lines, mixed concerns |
| Open/Closed | Extend, don't modify | Switch statements growing |
| Liskov Substitution | Subtypes must be substitutable | Override changes behavior |
| Interface Segregation | No forced unused dependencies | Implementing empty methods |
| Dependency Inversion | Depend on abstractions | Direct `new` in business logic |

### Foundational Principles

**DRY**: Extract on 2nd occurrence. Not 3rd, not "might need later."
**KISS**: Simplest working solution. Three similar lines > premature abstraction.
**YAGNI**: Build for today's requirements. Speculative features are waste.
**Composition > Inheritance**: Favor object composition over class hierarchies.
**Separation of Concerns**: Each module handles one domain aspect.

## Decision-Making Framework

### Trade-off Analysis

For any non-trivial decision:

1. **Identify options** (minimum 2 alternatives)
2. **Score against criteria**: maintainability, performance, security, complexity
3. **Classify reversibility**: reversible | costly-to-reverse | irreversible
4. **Document rationale**: Why this option, not the other

### Risk Assessment

| Risk Level | Probability x Impact | Action |
|-----------|---------------------|--------|
| Low | Minor, recoverable | Proceed with monitoring |
| Medium | Notable, fixable | Mitigate before proceeding |
| High | Significant, costly | Block until resolved |
| Critical | Severe, irreversible | Escalate immediately |

## Quality Standards

### Non-Negotiable

- All user input validated at system boundaries
- Error handling with meaningful context (never silent failures)
- No hardcoded secrets or credentials
- Functions <50 lines, files <800 lines
- No deep nesting (>4 levels)

### Measurable Targets

| Metric | Target | Measurement |
|--------|--------|-------------|
| Test coverage | >=80% | Unit + integration |
| Cyclomatic complexity | <10 per function | Static analysis |
| Build time | <60s | CI pipeline |
| Response time | <200ms API, <3s page load | Monitoring |

## Quality Gates (see `references/quality-gates.md`)

Every deliverable passes the 8-step validation:
1. Syntax check
2. Type safety
3. Lint rules
4. Security scan
5. Test execution
6. Performance check
7. Documentation completeness
8. Integration verification

## References

- `references/solid.md` - SOLID principles with examples
- `references/quality-gates.md` - 8-step validation cycle details
