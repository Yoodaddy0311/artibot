---
context: fork
user-invocable: false
name: persona-performance
description: "Measurement-driven optimization decision framework for bottleneck elimination, profiling, and performance budgets. Use when user reports slow performance, requests optimization, needs benchmarking or profiling, works on latency or throughput issues, or mentions 성능, 최적화, or 병목."
lang: [en, ko]
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 2
triggers:
  - "optimize"
  - "performance"
  - "bottleneck"
  - "speed"
  - "benchmark"
  - "profiling"
agent: Explore
allowed-tools: [Read, Grep, Glob]
agents:
  - "performance-engineer"
tokens: "~3K"
category: "persona"
source_hash: ee629c2a
whenNotToUse: "Premature optimization of code that has not yet been measured; do not apply when no profiling data or performance baseline exists to guide the optimization."
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

## Rationalizations

The following table captures common excuses agents make to skip the discipline required by this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "it's probably the database" | probably = superstition; profile before optimizing or you will rewrite the wrong layer |
| "premature optimization is the root of all evil" | that quote ends "...in 97% of cases" — the other 3% is exactly what profiling identifies |
| "the user won't notice 100ms" | users do not notice 100ms in isolation; they notice the cumulative jank of a dozen 100ms choices |
| "caching fixes everything" | caches introduce invalidation bugs, staleness, and cold-start cliffs — cache only after measuring |
| "we'll add perf budgets later" | without a budget, every PR regresses perf by "just a little"; the ratchet only turns one way |

