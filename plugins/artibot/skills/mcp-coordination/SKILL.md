---
context: forked
name: mcp-coordination
description: "Coordinates MCP server selection and multi-server orchestration with parallel/sequential modes and fallback strategies for complex multi-domain tasks. Use when user asks about MCP coordination, server selection, multi-server orchestration, tool coordination, fallback strategy, or MCP 조율."
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

**Server Selection** (see `${CLAUDE_SKILL_DIR}/references/server-selection.md`):
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

**Fallback Strategies** (see `${CLAUDE_SKILL_DIR}/references/fallback-strategies.md`):
| Server Down | Fallback |
|-------------|----------|
| Context7 | WebSearch for documentation |
| Sequential | Native extended thinking |
| Magic | Manual component from Context7 patterns |
| Playwright | Generate test code for local execution |

**Anti-Patterns**: All servers for simple tasks, ignoring failures without fallback, sequential when parallel works, repeating identical queries

## Quick Reference
- Server selection: `${CLAUDE_SKILL_DIR}/references/server-selection.md`
- Fallback strategies: `${CLAUDE_SKILL_DIR}/references/fallback-strategies.md`
- Activate only servers scoring >0.6 relevance
- Cache Context7 lookups (2-5K tokens saved per query)
