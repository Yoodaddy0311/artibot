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
```

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
