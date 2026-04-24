# Artibot Plugin Development Context

Auto-loads when Claude accesses `plugins/artibot/`.

## Stack

Claude Native Agent Teams API (TeamCreate/SendMessage/TaskCreate) + 28 agents + 100 skills + 56 commands. ESM only, `"type": "module"`, zero runtime deps, Node >=20.

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

**Claude 4.7 override**: 4.7 reduces sub-agents by default. This policy explicitly reverses that default for this repo.

## Agent Delegation Rules

- Complex features → `planner` agent first
- After writing code → `code-reviewer` agent
- Bug fixes / new features → `tdd-guide` agent
- Architecture decisions → `architect` agent
- Multiple independent tasks → parallel agents

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

### DEV Protocol (Mandatory for all code changes)
1. **DECOMPOSE**: Break request into numbered atomic items before any action
2. **EXECUTE**: Read target file → Make change → Re-read to confirm
3. **VERIFY**: Report with evidence per item (file:line + what changed)

### Zero-Skip Policy
- Never silently skip any part of a multi-part request
- Never claim completion without re-reading the modified file
- If blocked, explain WHY and propose alternatives

### Agent Delegation
- Complex features: use planner agent first
- After writing code: use code-reviewer agent
- Bug fixes / new features: use tdd-guide agent
- Architecture decisions: use architect agent
- Multiple independent tasks: launch agents in parallel

### Quality Gates
- Read before write (no blind modifications)
- Functions < 50 lines, files < 800 lines
- Immutable patterns (create new objects, never mutate)
- 80%+ test coverage target
