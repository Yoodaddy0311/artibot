---
description: Evidence-based code improvement with iterative refinement support
argument-hint: '[target] e.g. "성능 최적화 개선"'
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Task, TaskCreate]
---

# /improve

Systematic code improvement with measurable before/after metrics. Supports iterative refinement loops.

## Arguments

Parse $ARGUMENTS:
- `target`: File path, directory, or `@<path>` reference
- `--focus [domain]`: `performance` | `security` | `quality` | `architecture`
- `--loop`: Enable iterative improvement (default: 3 iterations)
- `--iterations [n]`: Number of improvement cycles (1-10)
- `--interactive`: Pause for confirmation between iterations
- `--scope [level]`: `file` | `module` | `project`

## Execution Flow

1. **Parse**: Resolve target, determine scope and focus domain
2. **Baseline**: Measure current state metrics before any changes:
   - **performance**: Response times, bundle size, complexity scores
   - **security**: Vulnerability count, dependency audit results
   - **quality**: Cyclomatic complexity, duplication %, lint errors, test coverage
   - **architecture**: Coupling score, cohesion metrics, dependency depth
3. **Analyze**: Identify improvement opportunities ranked by impact:
   - HIGH impact + LOW effort = Priority 1
   - HIGH impact + HIGH effort = Priority 2
   - LOW impact + LOW effort = Priority 3
4. **Improve**: Apply changes in priority order:
   - Use immutable patterns (never mutate existing objects)
   - Preserve existing test coverage
   - Follow project conventions
5. **Measure**: Re-run baseline metrics, calculate delta
6. **Iterate** (if `--loop`): Repeat steps 3-5 for remaining iterations
7. **Report**: Output improvement summary with before/after comparison

## Focus-Specific Strategies

| Focus | Key Actions |
|-------|------------|
| performance | Eliminate O(n^2), add memoization, reduce bundle, lazy-load |
| security | Fix injection points, add input validation, remove hardcoded secrets |
| quality | Reduce complexity, extract functions, improve naming, add types |
| architecture | Decouple modules, invert dependencies, define interfaces |

## Output Format

```
IMPROVEMENT REPORT
==================
Target:     [path]
Focus:      [domain]
Iterations: [completed/total]

BEFORE -> AFTER
---------------
[metric]: [before] -> [after] ([+/-delta])

CHANGES APPLIED
---------------
[priority] [file:line] [description]

REMAINING OPPORTUNITIES
-----------------------
[items not addressed in this run]
```
