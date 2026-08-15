---
description: (Artibot) Ship & Deploy phase command — routes to candidate agents via lifecycle router
argument-hint: '[task description]'
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, TaskCreate]
toolset: devops
lifecycle: ship
---

# /ship

Deploy, release, document shipped changes.

## What this command does

Routes the user's request to the appropriate specialist agent for the **ship** lifecycle phase. Uses `lib/core/lifecycle-router.js` to pick the best agent based on context.

## Usage

```
/ship [your request]
/ship --auto-description           # synthesize PR body from git + SESSION-NOTES
/ship --auto-description --stats   # also append `git diff --stat` block
```

## Options

| Flag | Description |
|------|-------------|
| `--auto-description` | Run `scripts/build-pr-description.mjs` and pipe its markdown into `gh pr create --body`. Combines git history between base..HEAD with the most recent `.artibot/SESSION-NOTES.md` entry. |
| `--stats` | Forwarded to the builder — appends a `git diff base...head --stat` block. Useful for large PRs. |

### Auto-description workflow

When `--auto-description` is passed, the ship agent should:

1. Resolve the base branch (defaults to `master` if not specified)
2. Invoke the builder:
   ```bash
   node plugins/artibot/scripts/build-pr-description.mjs \
     --base master \
     --head HEAD \
     --session-notes .artibot/SESSION-NOTES.md \
     [--stats]
   ```
3. Capture stdout into a heredoc variable
4. Pass it to `gh pr create --body "$(...)"`

The builder is fault-tolerant: git failures or a missing SESSION-NOTES.md
collapse to an empty section rather than aborting. The default flow (no
flag) is unchanged — agents still write the body by hand.

## Phase Mapping

- **Default agent**: `devops-engineer`
- **Candidates**: devops-engineer, doc-updater
- **Toolset**: `devops`

## Context Matchers

This command auto-activates when prompts contain keywords like: deploy, ship, release, 배포, 릴리즈

## Aliases

Cross-reference with legacy commands that map to this lifecycle:
- `/git`

## Implementation

When invoked, this command:
1. Parses the user's request (text after the slash command)
2. Resolves the route via the CLI bridge:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/route-lifecycle.mjs" ship "$ARGUMENTS"
   ```
   This calls `routeLifecycle('ship', { hint })` from `lib/core/lifecycle-router.js` and prints the `{agent, toolset, skills, candidates}` resolution as a single JSON line.
3. Spawns the resolved agent via Agent() tool with the appropriate prompt
4. Reports back with the agent's findings

## Release Surface Checklist

릴리즈는 하나의 단일 이벤트가 아니라 **독립적으로 성공·실패할 수 있는 5개 surface**의 합이다. 한 surface가 통과해도 다른 surface를 추론하지 말 것 — 반드시 각각 별도로 검증한다.

| # | Surface | 검증 명령 | 주의 사항 |
|---|---------|-----------|-----------|
| ① | Source tag | `git tag --list \| grep vX.Y.Z` | 태그가 e2e 포함 풀 테스트 통과 **이후** commit을 가리키는지 확인 |
| ② | CI green (태그 시점 commit 기준) | GitHub Actions → 해당 commit의 workflow run 결과 | release.yml은 태그 push 시점 commit으로 테스트 — 태그를 fix 전 commit에 박으면 release workflow 실패 |
| ③ | GitHub Release page | `gh release view vX.Y.Z` | CI와 별개로 release page 존재·내용 직접 확인 |
| ④ | npm publish | `npm view artibot version` | (해당하는 경우) registry 반영 여부 별도 확인 |
| ⑤ | README badge-sync PR | `gh pr list --search "badge-sync"` | 처리 규율 아래 참조 |

### badge-sync PR 처리 규율

`release.yml`이 자동 생성하는 badge-sync PR은 **무조건 merge 또는 close가 아니라** 내용 판별 후 결정한다:

```
gh pr diff <PR번호>
```

- **구버전 메타(이미 지난 릴리즈 반영분)** → `gh pr close <PR번호>` (merge 금지)
- **직전 릴리즈분(테스트 수·커버리지 등 메타가 최신)** → `gh pr merge <PR번호>` (close 금지)

> 이 규율은 v4.26.1 릴리즈에서 badge-sync PR #64를 실수로 close할 뻔한 실제 사례에서 도출됐다.  
> `gh pr diff`로 변경 내용을 직접 읽어 판별하는 것이 유일한 정답이다.

### 11-지점 lockstep과의 관계

`npm run release` (`release-check.js` 게이트)는 **lockstep 11지점**(package.json·plugin.json·artibot.config.json·README 배지 등 버전 동기화)을 자동 검증한다.  
이 게이트가 커버하는 것 = 버전 숫자 일치 여부.  
이 게이트가 커버하지 않는 것 = CI 실행 결과, gh release page 생성 여부, badge-sync PR 처리 — **위 ①~⑤는 사람이 직접 확인해야 한다**.

## Next Steps

| # | Action | Command | Description |
|---|--------|---------|-------------|
| 1 | Related | `/marketing` | Continue to the next lifecycle phase (Marketing & Growth) |
