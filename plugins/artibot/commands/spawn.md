---
description: (Artibot) Multi-agent task orchestration with parallel and sequential coordination using Agent Teams
argument-hint: '[task] e.g. "병렬로 분석+테스트 실행"'
allowed-tools: [Read, Glob, Grep, Bash, Agent, SendMessage, TaskCreate, TaskUpdate, TaskList, TaskGet]
disable-model-invocation: true
toolset: team
---

# /spawn

> **vs /orchestrate**: `/spawn` is **free-form meta-orchestration** — decomposes arbitrary tasks into parallel/sequential/pipeline execution modes (no `--pattern`). `/orchestrate` runs **predefined workflow patterns** (feature, bugfix, refactor, security) with structured phases. **Pick rule:** known dev workflow with a named lifecycle → `/orchestrate`; ad-hoc multi-domain work that doesn't fit a template → `/spawn`. Both share the same Agent Teams primitives, so neither is an alias of the other.

Meta-orchestration command for complex multi-domain operations. Creates an Agent Team, decomposes work into shared tasks, and spawns specialized teammates that coordinate through task dependencies and direct messaging. Supports parallel, sequential, and pipeline execution modes mapped to task dependency graphs.

## Arguments

Parse $ARGUMENTS:
- `task-description`: High-level description of work to orchestrate
- `--mode [mode]`: `parallel` | `sequential` | `pipeline` (default: auto-detect)
- `--agents [n]`: Maximum concurrent teammates (default: 3, max: 7)
- `--strategy [type]`: `by-directory` | `by-domain` | `by-task` | `auto`
- `--dry-run`: Show orchestration plan without executing

## Execution Modes

| Mode | Task Dependency Pattern | Coordination |
|------|------------------------|-------------|
| parallel | All tasks created with no `blockedBy` - teammates self-claim available work | Teammates work simultaneously, results aggregated via SendMessage |
| sequential | Tasks chained: `TaskUpdate(taskId, addBlockedBy=[previous-id])` | Each task unblocks the next upon completion |
| pipeline | Tasks chained with output forwarding via SendMessage between phases | Teammate sends results to next teammate, who uses them as input |

### Mode Implementation

**Parallel**:
```
TaskCreate(subject="Analyze {module-A}", description="...")  # Task #1
TaskCreate(subject="Analyze {module-B}", description="...")  # Task #2
TaskCreate(subject="Analyze {module-C}", description="...")  # Task #3
# No blockedBy - all tasks available immediately
# Teammates self-claim via TaskList -> TaskUpdate(owner) when task tools are available;
# if they answer "disabled for this session", assign each task in the spawn prompt instead
```

**Sequential**:
```
TaskCreate(subject="Phase 1: Plan", description="...")       # Task #1
TaskCreate(subject="Phase 2: Implement", description="...")  # Task #2
TaskCreate(subject="Phase 3: Test", description="...")       # Task #3
TaskUpdate(taskId="2", addBlockedBy=["1"])
TaskUpdate(taskId="3", addBlockedBy=["2"])
```

**Pipeline**:
```
TaskCreate(subject="Stage 1: Lint", description="...")       # Task #1
TaskCreate(subject="Stage 2: Test", description="...")       # Task #2
TaskUpdate(taskId="2", addBlockedBy=["1"])
# When Stage 1 completes:
SendMessage(to="tester", message="{lint results and context}")
```

## Strategy Types

| Strategy | Split By | Team Structure |
|----------|---------|----------------|
| by-directory | Directory boundaries | One TaskCreate per directory scope, teammates assigned per package/module |
| by-domain | Expertise areas | One TaskCreate per domain (security, performance, quality), domain-specialist teammates |
| by-task | Operation type | One TaskCreate per operation stage (lint, test, build, deploy), pipeline teammates |
| auto | Complexity analysis | Orchestrator analyzes task shape and selects optimal strategy |

## Execution Flow

1. **Parse**: Extract task requirements and constraints from $ARGUMENTS
2. **Analyze**: Score complexity, identify domains, count affected files:
   - Determine optimal mode (parallel/sequential/pipeline)
   - Select strategy (by-directory/by-domain/by-task/auto)
   - Identify required specialist types
3. **Name the run**: There is no team to create. The session has one implicit
   team, so instead fix a run slug `spawn-{task-slug}-{sid}` and use it as the
   prefix of every teammate name below, which is what keeps one run's agents
   distinguishable from another's.
   `{sid}` is the session discriminator and may not be omitted: `{task-slug}`
   comes deterministically from the task text, so two sessions in the same repo
   given the same task would otherwise build the same names, and `SendMessage`
   resolves a same-name collision silently, so a cross-session message lands on
   the wrong teammate with no error. How to pick it is defined once, in
   `commands/team.md` Phase 2 (`#### {sid} — 세션 판별자`): the first 6 characters
   of the hook payload `session_id`, or the 6-character `[ref]` on your own
   `ListAgents` row. Keep it fixed for the whole run.
