# MCP Server Selection Criteria

## Server Capabilities

### Context7
- **Strength**: Official library documentation, version-accurate patterns
- **Latency**: Medium (external API call)
- **Token Cost**: 2-5K per query
- **Best For**: Framework questions, API lookups, dependency docs
- **Weakness**: Limited to indexed libraries

### Sequential
- **Strength**: Multi-step reasoning, complex analysis
- **Latency**: Medium-High (iterative processing)
- **Token Cost**: Variable (scales with complexity)
- **Best For**: Debugging, architecture review, security analysis
- **Weakness**: Higher token consumption

### Magic
- **Strength**: Modern UI component generation, design systems
- **Latency**: Medium
- **Token Cost**: 1-3K per component
- **Best For**: React/Vue components, design patterns
- **Weakness**: Limited to UI generation

### Playwright
- **Strength**: Real browser interaction, performance measurement
- **Latency**: High (browser startup + execution)
- **Token Cost**: Low (execution-based)
- **Best For**: E2E tests, visual testing, performance metrics
- **Weakness**: Requires browser environment

## Selection Decision Tree

```
Is this about an external library?
  YES → Context7
  NO ↓

Is this about UI components?
  YES → Magic
  NO ↓

Is this about browser testing or performance?
  YES → Playwright
  NO ↓

Is this a complex multi-step analysis?
  YES → Sequential
  NO ↓

Use native Claude tools (no MCP needed)
```

## Multi-Server Combinations

| Scenario | Servers | Flow |
|----------|---------|------|
| New feature with framework | Context7 + Magic | Docs → Component |
| Performance audit | Playwright + Sequential | Measure → Analyze |
| Security review | Sequential + Context7 | Analyze → Verify |
| Full dev cycle | All four | Research → Plan → Build → Test |
