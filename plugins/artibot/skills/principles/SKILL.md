---
name: principles
description: |
  Core development principles enforcing SOLID, DRY, KISS, YAGNI, and quality-first design.
  Auto-activates when: writing code, making design decisions, refactoring, reviewing architecture.
  Triggers: design, architecture, refactor, pattern, principle, SOLID, clean code
---

# Development Principles

## When This Skill Applies
- Writing new code or modifying existing code
- Making architectural or design decisions
- Refactoring or improving code quality
- Reviewing pull requests or code structure
- Evaluating trade-offs between approaches

## Core Guidance

### SOLID Principles
- **S**ingle Responsibility: One class/function = one reason to change
- **O**pen/Closed: Open for extension, closed for modification
- **L**iskov Substitution: Subtypes must be substitutable for base types
- **I**nterface Segregation: No forced dependency on unused interfaces
- **D**ependency Inversion: Depend on abstractions, not concretions

See `references/solid.md` for detailed examples.

### Design Principles
- **DRY**: Abstract common functionality, eliminate duplication
- **KISS**: Simplest solution that works. Complexity is a cost.
- **YAGNI**: Only implement current requirements. No speculative features.
- **Composition > Inheritance**: Favor object composition
- **Loose Coupling + High Cohesion**: Minimize dependencies, group related logic

### Decision Framework
1. **Evidence > Assumptions**: Verify with tests, metrics, documentation
2. **Code > Documentation**: Working code is the source of truth
3. **Measure first**: Profile before optimizing
4. **Reversibility**: Prefer reversible decisions when uncertain
5. **Trade-off analysis**: Consider immediate vs. long-term impact

### Quality Gate Integration
All code changes pass through a 3-step validation cycle.
See `references/quality-gates.md` for the validation framework.

## Quick Reference

| Principle | Check | Violation Signal |
|-----------|-------|------------------|
| SRP | Does this have one reason to change? | Class/function does multiple things |
| DRY | Is this duplicated elsewhere? | Copy-paste patterns |
| KISS | Is there a simpler way? | Over-engineering, unnecessary abstraction |
| YAGNI | Is this needed now? | Speculative features, unused code |
