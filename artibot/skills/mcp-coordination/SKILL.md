---
name: mcp-coordination
description: |
  Multi-MCP server coordination and intelligent server selection.
  Orchestrates Context7, Sequential, Magic, and Playwright
  for optimal task execution.

  Use proactively when multiple MCP servers are needed,
  when selecting the best server for a task, or when
  coordinating cross-server operations.

  Triggers: MCP, server selection, multi-server, Context7,
  Sequential, Magic, Playwright, coordinate servers,
  MCP, 서버선택, 다중서버, 서버조율,
  MCP, サーバー選択, マルチサーバー

  Do NOT use for: single-server operations where the
  server choice is obvious.
---

# MCP Coordination

> Right server for the right task. Fallback when unavailable.

## When This Skill Applies

- Task requires multiple MCP servers
- Optimal server selection is unclear
- Cross-server data flow needed
- Server failure requires fallback routing
- Complex operations spanning documentation, UI, testing

## Server Selection Matrix

| Task Type | Primary | Secondary | Fallback |
|-----------|---------|-----------|----------|
| Library docs lookup | Context7 | WebSearch | Native knowledge |
| Complex analysis | Sequential | Native analysis | Simpler approach |
| UI component generation | Magic | Context7 (patterns) | Manual implementation |
| E2E testing | Playwright | Manual test steps | Test plan only |
| Security analysis | Sequential | Context7 | Checklist-based |
| Performance profiling | Playwright | Sequential | Metrics-based |

## Auto-Activation Rules

| Server | Trigger | Confidence |
|--------|---------|-----------|
| Context7 | External imports detected, framework questions | 85% |
| Sequential | Complex debugging, --think flags, multi-step analysis | 80% |
| Magic | UI component requests, design system queries | 80% |
| Playwright | E2E tests, performance monitoring, cross-browser | 85% |

## Flag Integration

| Flag | Effect |
|------|--------|
| `--c7` / `--context7` | Force enable Context7 |
| `--seq` / `--sequential` | Force enable Sequential |
| `--magic` | Force enable Magic |
| `--play` / `--playwright` | Force enable Playwright |
| `--all-mcp` | Enable all servers |
| `--no-mcp` | Disable all servers (native only) |
| `--no-[server]` | Disable specific server |

## Multi-Server Patterns

### Documentation + Implementation
```
Context7 (patterns) → Magic (UI generation) → Playwright (validation)
```

### Deep Analysis
```
Sequential (analysis) → Context7 (verification) → Sequential (synthesis)
```

### Full Development Cycle
```
Context7 (research) → Sequential (planning) → Magic/Edit (implementation) → Playwright (testing)
```

## Caching Strategy

| Server | Cache Target | Savings |
|--------|-------------|---------|
| Context7 | Documentation lookups | 2-5K tokens/query |
| Sequential | Reasoning analysis results | Variable |
| Magic | UI component patterns | 1-3K tokens/pattern |
| Playwright | Test results, screenshots | Variable |

## Error Recovery

| Failure | Recovery Strategy |
|---------|------------------|
| Context7 unavailable | WebSearch for docs, manual implementation |
| Sequential timeout | Native Claude analysis, simpler approach |
| Magic failure | Generate basic component, manual enhancement |
| Playwright connection lost | Provide manual test cases |
| Multiple failures | Graceful degradation to native tools |

## Performance Tips

- Start with minimal MCP usage, expand as needed
- Cache successful patterns for session reuse
- Use `--no-mcp` for simple tasks (40-60% faster)
- Disable unused servers with `--no-[server]` (10-30% faster each)

## References

- `references/server-selection.md` - Detailed selection criteria
- `references/fallback-strategies.md` - Comprehensive fallback chains
