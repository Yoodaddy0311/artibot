---
name: git-workflow
description: |
  Git workflow with conventional commits, branch strategy, and PR best practices.
  Auto-activates when: git operations, commit creation, branch management, PR workflows needed.
  Triggers: git, commit, branch, merge, PR, pull request, push, release, 커밋, 브랜치, 머지
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "git"
  - "commit"
  - "branch"
  - "PR"
  - "pull request"
  - "merge"
  - "rebase"
  - "workflow"
agents:
  - "devops-engineer"
  - "doc-updater"
tokens: "~3K"
category: "devops"
---
# Git Workflow

## When This Skill Applies
- Creating commits with conventional commit format
- Branch creation and management strategy
- Pull request creation and review workflow
- Release tagging and changelog generation

## Core Guidance

**Commit Format**: `type(scope): subject` (see `references/commit-conventions.md`)

**Types**: feat, fix, refactor, docs, test, chore, perf, ci, style

**Commit Rules**:
- Imperative mood, lowercase, no period, max 72 chars
- Body: explain "what" and "why", not "how"
- Reference issues: `Fixes #123`, `Closes #456`

**Branch Strategy**:
| Branch | Naming | Purpose |
|--------|--------|---------|
| main | Protected | Production-ready |
| feat/* | `feat/short-desc` | New features |
| fix/* | `fix/issue-desc` | Bug fixes |
| release/* | `release/v1.2.3` | Release prep |

**Safety Rules**:
- NEVER force push to main/master
- NEVER amend published commits
- ALWAYS create new branch for changes
- ALWAYS verify diff before push

**PR Workflow**: Create branch -> conventional commits -> push with `-u` -> PR with summary + test plan -> address feedback -> squash-merge

## Quick Reference
- Commit conventions: `references/commit-conventions.md`
- Always `git diff --staged` before commit
- New commits over amending when hooks fail
- PR body: Summary (bullets) + Test Plan (checklist)
