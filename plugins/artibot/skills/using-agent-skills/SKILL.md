---
name: using-agent-skills
context: fork
user-invocable: false
level: 1
description: "Discovery flowchart for Artibot's 102 skills. Use this as orientation when the user asks 'what skills do you have', 'how do I do X', 'what commands are available', or when picking the right tool for an unfamiliar task."
platforms: [claude-code, gemini-cli, codex-cli, cursor]
triggers:
  - "how do I"
  - "what skills"
  - "available commands"
  - "list skills"
  - "어떤 스킬"
  - "어떤 명령어"
  - "사용 가능한"
allowed-tools: [Read, Grep, Glob]
tokens: "~2K"
category: "meta"
agents: [orchestrator, planner]
whenNotToUse: "Inside an active skill — discovery is for orientation, not work. If you already know which skill applies, jump straight to it."
---

# Using Agent Skills (Meta-Skill)

A discovery aid for Artibot's skill catalog. **Do not** stay here once you know what to pick — read this, decide, then leave.

## Pick by intent (top of the flowchart)

| Intent | Start with | Cluster |
|---|---|---|
| "Plan a feature / break it down" | `planner` agent + `spec-format` | Planning |
| "Write code with tests-first" | `tdd-guide` agent + `tdd-workflow` | Implementation |
| "Review what I just wrote" | `code-reviewer` agent + `production-code-audit` | Review |
| "Refactor / simplify existing code" | `refactor-cleaner` agent + `fp-refactor` | Refactor |
| "Pick architecture / module boundaries" | `architect` agent + `persona-architect` | Architecture |
| "Find a bug systematically" | `systematic-debugging` + `verification-completion` | Debug |
| "Audit security / dependencies" | `security-reviewer` agent + `security-standards` | Security |
| "Run a coordinated multi-agent task" | `/team` (auto-triggered) + `multi-agent-patterns` | Orchestration |
| "Research a library / API surface" | `context7` MCP + `source-driven-development` | Research |
| "Write docs / README / changelog" | `doc-updater` agent + `coding-standards` | Docs |

## 7 lifecycle commands (Artibot autopilot phases)

| # | Command | Phase |
|---|---|---|
| 1 | `/plan` | PLAN — decompose request, draft adoption matrix |
| 2 | `/implement` | EXECUTE — squads run in parallel against file allowlist |
| 3 | `/code-review` | REVIEW — DEV-protocol cross-check |
| 4 | `/verify` | VERIFY — `npm run ci` + acceptance evidence |
| 5 | `/improve` | IMPROVE — prune backlog, tighten docs |
| 6 | `/team` | TEAM — multi-agent parallelism (auto-triggered when ≥2 subtasks) |
| 7 | `/daily` | DAILY — session digest, memory rotation |

These are **auto-invoked** — users never need to type them. The meta-rule from `CLAUDE.md`: detect intent → trigger silently.

## Skill clusters (top of `plugins/artibot/skills/`)

| Cluster | Purpose | Sample skills |
|---|---|---|
| Planning | Decompose / spec / estimate | `spec-format`, `clarify`, `polish` |
| Implementation | TDD, language ergonomics | `tdd-workflow`, `coding-standards`, `fp-refactor` |
| Review | Quality + security audit | `production-code-audit`, `code-slop-reviewer`, `security-standards` |
| Cognitive | System 1/2 routing, effort policy | `cognitive-routing`, `compaction-survival` |
| Orchestration | Team API + delegation | `multi-agent-patterns`, `delegation`, `tool-design` |
| Memory & Learning | Session memory, swarm | `memory-management`, `agent-memory-snapshot`, `continuous-learning` |
| DDD / Architecture | Tactical + strategic design | `ddd-tactical-design`, `persona-architect` |
| Marketing / Growth | Ads, SEO, content | `advertising`, `content-seo`, `cro-forms` |
| Meta | Discovery, this file | `using-agent-skills` |

Full count: 102 skills under `plugins/artibot/skills/`. Use `Glob "plugins/artibot/skills/*/SKILL.md"` to enumerate.

## Decision flowchart

```
User asks something
        │
        ▼
Is it about a SPECIFIC skill domain (security/perf/test/UI)?
        │
   ┌────┴────┐
   │ Yes     │ No
   ▼         ▼
Jump to     Is it ≥2 independent subtasks?
that skill        │
              ┌───┴───┐
              │ Yes   │ No
              ▼       ▼
            /team    Pick by intent (table above)
                     │
                     ▼
                Use the matching agent + skill
```

## Anti-patterns (do not do)

- Re-reading this file mid-task ("just to double-check"). Pick once, leave.
- Asking the user "which skill do you want?" — that violates the auto-invoke principle. Detect intent and trigger silently.
- Listing all 102 skills to the user. Show only the 3-5 relevant ones with one-line descriptions.

## Where to look next

- `plugins/artibot/AGENTS.md` — agent roster + when each is best
- `plugins/artibot/CLAUDE.md` — DEV protocol + auto-team rules
- `docs/ARCHITECTURE.md` — 5-layer module map
