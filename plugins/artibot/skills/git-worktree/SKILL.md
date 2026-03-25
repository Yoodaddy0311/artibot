---
context: fork
name: git-worktree
description: |
  Git 워크트리 라이프사이클 관리 — 여러 브랜치를 동시에 열어두고 작업. 생성·상태 확인·충돌 예측·머지·정리를 단계별 안내.
  Auto-activates when: worktree, 워크트리, 병렬 브랜치 작업, git workspace, 여러 브랜치 동시 작업.
  Triggers: worktree, 워크트리, git worktree, parallel branch, 병렬 작업
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "worktree"
  - "워크트리"
  - "git worktree"
  - "parallel branch"
  - "병렬 작업"
  - "여러 브랜치"
  - "workspace"
agents:
  - "devops-engineer"
tokens: "~2K"
category: "devops"
---

# Git Worktree

## 목적

Git worktree로 여러 브랜치를 동시에 다른 디렉터리에서 작업.
브랜치 전환(checkout) 없이 병렬로 기능 개발, 버그 수정, 코드 리뷰 가능.

---

## When This Skill Applies

- 여러 기능을 동시에 작업하면서 브랜치 전환 비용을 없애고 싶을 때
- 현재 작업을 stash하지 않고 긴급 버그픽스가 필요할 때
- PR 리뷰 중 로컬에서 직접 실행해보고 싶을 때
- 워크트리 상태 확인 또는 정리가 필요할 때

---

## Core Concept

```
프로젝트 루트 레이아웃:
  ~/projects/
    myapp/          ← 메인 워크트리 (main 브랜치)
    myapp-feat-login/    ← 워크트리 (feat/login 브랜치)
    myapp-fix-crash/     ← 워크트리 (fix/crash 브랜치)

동일한 .git 디렉터리를 공유 → 커밋/브랜치 즉시 동기화
```

---

## Workflow

### `create [branch]`

워크트리 생성 + 브랜치 설정을 한 번에 처리.

```bash
# 기본 사용 (bare 이름 → feat/ 자동 prefix)
/git worktree create login-page
# → 브랜치: feat/login-page
# → 디렉터리: ../myapp-feat-login-page

# fix 접두사 힌트
/git worktree create fix/auth-crash
# → 브랜치: fix/auth-crash
# → 디렉터리: ../myapp-fix-auth-crash
```

**실행 단계**:
1. 브랜치명 파싱 — bare name이면 `feat/` 접두사 자동 추가
2. 디렉터리명 계산: `../{project}-{branch-slug}`
3. 워크트리 생성:
   ```bash
   git worktree add -b feat/login-page ../myapp-feat-login-page main
   ```
4. 공유 설정 복사 (`.env`, `.env.local` 등 — `.gitignore`된 파일):
   ```bash
   cp .env ../myapp-feat-login-page/.env 2>/dev/null || true
   ```
5. 생성 완료 메시지:
   ```
   워크트리 생성 완료
   브랜치:    feat/login-page
   경로:      ../myapp-feat-login-page
   기준:      main (HEAD: abc1234)

   이동 명령: cd ../myapp-feat-login-page
   ```

---

### `list`

활성 워크트리 전체 상태 대시보드 출력.

```bash
git worktree list
```

**출력 형식**:
```
WORKTREE STATUS DASHBOARD
==========================
#  경로                      브랜치              상태     마지막 커밋
─  ─────────────────────────  ──────────────────  ───────  ────────────────────
1  ~/projects/myapp           main               CLEAN    abc1234 feat: 결제 완료
2  ../myapp-feat-login-page   feat/login-page    DIRTY 2  def5678 wip: 로그인 폼
3  ../myapp-fix-auth-crash    fix/auth-crash     CLEAN    ghi9012 fix: 토큰 갱신
```

- `DIRTY N`: 미커밋 변경파일 N개
- `CLEAN`: 변경사항 없음
- `STALE`: 브랜치가 삭제된 워크트리 (정리 필요)

---

### `check`

모든 워크트리 쌍 간 충돌 예측. `git merge-tree` 기반.

```bash
# 모든 쌍 조합 검사
git merge-tree $(git merge-base feat/login-page feat/signup) feat/login-page feat/signup
```

