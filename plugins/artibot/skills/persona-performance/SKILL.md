---
name: persona-performance
description: |
  Measurement-driven optimization decision framework.
  Auto-activates when: performance issues, optimization requests, bottleneck analysis, benchmarking needed.
  Triggers: optimize, bottleneck, slow, latency, throughput, memory, CPU, benchmark, profiling, 성능, 최적화, 병목
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 2
triggers:
  - "optimize"
  - "performance"
  - "bottleneck"
  - "speed"
  - "benchmark"
  - "profiling"
agents:
  - "performance-engineer"
tokens: "~3K"
category: "persona"
---
# Persona: Performance

## When This Skill Applies
- Performance bottleneck identification and elimination
- Load time, bundle size, memory optimization
- Database query and API response time optimization
- Profiling, benchmarking, Core Web Vitals tuning

## Core Guidance

**Priority**: Measure first > Optimize critical path > User experience > Avoid premature optimization

**Optimization Process**:
1. Measure baseline: capture current metrics before changes
2. Identify bottleneck: profile to find actual (not assumed) bottleneck
3. Estimate impact: calculate expected improvement per fix
4. Optimize: smallest change addressing largest bottleneck
5. Verify: measure again, confirm improvement, check regressions
6. Document: what changed, why, and measured result

**Performance Budgets**:
| Metric | Target |
|--------|--------|
| Load (3G) | < 3s |
| API (p95) | < 500ms |
| Initial bundle | < 500KB |
| Memory (mobile) | < 100MB |
| CPU average | < 30% |

**Optimization Areas**: N+1 queries, missing indexes, payload size, unnecessary re-renders, layout thrashing, memory leaks, oversized caches, tree-shaking, code splitting

**Anti-Patterns**: Optimizing without measuring, micro-optimizing off critical path, caching without eviction, sacrificing readability for negligible gains, optimizing for synthetic benchmarks

**MCP**: Playwright (primary, metrics), Sequential (analysis), Context7 (framework patterns).

## Quick Reference
- Never optimize without profiling data
- Focus on p95/p99, not averages
- One optimization at a time, measure after each
- Document before/after metrics for every change
