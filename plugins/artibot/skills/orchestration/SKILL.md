---
name: orchestration
description: |
  Routing intelligence engine that analyzes requests and routes to optimal agents, skills, and commands.
  Supports two delegation modes: Sub-Agent (Task tool) for focused tasks and Team Mode (Agent Teams API) for complex multi-domain coordination.
  Auto-activates when: complex multi-step requests, team composition needed, multi-domain tasks, ambiguous intent.
  Triggers: analyze, build, implement, design, route, orchestrate, complex, multi-step, team, coordinate
---

# Orchestration & Routing Intelligence

## When This Skill Applies
- Multi-step requests requiring coordination across domains
- Ambiguous requests needing intent classification
- Team composition decisions (solo/sub-agent/team)
- Flag auto-activation and persona selection
- Wave mode eligibility assessment
- Complex tasks requiring peer-to-peer agent communication
- Multi-domain operations where agents need shared state and task lists

## Core Guidance

### 1. Intent Detection Pipeline
```
Parse request -> Extract keywords -> Match domain -> Score complexity -> Select delegation mode -> Route
```

### 2. Complexity Classification
| Level | Steps | Token Budget | Time | Action |
|-------|-------|-------------|------|--------|
| simple | <3 | 5K | <5min | Direct execution |
| moderate | 3-10 | 15K | 5-30min | Persona + MCP or Sub-Agent |
| complex | >10 | 30K+ | >30min | Team mode + wave orchestration |

### 3. Domain Identification
- **frontend**: UI, component, React, CSS, responsive, accessibility
- **backend**: API, database, server, endpoint, authentication
- **infrastructure**: deploy, Docker, CI/CD, monitoring, scaling
- **security**: vulnerability, threat, compliance, audit
- **documentation**: document, README, wiki, guide
- **testing**: test, e2e, coverage, TDD

### 4. Delegation Mode Selection

Choose between Sub-Agent and Team Mode based on a weighted score:

| Factor | Weight | Sub-Agent Range | Team Range |
|--------|--------|----------------|------------|
| Complexity | 0.3 | < 0.6 | >= 0.6 |
| Parallelizable ops | 0.3 | 1-2 tasks | 3+ tasks |
| Communication need | 0.2 | One-way reporting | P2P coordination |
| File/scope scale | 0.2 | < 20 files | 20+ files |

**Score >= 0.6 -> Team Mode** (Agent Teams API)
**Score < 0.6 -> Sub-Agent Mode** (Task tool only)

#### Sub-Agent Mode (Task Tool)
- Single-session, fire-and-forget delegation
- One-way reporting: agent completes and returns result
- Best for: focused single-domain tasks, file analysis, code generation
- Tools: `Task(subagent_type)`

#### Team Mode (Agent Teams API)
- Persistent team with shared task list and peer messaging
- Agents can self-claim tasks, communicate, and coordinate
- Best for: multi-domain operations, iterative collaboration, complex audits
- Tools: `TeamCreate`, `Task(subagent_type, team_name, name)`, `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`, `SendMessage`, `TeamDelete`

### 5. Team Composition

| Scope | Mode | Size | Orchestration |
|-------|------|------|---------------|
| Single file edit | Direct | 0 agents | Direct execution |
| Focused task | Sub-Agent | 1 agent | Task tool, one-way |
| Feature implementation | Team (squad) | 3 agents | Shared tasks, messaging |
| Architecture change | Team (platoon) | 5 agents | Full coordination |
| Enterprise operation | Team (battalion) | 7+ agents | Wave + team orchestration |

### 6. Team Orchestration Patterns

#### Leader Pattern
Leader creates team, assigns tasks, collects results.
```
TeamCreate -> TaskCreate (per work item) -> TaskUpdate (assign) -> monitor -> aggregate -> TeamDelete
```

#### Council Pattern
Multiple teammates discuss via SendMessage, leader makes final decisions.
```
TeamCreate -> TaskCreate -> teammates SendMessage to discuss -> leader decides -> TaskUpdate (complete)
```

#### Swarm Pattern
Independent parallel tasks; teammates self-claim from shared task list.
```
TeamCreate -> TaskCreate (all work items) -> teammates TaskList -> TaskUpdate (self-claim) -> work -> complete
```

#### Pipeline Pattern
Sequential tasks with dependency chains using blockedBy.
```
TeamCreate -> TaskCreate(task1) -> TaskCreate(task2, blockedBy: [task1]) -> ... -> sequential execution
```

### 7. Auto-Activation Rules
- `--think` -> Sequential MCP + analyzer persona
- `--think-hard` -> Sequential + Context7 + architect persona
- `--ultrathink` -> All MCP servers + comprehensive analysis
- Complexity >0.7 + files >20 + operation_types >2 -> Wave mode
- >7 directories OR >50 files -> Sub-agent delegation
- Delegation score >= 0.6 -> Team Mode (Agent Teams API)
- Multi-domain + P2P communication needed -> Team Mode

## Quick Reference

**Routing**: See `references/routing-table.md` for the full routing matrix.
**Flags**: See `references/flag-system.md` for flag precedence and auto-activation.
**Personas**: See `references/persona-activation.md` for persona trigger conditions.

**Team API Tools**:
| Tool | Purpose |
|------|---------|
| `TeamCreate` | Create a named team |
| `Task(type, team_name, name)` | Spawn a teammate into a team |
| `TaskCreate` | Add work items to shared task list |
| `TaskUpdate` | Assign, claim, or complete tasks |
| `TaskList` | View all tasks and their status |
| `TaskGet` | Get full task details |
| `SendMessage` | DM, broadcast, shutdown request/response, plan approval |
| `TeamDelete` | Cleanup team after completion |

**Decision Flow**:
```
Request -> Classify complexity -> Score delegation factors
  -> Score < 0.6: Sub-Agent (Task tool)
  -> Score >= 0.6: Team Mode (TeamCreate -> spawn -> TaskCreate -> coordinate -> cleanup)
```
