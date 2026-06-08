---
context: fork
name: git-unified
description: |
  Git 통합 워크플로우 허브 — autopilot, collab (팀 온보딩), conflict (충돌 해결), guide (초보자 가이드), safe (안전망), strategy (브랜치 전략), sync (동기화), workflow (커밋·브랜치·PR), worktree (병렬 브랜치) 9개 서브툴을 통합.
  Auto-activates when: git, commit, branch, merge, PR, push, pull, rebase, release, conflict, stash, worktree, git flow, github flow, autopilot, 커밋, 브랜치, 머지, 충돌, 푸시, 동기화, 워크트리, git 자동화, 협업, 팀 온보딩 등 git 관련 작업이 감지될 때.
  Triggers: git, commit, branch, PR, pull request, merge, rebase, workflow, push, git sync, git pull, git push, 동기화, 최신 받기, 업데이트, worktree, 워크트리, git worktree, parallel branch, 병렬 작업, merge conflict, 충돌, CONFLICT, git conflict, 머지 충돌, rebase conflict, 충돌 해결, 브랜치 전략, git flow, github flow, trunk based, git strategy, 어떤 전략, 백업, 실험 전 저장, 되돌리기, git stash, 안전 저장, git safe, 작업 저장, git autopilot, 자동 커밋, autopilot on, autopilot off, autopilot status, 팀 온보딩, git 협업, 저장소 설정, 팀원 추가, collab setup, git 모르겠어, git 처음, git 어떻게, git 도움, git help, git 초보, how do I git, 커밋, 브랜치, 머지
lang: [en, ko]
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
  - "push"
  - "git sync"
  - "동기화"
  - "최신 받기"
  - "git pull"
  - "git push"
  - "업데이트"
  - "원격 동기화"
  - "sync branch"
  - "worktree"
  - "워크트리"
  - "git worktree"
  - "parallel branch"
  - "병렬 작업"
  - "여러 브랜치"
  - "workspace"
  - "merge conflict"
  - "충돌"
  - "CONFLICT"
  - "git conflict"
  - "머지 충돌"
  - "rebase conflict"
  - "충돌 해결"
  - "브랜치 전략"
  - "git flow"
  - "github flow"
  - "trunk based"
  - "git strategy"
  - "어떤 전략"
  - "브랜치 어떻게"
  - "백업"
  - "실험 전 저장"
  - "되돌리기"
  - "git stash"
  - "안전 저장"
  - "git safe"
  - "작업 저장"
  - "잃지 않게"
  - "git autopilot"
  - "git 자동화"
  - "자동 커밋"
  - "autopilot on"
  - "autopilot off"
  - "autopilot status"
  - "팀 온보딩"
  - "git 협업"
  - "저장소 설정"
  - "팀원 추가"
  - "collab setup"
  - "협업 git"
  - "팀 규칙"
  - "git 모르겠어"
  - "git 처음"
  - "git 어떻게"
  - "git 도움"
  - "git help"
  - "git 초보"
  - "how do I git"
  - "커밋"
  - "브랜치"
  - "머지"
agents:
  - "devops-engineer"
  - "doc-updater"
  - "architect"
argument-hint: "[operation] e.g., commit, branch, merge, PR, conflict, worktree, autopilot on, strategy, stash, help"
tokens: "~3K"
category: "workflow"
whenNotToUse: "Non-Git version control systems (SVN, Mercurial) or tasks with no repository context where Git workflow guidance is irrelevant."
level1_tokens: 200
level2_tokens: 1200
platforms: [claude-code, gemini-cli, codex-cli, cursor]
---

# Git Unified Workflow Hub

Git 관련 9개 서브툴을 통합한 엔트리포인트. 사용자 의도에 따라 해당 `references/*.md`로 위임.

## Current State
<!-- Dynamic context injected at activation -->
!`git status --short 2>/dev/null | head -10`
!`git log --oneline -5 2>/dev/null`
!`git branch --show-current 2>/dev/null`
!`git rev-list --left-right --count HEAD...@{upstream} 2>/dev/null`

