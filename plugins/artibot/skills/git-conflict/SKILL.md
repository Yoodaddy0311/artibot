---
context: fork
name: git-conflict
description: |
  Git 충돌 해결 자동화 — 충돌 블록을 분류하고 안전한 것은 자동 해결, 위험한 것은 Human Checkpoint.
  Auto-activates when: merge conflict, CONFLICT, 충돌, 머지 실패, rebase conflict.
  Triggers: merge conflict, 충돌, CONFLICT, git conflict, 머지 충돌
platforms: [claude-code]
level: 2
triggers:
  - "merge conflict"
  - "충돌"
  - "CONFLICT"
  - "git conflict"
  - "머지 충돌"
  - "rebase conflict"
  - "충돌 해결"
agents:
  - "devops-engineer"
argument-hint: "[file-path] e.g., src/auth/login.ts, package-lock.json"
tokens: "~2K"
category: "devops"
source_hash: 5f5b2689
---

# Git Conflict Resolver

Use `$ARGUMENTS` to specify the conflicting file path to resolve.

## Current State
<!-- Dynamic context injected at activation -->
!`git diff --name-only --diff-filter=U 2>/dev/null`
!`git status --short 2>/dev/null | head -10`

## 목적

머지/리베이스 충돌 시 충돌 블록을 자동 분류하고:
- 안전한 충돌 → 자동 해결
- 판단이 필요한 충돌 → Human Checkpoint로 사용자에게 전달

---

## When This Skill Applies

- `git merge` / `git rebase` 후 충돌 발생 시
- `CONFLICT (content): Merge conflict in [파일]` 오류 메시지
- `<<<<<<`, `=======`, `>>>>>>>` 마커가 파일에 남아있을 때

---

## Conflict Classification

충돌 블록을 4가지로 분류:

| 유형 | 정의 | 처리 |
|------|------|------|
| `duplicate` | ours == theirs (동일 변경) | 자동 — ours 채택 |
| `safe_ours` | theirs ⊂ ours (ours가 theirs 포함) | 자동 — ours 채택 |
| `safe_theirs` | ours ⊂ theirs (theirs가 ours 포함) | 자동 — theirs 채택 |
| `manual` | 진짜 충돌 (겹치지만 다름) | Human Checkpoint |

---

## Workflow

### Step 1: 충돌 파일 목록 수집

```bash
git diff --name-only --diff-filter=U
```

충돌 파일 수와 목록 출력:
```
충돌 파일 3개 감지:
  - src/auth/login.ts
  - src/utils/helpers.js
  - package-lock.json
```

### Step 2: 충돌 블록 파싱

각 파일의 `<<<<<<<`...`=======`...`>>>>>>>` 블록 추출.
블록별로 classification 적용.

### Step 3: 자동 해결 가능한 블록 처리

`duplicate` / `safe_ours` / `safe_theirs` 블록:
1. 해당 마커 제거
2. 정책에 따라 한쪽 내용 채택
3. `git add [파일]`

자동 해결 완료 후 보고:
```
자동 해결 완료:
  login.ts   — 2블록 (duplicate×1, safe_ours×1)
  helpers.js — 1블록 (safe_theirs×1)
```

### Step 4: 수동 해결 필요 블록 → Human Checkpoint

`manual` 블록이 있으면 각 블록을 사용자에게 표시:

```
[수동 해결 필요] src/auth/login.ts:45

  <<<< 현재 브랜치 (feat/oauth)
  const token = await getOAuthToken(user.id)
  return { token, expiry: 3600 }
  ====
  const token = generateJWT(user)
  return { token, expiry: user.isPremium ? 86400 : 3600 }
  >>>> main

  선택:
  1) 현재 브랜치 (feat/oauth) 채택
  2) main 브랜치 채택
  3) 직접 편집
```

### Step 5: 해결 완료 후 커밋

모든 블록 해결 후:
```bash
git add .
git commit -m "fix: merge conflict 해결 — [브랜치명] ← [소스브랜치]"
```

---

## 특수 파일 처리

### package-lock.json / yarn.lock
자동으로 재생성 전략 사용:
```bash
git checkout --theirs package-lock.json   # 또는 --ours
npm install  # lock 파일 재생성
git add package-lock.json
```

### 바이너리 파일 충돌
자동 해결 불가 → 항상 Human Checkpoint:
```
[바이너리 충돌] assets/logo.png
어느 버전을 사용하시겠습니까?
1) 현재 브랜치
2) 병합 대상 브랜치
```

