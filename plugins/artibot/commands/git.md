---
description: Git workflow assistant with commit conventions, PR creation, and branch management
argument-hint: '[operation] e.g. "커밋 후 PR 생성"'
allowed-tools: [Read, Bash, Glob, Grep, TaskCreate]
---

# /git

Git workflow management enforcing conventional commits, branch naming, and PR best practices.

## Arguments

Parse $ARGUMENTS:
- `operation`: `commit` | `pr` | `branch` | `status` | `log` | `diff`
- `--type [kind]`: Commit type - `feat` | `fix` | `refactor` | `docs` | `test` | `chore` | `perf` | `ci`
- `--scope [module]`: Commit scope (e.g., `auth`, `ui`, `api`)
- `--message [text]`: Commit message body (auto-generated if omitted)
- `--base [branch]`: Base branch for PR creation (default: `main`)

## Operations

### commit
Stage changes, generate conventional commit message, create commit.
- Auto-detect type from changed files if `--type` not specified
- Enforce format: `<type>(<scope>): <description>`
- Scan for secrets before committing (.env, API keys, tokens)
- Never auto-commit without user confirmation

### pr
Create pull request with structured description.
- Analyze full commit history from base branch
- Generate summary from all commits (not just latest)
- Include test plan with TODOs
- Push with `-u` if needed

### branch
Create or switch branches following naming convention: `<type>/<description>`.

### status
Show working tree status with staged/unstaged/untracked summary.

### log
Show recent commit history with conventional commit formatting.

### diff
Show changes with context-aware summary.

## Execution Flow

1. **Parse**: Identify operation and parameters
2. **Validate**: Check git repo state, verify clean/dirty status as appropriate
3. **Execute**: Run operation with convention enforcement
4. **Security Check**: Scan staged files for secrets, credentials, .env files
5. **Report**: Output operation result

## Commit Convention

```
<type>(<scope>): <imperative-description>

[optional body - what and why, not how]

[optional footer - BREAKING CHANGE, references]
```

## Output Format

```
GIT OPERATION
=============
Operation:  [commit|pr|branch|status]
Branch:     [current branch]
Status:     [SUCCESS|BLOCKED]

DETAILS
-------
[operation-specific output]

WARNINGS (if any)
-----------------
[security findings, convention violations]
```