## Contents
- [When This Skill Applies](#when-this-skill-applies)
- [Sub-Tool Routing](#sub-tool-routing)
- [Cross-Tool Safety Rules](#cross-tool-safety-rules-공통)

## When This Skill Applies

- 모든 Git 관련 작업: commit / branch / PR / merge / push / pull / rebase / release
- 충돌 해결, 브랜치 전략 선택, 팀 온보딩, 워크트리 관리
- 초보자 대화형 가이드, 자동화(autopilot), 안전망(stash/tag/bundle)

## Sub-Tool Routing

| 상황 / 의도 | 참조 |
|-------------|------|
| 커밋·브랜치·PR 기본 워크플로우 (conventional commits, squash-merge) | [references/workflow.md](references/workflow.md) |
| `/git autopilot on/off/status` — 자동 커밋·푸시 | [references/autopilot.md](references/autopilot.md) |
| 팀 신규 온보딩, CONTRIBUTING.md, PR 템플릿, 브랜치 보호 | [references/collab.md](references/collab.md) |
| 머지/리베이스 CONFLICT 마커 해결 (분류: duplicate/safe/manual) | [references/conflict.md](references/conflict.md) |
| "git 모르겠어요" — 초보자 대화형 가이드 | [references/guide.md](references/guide.md) |
| 실험 전 백업, stash/tag/bundle/revert — 안전망 | [references/safe.md](references/safe.md) |
| 팀 상황별 브랜치 전략 추천 (Trunk / GitHub Flow / Git Flow / GitLab Flow) | [references/strategy.md](references/strategy.md) |
| pull / push / rebase 동기화 자동화 (force-with-lease 포함) | [references/sync.md](references/sync.md) |
| `git worktree` 라이프사이클 (create / list / check / merge / clean) | [references/worktree.md](references/worktree.md) |

## Routing Rule

1. 사용자 발화 또는 현재 상태(위의 Current State 블록)에서 triggers 매칭.
2. 매칭 의도에 따라 1개의 sub-tool references 파일을 우선 로드.
3. 복합 작업(예: "충돌 해결 후 동기화")은 conflict → sync 순으로 체인.
4. 의도가 모호하면 `references/guide.md`로 라우팅(대화형 질문 플로우).

## Cross-Tool Safety Rules (공통)

모든 서브툴에 걸쳐 반드시 지켜야 할 규칙:

- **`main`/`master` 직접 force push 절대 금지**
- **`git push --force` (lease 없는) 안내 금지** — 항상 `--force-with-lease`
- **`git pull/merge -X theirs|ours`는 commit-level 전략** — 의도적 변경을 조용히 원복시킬 수 있음. 파일 단위 `git checkout --theirs/--ours <path>` 우선 사용 (2026-04-20 4.7 migration 사고 사례 참조 → `references/conflict.md`)
- **`.env`, `*.secret`, `*.key` 자동 푸시 금지** — autopilot excludePaths/sync pre-push 스캔으로 차단
- **`git reset --hard` 전 경고** — 데이터 손실 가능
- **대규모 작업(충돌 10+, 커밋 10+, 워크트리 삭제) 전 Human Checkpoint**
- **squash-merge 후 원본 브랜치 삭제는 사용자 명시 확인 후에만**

## Quick Reference

```bash
# 기본 워크플로우 (references/workflow.md)
git status && git diff --staged
git commit -m "feat(scope): description"
git push -u origin feat/branch-name

# 동기화 (references/sync.md)
git pull --rebase origin main
git push origin feat/x --force-with-lease

# 워크트리 (references/worktree.md)
/git worktree create feat/login
/git worktree list
/git worktree merge

# 충돌 해결 (references/conflict.md)
git diff --name-only --diff-filter=U

# 안전망 (references/safe.md)
git stash push -m "before-experiment"
git tag -a "v1.0-snapshot" -m "before refactor"

# Autopilot (references/autopilot.md)
/git autopilot on safe
/git autopilot status
```

## Rationalizations

공통 excuse → rebuttal (서브툴별 세부 rationalization은 각 references/*.md 참조):

| Excuse | Rebuttal |
|--------|----------|
| "git 스킬 여러 개를 따로 익혀야 하나?" | 이 허브가 9개 서브툴의 triggers/safety/checkpoints를 단일 엔트리포인트로 통합했으니 의도만 말하면 된다. |
| "머지 전략 하나로 통일하면 안 되나" | 프로젝트 규모·배포 주기가 다르면 trunk/github-flow/git-flow/gitlab-flow의 tradeoff가 다르다. strategy.md 참조. |
| "force push는 내 브랜치에서만 하니 괜찮다" | 팀원이 이미 pull 받았으면 force는 재앙이다. 항상 --force-with-lease. |
| "autopilot이 실수하면 어쩌지" | safe 모드는 커밋만, full 모드는 Human Checkpoint 거쳐 squash+push — 사용자 승인 없는 destructive 동작 없다. |
| "충돌은 손으로 풀어야 안전하다" | duplicate/safe_ours/safe_theirs 분류는 수학적으로 안전한 경우만 자동 해결 — manual 블록만 사용자 확인. |
