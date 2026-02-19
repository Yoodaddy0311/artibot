# MCP Fallback Strategies

## Fallback Chain per Server

### Context7 Fallback
```
Context7 (primary)
  → WebSearch (secondary)
    → Native Claude knowledge (tertiary)
      → Ask user for docs link (last resort)
```

### Sequential Fallback
```
Sequential MCP (primary)
  → Extended thinking (--think) (secondary)
    → Step-by-step native analysis (tertiary)
```

### Magic Fallback
```
Magic MCP (primary)
  → Context7 for component patterns (secondary)
    → Manual component implementation (tertiary)
```

### Playwright Fallback
```
Playwright MCP (primary)
  → Manual test case description (secondary)
    → Provide test commands for user (tertiary)
```

## Error Classification

| Error Type | Retry? | Fallback? | User Action? |
|-----------|--------|-----------|-------------|
| Timeout | Yes (1x) | Yes | No |
| Connection refused | No | Yes | Check server |
| Rate limited | Yes (with backoff) | After 3 fails | No |
| Invalid response | No | Yes | No |
| Server error (500) | Yes (1x) | Yes | Report |

## Degradation Levels

| Level | Available Servers | Strategy |
|-------|------------------|----------|
| Full | All MCP servers | Optimal selection |
| Partial | Some unavailable | Fallback routing |
| Minimal | Only 1 server | That server for all |
| None | No MCP servers | Native tools only |

## Recovery Protocol

1. Detect failure (timeout or error response)
2. Log failure with context
3. Check retry eligibility
4. If retriable, retry once with exponential backoff
5. If retry fails, activate fallback server
6. If fallback fails, degrade to native tools
7. Inform user of degraded capability
