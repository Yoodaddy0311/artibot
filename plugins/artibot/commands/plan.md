---
description: Implementation plan creation with risk identification and phase decomposition
argument-hint: '[task] e.g. "결제 시스템 구현 계획"'
allowed-tools: [Read, Glob, Grep, Bash, Task, TodoWrite]
---

# /plan

Create structured implementation plans using the planner agent. Decomposes complex work into phases with dependency tracking and risk assessment.

## Arguments

Parse $ARGUMENTS:
- `feature-or-task`: Description of what needs to be implemented or changed
- `--depth [level]`: `shallow` (high-level phases) | `deep` (detailed task breakdown)
- `--scope [level]`: `file` | `module` | `project` | `system`
- `--risks`: Emphasize risk identification and mitigation strategies

## Execution Flow

1. **Parse**: Extract requirements from description. Identify scope and complexity
2. **Context**: Scan codebase for:
   - Existing patterns and conventions
   - Related files and modules that will be affected
   - Current test coverage in target areas
   - Dependency graph of affected components
3. **Delegate**: Route to Task(planner) with gathered context for:
   - Phase decomposition (3-7 phases typical)
   - Task breakdown within each phase
   - Dependency ordering between tasks
   - Risk identification per phase
4. **Validate**: Check plan for:
   - Circular dependencies between phases
   - Missing test phases
   - Unreferenced files in the codebase
5. **Report**: Output structured plan with TodoWrite integration

## Plan Structure

Each phase contains:
- **Objective**: What this phase achieves
- **Tasks**: Atomic work items (create/modify/delete files)
- **Dependencies**: Which phases must complete first
- **Risks**: What could go wrong + mitigation
- **Verification**: How to confirm phase completion

## Output Format

```
IMPLEMENTATION PLAN
===================
Feature:    [description]
Complexity: [simple|moderate|complex]
Phases:     [count]
Est. Files: [create: n, modify: n]

PHASE 1: [name]
  Objective: [what]
  Tasks:
    [ ] [task description] -> [file path]
    [ ] [task description] -> [file path]
  Depends on: [none|phase N]
  Risk: [description] | Mitigation: [strategy]
  Verify: [how to confirm completion]

PHASE 2: [name]
  ...

RISKS
-----
[severity] [description] -> [mitigation]
```
