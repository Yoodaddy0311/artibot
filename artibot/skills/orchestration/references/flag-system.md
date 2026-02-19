# Flag System

> Flag activation rules, precedence, and auto-detection patterns.

## Flag Precedence Rules

1. Safety flags (`--safe-mode`) override optimization flags
2. Explicit flags override auto-activation
3. Thinking depth: `--ultrathink` > `--think-hard` > `--think`
4. `--no-mcp` overrides all individual MCP flags
5. Scope: system > project > module > file
6. Last specified persona takes precedence
7. `--uc` auto-activation overrides verbose flags

## Planning & Analysis Flags

| Flag | Token Budget | Auto-Activates When | Enables |
|------|-------------|---------------------|---------|
| `--plan` | +1K | Explicit only | Execution plan display |
| `--think` | ~4K | Import chains >5 files, cross-module >10 refs | --seq |
| `--think-hard` | ~10K | System refactoring, bottlenecks >3 modules | --seq --c7 |
| `--ultrathink` | ~32K | Legacy modernization, critical vulnerabilities | --seq --c7 --all-mcp |

## Compression Flags

| Flag | Effect | Auto-Activates When |
|------|--------|---------------------|
| `--uc` | 30-50% token reduction | Context >75%, large operations |
| `--answer-only` | Direct response only | Explicit only |
| `--verbose` | Maximum detail | Explicit only |
| `--validate` | Pre-operation validation | Risk >0.7, resources >75% |
| `--safe-mode` | Maximum safety | Resources >85%, production env |

## MCP Server Flags

| Flag | Server | Auto-Activates When |
|------|--------|---------------------|
| `--c7` | Context7 | External imports, framework questions |
| `--seq` | Sequential | Complex debugging, --think flags |
| `--magic` | Magic | UI component requests, JSX patterns |
| `--play` | Playwright | E2E testing, browser automation |
| `--all-mcp` | All servers | Complexity >0.8, multi-domain |
| `--no-mcp` | None | Explicit only, 40-60% faster |

## Scope & Focus Flags

| Flag | Values | Usage |
|------|--------|-------|
| `--scope` | file, module, project, system | Analysis boundary |
| `--focus` | performance, security, quality, architecture, accessibility, testing | Analysis domain |

## Delegation Flags

| Flag | Effect | Auto-Activates When |
|------|--------|---------------------|
| `--delegate files` | File-level sub-agents | >50 files |
| `--delegate folders` | Directory-level sub-agents | >7 directories |
| `--delegate auto` | Auto-detect strategy | Complex structures |
| `--concurrency N` | Max parallel agents (1-15) | Default: 7 |

## Persona Flags

| Flag | Persona |
|------|---------|
| `--persona-architect` | Systems architecture |
| `--persona-frontend` | UX, accessibility |
| `--persona-backend` | Reliability, APIs |
| `--persona-analyzer` | Root cause analysis |
| `--persona-security` | Threat modeling |
| `--persona-mentor` | Knowledge transfer |
| `--persona-refactorer` | Code quality |
| `--persona-performance` | Optimization |
| `--persona-qa` | Testing, quality |
| `--persona-devops` | Infrastructure |
| `--persona-scribe=lang` | Documentation |

## Auto-Activation Patterns

### Context-Based Triggers

| Condition | Flags Activated |
|-----------|----------------|
| Performance issues | --persona-performance + --focus performance + --think |
| Security concerns | --persona-security + --focus security + --validate |
| UI/UX tasks | --persona-frontend + --magic + --c7 |
| Complex debugging | --think + --seq + --persona-analyzer |
| Large codebase | --uc + --delegate auto |
| Testing operations | --persona-qa + --play + --validate |
| Refactoring | --persona-refactorer + --validate |

### MCP Auto-Activation Detection

**Context7**: `import`, `require`, `from`, `use` statements; framework keywords
**Sequential**: debug/trace/analyze keywords; nested conditionals; async chains
**Magic**: component/button/form keywords; JSX patterns; accessibility requirements
**Playwright**: test/e2e keywords; performance monitoring; cross-browser requirements
