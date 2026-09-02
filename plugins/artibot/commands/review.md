---
description: (Artibot) Review & Quality phase command — routes to candidate agents via lifecycle router
argument-hint: '[task description]'
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, TaskCreate]
toolset: code
lifecycle: review
---

# /review

Code review, security audit, spec compliance.

## What this command does

Routes the user's request to the **review** lifecycle phase via `lib/core/lifecycle-router.js`. The router does **not** read the request text: `lib/core/lifecycle-router.js#pickAgent` honours only `context.preferredAgent`, and the CLI bridge passes only `{ hint }`, so the resolution is always the default agent `code-reviewer` (measured 2026-09-02 with no hint, "security audit of auth", and "spec compliance check"). `code-reviewer` itself runs spec-reviewer and quality-reviewer in sequence. To reach `security-reviewer` today, use `/adversarial-review` (spawns it alongside code-reviewer) or spawn it by name with `Agent(subagent_type="artibot:security-reviewer")`; `spec-reviewer` / `quality-reviewer` can likewise be spawned by name.

## Usage

```
/review [your request]
```

## Phase Mapping

- **Default agent**: `code-reviewer`
- **Candidates**: code-reviewer, security-reviewer, spec-reviewer, quality-reviewer
- **Toolset**: `code`

## Context Matchers

Manifest `context_matchers` for this phase: review, audit, security, 리뷰, 보안. They are consumed only by `routeByContext` in the router module — no hook calls it, so there is **no automatic activation** today (measured 2026-09-02).

## Aliases

Cross-reference with legacy commands that map to this lifecycle:
- `/code-review`
- `/adversarial-review`

## Implementation

When invoked, this command:
1. Parses the user's request (text after the slash command)
2. Resolves the route via the CLI bridge:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/route-lifecycle.mjs" review "$ARGUMENTS"
   ```
   This calls `routeLifecycle('review', { hint })` from `lib/core/lifecycle-router.js` and prints the `{agent, toolset, skills, candidates}` resolution as a single JSON line. `hint` is not consulted by `pickAgent`; `agent` is always `code-reviewer` and `candidates` lists the other three for the leader to choose from.
3. Spawns the resolved agent via Agent() tool with the appropriate prompt
4. Reports back with the agent's findings

## Next Steps

| # | Action | Command | Description |
|---|--------|---------|-------------|
| 1 | Related | `/ship` | Continue to the next lifecycle phase (Ship & Deploy) |
