# Artibot Plugin Development Context

This file auto-loads when Claude accesses files in `plugins/artibot/`.

## Architecture

- **Engine**: Claude Native Agent Teams API (TeamCreate, SendMessage, TaskCreate)
- **Agents**: 26 specialized agents in `agents/` (opus 73%, sonnet 27%)
- **Cognitive Core**: Dual-process routing in `lib/cognitive/` (System 1 fast / System 2 deliberate)
- **Learning Pipeline**: `lib/learning/` (GRPO self-eval, memory, knowledge-transfer, lifelong)
- **Swarm**: `lib/swarm/` (federated collective learning across instances)

## Module Map

| Directory | Purpose | Key Files |
|-----------|---------|-----------|
| `agents/` | Agent definitions (26 .md) | orchestrator.md (CTO), planner.md |
| `commands/` | Slash commands (43 .md) | sc.md (router), implement.md, build.md |
| `skills/` | SKILL.md + references/ (79 dirs) | principles/, tdd-workflow/, coding-standards/ |
| `lib/cognitive/` | Dual-process engine | router.js, system1.js, system2-core.js |
| `lib/learning/` | Lifelong learning (9 modules) | grpo.js, memory.js, lifelong.js |
| `lib/core/` | Core utilities (21 files) | plugin-loader.js, hook-utils.js |
| `lib/visual/` | Visual validation | visual-validator.js, screenshot-differ.js |
| `lib/privacy/` | PII protection | pii-scrubber.js, homoglyph-detector.js |
| `hooks/` | Event hooks config | hooks.json (14 event types) |
| `rules/` | Path-specific auto-rules | dev-protocol.md, quality-gates.md |
| `tests/` | Vitest test suite (71 files) | 2,933 test cases |

## Development Standards

- **ESM only**: All `.js` files use `import/export`, `"type": "module"` in package.json
- **Zero runtime deps**: Only devDependencies (vitest, eslint, c8)
- **Coverage thresholds**: Statements 90%, Branches 85%, Functions 88%, Lines 90%
- **Immutable patterns**: Never mutate objects, always spread/create new
- **Functions < 50 lines, Files < 800 lines**

## Testing

```bash
npm test              # Run all 2,933 tests
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
