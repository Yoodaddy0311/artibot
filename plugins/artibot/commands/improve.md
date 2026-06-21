---
description: (Artibot) Evidence-based code improvement with iterative refinement support
argument-hint: '[target] e.g. "성능 최적화 개선"'
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Task, TaskCreate]
toolset: team
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

## Proposal Validation Gate (필수)

개선안을 생성하기 **전에** 각 후보를 `problem-validation` 스킬 체크리스트로 검증한다:
1. 이미 존재하는가? (`file:line`으로 확인)
2. 하드 증거(incident·실패테스트·측정값)가 있는가? (트렌드 추론 금지)
3. YAGNI 아닌가? (현재 실제로 필요하지 않으면 REJECT)

기본값 = REJECT. 통과 후보가 0개면 "변경 불필요"로 종료. 제안 시 NECESSARY + REJECT 목록을 함께 제시한다.

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
