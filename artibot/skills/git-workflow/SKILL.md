---
name: git-workflow
description: |
  Git version control workflow and conventions. Commit message standards,
  branching strategy, PR creation, and conflict resolution.

  Use proactively when committing code, creating branches,
  opening pull requests, or resolving merge conflicts.

  Triggers: commit, push, pull request, merge, branch, rebase,
  conflict, git, version control, PR, changelog,
  커밋, 푸시, 풀리퀘스트, 병합, 브랜치,
  コミット, プッシュ, プルリクエスト, マージ

  Do NOT use for: code implementation, testing,
  or non-version-control tasks.
---

# Git Workflow

> Clean history. Meaningful commits. Safe operations.

## When This Skill Applies

- Committing changes
- Creating or managing branches
- Opening pull requests
- Resolving merge conflicts
- Reviewing commit history
- Tagging releases

## Commit Message Format

```
<type>: <description>

[optional body]
```

### Types

| Type | When | Example |
|------|------|---------|
| feat | New feature | `feat: add user search endpoint` |
| fix | Bug fix | `fix: prevent null pointer in auth middleware` |
| refactor | Code restructure (no behavior change) | `refactor: extract validation logic to shared module` |
| docs | Documentation only | `docs: update API reference for /users` |
| test | Test additions or fixes | `test: add edge cases for payment calculation` |
| chore | Build, tooling, config | `chore: update eslint config` |
| perf | Performance improvement | `perf: add database index for user lookup` |
| ci | CI/CD changes | `ci: add staging deploy step` |

### Rules
- Imperative mood ("add" not "added" or "adds")
- Lowercase first word after type
- No period at end of subject line
- Subject line under 72 characters
- Body explains what and why, not how

## Branch Strategy

```
main                    # Production-ready
  └── feat/feature-name # Feature branches
  └── fix/bug-name      # Bug fix branches
  └── refactor/scope    # Refactoring branches
```

### Rules
- Never push directly to main
- Branch from latest main
- Keep branches short-lived (<3 days ideal)
- Delete branch after merge

## Pull Request Workflow

1. Check all changes with `git diff main...HEAD`
2. Write clear title (<70 chars)
3. Include summary and test plan
4. Request review from relevant reviewer
5. Address feedback before merge
6. Squash merge for clean history

## Safety Rules

### NEVER
- Force push to main/master
- Use `git reset --hard` without confirming with user
- Skip pre-commit hooks (--no-verify)
- Commit secrets, .env files, or credentials
- Amend published commits

### ALWAYS
- Read git status before staging
- Review diff before committing
- Use specific file staging (not `git add -A`)
- Confirm destructive operations with user

## Conflict Resolution

1. Understand both sides of the conflict
2. Preserve the intent of both changes
3. Test the merged result
4. Never blindly accept "ours" or "theirs"

## References

- `references/commit-conventions.md` - Detailed commit message examples
