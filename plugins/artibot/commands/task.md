---
description: (Artibot) Task management with creation, assignment, tracking, and completion
argument-hint: '[op] e.g. "할 일 목록 생성 및 추적"'
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, TaskCreate]
toolset: team
---

# /task

Structured task management using TaskCreate. Create, track, update, and complete tasks within the current session.

## Arguments

Parse $ARGUMENTS:
- `operation`: `create` | `list` | `update` | `complete` | `block` | `clear`
- `task-description`: Task content (for `create` and `update`)
- `--priority [level]`: `high` | `medium` | `low`
- `--id [n]`: Task ID for update/complete/block operations
- `--assign [agent]`: Assign task to specific agent type
- `--depends [id]`: Set dependency on another task

## Operations

### create
Create new task(s) from description. Auto-decomposes complex tasks into subtasks (3-7 items).

### list
Display all tasks with current status. Group by state: in_progress -> pending -> blocked -> completed.

### update
Modify task description, priority, or assignment. Requires `--id`.

### complete
Mark task as completed. Validates completion criteria before marking. Requires `--id`.

### block
Mark task as blocked with reason. Requires `--id`.

### clear
Remove all completed tasks from the list.

## Execution Flow

1. **Parse**: Identify operation and extract parameters
2. **Context**: TodoRead to get current task state
3. **Execute**:
   - `create`: Decompose into atomic tasks, assign priorities, write with TaskCreate
   - `list`: Read and format current tasks by status
   - `update`: Modify specified task, re-validate dependencies
   - `complete`: Verify task output, mark done, check if unblocks other tasks
   - `block`: Mark blocked, identify dependent tasks affected
   - `clear`: Remove completed tasks, compact list
4. **Verify**: Ensure single task in_progress at a time. Validate no circular dependencies
5. **Report**: Output updated task board

## Output Format

```
TASK BOARD
==========
Active:    [count]
Pending:   [count]
Blocked:   [count]
Done:      [count]

IN PROGRESS
  [id] [description] (priority: [level])

PENDING
  [id] [description] (depends: [id|none])

BLOCKED
  [id] [description] (reason: [why])
```

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 작업 실행 | `/implement` | 등록된 작업 구현 시작 |
| 2 | 진행 리포트 | `/daily` | 작업 진행 현황 리포트 |
| 3 | 완료 커밋 | `/git` | 완료된 작업 커밋 및 푸시 |
