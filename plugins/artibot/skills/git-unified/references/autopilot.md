# Git Autopilot

## 목적

사용자가 코드 작성에만 집중할 수 있도록 Git 작업 전체를 자동화.
PostToolUse(Edit/Write) 훅이 변경을 감지 → WIP 커밋 → 세션 종료 시 자동 푸시.

---

## When This Skill Applies

- `/git autopilot on|off|status` 명령 실행 시
- 자동 커밋/푸시 설정이 필요할 때
- autopilot 상태 확인 또는 모드 변경 시

---

## Core Concepts

### Autopilot 모드

| 모드 | 자동 커밋 | 자동 푸시 | 자동 충돌 해결 |
|------|:--------:|:--------:|:------------:|
| `off` | X | X | X |
| `safe` | O | X (세션 종료 시 확인) | X |
| `full` | O | O | O (safe 전략만) |

### 설정 파일

**`~/.claude/artibot/git-autopilot.json`**:
```json
{
  "enabled": true,
  "mode": "safe",
  "autoCommit": true,
  "autoPush": false,
  "autoMerge": false,
  "commitPrefix": "wip",
  "excludePaths": ["*.env", "*.secret", "*.key"],
  "squashOnPush": true
}
```

### WIP 커밋 전략

Autopilot이 생성하는 커밋은 `wip: [파일명] [타임스탬프]` 형식.
푸시 전 `git reset --soft origin/[branch]` → 단일 의미있는 커밋으로 squash.

---

## Workflow

### `/git autopilot on [mode]`

1. `~/.claude/artibot/git-autopilot.json` 확인 또는 생성
2. `mode` 파라미터 파싱 (기본값: `safe`)
3. `enabled: true` 설정
4. 현재 브랜치 + remote 상태 확인
5. 상태 출력:
   ```
   Autopilot ON (safe mode)
   브랜치: feat/my-feature → origin/feat/my-feature
   자동 커밋: O  자동 푸시: X  자동 충돌 해결: X
   ```

### `/git autopilot off`

1. `~/.claude/artibot/git-autopilot.json` → `enabled: false`
2. 현재 스테이징된 변경사항 확인
3. 미커밋 WIP 있으면 squash 제안:
   ```
   Autopilot OFF
   미커밋 변경사항 3개 감지. squash 커밋으로 마무리하시겠습니까? [Y/n]
   ```

### `/git autopilot status`

현재 설정 + 상태 출력:
```
GIT AUTOPILOT STATUS
====================
모드:     safe
자동커밋: O  자동푸시: X  자동머지: X
WIP 커밋: 7개 (squash 대상)
마지막 WIP: wip: auth.ts 14:32:05
설정 파일: ~/.claude/artibot/git-autopilot.json
```

### PostToolUse 훅 동작 (내부)

Edit/Write 도구 실행 후 자동 트리거:
1. 변경 파일이 `excludePaths` 패턴에 해당하는지 확인
2. 해당하면 스킵
3. 아니면: `git add [파일]` → `git commit -m "wip: [파일] [시각]"`

### SessionStop 훅 동작 (내부)

세션 종료 시:
- **safe 모드**: WIP 커밋 수 보고 → "푸시하시겠습니까?" Human Checkpoint
- **full 모드**: squash → 자동 푸시

---

## Conflict Resolution Engine (full 모드)

충돌 블록 분류:

```
classifyBlock(ours, theirs):
  if ours == theirs          → 'duplicate' (둘 다 동일, ours 채택)
  if intersection(ours,theirs) == theirs → 'safe_ours' (ours가 theirs 포함)
  if intersection(ours,theirs) == ours  → 'safe_theirs' (theirs가 ours 포함)
  else                       → 'manual' (수동 해결 필요)
```

자동 해결 가능: `duplicate`, `safe_ours`
자동 해결 불가: `manual` → 사용자에게 Human Checkpoint

---

## Human Checkpoints

### Checkpoint 1: Safe 모드 푸시 확인 (SessionStop 후)
**Context**: 세션 종료 시 WIP 커밋들을 squash 후 푸시 직전.
**Ask**: "WIP 커밋 [N]개를 squash하여 `[브랜치]`에 푸시합니다. 계속할까요?"
**Options**: 1) 푸시 / 2) squash만 (푸시 보류) / 3) 취소
**Skippable**: No
**Freedom**: LOW

### Checkpoint 2: 충돌 수동 해결 필요 (full 모드)
**Context**: `manual` 분류 충돌 블록 발견 시.
**Ask**: "자동 해결 불가 충돌 [N]개. 직접 해결 후 계속하시겠습니까?"
**Options**: 1) 수동 해결 후 계속 / 2) 머지 중단
**Skippable**: No
**Freedom**: LOW

---

## Checklist

- [ ] `git-autopilot.json` 존재 확인
- [ ] `excludePaths`에 `.env`, `*.secret` 포함 여부 확인
- [ ] WIP 커밋 squash 전 `git log --oneline` 검토
- [ ] full 모드 활성화 시 Human Checkpoint 적용

## Guardrails

- `main`/`master` 브랜치에서 autopilot 자동 커밋 금지
- `excludePaths` 패턴 파일은 절대 자동 스테이징 금지
- full 모드 활성화는 반드시 사용자 명시적 선택 필요
- `dangerouslySkipPermissions` 없이도 동작 가능하도록 설계
- squash 전 현재 커밋 수 사용자에게 항상 표시

## Rationalizations

The following table captures common excuses agents make to skip the discipline required by this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "automated commits are risky" | manual commits that skip the diff review are equally risky — autopilot enforces the review the human keeps skipping |
| "I'll batch it into one commit later" | batched commits lose the bisectable history; autopilot preserves atomicity at the moment work happens |
| "the commit message is obvious from the diff" | future readers see only the message in log output — the diff is one click away, the context is gone |
| "I don't need conventional commits" | without a convention, release notes, changelogs, and semver automation all break downstream |
| "just --amend, it's faster" | amend rewrites published history; autopilot prefers additive commits that survive pushes safely |
