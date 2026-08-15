---
description: (Artibot) Alias for /adversarial-review — multi-agent attacker-perspective review (Claude Code naming compat)
argument-hint: '[target] e.g. "src/ 적대적 리뷰해줘"'
allowed-tools: [Read, Glob, Grep, Bash, Agent, TaskCreate]
toolset: code
---

# /ultrareview

Upstream Claude Code naming alias. Routes directly to Artibot's `/adversarial-review`, which performs an 8-attack-surface audit with `code-reviewer` + `security-reviewer` agents in parallel and OWASP Top 10 cross-check.

Run `/adversarial-review $ARGUMENTS` with the same arguments.
