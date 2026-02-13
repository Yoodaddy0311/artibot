---
description: Feature implementation with planner/tdd-guide/code-reviewer pipeline
argument-hint: [feature] [--type component|api|service|feature]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Task, TodoWrite]
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

1. **Parse**: Extract feature requirements, detect type and framework
2. **Plan**: Delegate to Task(planner) for implementation breakdown:
   - File list (create/modify)
   - Dependency identification
   - Risk assessment
   - Phase ordering
3. **Design** (for `api` and `service` types): Delegate to Task(architect) for:
   - Interface/contract definition
   - Data model design
   - Error handling strategy
4. **Implement**: Execute plan phase by phase:
   - Write tests first if `--tdd` (delegate to Task(tdd-guide))
   - Create/modify files following plan
   - Use framework conventions and existing patterns
5. **Test**: Run tests, verify coverage >= 80%
6. **Review**: Delegate to Task(code-reviewer) for:
   - CRITICAL/HIGH issue detection
   - Pattern consistency check
   - Security scan
7. **Report**: Output implementation summary

## Pipeline by Type

| Type | Pipeline |
|------|----------|
| component | planner -> implement -> accessibility check -> code-reviewer |
| api | planner -> architect -> implement -> tdd-guide -> security check |
| service | planner -> architect -> implement -> tdd-guide -> code-reviewer |
| feature | planner -> implement -> tdd-guide -> code-reviewer |

## Output Format

```
IMPLEMENTATION SUMMARY
======================
Feature:    [description]
Type:       [component|api|service|feature]
Framework:  [detected]
Files:      [created: n, modified: n]

PIPELINE STATUS
---------------
Plan .............. [DONE]
Design ............ [DONE|SKIPPED]
Implement ......... [DONE]
Test .............. [PASS|FAIL] (coverage: n%)
Review ............ [PASS|n issues]

ARTIFACTS
---------
- [file path] ([created|modified])
```
