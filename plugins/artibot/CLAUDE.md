# Artibot Plugin Development Context

This file auto-loads when Claude accesses files in `plugins/artibot/`.

## Architecture

- **Engine**: Claude Native Agent Teams API (TeamCreate, SendMessage, TaskCreate)
- **Agents**: 28 specialized agents in `agents/` (opus 73%, sonnet 27%)
- **Cognitive Core**: Dual-process routing in `lib/cognitive/` (System 1 fast / System 2 deliberate)
- **Learning Pipeline**: `lib/learning/` (GRPO self-eval, memory, knowledge-transfer, lifelong)
- **Swarm**: `lib/swarm/` (federated collective learning across instances)

## 5-Layer Architecture

```
Layer 5 (Runtime):    lib/runtime/    — 11-stage middleware pipeline, agent factory
Layer 4 (Cognitive):  lib/cognitive/  — System 1/2 dual-process routing
Layer 3 (Learning):   lib/learning/   — GRPO, memory, knowledge-transfer, lifelong
Layer 2 (Auxiliary):  lib/adapters/, lib/swarm/, lib/privacy/, lib/orchestration/, lib/intent/, lib/visual/, lib/git/, lib/context/, lib/sdk/, lib/system/, lib/tools/
Layer 1 (Core):       lib/core/       — config, cache, I/O, lifecycle, event-bus, guard-registry
```

**Dependency direction**: Upper layers import lower layers only (Layer 5 → 4 → 3 → 2 → 1).

| Layer | Responsibility |
|-------|---------------|
| **5 — Runtime** | Request lifecycle: middleware pipeline orchestrates agent creation, evaluation, and response |
| **4 — Cognitive** | Intent classification: routes requests to System 1 (fast/intuitive) or System 2 (deliberate) |
| **3 — Learning** | Self-improvement: GRPO self-eval, memory persistence, cross-session knowledge transfer |
| **2 — Auxiliary** | Domain services: platform adapters, swarm federation, privacy scrubbing, visual validation |
| **1 — Core** | Foundation: config loading, file I/O, caching, event bus, guard registry, debug utilities |

## Module Map

| Directory | Purpose | Key Files |
|-----------|---------|-----------|
| `agents/` | Agent definitions (28 .md) | orchestrator.md (CTO), planner.md |
| `commands/` | Slash commands (50 .md) | sc.md (router), implement.md, build.md, repo.md |
| `skills/` | SKILL.md + references/ (117 dirs) | principles/, tdd-workflow/, coding-standards/ |
| `lib/cognitive/` | Dual-process engine | router.js, system1.js, system2-core.js |
| `lib/learning/` | Lifelong learning (26 modules) | grpo.js, memory.js, lifelong.js, skill-promoter.js, eval-calibrator.js, skill-freshness.js |
| `lib/core/` | Core utilities (32 files) | plugin-loader.js, hook-utils.js, feature-tracker.js |
| `lib/visual/` | Visual validation | visual-validator.js, screenshot-differ.js |
| `lib/privacy/` | PII protection | pii-scrubber.js, homoglyph-detector.js |
| `lib/runtime/` | Runtime pipeline (15 files, 11 middlewares) | create-artibot-agent.js, evaluator.js, middleware/, sprint-contract.js |
| `hooks/` | Event hooks config | hooks.json (15 event types, 39 registrations) |
| `rules/` | Path-specific auto-rules | dev-protocol.md, quality-gates.md |
| `tests/` | Vitest test suite (147 files) | 4,918 test cases |

## Development Standards

- **ESM only**: All `.js` files use `import/export`, `"type": "module"` in package.json
- **Zero runtime deps**: Only devDependencies (vitest, eslint, c8)
- **Coverage thresholds**: Statements 90%, Branches 85%, Functions 88%, Lines 90%
- **Immutable patterns**: Never mutate objects, always spread/create new
- **Functions < 50 lines, Files < 800 lines**

## Context Efficiency

- **Instruction budget**: Individual files <= 4K chars, total <= 12K chars across all instruction files
- **Token estimation**: `chars / 4 + 1` heuristic for quick budget calculations
- **Compaction survival**: Front-load critical info in first 160 chars of outputs
- **Key file extraction**: Always use full paths with extensions (e.g., `lib/core/metrics-collector.js`)
- **Recent message preservation**: Last 4 messages survive compaction verbatim
- **Prompt caching**: Static instructions above dynamic context for cache hit rate

## Testing

```bash
npm test              # Run all 4,918 tests
npm run test:coverage # Coverage report
npm run test:bench    # 27 benchmarks
npm run lint          # ESLint (0 errors, 0 warnings target)
```

## Config Files

- `artibot.config.json` — Central config (model policy, team settings, cognitive params)
- `.claude-plugin/plugin.json` — Plugin manifest (version, agent/command/skill/rule paths)
- `package.json` — Node.js ESM project config
- `.mcp.json` — MCP server config (Context7, Playwright)

## Naming Conventions

- Agents: `kebab-case.md` (e.g., `frontend-developer.md`)
- Commands: `kebab-case.md` matching slash command name
- Skills: `kebab-case/SKILL.md` with optional `references/` dir
- Lib modules: `kebab-case.js` with JSDoc comments
- Tests: `*.test.js` mirroring source structure in `tests/`

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
