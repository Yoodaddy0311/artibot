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

**Commit Format**: `type(scope): subject` (see `${CLAUDE_SKILL_DIR}/references/commit-conventions.md`)

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

### Checkpoint 1: 커밋 메시지 승인 (After Step 2)
**Context**: 변경사항에 대한 커밋 메시지가 작성된 시점. 컨벤션을 따르지 않는 메시지는 git 히스토리 가독성을 해치고 자동화 도구와 호환성 문제를 일으킨다.
**Ask**: "커밋 메시지 `**[type(scope): subject]**` 가 컨벤션을 따르고 있나요?"
**Options**:
1. Approve — 메시지를 승인하고 커밋 진행
2. Rewrite message — 메시지를 수정 후 재확인
**Default**: 1 (컨벤션 체크 후 승인)
**Skippable**: No — 잘못된 커밋 메시지는 이후 수정이 어렵고 히스토리를 오염
**Freedom**: MEDIUM

### Checkpoint 2: 스테이징 변경사항 확인 (After Step 3)
**Context**: `git diff --staged` 실행 후 커밋 직전 시점. 의도하지 않은 파일이나 변경사항이 포함되어 있으면 즉시 수정해야 한다.
**Ask**: "스테이징된 변경사항이 **의도한 내용과 일치**하나요? 지금 커밋할까요?"
**Options**:
1. Commit — 변경사항이 정확함, 커밋 실행
2. Unstage and revise — 일부 파일을 unstage하거나 내용 수정 필요
**Default**: 1 (diff 검토 후 이상 없으면 커밋)
**Skippable**: No — diff 검토 없는 커밋은 의도치 않은 변경사항 포함 위험
**Freedom**: LOW

### Checkpoint 3: PR 설명 승인 (After Step 5)
**Context**: PR summary와 test plan이 작성된 시점. PR 설명은 리뷰어가 변경사항을 이해하는 주요 수단이므로 정확성과 완성도가 중요하다.
**Ask**: "PR 설명이 **변경사항을 정확하게 요약**하고 테스트 계획을 포함하고 있나요?"
**Options**:
1. Submit PR — 설명이 충분함, PR 제출
2. Edit description — 설명 내용을 수정 후 제출
**Default**: 1 (요약과 테스트 플랜이 포함된 경우 제출)
**Skippable**: No — 불완전한 PR 설명은 리뷰 품질과 속도에 영향
**Freedom**: MEDIUM

### Checkpoint 4: 머지 최종 승인 (After Step 7)
**Context**: 리뷰 피드백이 반영되고 squash-merge 직전 시점. 머지는 되돌리기 어렵고 메인 브랜치에 직접 영향을 미치므로 최종 확인이 필요하다.
**Ask**: "리뷰 피드백이 모두 반영되었나요? **메인 브랜치에 머지**를 진행할까요?"
**Options**:
1. Merge — 준비 완료, squash-merge 실행
2. Request more changes — 추가 수정이 필요, 머지 보류
**Default**: 1 (모든 리뷰 코멘트 해결 후 머지)
**Skippable**: No — 미완료 피드백 상태에서의 머지는 코드 품질 저하
**Freedom**: LOW

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
- Commit conventions: `${CLAUDE_SKILL_DIR}/references/commit-conventions.md`
- Always `git diff --staged` before commit
- New commits over amending when hooks fail
- PR body: Summary (bullets) + Test Plan (checklist)
