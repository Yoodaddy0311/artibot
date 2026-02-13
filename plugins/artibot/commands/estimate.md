---
description: Evidence-based estimation with complexity scoring and risk factoring
argument-hint: [feature-or-task] [--granularity coarse|fine]
allowed-tools: [Read, Glob, Grep, Bash, Task]
---

# /estimate

Evidence-based estimation that factors in codebase complexity, dependency depth, test requirements, and historical patterns. Uses architect and analyzer personas for multi-perspective assessment.

## Arguments

Parse $ARGUMENTS:
- `feature-or-task`: Description of work to estimate
- `--granularity [level]`: `coarse` (high-level) | `fine` (detailed per-task)
- `--scope [level]`: `file` | `module` | `project` | `system`
- `--include-risks`: Factor risk mitigation time into estimates
- `--compare [reference]`: Compare against similar past work

## Estimation Factors

| Factor | Weight | Measures |
|--------|--------|----------|
| Complexity | 30% | Cyclomatic complexity, dependency depth, domain crossings |
| Scope | 25% | Files affected, lines of change, modules touched |
| Risk | 20% | Unknown dependencies, external integrations, data migrations |
| Testing | 15% | Test coverage needed, E2E scenarios, edge cases |
| Review | 10% | Security review needs, architecture review, documentation |

## Execution Flow

1. **Parse**: Extract feature requirements and scope
2. **Context**: Analyze codebase for estimation evidence:
   - Count files and modules in affected areas
   - Measure existing complexity of target code
   - Identify external dependencies and integration points
   - Check existing test coverage in target areas
3. **Decompose**: Break work into estimable units:
   - Implementation tasks (create/modify files)
   - Testing tasks (unit, integration, E2E)
   - Review tasks (code review, security review)
   - Documentation tasks (API docs, guides)
4. **Score**: Apply complexity scoring to each unit:
   - Simple (1): Single file, clear pattern, no dependencies
   - Moderate (3): Multi-file, some dependencies, testing needed
   - Complex (5): Cross-module, external integrations, architectural impact
   - Critical (8): System-wide, data migration, breaking changes
5. **Aggregate**: Combine scores with risk buffer
6. **Report**: Output structured estimate with confidence levels

## Confidence Levels

| Confidence | Conditions | Buffer |
|------------|-----------|--------|
| High (90%) | Clear requirements, familiar codebase, similar past work | +10% |
| Medium (70%) | Partial requirements, some unknowns | +30% |
| Low (50%) | Vague requirements, unfamiliar domain, many unknowns | +50% |

## Output Format

```
ESTIMATION REPORT
=================
Feature:     [description]
Granularity: [coarse|fine]
Confidence:  [high|medium|low]

BREAKDOWN
---------
Phase          | Complexity | Effort
---------------|------------|-------
[phase name]   | [score]    | [estimate]
[phase name]   | [score]    | [estimate]
               | Total      | [sum]
               | Risk buffer| [+n%]
               | Final      | [total]

RISK FACTORS
------------
[risk] -> [impact on estimate]

ASSUMPTIONS
-----------
- [assumption that affects estimate]
```
