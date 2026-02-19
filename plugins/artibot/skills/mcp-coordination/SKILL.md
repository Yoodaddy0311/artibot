---
name: mcp-coordination
description: |
  MCP server selection and multi-server orchestration strategy.
  Auto-activates when: multi-server coordination needed, server selection decisions, complex multi-domain tasks.
  Triggers: MCP, server coordination, multi-server, Context7+Playwright, fallback, orchestration, MCP 조율
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "MCP"
  - "server coordination"
  - "multi-server"
  - "MCP orchestration"
  - "tool coordination"
agents:
  - "orchestrator"
tokens: "~3K"
category: "tooling"
---
# MCP: Coordination

## When This Skill Applies
- Complex tasks requiring multiple MCP servers
- Server selection decisions for optimal tool matching
- Multi-server coordination (parallel or sequential)
- Fallback strategy when servers are unavailable

## Core Guidance

**Server Selection** (see `references/server-selection.md`):
| Server | Primary Use | Activation Signals |
|--------|------------|-------------------|
| Context7 | Library docs, framework patterns | import/require, framework keywords |
| Playwright | E2E testing, performance metrics | test/e2e, browser interaction |
| Sequential | Complex multi-step analysis | debug/trace, system design, --think |
| Magic | UI component generation | component/button/form, JSX patterns |

**Auto-Activation Rules**:
| Pattern | Servers |
|---------|---------|
| External library code | Context7 |
| UI component work | Magic + Context7 |
| E2E test creation | Playwright + Sequential |
| Complex debugging | Sequential + Context7 |
| Full system analysis | All servers |

**Coordination Modes**:
- **Parallel**: Independent aspects of same task (Context7 docs + Playwright testing)
- **Sequential**: Output feeds next (Context7 patterns -> Magic generate -> Playwright test)

**Fallback Strategies** (see `references/fallback-strategies.md`):
| Server Down | Fallback |
|-------------|----------|
| Context7 | WebSearch for documentation |
| Sequential | Native extended thinking |
| Magic | Manual component from Context7 patterns |
| Playwright | Generate test code for local execution |

**Anti-Patterns**: All servers for simple tasks, ignoring failures without fallback, sequential when parallel works, repeating identical queries

## Quick Reference
- Server selection: `references/server-selection.md`
- Fallback strategies: `references/fallback-strategies.md`
- Activate only servers scoring >0.6 relevance
- Cache Context7 lookups (2-5K tokens saved per query)
