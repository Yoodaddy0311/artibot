---
description: Create state checkpoint snapshots saved to auto memory
argument-hint: '[label] e.g. "리팩토링 전 스냅샷"'
allowed-tools: [Read, Write, Bash, Glob, Grep, TodoWrite]
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
   - Active TodoWrite tasks and their status
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
[TodoWrite task snapshot]

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
```
