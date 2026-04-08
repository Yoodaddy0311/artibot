---
context: fork
name: git-collab
description: |
  Git 팀 협업 온보딩 자동화 — 신규 팀원을 위한 저장소 설정, 브랜치 규칙, PR 워크플로우 자동 안내.
  Auto-activates when: 팀원 온보딩, 협업 설정, 저장소 셋업, clone 후 설정, 팀 git 규칙.
  Triggers: 팀 온보딩, git 협업, 저장소 설정, 팀원 추가, collab setup
platforms: [claude-code]
level: 2
triggers:
  - "팀 온보딩"
  - "git 협업"
  - "저장소 설정"
  - "팀원 추가"
  - "collab setup"
  - "협업 git"
  - "팀 규칙"
agents:
  - "devops-engineer"
  - "doc-updater"
tokens: "~2K"
category: "devops"
source_hash: cd2c4401
---

# Git Collab (팀 협업 온보딩)

## 목적

신규 팀원이 저장소를 클론한 후 첫 PR을 올리기까지 필요한 모든 설정을 자동 안내.
팀 리더에게는 CONTRIBUTING.md, PR 템플릿, 브랜치 보호 규칙 설정 자동화.

---

## When This Skill Applies

- 새 팀원이 프로젝트에 합류했을 때
- 팀 Git 워크플로우 문서가 없을 때
- 협업 규칙을 표준화하고 싶을 때
- 저장소 초기 설정 (PR 템플릿, 브랜치 보호) 필요 시

---

## Workflow

### 역할 선택

```
어떤 역할로 시작하시겠습니까?

  1) 신규 팀원 — 저장소 클론부터 첫 PR까지 안내
  2) 팀 리더 — CONTRIBUTING.md, PR 템플릿, 브랜치 규칙 설정
  3) 팀 전체 — 현재 협업 설정 점검 및 개선
> _
```

---

### 신규 팀원 온보딩 플로우

#### Phase 1: 저장소 설정 (5분)
```bash
# 1. 클론
git clone [repo-url]
cd [repo-name]

# 2. 업스트림 설정 (fork 기반이라면)
git remote add upstream [original-repo-url]
git remote -v   # 확인

# 3. 기본 브랜치 확인
git branch -a
git checkout main  # 또는 develop
```

#### Phase 2: 로컬 환경 설정
```bash
# Git 사용자 정보 (전역 또는 프로젝트별)
git config user.name "이름"
git config user.email "email@company.com"

# 커밋 서명 (팀에서 요구하는 경우)
git config commit.gpgsign true

# 줄바꿈 처리 (OS별)
git config core.autocrlf input  # Mac/Linux
git config core.autocrlf true   # Windows
```

#### Phase 3: 첫 작업 브랜치
```bash
# 최신 main 기준으로 브랜치 생성
git checkout main
git pull origin main
git checkout -b feat/[이름]-[기능명]

# 예시
git checkout -b feat/youngmi-login-ui
```

#### Phase 4: 첫 PR 체크리스트
```
PR 올리기 전 확인:
- [ ] 브랜치 이름이 규칙에 맞는가? (feat/*, fix/*, docs/*)
- [ ] 커밋 메시지가 컨벤션을 따르는가?
- [ ] 테스트가 통과하는가?
- [ ] CONTRIBUTING.md를 읽었는가?
- [ ] PR 설명에 변경 사항과 테스트 방법을 작성했는가?
```

---

### 팀 리더 설정 플로우

#### CONTRIBUTING.md 생성

요청 시 프로젝트에 맞는 `CONTRIBUTING.md` 자동 생성:
```markdown
# Contributing Guide

## 브랜치 네이밍
- feat/기능명
- fix/버그명
- docs/문서명
- chore/잡무

## 커밋 메시지 (Conventional Commits)
feat(scope): 새 기능
fix(scope): 버그 수정
...

## PR 프로세스
1. main에서 브랜치 생성
2. 변경사항 커밋
3. PR 생성 (템플릿 사용)
4. 리뷰어 1명 이상 승인
5. CI 통과 후 머지

## 코드 리뷰 기준
...
```

#### PR 템플릿 생성

`.github/PULL_REQUEST_TEMPLATE.md` 생성:
```markdown
## 변경 사항

## 테스트 방법

## 체크리스트
- [ ] 테스트 추가/수정
- [ ] 문서 업데이트
- [ ] Breaking change 없음
```

#### 브랜치 보호 규칙 (GitHub CLI)
```bash
# main 브랜치 보호 설정
gh api repos/{owner}/{repo}/branches/main/protection \
  -X PUT \
  --field required_pull_request_reviews.required_approving_review_count=1 \
  --field required_status_checks.strict=true
```

---

### 협업 설정 점검

현재 저장소의 협업 설정 자동 점검:
```
협업 설정 점검 결과:
✓ CONTRIBUTING.md 존재
✗ PR 템플릿 없음 → 생성 권장
✓ main 브랜치 보호 활성화
✗ commit-msg 훅 없음 → Conventional Commits 강제 권장
✓ .gitignore 존재
```

---

## Human Checkpoints

### Checkpoint 1: CONTRIBUTING.md 내용 검토
**Context**: 자동 생성된 CONTRIBUTING.md 저장 전.
**Ask**: "생성된 CONTRIBUTING.md 내용을 확인해주세요. 팀 규칙에 맞게 수정이 필요한 부분이 있나요?"
**Options**: 1) 그대로 저장 / 2) 내용 수정 후 저장
**Skippable**: No — 팀 전체에 영향
**Freedom**: MEDIUM

---

## Checklist

- [ ] 신규 팀원 / 팀 리더 역할 먼저 확인
- [ ] `git remote -v` 로 remote 설정 확인
- [ ] CONTRIBUTING.md 없으면 생성 제안
- [ ] PR 템플릿 없으면 생성 제안
- [ ] 브랜치 보호 규칙 상태 확인

## Guardrails

- 브랜치 보호 규칙 변경은 저장소 관리자 권한 필요 — 권한 확인 후 진행
- CONTRIBUTING.md는 덮어쓰기 전 기존 내용 표시
- Git 설정(`user.name`, `user.email`)은 전역 vs 프로젝트별 차이 설명
- GPG 서명 설정은 키 생성 선행 필요 — 없으면 단계 안내

## Rationalizations

The following table captures common excuses agents make to skip the discipline required by this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "the new hire can figure out git" | unguided onboarding produces force-pushes to main within the first week; standardize the on-ramp |
| "we all use different workflows, it's fine" | divergent workflows cause merge hell and PR review confusion; pick one and document it |
| "CODEOWNERS is bureaucracy" | CODEOWNERS is the mechanism that prevents unreviewed changes to critical paths — that's safety, not process |
| "branch protection slows us down" | it slows down the five minutes before you would have broken main for everyone else |
| "we don't need a PR template" | without a template every PR description becomes "see title", and reviewers re-ask the same questions |

