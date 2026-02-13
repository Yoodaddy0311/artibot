# Flag System Reference

## Thinking Flags (Mutually Exclusive -- Highest Wins)

| Flag | Depth | Tokens | Auto-Enables | Use Case |
|------|-------|--------|-------------|----------|
| `--think` | Module | ~4K | --seq, analyzer | Multi-file analysis, >5 imports |
| `--think-hard` | System | ~10K | --seq, --c7, architect | Cross-module refactoring, >3 modules |
| `--ultrathink` | Critical | ~32K | --all-mcp, comprehensive | Legacy modernization, critical vuln |

## MCP Server Flags

| Flag | Server | Auto-Activates When |
|------|--------|---------------------|
| `--c7` | Context7 | External imports, framework questions |
| `--seq` | Sequential | Complex debugging, --think flags |
| `--magic` | Magic | UI component requests, JSX patterns |
| `--play` | Playwright | E2E testing, performance monitoring |
| `--all-mcp` | All servers | complexity >0.8, multi-domain |
| `--no-mcp` | None | Speed priority, 40-60% faster |

## Operational Flags

| Flag | Effect | Auto-Activates When |
|------|--------|---------------------|
| `--plan` | Show execution plan before acting | Explicit only |
| `--uc` | 30-50% token reduction | Context >75%, large operations |
| `--validate` | Pre-operation risk assessment | Risk >0.7, resources >75% |
| `--safe-mode` | Maximum validation, conservative | Resources >85%, production |
| `--delegate` | Sub-agent parallel processing | >7 dirs OR >50 files |
| `--loop` | Iterative improvement cycles | polish, refine, enhance keywords |
| `--wave-mode` | Multi-stage orchestration | complexity >0.7, files >20 |

## Precedence Rules (Highest First)
1. Safety flags (`--safe-mode`) override optimization
2. Explicit flags override auto-activation
3. `--ultrathink` > `--think-hard` > `--think`
4. `--no-mcp` overrides all MCP flags
5. Scope: system > project > module > file
6. Last persona flag wins
7. `--uc` auto-activation overrides verbose
