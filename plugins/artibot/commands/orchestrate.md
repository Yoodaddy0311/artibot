---
description: (Artibot) Multi-agent workflow orchestration for complex operations using Agent Teams
argument-hint: '[workflow] e.g. "기능 개발 파이프라인"'
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, SendMessage, TaskCreate, TaskUpdate, TaskList, TaskGet]
disable-model-invocation: true
toolset: team
---

# /orchestrate

> **vs /spawn**: `/orchestrate` runs **predefined workflow patterns** (feature, bugfix, refactor, security) with structured phases via `--pattern`. `/spawn` is **free-form meta-orchestration** for arbitrary task decomposition without a pattern template. **Pick rule:** known dev workflow with a named lifecycle → `/orchestrate`; ad-hoc multi-domain work that doesn't fit a template → `/spawn`. Both share the same Agent Teams primitives, so neither is an alias of the other.

> **vs /workflows — launcher ≠ monitor**: `/orchestrate` *starts* a run; it does not show status. It executes on **Agent Teams** (`toolset: team` → `Agent` spawns plus `SendMessage`), **not** the harness `Workflow` tool. Consequently the native **`/workflows`** command — which only *watches* already-running harness `Workflow`-tool runs — does **not** track `/orchestrate` runs. Follow an `/orchestrate` run's progress via its team tasks (`TaskList`/`TaskGet`, step 5). To start a **new** run while one is active, just invoke `/orchestrate` again — Agent Teams runs are independent and can run concurrently.

Coordinate multi-agent workflows for complex operations that span multiple domains. Creates an Agent Team, spawns specialized teammates, and sequences them through a defined pipeline using shared tasks and direct messaging for handoffs between phases.

## Arguments

Parse $ARGUMENTS:
- `workflow`: Task description or workflow name
- `--pattern [type]`: Predefined workflow pattern - `feature` | `bugfix` | `refactor` | `security`
- `--agents [list]`: Override agent selection (comma-separated)
- `--parallel`: Enable parallel agent execution where phases are independent
- `--dry-run`: Show execution plan without running agents

## Workflow Patterns

| Pattern | Pipeline | Teammates |
|---------|----------|-----------|
| feature | plan -> design -> implement -> review -> merge | planner, architect, backend-developer, code-reviewer |
| bugfix | analyze -> fix -> verify | analyzer, backend-developer, tdd-guide |
| refactor | assess -> refactor -> test -> review | code-reviewer, refactor-cleaner, tdd-guide |
| security | scan -> assess -> fix -> verify | security-reviewer, backend-developer, code-reviewer |

## Execution Flow

1. **Parse**: Extract workflow requirements, select or detect pattern
2. **Name the run**: There is no team to create. The session has one implicit
   team, so instead fix a run slug `orchestrate-{workflow-slug}-{sid}` and use it
   as the prefix of every teammate name below, which is what keeps one run's agents
   distinguishable from another's.
   `{sid}` is the session discriminator and may not be omitted: `{workflow-slug}`
   comes deterministically from the workflow text, so two sessions in the same repo
   given the same workflow would otherwise build the same names, and `SendMessage`
   resolves a same-name collision silently, so a cross-session message lands on
   the wrong teammate with no error. How to pick it is defined once, in
   `commands/team.md` Phase 2 (`#### {sid} — 세션 판별자`): the first 6 characters
   of the hook payload `session_id`, or the 6-character `[ref]` on your own
   `ListAgents` row. Keep it fixed for the whole run.
3. **Spawn Teammates**: Launch required agents for the pipeline:
   ```
   Agent(
     subagent_type="{type}",
     name="orchestrate-{workflow-slug}-{sid}-{role-name}",
     prompt="{role brief}\n\n{보고 주소}"
   )
   ```
   The name is what makes a teammate addressable by `SendMessage`, so spawn with
   one even when the role seems obvious. The `{보고 주소}` slot takes the report
   address block from `## Report Address` below, verbatim, in every spawn prompt.
   - Spawn all teammates needed for the pipeline pattern
   - Each teammate is a specialist agent activated via the Task tool
4. **Create Phase Tasks**: Build the pipeline as shared tasks:
   ```
   TaskCreate(subject="Phase: {phase-name}", description="{scope, objectives, success criteria}")
   ```
   - One task per pipeline phase
   - Set dependencies: `TaskUpdate(taskId, addBlockedBy=[previous-phase-id])` for sequential phases
   - Parallel-eligible phases share no blockedBy constraints
5. **Assign and Execute**: Drive the pipeline forward:
   - `TaskUpdate(taskId, owner="{teammate-name}", status="in_progress")` to assign phases
   - Teammates pick up tasks, execute, and mark completed
   - Use `TaskList` / `TaskGet` to monitor progress
6. **Coordinate via Messaging**: Manage inter-phase communication:
   ```
   SendMessage(to="{next-agent}", message="{handoff context}")
   ```
   - Pass findings, artifacts, and constraints between phases
   - Route implementation output to reviewers
   - Aggregate feedback at decision points
   - For critical team-wide updates only, send one `SendMessage(to="{teammate}")` per teammate (the tool has no broadcast)
