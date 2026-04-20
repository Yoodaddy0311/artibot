# Git Safe (안전망)

## 목적

`project-backup-20241215/` 같은 수동 백업 폴더를 Git 기능으로 대체.
실험적 변경을 안전하게 저장하고, 언제든 원하는 시점으로 복귀.

---

## When This Skill Applies

- 큰 리팩터링/실험 전 현재 상태 저장하고 싶을 때
- "이것저것 바꿔봤다가 되돌리고 싶어"
- 특정 시점의 스냅샷을 보존해두고 싶을 때
- `git stash`를 어떻게 쓰는지 모를 때

---

## 안전망 전략 선택

```
어떤 상황인가요?

  1) 잠깐 실험할게요 — 곧 돌아올 수도 있어요 (stash)
  2) 지금 이 상태를 이름 붙여 저장하고 싶어요 (tag)
  3) 완전히 오프라인 백업이 필요해요 (bundle)
  4) 이미 바꾼 걸 되돌리고 싶어요 (revert/reset)
> _
```

---

## 전략 1: Stash (임시 저장)

현재 작업 중인 변경사항을 임시로 보관하고 나중에 꺼냄.

```bash
# 현재 상태 저장 (이름 붙이기 권장)
git stash push -m "로그인 UI 실험 중 — 2024-12-15"

# 저장된 stash 목록 보기
git stash list
# stash@{0}: On feat/login: 로그인 UI 실험 중 — 2024-12-15
# stash@{1}: On main: 이전 실험

# 꺼내기 (가장 최근 또는 특정 stash)
git stash pop           # 가장 최근 꺼내기 + 목록에서 제거
git stash apply stash@{1}  # 특정 stash 꺼내기 (목록 유지)

# 삭제
git stash drop stash@{0}  # 특정 stash 삭제
git stash clear           # 전체 삭제
```

**적합한 상황**: 다른 브랜치로 잠깐 이동할 때, 짧은 실험 후 돌아올 때

---

## 전략 2: Tag (이름 있는 스냅샷)

특정 커밋에 의미 있는 이름을 붙여 영구 보존.

```bash
# 현재 상태를 먼저 커밋 (미커밋 변경사항이 있다면)
git add .
git commit -m "chore: 리팩터링 전 스냅샷"

# 태그 생성
git tag -a "before-refactor-20241215" -m "대규모 리팩터링 전 안전 지점"

# 태그 목록 보기
git tag -l

# 태그로 이동 (읽기 전용)
git checkout before-refactor-20241215

# 태그에서 새 브랜치 생성 (수정하려면)
git checkout -b recovery/from-refactor-snapshot before-refactor-20241215

# 태그 삭제 (로컬)
git tag -d before-refactor-20241215
```

**적합한 상황**: "이 버전은 반드시 보존", 릴리즈 전 스냅샷, 실험 시작점 기록

---

## 전략 3: Bundle (오프라인 백업)

전체 저장소를 단일 파일로 내보내기. 네트워크 없이도 복원 가능.

```bash
# 전체 저장소 번들 생성
git bundle create ~/backups/repo-20241215.bundle --all

# 번들에서 복원
git clone ~/backups/repo-20241215.bundle repo-restored

# 특정 브랜치만 번들
git bundle create feature-backup.bundle feat/login main
```

**적합한 상황**: USB로 전달, 인터넷 없는 환경, 장기 아카이브

---

## 전략 4: 되돌리기

### 미커밋 변경사항 되돌리기
```bash
# 특정 파일만 되돌리기
git restore 파일명.js

# 전체 되돌리기 (복구 불가 — 경고)
git restore .
```

### 커밋 되돌리기
```bash
# 안전하게: 새 커밋으로 되돌리기 (히스토리 보존)
git revert HEAD         # 마지막 커밋 되돌리기
git revert abc123       # 특정 커밋 되돌리기

# 강제: 커밋 자체를 지우기 (공유 브랜치에서 사용 금지)
git reset --soft HEAD~1   # 커밋만 취소 (변경사항 유지)
git reset --hard HEAD~1   # 커밋 + 변경사항 모두 취소
```

---

## 빠른 안전망 루틴

실험 시작 전 30초 루틴:
```bash
# 1. 현재 상태 태그
git add . && git commit -m "snapshot: 실험 전 $(date +%Y%m%d-%H%M)"

# 2. 실험용 브랜치 생성
git checkout -b experiment/$(date +%Y%m%d)

# → 맘껏 실험, 언제든 main으로 복귀 가능
```

---

## Checklist

- [ ] 목적에 맞는 전략 선택 (stash/tag/bundle/revert)
- [ ] stash 사용 시 의미 있는 이름 붙이기
- [ ] `git reset --hard` 전 반드시 경고 표시
- [ ] bundle 생성 경로가 저장소 외부인지 확인

## Guardrails

- `git reset --hard`는 데이터 손실 위험 — 항상 경고 후 실행
- `git restore .` 전 stash 또는 커밋 여부 확인
- 공유 브랜치(main/develop)에서 `reset --hard` 절대 안내 금지
- bundle 파일은 `.gitignore` 된 경로에 저장 권장 (저장소 내부 금지)
- stash 목록이 10개 이상이면 정리 제안

## Rationalizations

The following table captures common excuses agents make to skip the discipline required by this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "I'll back up to a folder copy" | folder copies drift from git state, lose history, and clutter the workspace — use stash/tag/bundle |
| "stash is unsafe, I might lose it" | stashes live in reflog for 90 days; named stashes and tags make them discoverable forever |
| "I don't need a backup, I just committed" | local commits die with your disk; safety nets require either a remote or a bundle |
| "rebasing is always safer than merge" | rebasing rewrites history — without a tag before the rebase, recovery from a bad conflict resolution is painful |
| "force push is fine on my branch" | force push is fine until a collaborator pulled it; always use --force-with-lease |
