---
description: (Artibot) Feature implementation with planner/tdd-guide/code-reviewer pipeline
argument-hint: '[feature] e.g. "로그인 기능 구현"'
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, TaskCreate]
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

## Phase 0: Pre-Implementation Validation

Before writing a single line of code, verify three things (use Grep/Read — no guessing from memory):

1. **Exists?** Search the codebase for a similar function, component, or module that already satisfies the request. If found, prefer reuse or extension over new code.
2. **In scope?** Confirm the feature is explicitly requested. Do not add helper utilities, extra options, or "nice-to-have" abstractions that were not asked for.
3. **Minimal design?** Identify the most compact implementation path that meets the requirement. Choose the simplest data structure and fewest new files.

> Cross-ref: this gate is the implementation-time application of the `problem-validation` skill (single source of truth for the 4-check validation framework). If Phase 0 reveals no new code is needed, report that as the outcome — do not implement anyway.

## Execution Flow

1. **Decompose**: Break user request into numbered atomic requirements. EVERY requirement MUST be tracked.
2. **Parse**: Extract feature requirements, detect type and framework
3. **Read Context**: Read ALL files that will be modified BEFORE making any changes. Understand existing patterns.
4. **Plan**: Delegate to Agent(planner) for implementation breakdown:
   - File list (create/modify)
   - Dependency identification
   - Risk assessment
   - Phase ordering
5. **Design** (for `api` and `service` types): Delegate to Agent(architect) for:
   - Interface/contract definition
   - Data model design
   - Error handling strategy
6. **Implement**: Execute plan phase by phase:
   - Write tests first if `--tdd` (delegate to Agent(tdd-guide))
   - Create/modify files following plan
   - Use framework conventions and existing patterns
   - Re-read EVERY modified file to verify changes are correct
7. **Test**: Run tests, verify coverage >= 80%
8. **Review**: Delegate to Agent(code-reviewer) for:
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

### Effort & Task Budget (현재 정책 티어 네이티브)
현재 정책 티어(model-policy 해석)는 effort를 네이티브 레벨(**max / xhigh / high / medium / low**, 베타 헤더 불필요)로 노출한다. API 기본값은 모델마다 다르다 — 공식 effort 문서(효력일 2026-10-07, 열람일 2026-10-12) 기준 Opus 5.5·Haiku 5.5 는 `medium`, 그 밖의 effort 지원 모델은 `high`. 구현 작업은 **xhigh**가 기본 권장값이다(`lib/cognitive/effort-policy.js` 의 `EFFORT_POLICY.implement` — 플러그인 정책값이지 공식 문서의 모델별 권고가 아니다).

이 커맨드는 Claude Code 안에서 돌고 플러그인에는 Messages API 호출자가 없다(`grep -rn output_config lib scripts` 가 `lib/cognitive/effort-policy.js` 의 주석 2줄만 찾는다 — 2026-10-12 측정). 그래서 effort 는 호출 측이 JSON 으로 지정하는 값이 아니라 호스트·세션이 정한다. 공식 Claude Code 문서(model-config 의 "Adjust effort level", 열람일 2026-10-12)의 결정 순서는 `CLAUDE_CODE_EFFORT_LEVEL` 환경변수·`--effort` 플래그·세션 안에서 effort 를 고르는 내장 명령 → 저장된 설정(`modelSettings`·`effortLevel`) → 모델 기본값이다. 플러그인은 `[artibot:effort level=… command=implement]` 프롬프트 디렉티브로 권장값을 알릴 뿐이고, 디렉티브는 권고 텍스트라 실제 effort 는 호스트가 적용한 값이다. `Agent(...)` 로 띄우는 하위 에이전트의 effort 에 대해, 호스트 changelog 2.1.292 에는 `Agent` 도구에 `effort` 파라미터를 추가했다는 항목이 있으나 모든 세션에 노출된다는 보장은 없다 — 사실 등급과 디렉티브 폴백은 `commands/team.md` 의 `### Effort & Task Budget` 가 정본이고, 이 문서는 그것을 따른다.

작업 예산(task budget)은 Messages API 의 베타 기능이다. 공식 task-budgets 문서(열람일 2026-10-12)는 "Task budgets are not supported on Claude Code or Cowork surfaces" 라고 적는다. 그래서 `/implement` 에는 API `task_budget` 을 지정하는 절차가 없다 — `[artibot:task-budget max_tokens=…]` 디렉티브는 프롬프트 텍스트 권고일 뿐 API 필드가 아니다(`lib/runtime/task-budget.js`). API 를 직접 호출하는 경우의 필드·베타 헤더·최소값은 공식 문서(https://platform.claude.com/docs/en/build-with-claude/task-budgets)를 보라.

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
