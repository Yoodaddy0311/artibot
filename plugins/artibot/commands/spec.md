---
description: (Artibot) Spec & Requirements phase command — routes to candidate agents via lifecycle router
argument-hint: '[task description]'
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Task, TaskCreate]
toolset: meta
lifecycle: spec
---

# /spec

Define requirements, acceptance criteria, and user stories.

## What this command does

Routes the user's request to the appropriate specialist agent for the **spec** lifecycle phase. Uses `lib/core/lifecycle-router.js` to pick the best agent based on context.

## Usage

```
/spec [your request]
```

## Phase Mapping

- **Default agent**: `null` (no default — awaits candidate registration)
- **Candidates**: (none registered yet)
- **Toolset**: `meta`

## Context Matchers

This command auto-activates when prompts contain keywords like: spec, requirement, acceptance criteria, user story, 스펙, 요구사항

## Aliases

No legacy alias.

## Implementation

When invoked, this command:
1. Parses the user's request (text after the slash command)
2. Calls `routeLifecycle('spec', { hint: requestText })` from `lib/core/lifecycle-router.js`
3. Spawns the resolved agent via Task() tool with the appropriate prompt
4. Reports back with the agent's findings

## Next Steps

| # | Action | Command | Description |
|---|--------|---------|-------------|
| 1 | Related | `/plan` | Continue to the next lifecycle phase (Plan & Architecture) |
