---
description: (Artibot) Git workflow assistant with commit conventions, PR creation, and branch management
argument-hint: '[operation] e.g. "커밋 후 PR 생성"'
allowed-tools: [Read, Bash, Glob, Grep, TaskCreate]
---

# /git

Git workflow management enforcing conventional commits, branch naming, and PR best practices.

## Arguments

Parse $ARGUMENTS:
- `operation`: `commit` | `pr` | `branch` | `status` | `log` | `diff` | `release`
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

### release
**Automated release workflow** -- version bump + README update + MEMORY.md update + commit + push + tag + GitHub Release in one step.

**Steps executed automatically:**
1. **Analyze changes**: `git diff --stat` + `git status` to understand all modifications
2. **Version bump**: Increment version in `package.json`, `artibot.config.json`, `plugin.json`
   - Default: patch bump (1.6.0 → 1.6.1)
   - `--minor`: minor bump (1.6.0 → 1.7.0)
   - `--major`: major bump (1.6.0 → 2.0.0)
   - `--version [x.y.z]`: explicit version
3. **README update**: Update badges (version, test count, coverage), feature list, agent tables, file counts, version line
4. **MEMORY.md update**: Update project structure, version, sprint info, file counts
5. **Commit**: Stage all changes, generate conventional commit message based on diff analysis
6. **Push**: `git push origin [current-branch]`
7. **Tag**: `git tag v[version]` + `git push origin v[version]`
8. **GitHub Release**: `gh release create v[version]` with auto-generated release notes from commit history

**Flags:**
- `--minor`: Minor version bump (default)
- `--major`: Major version bump
- `--patch`: Patch version bump
- `--version [x.y.z]`: Set explicit version
- `--dry-run`: Show plan without executing
- `--no-push`: Commit only, skip push/tag/release
- `--no-release`: Push but skip tag and GitHub Release

**Example:**
```bash
/git release --minor          # 1.6.0 → 1.7.0, update READMEs, commit, push, tag, release
/git release --version 2.0.0  # explicit version
/git release --dry-run        # preview only
/git release --no-release     # commit+push only, no tag/release
```

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