4. **Spawn Teammates**: Launch specialist agents:
   ```
   Agent(
     subagent_type="{type}",
     name="spawn-{task-slug}-{sid}-{role-name}",
     prompt="{role brief}\n\n{보고 주소}"
   )
   ```
   The name is what makes a teammate addressable by `SendMessage`, so spawn with
   one even when the role seems obvious. The `{보고 주소}` slot takes the report
   address block from `## Report Address` below, verbatim, in every spawn prompt.
   - Spawn up to `--agents` teammates (default 3, max 7)
   - Each teammate is a specialist matched to the strategy
5. **Create Work Tasks**: Build the task graph:
   - One `TaskCreate` per work unit with clear scope, objectives, and success criteria
   - Set dependencies via `TaskUpdate(taskId, addBlockedBy=[...])` based on execution mode
   - Parallel: no dependencies between peer tasks
   - Sequential: linear chain of blockedBy
   - Pipeline: chain + SendMessage for output forwarding
6. **Monitor Execution**: Track progress and handle failures:
   - Poll `TaskList` to monitor task statuses (if it answers "disabled for this session", track status from teammates' `SendMessage` reports instead)
   - Use `TaskGet(taskId)` for detailed status on specific tasks
   - Handle failures: reassign tasks or spawn replacement teammates
   - Use `SendMessage` to coordinate, redirect, or provide additional context
7. **Aggregate Results**: Combine all teammate outputs:
   - Collect findings via `SendMessage` from each teammate
   - Merge results by priority and severity
   - Resolve conflicts between teammate recommendations
8. **Shutdown and Cleanup**: Gracefully end the team:
   ```
   SendMessage(to="{teammate}", message={type: "shutdown_request"})
   ```
   - Send shutdown requests to all teammates
   - Wait for confirmations
   - No teardown call follows. The team is implicit, so shutting down every
     teammate *is* the cleanup; there is nothing left to delete.
9. **Report**: Output orchestration summary with team lifecycle metrics

## Report Address (MANDATORY)

Teammates run in the background, so plain-text output does not reach the leader
(`commands/team.md` `### 보고 계약` records 7 of 7 agents finishing in plain text on
2026-07-27 with nothing delivered). Step 7 collects findings via `SendMessage`, which only works
if every teammate is told where to send them. This command is not a parity carrier of the full
`[보고 계약]` block (`tests/commands/report-contract-parity.test.js`), so it carries only that
block's channel clause, below.

`main` is the address of the main session that ran this command. Use a teammate's own name
instead only when that teammate is the one running `/spawn`. Never put a session name or a run
slug there: a message addressed to the main session by such a name is refused (measured
2026-09-22, recorded in `commands/team.md`).

```
[보고 주소]
- 보고는 반드시 SendMessage(to="main") 로 보낸다. 일반 텍스트 출력은 리더에게 전달되지 않는다.
- 보고가 5,000자를 넘으면 줄 경계에서 5,000자 이하 조각으로 나눠 여러 번 보낸다. 각 조각 첫 줄에 `chunk k/N` 을 적는다.
```

## Agent Assignment

| Domain | Teammate Spawn | Focus |
|--------|----------------|-------|
| Security | `Agent(security-reviewer, name="spawn-{task-slug}-{sid}-security")` | Vulnerabilities, compliance |
| Performance | `Agent(performance-engineer, name="spawn-{task-slug}-{sid}-perf-analyst")` | Bottlenecks, optimization |
| Quality | `Agent(code-reviewer, name="spawn-{task-slug}-{sid}-quality")` | Code quality, patterns |
| Architecture | `Agent(architect, name="spawn-{task-slug}-{sid}-architect")` | Structure, design |
| Testing | `Agent(tdd-guide, name="spawn-{task-slug}-{sid}-tester")` | Coverage, test quality |
| Frontend | `Agent(frontend-developer, name="spawn-{task-slug}-{sid}-frontend-dev")` | UI, accessibility |
| Backend | `Agent(backend-developer, name="spawn-{task-slug}-{sid}-backend-dev")` | API, data, reliability |

## Output Format

Use GFM markdown tables:

**Summary**

| 항목 | 값 |
|------|-----|
| Task | {description} |
| Mode | {parallel/sequential/pipeline} |
| Strategy | {by-directory/by-domain/by-task/auto} |
| Team | {team-name} |

**Team Lifecycle**

| Teammate | Type | Status |
|----------|------|--------|
| {name} | {subagent_type} | ACTIVE/SHUTDOWN |

**Execution**

| Task ID | Subject | Teammate | Status | Key Findings |
|---------|---------|----------|--------|-------------|
| #{id} | {subject} | {teammate} | DONE/FAIL | {summary} |

**Aggregated Results**

{Combined findings, prioritized by severity}

**Team Metrics**

| Metric | Value |
|--------|-------|
| Teammates Spawned | {n} |
| Messages Exchanged | {n} |
| Tasks Created | {n} |
| Tasks Completed | {n} |
| Tasks Failed | {n} |
| Shutdowns Confirmed | {n}/{n} |

**Actions Taken**

| Action |
|--------|
| {action description} |

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 진행 추적 | `/task` | 스폰된 작업 진행 상태 추적 |
| 2 | 결과 검증 | `/verify` | 에이전트 작업 결과 검증 |
| 3 | 변경사항 커밋 | `/git` | 작업 결과 커밋 및 푸시 |
