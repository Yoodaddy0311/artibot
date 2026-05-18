---
description: (Artibot) Ship & Deploy phase command — routes to candidate agents via lifecycle router
argument-hint: '[task description]'
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Task, TaskCreate]
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
2. Calls `routeLifecycle('ship', { hint: requestText })` from `lib/core/lifecycle-router.js`
3. Spawns the resolved agent via Task() tool with the appropriate prompt
4. Reports back with the agent's findings

## Next Steps

| # | Action | Command | Description |
|---|--------|---------|-------------|
| 1 | Related | `/marketing` | Continue to the next lifecycle phase (Marketing & Growth) |
