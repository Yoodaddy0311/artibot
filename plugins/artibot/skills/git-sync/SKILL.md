---
context: fork
disable-model-invocation: true
name: git-sync
description: |
  Git 동기화 자동화 — pull/push/rebase를 상황에 맞게 자동 실행. 충돌 감지 시 git-conflict 스킬로 위임.
  Auto-activates when: git 동기화, pull 해야 해, push 할게, 최신 받기, sync, 업데이트.
  Triggers: git sync, git pull, git push, 동기화, 최신 받기, 업데이트
platforms: [claude-code]
level: 2
triggers:
  - "git sync"
  - "동기화"
  - "최신 받기"
  - "git pull"
  - "git push"
  - "업데이트"
  - "원격 동기화"
  - "sync branch"
agents:
  - "devops-engineer"
tokens: "~1.5K"
category: "devops"
source_hash: 4cfa96c0
---

# Git Sync (동기화 자동화)

## Current State
<!-- Dynamic context injected at activation -->
!`git rev-list --left-right --count HEAD...@{upstream} 2>/dev/null`
!`git status --short 2>/dev/null | head -10`
!`git stash list --oneline 2>/dev/null | head -5`

## 목적

로컬↔원격 브랜치 동기화를 안전하게 자동화.
- Pull: 최신 변경사항을 안전하게 가져오기
- Push: 로컬 커밋을 원격에 올리기
- Rebase: 브랜치를 최신 main 기준으로 정렬

충돌 발생 시 자동으로 git-conflict 스킬로 위임.

---

## When This Skill Applies

- "원격에서 최신 받아야 해"
- "내 브랜치 push 해줘"
- "main이 많이 앞서갔어, 내 브랜치 업데이트해줘"
- 자동 autopilot 종료 시 push 단계

---

## 작업 선택

```
어떤 동기화가 필요한가요?

  1) 최신 받기 (pull)
  2) 내 작업 올리기 (push)
  3) 브랜치 업데이트 (rebase onto main)
  4) 전체 동기화 (pull + rebase + push)
> _
```

---

## Workflow

### Pull (최신 받기)

```bash
# 1. 현재 상태 확인
git status
git fetch origin

# 2. 변경사항 미리 보기 (안전 확인)
git log HEAD..origin/[브랜치] --oneline

# 3. 현재 작업 중인 변경사항 처리
# (미커밋 변경사항이 있으면)
git stash push -m "sync 전 임시 저장"

# 4. Pull (rebase 방식 권장 — 깨끗한 히스토리)
git pull --rebase origin [브랜치]

# 5. stash 복원 (3번에서 stash 했다면)
git stash pop
```

충돌 발생 시:
```
충돌 감지! git-conflict 스킬로 이동합니다.
```

### Push (올리기)

```bash
# 1. 현재 브랜치 + 미push 커밋 확인
git status
git log origin/[브랜치]..HEAD --oneline

# 2. 보안 검사 (secrets, .env 파일)
git diff --staged --name-only | grep -E '\.env|\.secret|\.key'

# 3. Push
git push origin [현재브랜치]

# 처음 push하는 브랜치라면
git push -u origin [현재브랜치]
```

### Rebase (브랜치 업데이트)

feat/* 브랜치를 최신 main 기준으로 정렬:

```bash
# 1. main 최신화
git fetch origin main

# 2. 현재 브랜치 확인
git branch --show-current

# 3. Rebase
git rebase origin/main

# 4. 충돌 시 각 커밋별 해결 + continue
# git rebase --continue  (해결 후)
# git rebase --abort     (취소)
```

충돌 발생 시 git-conflict 스킬로 위임.

### 전체 동기화

```bash
# 1. 최신 fetch
git fetch --all

# 2. 현재 브랜치를 main 기준으로 rebase
git rebase origin/main

# 3. 충돌 해결 (git-conflict 위임)

# 4. Push
git push origin [브랜치] --force-with-lease
```

`--force-with-lease`: 내가 모르는 사이 다른 사람이 push했으면 거부 (안전한 force push)

---

## 자동 동기화 상태 표시

sync 실행 후 결과 출력:
```
GIT SYNC
========
브랜치:   feat/login → origin/feat/login
상태:     ✓ SYNCED

받은 커밋: 3개
  abc123 fix: 세션 만료 처리
  def456 feat: 소셜 로그인
  ghi789 docs: API 문서 업데이트

올린 커밋: 2개
  jkl012 feat: UI 개선
  mno345 fix: 모바일 레이아웃

충돌:     없음
```

---

## Fork 저장소 동기화

Fork한 저장소를 원본(upstream)과 동기화:

```bash
# upstream이 설정되어 있는지 확인
git remote -v

# upstream 추가 (없으면)
git remote add upstream [원본-repo-url]

# upstream의 최신 가져오기
git fetch upstream

# 내 main을 upstream/main으로 업데이트
git checkout main
git rebase upstream/main

# 내 fork에 push
git push origin main
```

---

## Human Checkpoints

### Checkpoint 1: Force Push 확인
**Context**: `--force-with-lease` 사용 직전. 원격 브랜치 히스토리를 덮어씀.
**Ask**: "force push를 실행합니다 (`[브랜치]`). 원격 브랜치가 로컬과 달라집니다. 계속할까요?"
**Options**: 1) 실행 / 2) 취소
**Skippable**: No
**Freedom**: LOW

### Checkpoint 2: 다수의 미push 커밋
**Context**: 로컬에 push되지 않은 커밋이 10개 이상인 경우.
**Ask**: "push 예정 커밋이 [N]개입니다. 계속할까요?"
**Options**: 1) 전체 push / 2) 일부만 선택 / 3) 취소
**Skippable**: Yes
**Freedom**: MEDIUM

---

## Checklist

- [ ] pull 전 `git fetch` 로 원격 상태 미리 확인
- [ ] 미커밋 변경사항 있으면 stash 또는 커밋 먼저
- [ ] push 전 `.env`, `*.secret` 파일 포함 여부 확인
- [ ] 충돌 발생 시 git-conflict 스킬로 위임
- [ ] force push 시 `--force-with-lease` 사용 (일반 `--force` 금지)

## Guardrails

- `main`/`master`에 직접 force push 절대 금지
- `git push --force` (lease 없는) 안내 금지 — 항상 `--force-with-lease`
- pull 시 미커밋 변경사항이 있으면 stash 먼저 처리
- push 전 `.env`/`*.secret`/`*.key` 파일 자동 스캔
- upstream sync 시 fork main을 rebase로 처리 (merge 대신)

## Rationalizations

The following table captures common excuses agents make to skip the discipline required by this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "I'll pull at the end of the day" | end-of-day pulls surface a day of conflicts at once; sync incrementally or pay interest |
| "git pull always works" | default git pull does a merge that pollutes history with merge commits; configure rebase or ff-only |
| "fetch and merge is the same as pull" | fetch + review + merge is the same; pull skips the review step that catches surprise force-pushes |
| "I don't need to sync my feature branch with main" | drifting feature branches discover incompatibilities at PR time, when it is most expensive |
| "upstream is always clean" | upstream can be force-pushed, rewritten, or have a rogue commit — verify before blindly resetting to it |

