---
description: (Artibot) Feature implementation with planner/tdd-guide/code-reviewer pipeline
argument-hint: '[feature] e.g. "로그인 기능 구현"'
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Task, TaskCreate]
toolset: team
---

# /implement

End-to-end feature implementation following the pipeline: plan -> design -> implement -> test -> review.

## Arguments

Parse $ARGUMENTS:
- `feature`: Feature description or specification
- `--type [kind]`: `component` | `api` | `service` | `feature` (auto-detected if omitted)
- `--framework [name]`: Target framework override
- `--tdd`: Force test-driven development workflow
- `--skip-review`: Skip code review phase (not recommended)

## Type Detection

If `--type` not specified, detect from feature description:
- UI/component/page/form/button keywords -> `component`
- API/endpoint/route/REST/GraphQL keywords -> `api`
- Service/worker/queue/scheduler keywords -> `service`
- Default -> `feature`

## Execution Flow

1. **Decompose**: Break user request into numbered atomic requirements. EVERY requirement MUST be tracked.
2. **Parse**: Extract feature requirements, detect type and framework
3. **Read Context**: Read ALL files that will be modified BEFORE making any changes. Understand existing patterns.
4. **Plan**: Delegate to Task(planner) for implementation breakdown:
   - File list (create/modify)
   - Dependency identification
   - Risk assessment
   - Phase ordering
5. **Design** (for `api` and `service` types): Delegate to Task(architect) for:
   - Interface/contract definition
   - Data model design
   - Error handling strategy
6. **Implement**: Execute plan phase by phase:
   - Write tests first if `--tdd` (delegate to Task(tdd-guide))
   - Create/modify files following plan
   - Use framework conventions and existing patterns
   - Re-read EVERY modified file to verify changes are correct
7. **Test**: Run tests, verify coverage >= 80%
8. **Review**: Delegate to Task(code-reviewer) for:
   - CRITICAL/HIGH issue detection
   - Pattern consistency check
   - Security scan
9. **Verify Completion**: Check EVERY requirement from step 1. Evidence required per item.
10. **Report**: Output implementation summary with completion checklist

## Quality Rules (MANDATORY)

- **Read-First**: ALWAYS read a file before modifying it. No blind writes.
- **Verify-After**: Re-read modified files to confirm changes are correct.
- **Zero-Skip**: Every requirement from decomposition MUST be addressed. No silent drops.
- **Evidence-Based**: Completion claims require file paths, line numbers, or test results.
- **Ask-When-Unclear**: If any requirement is ambiguous, ask the user BEFORE implementing.

### Effort & Task Budget (Opus 4.8 native)
Opus 4.8은 effort를 네이티브 레벨(**max / xhigh / high / medium / low**, 기본 high, 베타 헤더 불필요)로 노출한다. 구현 작업은 **xhigh**가 기본 권장값이며 호출 측은 `output_config.effort`로 직접 지정한다.

```json
{
  "output_config": { "effort": "xhigh" }
}
```

작업 예산(task budget)은 에이전트 무한 루프를 방지하기 위해 구현 작업 전체에 부여하는 옵트인 권고치다. 베타 헤더 `task-budgets-2026-03-13` 필요. 기본 **64,000** 토큰, 대형 리팩토링은 **128,000**, 최소값은 **20,000** (20k 미만 설정 불가). 개방형 탐색에는 설정 금지 (작업 거부 유발 가능).

```json
{
  "headers": { "anthropic-beta": "task-budgets-2026-03-13" },
  "output_config": { "task_budget": { "type": "tokens", "total": 64000 } }
}
```

## Pipeline by Type

| Type | Pipeline |
|------|----------|
| component | planner -> implement -> accessibility check -> code-reviewer |
| api | planner -> architect -> implement -> tdd-guide -> security check |
| service | planner -> architect -> implement -> tdd-guide -> code-reviewer |
| feature | planner -> implement -> tdd-guide -> code-reviewer |

## Output Format

Use GFM markdown tables:

**Summary**

| 항목 | 값 |
|------|-----|
| Feature | [description] |
| Type | [component/api/service/feature] |
| Framework | [detected] |
| Files | created: n, modified: n |

**Pipeline Status**

| Phase | Status | Details |
|-------|--------|---------|
| Plan | DONE | [summary] |
| Design | DONE/SKIPPED | [summary] |
| Implement | DONE | [files changed] |
| Test | PASS/FAIL | coverage: n% |
| Review | PASS/n issues | [summary] |

**Artifacts**

| File | Action |
|------|--------|
| [file path] | created/modified |

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 테스트 작성 | `/tdd` | 구현 코드 테스트 작성 |
| 2 | 코드 리뷰 | `/code-review` | 구현 결과 코드 리뷰 |
| 3 | 전체 검증 | `/verify` | lint → typecheck → test 검증 |
| 4 | 커밋 | `/git` | 구현 완료 후 커밋 및 푸시 |
