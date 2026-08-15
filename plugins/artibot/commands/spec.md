---
description: (Artibot) Spec & Requirements phase command — routes to candidate agents via lifecycle router
argument-hint: '[task description]'
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, TaskCreate]
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
2. Resolves the route via the CLI bridge:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/route-lifecycle.mjs" spec "$ARGUMENTS"
   ```
   This calls `routeLifecycle('spec', { hint })` from `lib/core/lifecycle-router.js` and prints the `{agent, toolset, skills, candidates}` resolution as a single JSON line.
3. Spawns the resolved agent via Agent() tool with the appropriate prompt
4. Reports back with the agent's findings

## Next Steps

| # | Action | Command | Description |
|---|--------|---------|-------------|
| 1 | Related | `/plan` | Continue to the next lifecycle phase (Plan & Architecture) |
