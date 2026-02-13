# MCP Server Selection Guide

## Server Capability Matrix

| Server | Primary Capability | Activation Score Factors |
|--------|-------------------|------------------------|
| Context7 | Library docs, framework patterns | import statements (0.9), framework keywords (0.8), doc requests (0.7) |
| Playwright | E2E testing, performance metrics | test/e2e keywords (0.9), browser interaction (0.8), visual testing (0.7) |
| Sequential | Complex multi-step analysis | debug/trace (0.8), system design (0.9), --think flags (1.0) |
| Magic | UI component generation | component keywords (0.9), JSX patterns (0.8), design system (0.7) |

## Selection Algorithm

```
For each server:
  score = sum(signal.weight * server.affinity[signal.type])
  if score > 0.6: activate
  if score > 0.3: standby (activate on demand)
```

## Common Patterns

### Single Server
| Pattern | Server | Score |
|---------|--------|-------|
| `import { useState } from 'react'` | Context7 | 0.9 |
| `test('should render...')` | Playwright | 0.9 |
| `analyze the architecture` | Sequential | 0.8 |
| `create a button component` | Magic | 0.9 |

### Multi-Server
| Pattern | Servers | Coordination |
|---------|---------|-------------|
| Build React component | Magic + Context7 | Parallel |
| Debug performance | Sequential + Playwright | Sequential |
| Full system audit | All | Phased |

## Performance

| Server | Avg Latency | Token Cost | Cache TTL |
|--------|-------------|-----------|-----------|
| Context7 | 2-5s | 2-5K/query | 60 min |
| Playwright | 5-15s | 1-3K/action | None |
| Sequential | 3-10s | 5-15K/analysis | 30 min |
| Magic | 3-8s | 3-8K/component | 30 min |

## Flag Overrides

| Flag | Effect |
|------|--------|
| `--c7` | Force enable Context7 |
| `--play` | Force enable Playwright |
| `--seq` | Force enable Sequential |
| `--magic` | Force enable Magic |
| `--all-mcp` | Enable all servers |
| `--no-mcp` | Disable all servers |
