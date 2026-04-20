---
description: (Artibot) Review & Quality phase command — routes to candidate agents via lifecycle router
argument-hint: '[task description]'
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Task, TaskCreate]
toolset: code
lifecycle: review
---

# /review

Code review, security audit, spec compliance.

## What this command does

Routes the user's request to the appropriate specialist agent for the **review** lifecycle phase. Uses `lib/core/lifecycle-router.js` to pick the best agent based on context.

## Usage

```
/review [your request]
```

## Phase Mapping

- **Default agent**: `code-reviewer`
- **Candidates**: code-reviewer, security-reviewer, spec-reviewer, quality-reviewer
- **Toolset**: `code`

## Context Matchers

This command auto-activates when prompts contain keywords like: review, audit, security, 리뷰, 보안

## Aliases

Cross-reference with legacy commands that map to this lifecycle:
- `/code-review`
- `/adversarial-review`

## Implementation

When invoked, this command:
1. Parses the user's request (text after the slash command)
2. Calls `routeLifecycle('review', { hint: requestText })` from `lib/core/lifecycle-router.js`
3. Spawns the resolved agent via Task() tool with the appropriate prompt
4. Reports back with the agent's findings

## Next Steps

| # | Action | Command | Description |
|---|--------|---------|-------------|
| 1 | Related | `/ship` | Continue to the next lifecycle phase (Ship & Deploy) |
