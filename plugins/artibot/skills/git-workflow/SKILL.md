---
context: forked
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

## Workflow Checklist

Copy this checklist and track progress:

```
Progress:
- [ ] Step 1: Create feature branch from main (feat/*, fix/*, etc.)
- [ ] Step 2: Make changes with conventional commits
- [ ] Step 3: Run `git diff --staged` before each commit
- [ ] Step 4: Push branch with `-u` flag
- [ ] Step 5: Create PR with summary + test plan
- [ ] Step 6: Address review feedback with new commits
- [ ] Step 7: Squash-merge after approval
```

## Human Checkpoints

| After Step | Checkpoint | Type | Options |
|-----------|-----------|------|---------|
| Step 2 | Commit message follows conventions? | Approval | Approve / Rewrite message |
| Step 3 | Staged changes look correct? | Go-No-Go | Commit / Unstage and revise |
| Step 5 | PR summary accurate and complete? | Approval | Submit PR / Edit description |
| Step 7 | Ready to merge? | Go-No-Go | Merge / Request more changes |

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Create branch | LOW | Naming convention must be followed exactly |
| Write commits | MEDIUM | Type and format strict, scope and body flexible |
| Review staged diff | LOW | Must review every time, no skipping |
| Push branch | LOW | Use -u flag, never force push to main |
| Create PR | MEDIUM | Format defined, content depth flexible |
| Address feedback | HIGH | Implementation approach is up to developer |
| Merge strategy | LOW | Squash-merge is the standard |

## Quick Reference
- Commit conventions: `references/commit-conventions.md`
- Always `git diff --staged` before commit
- New commits over amending when hooks fail
- PR body: Summary (bullets) + Test Plan (checklist)
