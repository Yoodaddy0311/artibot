---
description: Multi-agent task orchestration with parallel and sequential coordination using Agent Teams
argument-hint: '[task] e.g. "병렬로 분석+테스트 실행"'
allowed-tools: [Read, Glob, Grep, Bash, TeamCreate, SendMessage, TaskCreate, TaskUpdate, TaskList, TaskGet, Task, TeamDelete]
---

# /spawn

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
# Teammates self-claim via TaskList -> TaskUpdate(owner)
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
SendMessage(type="message", recipient="tester", content="{lint results and context}")
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
3. **Create Team**: Initialize the spawn team:
   ```
   TeamCreate(
     team_name="spawn-{task-slug}",
     description="Spawn orchestration: {task description}"
   )
   ```
4. **Spawn Teammates**: Launch specialist agents:
   ```
   Task(subagent_type, team_name="spawn-{task-slug}", name="{role-name}")
   ```
   - Spawn up to `--agents` teammates (default 3, max 7)
   - Each teammate is a specialist matched to the strategy
5. **Create Work Tasks**: Build the task graph:
   - One `TaskCreate` per work unit with clear scope, objectives, and success criteria
   - Set dependencies via `TaskUpdate(taskId, addBlockedBy=[...])` based on execution mode
   - Parallel: no dependencies between peer tasks
   - Sequential: linear chain of blockedBy
   - Pipeline: chain + SendMessage for output forwarding
6. **Monitor Execution**: Track progress and handle failures:
   - Poll `TaskList` to monitor task statuses
   - Use `TaskGet(taskId)` for detailed status on specific tasks
   - Handle failures: reassign tasks or spawn replacement teammates
   - Use `SendMessage` to coordinate, redirect, or provide additional context
7. **Aggregate Results**: Combine all teammate outputs:
   - Collect findings via `SendMessage(type="message")` from each teammate
   - Merge results by priority and severity
   - Resolve conflicts between teammate recommendations
8. **Shutdown and Cleanup**: Gracefully end the team:
   ```
   SendMessage(type="shutdown_request", recipient="{teammate}")
   ```
   - Send shutdown requests to all teammates
   - Wait for confirmations
   - `TeamDelete` to clean up the team
9. **Report**: Output orchestration summary with team lifecycle metrics

## Agent Assignment

| Domain | Teammate Spawn | Focus |
|--------|----------------|-------|
| Security | `Task(security-reviewer, team_name="spawn-*", name="security")` | Vulnerabilities, compliance |
| Performance | `Task(performance-engineer, team_name="spawn-*", name="perf-analyst")` | Bottlenecks, optimization |
| Quality | `Task(code-reviewer, team_name="spawn-*", name="quality")` | Code quality, patterns |
| Architecture | `Task(architect, team_name="spawn-*", name="architect")` | Structure, design |
| Testing | `Task(tdd-guide, team_name="spawn-*", name="tester")` | Coverage, test quality |
| Frontend | `Task(frontend-developer, team_name="spawn-*", name="frontend-dev")` | UI, accessibility |
| Backend | `Task(backend-developer, team_name="spawn-*", name="backend-dev")` | API, data, reliability |

## Output Format

```
ORCHESTRATION SUMMARY
=====================
Task:     {description}
Mode:     {parallel|sequential|pipeline}
Strategy: {by-directory|by-domain|by-task|auto}
Team:     {team-name}

TEAM LIFECYCLE
--------------
Created:    {timestamp}
Teammates:  {n} spawned
  - {name} ({subagent_type}) ... {ACTIVE|SHUTDOWN}
  - {name} ({subagent_type}) ... {ACTIVE|SHUTDOWN}

EXECUTION
---------
Task #{id}: {subject} -> {teammate}
  Status: {DONE|FAIL}
  Key findings: {summary}

Task #{id}: {subject} -> {teammate}
  Status: {DONE|FAIL}
  Key findings: {summary}

AGGREGATED RESULTS
------------------
{Combined findings, prioritized by severity}

TEAM METRICS
------------
Teammates Spawned:   {n}
Messages Exchanged:  {n}
Tasks Created:       {n}
Tasks Completed:     {n}
Tasks Failed:        {n}
Shutdowns Confirmed: {n}/{n}

ACTIONS TAKEN
-------------
- {action description}
```
