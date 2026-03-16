---
description: (Artibot) Create state checkpoint snapshots saved to auto memory
argument-hint: '[label] e.g. "리팩토링 전 스냅샷"'
allowed-tools: [Read, Write, Bash, Glob, Grep, TaskCreate]
---

# /checkpoint

Create snapshots of current project state for recovery and context preservation across sessions. Saves to auto memory directory.

## Arguments

Parse $ARGUMENTS:
- `label`: Descriptive name for the checkpoint (e.g., "pre-refactor", "auth-complete")
- `--include-diff`: Include git diff in checkpoint
- `--restore [label]`: View a previous checkpoint to restore context
- `--list`: List all saved checkpoints
- `--prune [days]`: Remove checkpoints older than N days

## Execution Flow

1. **Parse**: Extract label, determine operation mode
2. **Capture State**:
   - Current branch and commit hash
   - Modified/staged/untracked files list
   - Active TaskCreate tasks and their status
   - Key metrics: test count, lint errors, build status
   - Git diff summary (if `--include-diff`)
3. **Save**: Write checkpoint to auto memory:
   - Path: `~/.claude/projects/<project>/memory/checkpoints/<timestamp>-<label>.md`
   - Format: Structured markdown with all captured state
4. **Verify**: Confirm checkpoint file written, display summary
5. **Report**: Output checkpoint confirmation with restore instructions

## Checkpoint Content

```markdown
# Checkpoint: [label]
Date: [timestamp]
Branch: [branch] @ [commit-hash]

## File State
Modified: [list]
Staged: [list]
Untracked: [list]

## Task State
[TaskCreate task snapshot]

## Metrics
Tests: [pass/total]
Lint: [errors/warnings]
Build: [status]

## Diff Summary (if --include-diff)
[condensed git diff]

## Notes
[auto-generated context about what was in progress]
```

## Operations

### Create (default)
Save current state with provided label.

### Restore (`--restore`)
Read checkpoint file, display state for context recovery. Does NOT modify files - provides information for manual restoration.

### List (`--list`)
Show all checkpoints with dates and labels.

### Prune (`--prune`)
Remove old checkpoints to manage storage.

## Worklog Integration

When creating a checkpoint, also append a summary entry to `memory/worklog.md`:
1. Read current worklog.md
2. If line count > 190, remove oldest entry (between first `---` and second `---`)
3. Append new entry in worklog format (작업/결정/보류)
4. This ensures both detailed checkpoint AND lightweight worklog exist

## Output Format

```
CHECKPOINT
==========
Label:    [name]
Time:     [timestamp]
Branch:   [branch] @ [short-hash]
Files:    [modified: n, staged: n, untracked: n]
Tasks:    [active: n, completed: n]
Saved to: [file path]
Worklog:  [appended to memory/worklog.md]
```

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 일일 리포트 | `/daily` | 체크포인트 포함 일일 회고 |
| 2 | 작업 관리 | `/task` | 체크포인트 기반 작업 정리 |
| 3 | 커밋 | `/git` | 체크포인트 시점 변경사항 커밋 |
