# Artibot Plugin Development Context

Auto-loads when Claude accesses `plugins/artibot/`.

## Stack

Claude Native Agent Teams API (TeamCreate/SendMessage/TaskCreate) + 28 agents + 111 skills + 70 commands. ESM only, `"type": "module"`, zero runtime deps, Node >=20.

## 5-Layer Architecture

| Layer | Dir | Responsibility |
|---|---|---|
| 5 Runtime | `lib/runtime/` | 11-stage middleware, agent factory |
| 4 Cognitive | `lib/cognitive/` | System 1/2 routing, EFFORT_POLICY |
| 3 Learning | `lib/learning/` | GRPO, memory, lifelong, knowledge-transfer |
| 2 Auxiliary | `lib/{adapters,swarm,privacy,visual,git,...}/` | Domain services |
| 1 Core | `lib/core/` | Config, I/O, cache, event-bus, guards |

Upper layers import lower only (5 → 4 → 3 → 2 → 1). Detailed module map: `docs/ARCHITECTURE.md`.

## DEV Protocol (Mandatory)

1. **DECOMPOSE** — numbered atomic items before any action
2. **EXECUTE** — Read target → change → re-read to confirm
3. **VERIFY** — report per item with `file:line` evidence

**Zero-Skip**: never silently drop any part of a multi-part request. If blocked, explain why + propose alternative.

## Operator-Waits DNA (auto-team)

Orchestrator delegates by default. Teammates execute and cross-check.

| Situation | Runner |
|---|---|
| <30 lines, single file, no domain risk | Orchestrator inline |
| ≥2 independent subtasks OR ≥2 files/domains OR medium+ complexity | **Parallel teammates** via `/team` (auto-triggered) |
| Any feature / bugfix / refactor | planner → parallel executors → reviewer |

Violation symptom: "all work done inline by main thread" = DNA breach. Opt-out: `--no-team` in prompt, or `team.autoApply: false` in `artibot.config.json`.

**Claude 4.8 dynamic workflows**: 4.8 natively supports dynamic workflows — ultracode (xhigh effort + always-on multi-agent permission via mid-conversation system messages) makes large-scale parallel delegation a model-level capability. Artibot's Operator-Waits DNA still owns the *automatic* trigger: parallel teams fire on intent without the user typing `/team`.

**Canonical evaluator**: the team trigger AND per-teammate effort/budget are both derived from one complexity classification by `lib/cognitive/workflow-plan.js#buildWorkflowPlan`; the numeric thresholds live only in `artibot.config.json#/team/autoApplyTriggers` (the table above is a summary).

## Auto-invoke Principle

Never tell the user to type slash-commands. Detect intent → trigger command/skill/agent silently. Users include non-developers. Applies to `/team`, `/implement`, `/plan`, `/code-review`, `/verify`, `/daily` — all commands. Inner command workflows (phases, checklists) must run in full, never shortened.

## Quality Gates

- Read before write (no blind modifications)
- Functions < 50 lines, files < 800 lines
- Immutable patterns (spread/create new, never mutate)
- 80%+ coverage target; current thresholds: Statements 90 / Branches 85 / Functions 88 / Lines 90

## Context Efficiency

- Instruction files ≤ 4K chars each, ≤ 12K chars total
- Front-load critical info in first 160 chars of outputs (compaction survival)
- Static instructions above dynamic context (cache hit rate)

## Testing

```
npm test               # 4,918 tests via vitest
npm run test:coverage
npm run lint           # 0 errors/warnings target
npm run ci             # validate + skill:check + lint + test + eval:runtime
```

Config: `artibot.config.json` (model policy, team, cognitive). Manifest: `.claude-plugin/plugin.json`.

## Artibot Integration

See `~/.claude/rules/artibot/` for DEV Protocol, Agent Delegation, Quality Gates, and team auto-apply rules.
