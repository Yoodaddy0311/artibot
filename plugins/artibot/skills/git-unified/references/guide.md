# Git Guide (초보자)

Use `$ARGUMENTS` to describe your git question or error message.

## 목적

Git을 처음 쓰거나 특정 상황에서 막힌 사용자를 위한 대화형 안내.
CLI 명령어를 직접 알려주되, 왜 그 명령어를 쓰는지 항상 함께 설명.

---

## When This Skill Applies

- Git 명령어를 모르거나 헷갈릴 때
- "처음으로 커밋하려고 해요", "푸시가 안 돼요" 같은 상황 진술
- 오류 메시지를 붙여넣고 도움 요청 시

---

## Workflow

### Step 1: 상황 파악

먼저 현재 상황을 물어본다:

```
지금 어떤 상황인지 알려주세요:

  1) 처음으로 파일을 저장하고 싶어요 (첫 커밋)
  2) 변경사항을 저장하고 싶어요 (커밋)
  3) GitHub에 올리고 싶어요 (푸시)
  4) 최신 코드를 받고 싶어요 (풀)
  5) 브랜치를 만들고 싶어요
  6) 오류 메시지가 나왔어요
  7) 기타 (직접 설명)
```

### Step 2: 상황별 단계 안내

#### 시나리오 1: 첫 커밋
```
# 1. 현재 상태 확인 (뭐가 바뀌었는지)
git status

# 2. 저장할 파일 선택 (전체 또는 특정 파일)
git add .          # 전체
git add 파일명.js  # 특정 파일

# 3. 스냅샷 찍기 (메시지 필수)
git commit -m "feat: 로그인 기능 추가"

설명: commit은 "저장 버튼"이에요. 메시지는 "무엇을 했는지" 기록합니다.
```

#### 시나리오 2: 일반 커밋
```
git status          # 변경된 파일 확인
git diff            # 구체적으로 뭐가 바뀌었는지 보기
git add -p          # 변경사항을 선택적으로 스테이징
git commit -m "fix: 로그인 버그 수정"
```

#### 시나리오 3: 푸시
```
# 처음 푸시하는 브랜치
git push -u origin 브랜치명

# 이미 연결된 브랜치
git push

주의: main 브랜치에 직접 push하면 팀원들에게 영향줄 수 있어요.
```

#### 시나리오 4: 풀 (최신 코드 받기)
```
git pull origin main    # main에서 최신 받기
git fetch               # 확인만 (내 코드 변경 없음)

차이: pull = fetch + merge. fetch는 확인만 해요.
```

#### 시나리오 5: 브랜치 생성
```
# 새 브랜치 만들고 이동
git checkout -b feat/로그인-기능

# 브랜치 목록 보기
git branch

이름 규칙: feat/기능명, fix/버그명, docs/문서명
```

#### 시나리오 6: 오류 메시지 분석
오류 메시지를 붙여넣으면 원인과 해결책 안내:

| 오류 | 원인 | 해결 |
|------|------|------|
| `rejected ... non-fast-forward` | 원격에 내가 없는 커밋 존재 | `git pull --rebase` 후 push |
| `CONFLICT (content)` | 같은 파일을 두 명이 수정 | 충돌 파일 열어서 수동 해결 |
| `detached HEAD` | 커밋 ID로 직접 이동함 | `git checkout 브랜치명` |
| `nothing to commit` | 스테이징된 변경사항 없음 | `git add` 먼저 실행 |

### Step 3: 확인 및 다음 단계 제안

명령어 실행 후:
```
잘 됐나요? 다음으로 뭘 하고 싶으세요?
  → 더 궁금한 점이 있으면 언제든 물어보세요.
  → /git status 로 현재 상태를 확인할 수 있어요.
```

---

## 핵심 개념 카드

```
저장소(Repository): 프로젝트의 전체 변경 이력을 담는 폴더
커밋(Commit):       특정 시점의 스냅샷 (저장 버튼)
브랜치(Branch):     독립적인 작업 공간 (평행 우주)
스테이징(Staging):  커밋할 변경사항을 선택하는 대기실
원격(Remote):       GitHub 같은 온라인 저장소
```

---

## Checklist

- [ ] 현재 상황을 먼저 물어본 후 안내 시작
- [ ] 명령어와 함께 "왜 이 명령어인지" 설명 포함
- [ ] 오류 메시지는 그대로 분석하여 해결책 제시
- [ ] 각 단계 후 "잘 됐나요?" 확인

## Guardrails

- `git push --force`는 절대 초보자에게 안내하지 않음
- `git reset --hard`는 데이터 손실 위험 경고 필수
- `main`/`master` 직접 커밋은 팀 영향 경고 후 안내
- 명령어만 나열하지 말고 항상 설명 포함

## Rationalizations

The following table captures common excuses agents make to skip the discipline required by this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "I'll just learn git by doing" | doing without a mental model produces the "detached HEAD" panic; learn the graph first |
| "I use the GUI, I don't need CLI" | GUIs abstract the common path and hide the recovery path; CLI literacy is the escape hatch |
| "git is too complicated" | git has 10 commands you need daily and 90 you rarely touch — the daily 10 are learnable in an afternoon |
| "I'll just delete the folder and re-clone" | reclone loses uncommitted work and uncovered stashes; learn reset/stash/reflog before nuking |
| "reflog is for experts" | reflog is the undo button — beginners need it more than experts do, because they make more mistakes |
