# Delegation Matrix

## Mode Decision Matrix

| Factor | Weight | Sub-Agent (<0.6) | Team (>=0.6) |
|--------|--------|-------------------|--------------|
| Complexity | 0.3 | Single domain, bounded scope | Multi-domain, architectural |
| Parallelizable ops | 0.3 | 1-2 independent tasks | 3+ coordinated tasks |
| Communication need | 0.2 | One-way reporting | P2P coordination, consensus |
| File/scope scale | 0.2 | <20 files | 20+ files |

**Score < 0.6**: Use Sub-Agent Mode (Task tool)
**Score >= 0.6**: Use Team Mode (Agent Teams API)

## Sub-Agent Strategy Selection

| Condition | Strategy | Agent Count | Gain |
|-----------|----------|-------------|------|
| >7 directories | parallel-dirs | 3-7 | ~65% |
| >50 files | parallel-files | 3-5 | ~60% |
| >2 focus areas | parallel-focus | 2-4 | ~70% |
| Complex + critical | adaptive | Dynamic | ~50% |

## Team Mode Strategy Selection

| Condition | Pattern | Team Size | API Flow |
|-----------|---------|-----------|----------|
| Independent parallel tasks | Swarm | 3-7 | TeamCreate -> TaskCreate (all) -> self-claim via TaskList |
| Sequential dependencies | Pipeline | 3-5 | TeamCreate -> TaskCreate with blockedBy -> ordered execution |
| Consensus or review needed | Council | 3-5 | TeamCreate -> TaskCreate -> SendMessage discussions -> leader decides |
| Coordinated complex output | Leader | 3-7 | TeamCreate -> TaskCreate -> TaskUpdate (assign) -> aggregate |

## Orchestration Patterns

| Pattern | Use When | Coordination | Mode |
|---------|----------|-------------|------|
| Direct | Trivial, <3 steps | None | Neither |
| Sub-Agent | Focused, single domain | Task tool, one-way | Sub-Agent |
| Leader | Clear authority, coordinated output | TaskUpdate assign, leader aggregates | Team |
| Council | Consensus needed, multiple perspectives | SendMessage discuss, leader decides | Team |
| Swarm | Independent tasks, embarrassingly parallel | TaskList self-claim, merge results | Team |
| Pipeline | Sequential dependencies, transformation | TaskCreate with blockedBy ordering | Team |

## Agent Teams API Reference

| Tool | Purpose | Usage |
|------|---------|-------|
| `TeamCreate` | Create a named team | Once at start of team operation |
| `Task(subagent_type, team_name, name)` | Spawn teammate into team | Per teammate needed |
| `TaskCreate` | Add work item to shared list | Per work item |
| `TaskUpdate` | Assign, claim, complete, set dependencies | Throughout lifecycle |
| `TaskList` | View tasks and status | Coordination and self-claiming |
| `TaskGet` | Read full task details | Before starting a task |
| `SendMessage(type: "message")` | DM specific teammate | Coordination |
| `SendMessage(type: "broadcast")` | Message all teammates | Critical announcements only |
| `SendMessage(type: "shutdown_request")` | Request teammate shutdown | Cleanup phase |
| `SendMessage(type: "shutdown_response")` | Approve/reject shutdown | Response to request |
| `SendMessage(type: "plan_approval_response")` | Approve/reject plan | Plan mode workflow |
| `TeamDelete` | Remove team | After all work complete |

## Sub-Agent Specialization

| Role | Persona | Focus | Tools |
|------|---------|-------|-------|
| Quality | qa | Complexity, maintainability | Read, Grep, Sequential |
| Security | security | Vulnerabilities, compliance | Grep, Sequential, Context7 |
| Performance | performance | Bottlenecks, optimization | Read, Sequential, Playwright |
| Architecture | architect | Patterns, structure | Read, Sequential, Context7 |

## Concurrency Limits

| Scale | Max Concurrent | Mode | Use Case |
|-------|---------------|------|----------|
| Solo | 0 | Direct | Simple tasks |
| Focused | 1-2 | Sub-Agent | Single-domain tasks |
| Squad | 3 | Team | Feature implementation |
| Platoon | 5 | Team | Large features, audits |
| Battalion | 7+ | Team | Enterprise operations |

## Result Aggregation

Applies to both Sub-Agent and Team modes:

1. **Collect**: Gather all agent results (Task return or SendMessage)
2. **Deduplicate**: Remove overlapping findings
3. **Cross-reference**: Identify patterns across domains
4. **Prioritize**: Rank by severity and impact
5. **Synthesize**: Produce unified recommendation

## Team Lifecycle Checklist

1. [ ] Score delegation factors -> confirm Team Mode needed
2. [ ] `TeamCreate` with descriptive name
3. [ ] `Task(type, team_name, name)` for each teammate
4. [ ] `TaskCreate` for all work items with clear descriptions
5. [ ] `TaskUpdate` to assign or let teammates self-claim
6. [ ] Monitor via `TaskList` and coordinate via `SendMessage`
7. [ ] Aggregate results as tasks complete
8. [ ] `SendMessage(shutdown_request)` to each teammate
9. [ ] `TeamDelete` to clean up
