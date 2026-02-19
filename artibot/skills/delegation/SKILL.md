---
name: delegation
description: |
  Task delegation and parallel execution strategies for multi-agent
  workflows. Sub-agent specialization, concurrency control,
  and result aggregation.

  Use proactively when tasks can be parallelized, when specialist
  agents are needed, or when scope exceeds single-agent capacity.

  Triggers: delegate, parallel, sub-agent, team, multi-agent,
  coordinate, distribute, concurrent, spawn,
  위임, 병렬, 서브에이전트, 팀, 조율,
  委任, 並列, サブエージェント, チーム

  Do NOT use for: simple single-file tasks, trivial operations,
  or when explicit sequential execution is required.
---

# Delegation Engine

> Parallel where possible. Sequential only when dependencies exist.

## When This Skill Applies

- Task spans multiple files or directories
- Multiple independent analysis needed
- Different specialist perspectives required
- Scope too large for single agent pass
- Time-sensitive multi-step operations

## Delegation Decision Matrix

| Condition | Strategy | Performance Gain |
|-----------|----------|-----------------|
| >7 directories | Parallel by directory | ~65% |
| >50 files | Parallel by file batch | ~60% |
| >2 focus areas | Parallel by domain | ~70% |
| High complexity + critical quality | Wave orchestration | ~80% |
| Single module, <10 files | No delegation (direct) | N/A |

## Auto-Activation Triggers

```yaml
directory_threshold: directory_count > 7
file_threshold: file_count > 50 AND complexity > 0.6
multi_domain: domains > 3
complex_analysis: complexity > 0.8 AND scope = comprehensive
```

## Agent Specialization Matrix

| Focus | Persona | Primary Tools | Scope |
|-------|---------|--------------|-------|
| Quality | qa | Read, Grep, Sequential | Code quality, maintainability |
| Security | security | Grep, Sequential, Context7 | Vulnerabilities, compliance |
| Performance | performance | Read, Sequential, Playwright | Bottlenecks, optimization |
| Architecture | architect | Read, Sequential, Context7 | Patterns, structure |
| API | backend | Grep, Context7, Sequential | Endpoints, contracts |

## Delegation Format

When delegating to a sub-agent, provide:

```
OBJECTIVE: [Single sentence - what to accomplish]
SCOPE:     [Which files/modules to analyze]
FOCUS:     [Specific aspect to evaluate]
CONSTRAINTS: [What NOT to change or investigate]
OUTPUT:    [Expected format of results]
```

## Concurrency Control

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| max_concurrent | 7 | 1-15 | Maximum parallel sub-agents |
| timeout_per_agent | 120s | 30-300s | Per-agent timeout |
| retry_on_failure | 1 | 0-3 | Retry count on agent failure |

## Result Aggregation

After all sub-agents complete:
1. Collect all results
2. Identify conflicts or contradictions
3. Merge non-overlapping findings
4. Resolve conflicts by priority (security > reliability > quality)
5. Present unified summary

## Orchestration Patterns

| Pattern | When | How |
|---------|------|-----|
| Leader | Clear task decomposition | Orchestrator delegates, collects |
| Council | Design decisions, reviews | Multiple perspectives, vote |
| Swarm | Large-scale implementation | Many agents, same pattern |
| Pipeline | Sequential dependencies | Chain: A output feeds B input |
| Watchdog | Continuous monitoring | Background checks during work |

## References

- `references/delegation-matrix.md` - Detailed delegation decision matrix
