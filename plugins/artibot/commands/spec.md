---
description: (Artibot) Spec & Requirements phase command — asks the lifecycle router for a spec agent; with none registered, the main session writes the spec
argument-hint: '[task description]'
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, TaskCreate]
toolset: meta
lifecycle: spec
---

# /spec

Define requirements, acceptance criteria, and user stories.

## What this command does

Resolves the **spec** lifecycle route with `lib/core/lifecycle-router.js`. If the route names an agent, the request goes to that agent; if it names none (`agent: null`, the case today, since the spec phase has no default agent and no candidates), the main session writes the spec itself (Implementation step 4).

## Usage

```
/spec [your request]
```

## Phase Mapping

- **Default agent**: `null` (no default — awaits candidate registration; until then the main session writes the spec, see Implementation step 4)
- **Candidates**: (none registered yet)
- **Toolset**: `meta`

## Context Matchers

This command auto-activates when prompts contain keywords like: spec, requirement, acceptance criteria, user story, 스펙, 요구사항

## Aliases

No legacy alias.

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
   node "<pluginRoot>/scripts/route-lifecycle.mjs" spec "$ARGUMENTS"
   ```
   This calls `routeLifecycle('spec', { hint })` from `lib/core/lifecycle-router.js` and prints the `{agent, toolset, skills, candidates}` resolution as a single JSON line.
4. Acts on the resolution:
   - **`agent` is a name**: spawn that agent via the Agent() tool with the request and the resolved `skills`.
   - **`agent` is `null`** — the expected result today, because the spec phase has no default agent and no candidates (`lifecycle.json#/lifecycles/spec`; measured 2026-11-21: `{"lifecycle":"spec","agent":null,"toolset":"meta","skills":[],"candidates":[]}`): there is nobody to spawn. Do **not** invent an agent or pick one from another phase. The main session writes the spec itself, following the `spec-format` skill (requirements, EARS acceptance criteria, user stories), and says in one sentence that no spec specialist is registered so the spec was written directly.
   - **The finder printed `artibot plugin root not found - run /update`, or the command failed**: say so in one line and continue as for `agent: null`.
5. Reports back with the spec (or the agent's findings)

## Next Steps

| # | Action | Command | Description |
|---|--------|---------|-------------|
| 1 | Related | `/plan` | Continue to the next lifecycle phase (Plan & Architecture) |
