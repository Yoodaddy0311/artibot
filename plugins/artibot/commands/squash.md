---
description: (Artibot) Squash contiguous WIP commits at HEAD into a single commit before push
argument-hint: '[--from <ref>] [--message <text>] [--dry-run]'
allowed-tools: [Read, Bash]
toolset: devops
---

# /squash

Collapse the run of `wip:` / `WIP` commits at the tip of the current branch
into one clean commit so push history stays readable. Autopilot's WIP commits
accumulate silently between sessions (interval = 120m, squashWipOnClose =
false by default since v4.7.8); this command is the manual squash gate.

## When to run

- After SessionStart shows `[artibot:wip] N WIP commit(s) ...` advisory
- Before `git push` or `/git pr`
- Before opening a code review

## Arguments

Parse $ARGUMENTS:

- `--from <ref>`  — Squash only the WIP run reachable from `<ref>..HEAD`.
  Use this when the auto-detected contiguous run is too aggressive.
- `--message <text>` — Override the synthesized squash commit message.
- `--dry-run` — Print the plan and exit without rewriting history.

## Execution Flow

1. **Pre-check** (read-only)
   - Confirm current branch via `git rev-parse --abbrev-ref HEAD`
   - Confirm working tree is clean (`git status --porcelain --untracked-files=no` is empty)
   - Refuse to run on `main` / `master` / `release/*` unless user explicitly confirms
2. **Plan** (always dry-run first)
   - Invoke: `node plugins/artibot/scripts/squash-wip.mjs --dry-run` (forward any user `--from`)
   - Show the user the planned commit count and base ref
3. **Apply** (only after user confirms or `--dry-run` was the original ask)
   - Invoke: `node plugins/artibot/scripts/squash-wip.mjs` (forward `--from` / `--message`)
   - Re-run `git log --oneline -5` so the user sees the new tip
4. **Verify**
   - If exit code is non-zero, report the script's stdout message verbatim
   - Never auto-`git push` — the user owns the push decision

## Safety Net

The backing script aborts when:

- Non-WIP commits are interleaved with WIP commits (your intentional work is
  protected — surfaces an `abort-mixed` message)
- The working tree is dirty (staged or unstaged changes exist)
- Only one WIP commit exists at HEAD (a squash would be a no-op)

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | Squash committed (or dry-run plan emitted) |
| 1 | Aborted (mixed history, dirty tree, or git error) |
| 2 | Nothing to do (zero or one WIP commit at HEAD) |

## Output Format

```
SQUASH WIP
==========
Branch:   [current-branch]
WIP run:  [N commit(s)] @ HEAD~N
Action:   [dry-run | applied | aborted]
Result:   [verbatim script message]
```

## Environment Variables

Threshold tuning for the SessionStart advisory line (read by
`lib/autopilot/wip-stats.js`):

| Variable | Default | Effect |
|----------|---------|--------|
| `ARTIBOT_WIP_COUNT_THRESHOLD` | `10` | Min commit count to surface advisory |
| `ARTIBOT_WIP_AGE_HOURS` | `4` | Min oldest-WIP age (hours) to surface advisory |

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 푸시 | `/git --op push` | 정리된 히스토리를 원격에 반영 |
| 2 | PR 생성 | `/git pr` | squash 결과로 깔끔한 PR 본문 |
| 3 | 체크포인트 | `/checkpoint pre-push` | squash 후 상태 스냅샷 저장 |
