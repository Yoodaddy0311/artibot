---
description: Multi-agent workflow orchestration for complex operations using Agent Teams
argument-hint: [workflow] [--pattern feature|bugfix|refactor|security]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, TeamCreate, SendMessage, TaskCreate, TaskUpdate, TaskList, TaskGet, Task, TeamDelete]
---

# /orchestrate

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
2. **Create Team**: Initialize the orchestration team:
   ```
   TeamCreate(
     team_name="orchestrate-{workflow-slug}",
     description="Orchestration: {workflow description}"
   )
   ```
3. **Spawn Teammates**: Launch required agents for the pipeline:
   ```
   Task(subagent_type, team_name="orchestrate-{workflow-slug}", name="{role-name}")
   ```
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
   SendMessage(type="message", recipient="{next-agent}", content="{handoff context}")
   ```
   - Pass findings, artifacts, and constraints between phases
   - Route implementation output to reviewers
   - Aggregate feedback at decision points
   - Use `SendMessage(type="broadcast")` only for critical team-wide updates
7. **Quality Gates**: Validate final output before completion:
   - All tests passing
   - No CRITICAL/HIGH review findings
   - Coverage thresholds met
   - Security scan clean
8. **Shutdown and Cleanup**: Gracefully end the orchestration:
   ```
   SendMessage(type="shutdown_request", recipient="{teammate}")
   ```
   - Send shutdown requests to all teammates
   - Wait for shutdown confirmations
   - `TeamDelete` to clean up the team
9. **Report**: Output orchestration summary with team metrics

## Communication Protocol

Between each pipeline phase, the orchestrator sends a structured handoff message via SendMessage:

```
SendMessage(
  type="message",
  recipient="{next-phase-agent}",
  content="
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
| Plan | `Task(planner, team_name="orchestrate-*", name="planner")` | Implementation breakdown |
| Design | `Task(architect, team_name="orchestrate-*", name="architect")` | System design decisions |
| Implement | `Task(backend-developer, team_name="orchestrate-*", name="developer")` | Code creation/modification |
| Test | `Task(tdd-guide, team_name="orchestrate-*", name="tester")` | Test writing and execution |
| Review | `Task(code-reviewer, team_name="orchestrate-*", name="reviewer")` | Code quality validation |
| Security | `Task(security-reviewer, team_name="orchestrate-*", name="security")` | Security assessment |
| Fix Build | `Task(build-error-resolver, team_name="orchestrate-*", name="build-fixer")` | Build error resolution |
| E2E | `Task(e2e-runner, team_name="orchestrate-*", name="e2e-runner")` | End-to-end testing |

## Output Format

```
ORCHESTRATION SUMMARY
=====================
Workflow:   {description}
Pattern:    {feature|bugfix|refactor|security}
Team:       {team-name}
Teammates:  {list of spawned teammates}
Duration:   {total phases completed}

PIPELINE STATUS
---------------
{phase 1} .......... {DONE|FAIL} ({teammate})  [Task #{id}]
{phase 2} .......... {DONE|FAIL} ({teammate})  [Task #{id}]
{phase n} .......... {DONE|FAIL} ({teammate})  [Task #{id}]

QUALITY GATES
-------------
Tests:    {PASS|FAIL}
Review:   {APPROVE|REQUEST_CHANGES}
Security: {CLEAN|ISSUES_FOUND}
Coverage: {n}%

TEAM METRICS
------------
Teammates Spawned: {n}
Messages Exchanged: {n}
Tasks Created:      {n}
Tasks Completed:    {n}
Tasks Failed:       {n}

ARTIFACTS
---------
- {file path} ({action})
```
