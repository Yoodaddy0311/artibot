---
description: System design with architect agent and ADR generation
argument-hint: [system-or-module] [--type api|data|infra|ui]
allowed-tools: [Read, Glob, Grep, Bash, Task, TodoWrite]
---

# /design

System design and architecture planning. Delegates to architect agent for structural analysis, trade-off evaluation, and Architecture Decision Record (ADR) generation.

## Arguments

Parse $ARGUMENTS:
- `system-or-module`: Target system, module, or feature to design
- `--type [domain]`: `api` | `data` | `infra` | `ui` | `full`
- `--adr`: Generate formal Architecture Decision Record
- `--alternatives [n]`: Number of design alternatives to evaluate (default: 2)

## Execution Flow

1. **Parse**: Identify design target and domain type
2. **Context**: Gather existing architecture:
   - Project structure and module boundaries
   - Current dependency graph
   - Existing design patterns in use
   - Technology stack and framework constraints
3. **Delegate**: Route to Task(architect) for:
   - Requirements analysis from target description
   - Design alternative generation (N options)
   - Trade-off matrix evaluation per alternative
   - Recommended approach with rationale
4. **ADR** (if `--adr`): Generate Architecture Decision Record:
   - Title, Status, Context, Decision, Consequences
   - Store in `docs/adr/` or project-specific ADR directory
5. **Validate**: Check design against SOLID principles, existing patterns, scalability needs
6. **Report**: Output design recommendation with trade-off analysis

## Design Evaluation Criteria

| Criterion | Weight | Measures |
|-----------|--------|----------|
| Maintainability | 30% | Complexity, readability, modification cost |
| Scalability | 25% | Load capacity, horizontal scaling, statelessness |
| Modularity | 20% | Coupling, cohesion, interface clarity |
| Simplicity | 15% | Abstraction count, learning curve |
| Extensibility | 10% | Plugin points, open/closed adherence |

## Output Format

```
SYSTEM DESIGN
=============
Target:    [system/module]
Domain:    [api|data|infra|ui]
Status:    [PROPOSED|ACCEPTED]

OPTION A: [name]
  Description: [summary]
  + [advantage]
  - [disadvantage]
  Score: [weighted total]

OPTION B: [name]
  Description: [summary]
  + [advantage]
  - [disadvantage]
  Score: [weighted total]

RECOMMENDATION
--------------
Preferred: [A|B] because [rationale]

DEPENDENCY MAP
--------------
[module] -> [module] (coupling: [tight|loose])
```