**충돌 매트릭스 출력**:
```
CONFLICT PREDICTION MATRIX
============================
                    feat/login  fix/crash  feat/signup
feat/login-page     —           SAFE ✓     CONFLICT ⚠
fix/auth-crash      SAFE ✓      —          SAFE ✓
feat/signup         CONFLICT ⚠  SAFE ✓     —

충돌 예상 파일 (feat/login-page ↔ feat/signup):
  src/auth/session.ts — 양쪽에서 수정됨
  src/utils/token.js  — 양쪽에서 수정됨

권장 머지 순서:
  1) fix/auth-crash → main (충돌 없음)
  2) feat/login-page → main
  3) feat/signup → main (login 머지 후 rebase 권장)
```

---

### `merge [target]`

현재 워크트리 브랜치를 대상 브랜치에 squash-merge.

**6단계 워크플로우**:

```
Phase 1 Validate   — 현재 워크트리 clean 상태 확인 (dirty면 커밋 요청)
Phase 2 Research   — git log, diff 분석으로 변경사항 파악
Phase 3 Prep       — target 브랜치 최신화 (git fetch + pull)
Phase 4 Merge      — merge-tree로 충돌 사전 감지
Phase 5 Commit     — squash-merge 실행 + AI 커밋 메시지 생성
Phase 6 Verify     — 머지 후 테스트 실행 (npm test 등)
```

```bash
# Phase 5: squash-merge
git checkout main
git merge --squash feat/login-page
git commit -m "[AI 생성 커밋 메시지]"
```

**AI 커밋 메시지 생성**: `git diff --stat` + `git log --oneline` 분석 →
```
feat(auth): 로그인 페이지 구현

- JWT 기반 세션 관리
- 소셜 로그인 (Google, GitHub) 연동
- 모바일 반응형 레이아웃
```

충돌 감지 시 (Phase 4):
```
머지 중단 — 충돌 예상 파일 발견:
  src/auth/session.ts

git-conflict 스킬로 충돌 해결 후 재시도하세요.
```

---

### `clean`

머지 완료되거나 오래된 워크트리 탐지 + 정리.

**탐지 기준**:
- 브랜치가 main에 머지된 워크트리
- `git worktree list`에서 `STALE` 상태 (브랜치 삭제됨)

```bash
# 머지 여부 확인
git branch --merged main | grep feat/login-page

# 워크트리 제거
git worktree remove ../myapp-feat-login-page
git branch -d feat/login-page
```

**절대 삭제하지 않는 경우**:
- DIRTY 워크트리 (미커밋 변경사항 있음)
- 메인 워크트리 (현재 작업 디렉터리)

---

## Human Checkpoints

### Checkpoint 1: 워크트리 삭제 확인 (clean 시)
**Context**: 워크트리 제거 + 브랜치 삭제 직전. 되돌리기 어렵다.
**Ask**: "다음 워크트리를 삭제합니다: `[경로]` (`[브랜치]`). 계속할까요?"
**Options**: 1) 삭제 / 2) 이 항목 건너뜀 / 3) 전체 취소
**Skippable**: No — 데이터 손실 가능
**Freedom**: LOW

### Checkpoint 2: squash-merge 커밋 메시지 승인 (merge 시)
**Context**: AI가 생성한 squash 커밋 메시지 확정 전.
**Ask**: "커밋 메시지를 확인해주세요: `[메시지]` 이대로 커밋할까요?"
**Options**: 1) 승인 / 2) 메시지 수정
**Skippable**: No — 메인 브랜치 히스토리에 영향
**Freedom**: MEDIUM

---

## Checklist

- [ ] `create` 시 브랜치명 자동 prefix 적용 여부 확인
- [ ] `create` 후 `.env` 등 공유 설정 복사 완료 확인
- [ ] `list` 출력 시 STALE 워크트리 강조 표시
- [ ] `check` 충돌 예측 후 권장 머지 순서 제시
- [ ] `merge` Phase 1에서 dirty 워크트리 차단
- [ ] `clean` 전 반드시 Human Checkpoint 실행

## Guardrails

- DIRTY 워크트리는 `clean`으로 절대 삭제 금지
- `main`/`master` 워크트리는 `clean` 대상 제외
- `merge --squash` 후 원본 브랜치 삭제는 사용자 명시 확인 후에만
- 워크트리 디렉터리가 저장소 내부(`./`)가 되지 않도록 경로 검증
- `git merge-tree` 결과가 비어있으면 "충돌 없음" 으로 판정 (오탐 없음)
- `check` 단계에서 충돌 예측 실패 시 "예측 불가" 표시 후 수동 확인 권장

## Quick Reference

```bash
/git worktree create feat/login    # 워크트리 생성
/git worktree list                 # 전체 상태
/git worktree check                # 충돌 예측
/git worktree merge                # → main squash-merge
/git worktree merge develop        # → develop squash-merge
/git worktree clean                # 정리
```
