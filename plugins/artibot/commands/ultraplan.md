---
description: (Artibot) Alias for /plan with autopilot scaffolding — Claude Code naming compat
argument-hint: '[task] e.g. "결제 시스템 구현 계획"'
allowed-tools: [Read, Glob, Grep, Bash, Task, TaskCreate]
toolset: team
lifecycle: plan
---

# /ultraplan

Upstream Claude Code naming alias. Routes directly to Artibot's `/plan`, which decomposes work into phases with risk identification and dependency tracking. For long-running autonomous execution, follow up with `/autopilot`.

Run `/plan $ARGUMENTS` with the same arguments. If the task warrants autonomous multi-phase execution, the planner agent will recommend `/autopilot` as the next step.
