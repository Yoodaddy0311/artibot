---
description: (Artibot) Marketing & Growth phase command — routes to candidate agents via lifecycle router
argument-hint: '[task description]'
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, TaskCreate]
toolset: marketing
lifecycle: marketing
---

# /marketing

> **vs /mkt**: `/marketing` is a **lifecycle router** — routes to the best specialist agent for the current context. `/mkt` produces a **full marketing strategy document** (market analysis, competitive intelligence, campaign architecture).

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
2. Finds the plugin root. The working directory is the user's project, not this plugin, and `CLAUDE_PLUGIN_ROOT` is often empty in the Bash tool, so run this once and use the absolute path it prints as `<pluginRoot>`, quoted:
   ```bash
   F="scripts/route-lifecycle.mjs"; R=""; P="$HOME/.claude/plugins"; T="${CLAUDE_PLUGIN_ROOT}"
   for d in plugins/artibot .; do [ -f "$d/$F" ] && grep -q '"name"[[:space:]]*:[[:space:]]*"artibot"' "$d/.claude-plugin/plugin.json" 2>/dev/null && R="$d" && break; done
   [ -z "$R" ] && [ -n "$T" ] && [ -f "$T/$F" ] && R="$T"
   [ -z "$R" ] && for v in $(ls -1 "$P/cache/artibot/artibot" 2>/dev/null | sort -t. -k1,1nr -k2,2nr -k3,3nr); do [ -f "$P/cache/artibot/artibot/$v/$F" ] && R="$P/cache/artibot/artibot/$v" && break; done
   [ -z "$R" ] && for m in $(ls -1 "$P/marketplaces" 2>/dev/null); do [ -f "$P/marketplaces/$m/plugins/artibot/$F" ] && R="$P/marketplaces/$m/plugins/artibot" && break; done
   [ -n "$R" ] && (cd "$R" && { pwd -W 2>/dev/null || pwd; }) || echo "artibot plugin root not found - run /update"
   ```
3. Resolves the route via the CLI bridge:
   ```bash
   node "<pluginRoot>/scripts/route-lifecycle.mjs" marketing "$ARGUMENTS"
   ```
   This calls `routeLifecycle('marketing', { hint })` from `lib/core/lifecycle-router.js` and prints the `{agent, toolset, skills, candidates}` resolution as a single JSON line. If the finder prints `artibot plugin root not found - run /update` or the command fails, say so in one line and use the default agent from Phase Mapping.
4. Spawns the resolved agent via Agent() tool with the appropriate prompt
5. Reports back with the agent's findings

## Next Steps

| # | Action | Command | Description |
|---|--------|---------|-------------|
| 1 | Related | `/spec` | Start a new lifecycle cycle (Spec & Requirements) |
