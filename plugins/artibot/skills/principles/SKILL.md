---
name: principles
description: |
  Core development principles enforcing SOLID, DRY, KISS, YAGNI, and quality-first design.
  Auto-activates when: writing code, making design decisions, refactoring, reviewing architecture.
  Triggers: design, architecture, refactor, pattern, principle, SOLID, clean code
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "design"
  - "architecture"
  - "refactor"
  - "pattern"
  - "principle"
  - "SOLID"
  - "clean code"
  - "DRY"
agents:
  - "architect"
  - "refactor-cleaner"
tokens: "~3K"
category: "code-quality"
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

### Execution Discipline (MANDATORY for ALL agents)

**Decompose-Execute-Verify (DEV) Protocol**:
1. **Decompose**: Break every request into numbered atomic items BEFORE starting
2. **Execute**: Read target files FIRST, make changes, re-read to confirm
3. **Verify**: Report completion with evidence (file:line) for each item

**Zero-Skip Policy**:
- NEVER silently skip or defer any part of a request
- NEVER claim "done" without re-reading modified files
- NEVER modify a file without reading it first
- If blocked, explain WHY with specific error/reason

**Evidence-Based Completion**:
- ✅ requires: file path + line number + what changed
- "Updated the file" = NOT acceptable evidence
- "Updated src/auth.ts:45-52, added validateToken() null check" = acceptable

## Quick Reference

| Principle | Check | Violation Signal |
|-----------|-------|------------------|
| SRP | Does this have one reason to change? | Class/function does multiple things |
| DRY | Is this duplicated elsewhere? | Copy-paste patterns |
| KISS | Is there a simpler way? | Over-engineering, unnecessary abstraction |
| YAGNI | Is this needed now? | Speculative features, unused code |
| DEV | Was every request item decomposed, executed, verified? | Silent skips, no evidence |
| Zero-Skip | Was any part of the request dropped? | Missing items in completion report |

## Workflow Checklist

Copy this checklist and track progress:

```
Progress:
- [ ] Step 1: DECOMPOSE — Break request into numbered atomic items
- [ ] Step 2: Read target files BEFORE any modifications
- [ ] Step 3: EXECUTE — Apply changes following SOLID, DRY, KISS, YAGNI
- [ ] Step 4: Re-read modified files to confirm correctness
- [ ] Step 5: VERIFY — Report evidence (file:line) for each item
- [ ] Step 6: Check for zero-skip — no items silently dropped
```

## Human Checkpoints

| After Step | Checkpoint | Type | Options |
|-----------|-----------|------|---------|
| Step 1 | Decomposition complete and correct? | Approval | Approve items / Add missing items |
| Step 3 | Design trade-offs acceptable? | Selection | KISS approach / More abstraction / Different pattern |
| Step 5 | Evidence satisfactory for each item? | Go-No-Go | Accept / Request more evidence |

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Decompose request | MEDIUM | Must capture all items, granularity is judgment call |
| Read target files | LOW | Mandatory before any modification |
| Apply principles | HIGH | SOLID/DRY/KISS/YAGNI provide direction, specific implementation varies |
| Re-read files | LOW | Mandatory after every modification |
| Report evidence | LOW | file:line format required, no vague claims |
| Zero-skip check | LOW | Every item must be addressed or explicitly blocked |
