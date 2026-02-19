---
name: delegation
description: |
  Delegation strategies for parallel and complex multi-file operations using Sub-Agent or Team Mode.
  Sub-Agent Mode: Task tool for focused, single-session tasks.
  Team Mode: Agent Teams API for complex multi-domain coordination with peer communication.
  Auto-activates when: >7 directories, >50 files, multi-domain operations, high complexity tasks, team coordination needed.
  Triggers: delegate, parallel, sub-agent, team, concurrent, large-scale, orchestrate, coordinate, 위임, 병렬, 대규모, 팀
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
progressive_disclosure:
  enabled: true
  level1_tokens: 100
  level2_tokens: 4000
triggers:
  - "delegate"
  - "parallel"
  - "sub-agent"
  - "team"
  - "concurrent"
  - "large-scale"
  - "orchestrate"
agents:
  - "orchestrator"
tokens: "~5K"
category: "orchestration"
---

# Delegation Strategies

## When This Skill Applies
- Operations spanning >7 directories or >50 files
- Multi-domain analysis (security + performance + quality)
- Complex tasks with parallelizable sub-operations
- Wave orchestration for comprehensive improvements
- Tasks requiring peer-to-peer agent communication
- Iterative collaboration where agents need shared context

## Core Guidance

### Delegation Mode Decision

Two modes are available. Select based on weighted scoring:

| Factor | Weight | Scoring |
|--------|--------|---------|
| Complexity | 0.3 | 0 (trivial) to 1.0 (critical redesign) |
| Parallelizable ops | 0.3 | 0 (sequential only) to 1.0 (fully parallel) |
| Communication need | 0.2 | 0 (one-way report) to 1.0 (continuous P2P) |
| File/scope scale | 0.2 | 0 (<10 files) to 1.0 (100+ files) |

**Score < 0.6 -> Sub-Agent Mode** | **Score >= 0.6 -> Team Mode**

---

## Sub-Agent Mode (Lightweight)

Use the `Task` tool to spawn focused sub-agents for bounded work.

**When to use**:
- Complexity < 0.6, single domain, < 20 files
- One-way delegation: assign, wait, receive result
- No inter-agent communication needed

**Strategies** (see `references/delegation-matrix.md`):
| Condition | Strategy | Gain |
|-----------|----------|------|
| >7 dirs | Parallel by directory | ~65% |
| >50 files | Parallel by file batch | ~60% |
| >2 focus areas | Parallel by domain | ~70% |
| Complexity >0.8 | Specialized agents | ~50% |

**Sub-Agent Rules**:
- Clear, bounded scope per agent
- Sufficient context in delegation message
- Explicit success criteria
- Parallel for independent ops, sequential only for dependencies
- Max concurrent: 7 (configurable)

**Result Aggregation**: Collect -> Deduplicate -> Cross-reference -> Prioritize -> Synthesize

---

## Team Mode (Agent Teams API)

Use the Agent Teams API for complex, multi-domain tasks requiring coordination.

**When to use**:
- Complexity >= 0.6, multiple domains, 20+ files
- Agents need to communicate with each other (P2P)
- Shared task list enables self-claiming and progress tracking
- Iterative collaboration or consensus-building required

### Team Lifecycle

```
1. TeamCreate          - Create named team
2. Task(type, team, name) - Spawn teammates into team
3. TaskCreate          - Populate shared task list
4. TaskUpdate          - Assign tasks or let agents self-claim
5. SendMessage         - Coordinate, discuss, resolve blockers
6. TaskUpdate          - Mark tasks completed as work finishes
7. SendMessage(shutdown_request) - Request teammates to shut down
8. TeamDelete          - Clean up team resources
```

### Team Communication Patterns

| Tool | Type | Purpose |
|------|------|---------|
| `SendMessage(type: "message")` | DM | Direct message to specific teammate |
| `SendMessage(type: "broadcast")` | Broadcast | Team-wide announcement (use sparingly) |
| `SendMessage(type: "shutdown_request")` | Control | Request teammate shutdown |
| `SendMessage(type: "shutdown_response")` | Control | Approve/reject shutdown |
| `SendMessage(type: "plan_approval_response")` | Control | Approve/reject teammate plan |

### Task Management

| Tool | Purpose |
|------|---------|
| `TaskCreate` | Add work items with subject, description, activeForm |
| `TaskUpdate` | Set status, owner, blockedBy/blocks dependencies |
| `TaskList` | View all tasks, find unclaimed work |
| `TaskGet` | Read full task details before starting work |

### Orchestration Patterns

| Pattern | Use When | Coordination Flow |
|---------|----------|-------------------|
| **Leader** | Clear authority, coordinated output | Leader assigns via TaskUpdate, collects results |
| **Council** | Consensus needed, multiple perspectives | Teammates discuss via SendMessage, leader decides |
| **Swarm** | Independent tasks, embarrassingly parallel | Teammates self-claim from TaskList |
| **Pipeline** | Sequential dependencies | TaskCreate with blockedBy for ordering |

### Team Sizing

| Scale | Teammates | Use Case |
|-------|-----------|----------|
| Squad | 3 | Feature implementation, focused refactoring |
| Platoon | 5 | Architecture change, security audit |
| Battalion | 7+ | Enterprise operations, large-scale migration |

---

## Anti-Patterns

- Delegating trivial tasks (complexity < 0.3) to sub-agents or teams
- Unclear scope boundaries in task descriptions
- Sequential execution when parallel is possible
- Over-splitting into too many tiny tasks
- No result aggregation after parallel work
- **Using sub-agents when inter-agent communication is needed** (use Team Mode instead)
- **Creating a full team for single-domain focused tasks** (use Sub-Agent instead)
- Forgetting `TeamDelete` cleanup after team work completes
- Broadcasting when a direct message suffices

## Quick Reference

**Decision**: Score complexity/parallelism/communication/scale -> Sub-Agent (<0.6) or Team (>=0.6)
**Delegation matrix**: `references/delegation-matrix.md`
**Auto-trigger**: >7 dirs OR >50 files OR complexity >0.8 OR multi-domain + communication need

**Sub-Agent Flow**: `Task(subagent_type)` -> receive result
**Team Flow**: `TeamCreate` -> `Task(type, team, name)` -> `TaskCreate` -> coordinate -> `TeamDelete`

Always aggregate and cross-reference results from both modes.
Prefer Swarm pattern for independent tasks, Pipeline for dependencies, Council for consensus.
