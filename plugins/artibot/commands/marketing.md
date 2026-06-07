---
description: (Artibot) Marketing & Growth phase command — routes to candidate agents via lifecycle router
argument-hint: '[task description]'
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Task, TaskCreate]
toolset: marketing
lifecycle: marketing
---

# /marketing

Marketing strategy, content, ads, CRO, SEO, analytics.

## What this command does

Routes the user's request to the appropriate specialist agent for the **marketing** lifecycle phase. Uses `lib/core/lifecycle-router.js` to pick the best agent based on context.

## Usage

```
/marketing [your request]
```

## Phase Mapping

- **Default agent**: `marketing-strategist`
- **Candidates**: marketing-strategist, ad-specialist, content-marketer, cro-specialist, seo-specialist, data-analyst
- **Toolset**: `marketing`

## Context Matchers

This command auto-activates when prompts contain keywords like: marketing, ads, cro, seo, campaign, 마케팅, 광고

## Aliases

Cross-reference with legacy commands that map to this lifecycle:
- `/mkt`
- `/ad`
- `/cro`
- `/seo`
- `/email`
- `/social`
- `/analytics`
- `/crm`

## Implementation

When invoked, this command:
1. Parses the user's request (text after the slash command)
2. Resolves the route via the CLI bridge:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/route-lifecycle.mjs" marketing "$ARGUMENTS"
   ```
   This calls `routeLifecycle('marketing', { hint })` from `lib/core/lifecycle-router.js` and prints the `{agent, toolset, skills, candidates}` resolution as a single JSON line.
3. Spawns the resolved agent via Task() tool with the appropriate prompt
4. Reports back with the agent's findings

## Next Steps

| # | Action | Command | Description |
|---|--------|---------|-------------|
| 1 | Related | `/spec` | Start a new lifecycle cycle (Spec & Requirements) |