7. **Quality Gates**: Validate final output before completion:
   - All tests passing
   - No CRITICAL/HIGH review findings
   - Coverage thresholds met
   - Security scan clean
8. **Shutdown and Cleanup**: Gracefully end the orchestration:
   ```
   SendMessage(to="{teammate}", message={type: "shutdown_request"})
   ```
   - Send shutdown requests to all teammates
   - Wait for shutdown confirmations
   - No teardown call follows. The team is implicit, so shutting down every
     teammate *is* the cleanup; there is nothing left to delete.
9. **Report**: Output orchestration summary with team metrics

## Report Address (MANDATORY)

Teammates run in the background, so plain-text output does not reach the leader
(`commands/team.md` `### 보고 계약` records 7 of 7 agents finishing in plain text on
2026-07-27 with nothing delivered). The handoffs below flow leader to teammate; the way back
(phase results, review findings) works only if every teammate is told where to send it. This
command is not a parity carrier of the full `[보고 계약]` block
(`tests/commands/report-contract-parity.test.js`), so it carries only that block's channel
clause, below.

`main` is the address of the main session that ran this command. Use a teammate's own name
instead only when that teammate is the one running `/orchestrate`. Never put a session name or
a run slug there: a message addressed to the main session by such a name is refused (measured
2026-09-22, recorded in `commands/team.md`).

```
[보고 주소]
- 보고는 반드시 SendMessage(to="main") 로 보낸다. 일반 텍스트 출력은 리더에게 전달되지 않는다.
- 보고가 5,000자를 넘으면 줄 경계에서 5,000자 이하 조각으로 나눠 여러 번 보낸다. 각 조각 첫 줄에 `chunk k/N` 을 적는다.
```

## Communication Protocol

Between each pipeline phase, the orchestrator sends a structured handoff message via SendMessage:

```
SendMessage(
  to="{next-phase-agent}",
  message="
    HANDOFF: {from-agent} -> {to-agent}
    ========================================
    Phase:     {completed phase name}
    Status:    {PASS|ISSUES_FOUND}
    Task ID:   {completed-task-id}

    CONTEXT
    -------
    {relevant findings, decisions, artifacts from previous phase}

    ARTIFACTS
    ---------
    - {file path} ({created|modified|reviewed})

    ACTION REQUIRED
    ---------------
    {specific instructions for the next agent phase}

    CONSTRAINTS
    -----------
    {any constraints or requirements from previous phases}
  ",
  summary="{phase} complete, handoff to {next-agent}"
)
```

## Agent Delegation

| Phase | Teammate Spawn | Purpose |
|-------|----------------|---------|
| Plan | `Agent(planner, name="orchestrate-{workflow-slug}-{sid}-planner")` | Implementation breakdown |
| Design | `Agent(architect, name="orchestrate-{workflow-slug}-{sid}-architect")` | System design decisions |
| Implement | `Agent(backend-developer, name="orchestrate-{workflow-slug}-{sid}-developer")` | Code creation/modification |
| Test | `Agent(tdd-guide, name="orchestrate-{workflow-slug}-{sid}-tester")` | Test writing and execution |
| Review | `Agent(code-reviewer, name="orchestrate-{workflow-slug}-{sid}-reviewer")` | Code quality validation |
| Security | `Agent(security-reviewer, name="orchestrate-{workflow-slug}-{sid}-security")` | Security assessment |
| Fix Build | `Agent(build-error-resolver, name="orchestrate-{workflow-slug}-{sid}-build-fixer")` | Build error resolution |
| E2E | `Agent(e2e-runner, name="orchestrate-{workflow-slug}-{sid}-e2e-runner")` | End-to-end testing |

## Output Format

Use GFM markdown tables:

**Summary**

| 항목 | 값 |
|------|-----|
| Workflow | {description} |
| Pattern | {feature/bugfix/refactor/security} |
| Team | {team-name} |
| Teammates | {list} |

**Pipeline Status**

| Phase | Status | Teammate | Task ID |
|-------|--------|----------|---------|
| {phase} | DONE/FAIL | {teammate} | #{id} |

**Quality Gates**

| Gate | Status |
|------|--------|
| Tests | PASS/FAIL |
| Review | APPROVE/REQUEST_CHANGES |
| Security | CLEAN/ISSUES_FOUND |
| Coverage | {n}% |

**Team Metrics**

| Metric | Value |
|--------|-------|
| Teammates Spawned | {n} |
| Messages Exchanged | {n} |
| Tasks Created | {n} |
| Tasks Completed | {n} |
| Tasks Failed | {n} |

**Artifacts**

| File | Action |
|------|--------|
| {file path} | {action} |

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 작업 추적 | `/task` | 오케스트레이션 작업 진행 추적 |
| 2 | 결과 검증 | `/verify` | 워크플로우 결과 검증 |
| 3 | 변경사항 커밋 | `/git` | 워크플로우 결과 커밋 |
