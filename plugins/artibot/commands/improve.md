---
description: (Artibot) Evidence-based code improvement with iterative refinement support
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

1. **Decompose**: Break user request into numbered atomic improvement items. Every item MUST be tracked.
2. **Parse**: Resolve target, determine scope and focus domain
3. **Read Context**: Read ALL target files BEFORE making any changes. Understand existing code first.
4. **Baseline**: Measure current state metrics before any changes:
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
7. **Measure**: Re-run baseline metrics, calculate delta
8. **Verify**: Re-read ALL modified files. Confirm each change is correct. Check every item from step 1.
9. **Iterate** (if `--loop`): Repeat steps 5-8 for remaining iterations
10. **Report**: Output improvement summary with before/after comparison and per-item completion evidence

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

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 개선 검증 | `/test` | 개선 코드 테스트 실행 |
| 2 | 전체 검증 | `/verify` | 전체 검증 파이프라인 실행 |
| 3 | 변경사항 커밋 | `/git` | 개선 사항 커밋 및 푸시 |