---

## Human Checkpoints

### Checkpoint 1: 수동 해결 블록 선택
**Context**: `manual` 분류 충돌 블록. 자동으로 판단할 수 없는 실제 충돌.
**Ask**: "다음 충돌 블록을 해결해주세요. [블록 내용 표시]"
**Options**: 1) 현재 브랜치 / 2) 병합 대상 / 3) 직접 편집
**Skippable**: No — 미해결 블록은 커밋 불가
**Freedom**: LOW

### Checkpoint 2: 대규모 충돌 전략 선택
**Context**: 충돌 블록이 10개 이상인 경우.
**Ask**: "충돌 블록이 [N]개입니다. 전략을 선택하세요."
**Options**: 1) 블록별 하나씩 해결 / 2) ours 전체 채택 / 3) theirs 전체 채택 / 4) 머지 중단
**Skippable**: No
**Freedom**: MEDIUM

---

## Checklist

- [ ] `git diff --name-only --diff-filter=U` 로 충돌 파일 전체 확인
- [ ] 자동 해결 전 블록 분류 결과 사용자에게 표시
- [ ] `package-lock.json` 등 lock 파일은 재생성 전략 사용
- [ ] 모든 충돌 해결 후 `git status` 로 잔여 충돌 없음 확인

## ⚠️ Whole-Merge `-X` 전략 금지 (Commit-Level Strategy Pitfall)

`git pull --no-rebase -X theirs` 또는 `git merge -X ours`는 **모든 충돌에 일괄 적용**된다. 이 전략은:

1. ✅ 런타임/lock 파일 등 **의도치 않은** 공통 충돌만 있을 때는 안전
2. ❌ 동일 파일에 **나의 의도적 변경 + 원격의 다른 변경**이 공존하면 내 변경이 **소리 없이 원복**됨

### 실제 사고 사례 (2026-04-20)
4.7 migration 머지 시 `-X theirs` 사용 → 런타임 파일은 정상 해소됐으나 `llm.csv`, `CLAUDE.md`, `CHANGELOG.md` 3개의 의도적 변경까지 원격 버전으로 원복. 복구 커밋(`30080cb`) 필요.

### 권장 대체 전략 (파일 단위)

| 상황 | 명령 |
|---|---|
| 특정 파일만 remote 채택 | `git checkout --theirs <path>` → `git add <path>` |
| 특정 파일만 local 채택 | `git checkout --ours <path>` → `git add <path>` |
| 의도적 변경 + 런타임 충돌 섞임 | 머지 진행 → 런타임 파일만 `--theirs` → 의도적 파일은 수동 해결 |
| 대량 런타임 파일 | `.gitignore` 추가 → `git rm --cached <path>` → 커밋 |

### Pre-Merge 체크리스트
- [ ] 나의 최근 커밋이 touch한 파일 목록 확보 (`git diff HEAD~1 --name-only`)
- [ ] 원격이 touch할 파일 목록 확보 (`git diff HEAD..origin/<branch> --name-only`)
- [ ] 교집합(위험 파일) 확인 — **이 파일은 `-X` 전략으로 해결하지 말 것**

## Guardrails

- `safe_theirs` 자동 채택 시 사용자에게 내용 표시 후 진행
- 10개 이상 충돌 시 전략 먼저 선택 (블록별 해결은 선택사항)
- 바이너리 파일은 절대 자동 해결 금지
- 충돌 해결 커밋 메시지에 반드시 어느 브랜치 간 머지인지 명시
- `git checkout --ours/--theirs`는 파일 전체를 덮어쓰므로 파일 단위 사용 시 경고
- **`git merge/pull -X theirs|ours` 는 commit-level 전략 — 내 의도적 변경을 원복시킬 수 있음. 파일별 `git checkout --theirs/--ours <path>` 우선 사용**

## Rationalizations

The following table captures common excuses agents make to skip the discipline required by this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "accept theirs, it's probably right" | "probably" = prayer-driven merging; read both sides before accepting |
| "squash now, sort later" | squashed conflicts lose the information needed to resolve them |
| "I'll just take ours for lock files" | lock files must be regenerated, not hand-merged — either side picked manually will desync with package.json |
| "it's just whitespace, accept either" | whitespace conflicts often hide real semantic conflicts masked by reformatting; inspect the neighbors |
| "the tests will catch bad merges" | tests catch what they cover; merge mistakes in error handling and concurrency usually slip past the suite |

