---
description: (Artibot) Git workflow assistant with commit conventions, PR creation, branch management, worktree automation, and beginner-friendly collaboration tools
argument-hint: '[operation] e.g. "커밋 후 PR 생성", "worktree create feat/login", "guide pull"'
allowed-tools: [Read, Bash, Glob, Grep, TaskCreate]
---

# /git

Git workflow management enforcing conventional commits, branch naming, and PR best practices.

## Arguments

Parse $ARGUMENTS:
- `operation`: `commit` | `pr` | `branch` | `status` | `log` | `diff` | `release` | `autopilot` | `guide` | `conflict` | `strategy` | `collab` | `safe` | `sync` | `worktree`
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

### autopilot
**Activate skill**: `git-autopilot`
Smart Git automation that handles pull/commit/push cycles with safety checks.
- Auto-detect dirty state and suggest commit or stash
- Pre-push validation (secrets scan, lint, test)
- WIP branch auto-commit on timer (opt-in)
- Beginner-friendly messages (no Git jargon)

**Flags:**
- `--on`: Enable autopilot mode for current session
- `--off`: Disable autopilot mode
- `--interval [seconds]`: WIP auto-commit interval (default: 300)

### guide
**Activate skill**: `git-guide`
Interactive Git learning assistant for beginners.
- Explain Git concepts in plain language (Korean/English)
- Step-by-step walkthroughs for common tasks (pull, push, branch, merge)
- Context-aware suggestions based on current repo state
- "What should I do?" mode — analyzes situation and recommends action

**Usage:**
```bash
/git guide pull          # "pull이 뭔가요?" + 현재 상태 기반 가이드
/git guide branch        # 브랜치 개념 설명 + 생성 방법
/git guide conflict      # 충돌 개념 설명 + 현재 충돌 해결 가이드
/git guide "뭘 해야 하지?"  # 현재 상태 분석 후 추천
```

### conflict
**Activate skill**: `git-conflict`
AI-powered merge conflict detection and resolution.
- Pre-merge conflict prediction using `git merge-tree` (dry-run, no side effects)
- AI conflict resolution: send both diffs + merge base to Claude for resolution
- Show diff of AI resolution for user approval before applying
- Never auto-apply without user confirmation

**Usage:**
```bash
/git conflict check              # 현재 브랜치와 main 간 충돌 예측
/git conflict check feat/login   # 특정 브랜치 간 충돌 예측
/git conflict resolve            # 현재 충돌을 AI로 해결 시도
/git conflict matrix             # 모든 워크트리 쌍의 충돌 매트릭스
```

### strategy
**Activate skill**: `git-strategy`
Branch strategy advisor and enforcement.
- Recommend branch strategy based on team size and project type
- Enforce naming conventions (feat/*, fix/*, release/*)
- Suggest merge strategy (squash, rebase, merge commit)
- PR workflow templates

### collab
**Activate skill**: `git-collab`
Team collaboration assistant for Git beginners.
- "Someone pushed changes" — guide through pull + rebase/merge
- "I need to share my work" — guide through commit + push
- "We're both editing the same file" — conflict prevention advice
- Multi-contributor workflow visualization

### safe
**Activate skill**: `git-safe`
Safety-first Git operations with undo guidance.
- Wrap dangerous operations (reset, force-push, rebase) with confirmation
- Always show "how to undo" after each operation
- Backup current state before destructive operations
- Block force-push to main/master by default

### sync
**Activate skill**: `git-sync`
Smart synchronization with remote repositories.
- Auto-detect upstream changes and suggest pull
- Handle diverged branches with guided rebase or merge
- Stale branch detection and cleanup suggestions
- Fork sync support (upstream → origin)

### worktree
**Activate skill**: `git-worktree`
Git worktree lifecycle management (Git-Zero workspace abstraction).

**Sub-operations:**
- `create [branch]`: Create worktree + branch in one step
  - Auto-prefix with `feat/` or `fix/` if bare name given
  - Directory naming: `../{project}-{branch-name}`
  - Copy shared configs (.env, etc.) via post-create hook
- `list`: Dashboard of all active worktrees with status, dirty files, last commit
- `check`: Conflict prediction across all worktree pairs using `git merge-tree`
  - Display conflict matrix with file-level detail
  - Recommend merge order to minimize conflicts
- `merge [target]`: Squash-merge current worktree branch into target (default: main)
  - 6-phase workflow: Validate → Research → Prep → Merge → Commit → Verify
  - AI-generated commit message from full diff analysis
  - Conflict detection before merge, stop and report if conflicts found
- `clean`: Detect and remove merged/stale worktrees
  - Only suggest deletion for branches merged into main
  - Never delete dirty worktrees (uncommitted changes warning)
  - Always require user confirmation

**Usage:**
```bash
/git worktree create login-page      # ../project-feat-login-page 생성
/git worktree list                   # 모든 워크트리 상태 대시보드
/git worktree check                  # 워크트리 간 충돌 예측 매트릭스
/git worktree merge                  # 현재 워크트리 → main squash-merge
/git worktree merge develop          # 현재 워크트리 → develop squash-merge
/git worktree clean                  # 머지 완료된 워크트리 정리
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
Operation:  [commit|pr|branch|status|autopilot|guide|conflict|strategy|collab|safe|sync|worktree]
Branch:     [current branch]
Status:     [SUCCESS|BLOCKED]

DETAILS
-------
[operation-specific output]

WARNINGS (if any)
-----------------
[security findings, convention violations]
```

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 푸시 전 검증 | `/verify` | 커밋 전 전체 검증 파이프라인 |
| 2 | 작업 리포트 | `/daily` | 일일 작업 회고 리포트 |
| 3 | 작업 상태 업데이트 | `/task` | 커밋 관련 작업 상태 갱신 |
| 4 | Git 가이드 | `/git guide` | Git 개념 설명 + 상황별 가이드 |
| 5 | 충돌 예측 | `/git conflict check` | 머지 전 충돌 미리 확인 |
| 6 | 워크트리 생성 | `/git worktree create` | 별도 작업 공간 생성 |
| 7 | 안전 모드 | `/git safe` | 되돌리기 가이드 포함 안전 Git 작업 |
