# MCP Fallback Strategies

## Fallback Chains

### Context7 Unavailable
1. WebSearch for official documentation
2. Use cached knowledge from session
3. Built-in knowledge (may be outdated)
4. Flag version uncertainty in output

### Playwright Unavailable
1. Generate test code files for local execution
2. Document manual test procedures
3. Create test plan with verification checklist
4. Suggest: `npx playwright test`

### Sequential Unavailable
1. Use Claude native extended thinking (`--think`)
2. Break problem into smaller sequential steps
3. Document each reasoning step explicitly
4. Note analysis depth may be reduced

### Magic Unavailable
1. Look up patterns in Context7
2. Generate component using framework conventions
3. Suggest component libraries (shadcn/ui, Radix)
4. Note component may need design polish

## Error Detection

| Error Type | Detection | Action |
|------------|-----------|--------|
| Timeout | No response in 30s | Retry once, then fallback |
| Connection refused | Server not running | Fallback immediately |
| Invalid response | Malformed data | Retry once, then fallback |
| Rate limited | 429 status | Wait and retry, or fallback |
| Partial response | Incomplete data | Use available, supplement |

## Circuit Breaker

```
Closed (normal) -> Open (3+ failures) -> Half-Open (after 60s)
  Success: Closed | Failure: Open
```

## Degradation Levels

| Level | Condition | Action |
|-------|-----------|--------|
| Normal | All servers up | Full capability |
| Degraded | 1 server down | Fallback for that server |
| Limited | 2+ servers down | Core functionality, note limits |
| Standalone | All servers down | Claude-native analysis only |
