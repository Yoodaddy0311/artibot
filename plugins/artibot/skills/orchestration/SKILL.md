---
name: orchestration
description: |
  Routing intelligence engine that analyzes requests and routes to optimal agents, skills, and commands.
  Supports two delegation modes: Sub-Agent (Task tool) for focused tasks and Team Mode (Agent Teams API) for complex multi-domain coordination.
  Auto-activates when: complex multi-step requests, team composition needed, multi-domain tasks, ambiguous intent.
  Triggers: analyze, build, implement, design, route, orchestrate, complex, multi-step, team, coordinate
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
progressive_disclosure:
  enabled: true
  level1_tokens: 100
  level2_tokens: 4000
triggers:
  - "analyze"
  - "build"
  - "implement"
  - "design"
  - "route"
  - "orchestrate"
  - "complex"
  - "multi-step"
  - "team"
  - "coordinate"
agents:
  - "orchestrator"
tokens: "~5K"
category: "orchestration"
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
| Complexity | 0.3 | < 0.5 | >= 0.5 |
| Parallelizable ops | 0.3 | 1-2 tasks | 3+ tasks |
| Communication need | 0.2 | One-way reporting | P2P coordination |
| File/scope scale | 0.2 | < 20 files | 20+ files |

**Score >= 0.5 -> Team Mode** (Agent Teams API)
**Score < 0.5 -> Sub-Agent Mode** (Task tool only)

Target ratio: **Sub-Agent ~35% | Team ~40%** (remaining ~25% is direct execution).

Team mode boost keywords (auto-upgrade to Team when detected):
"전체", "모든", "all", "comprehensive", "평가", "점검", "audit", "pipeline", "병렬", "parallel", "프로젝트 전체", "codebase", "전수", "일괄", "여러 파일", "모듈별"

#### Sub-Agent Mode (Task Tool)
- Single-session delegation for focused tasks
- One-way reporting: agent completes and returns result
- Best for: focused single-domain tasks, file analysis, code generation
- Tools:
  - `Task(subagent_type)` — blocking (for command pipelines where next step depends on result)
  - `Task(subagent_type, run_in_background=true)` — non-blocking (for /sc routing, keeping user session responsive)

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

## Token Budget Management

### Phase-Based Token Budgets

| Phase | Budget | Purpose |
|-------|--------|---------|
| Plan | 30K tokens | Intent analysis, task decomposition, delegation mode selection |
| Execute | 180K tokens | Implementation, code generation, tool operations |
| Review | 40K tokens | Validation, quality gates, result aggregation |

**Total budget per operation**: ~250K tokens (with 10% reserve for error recovery)

### /clear Strategy

Issue `/clear` to reset context and reclaim tokens in these situations:

| Trigger | When | Rationale |
|---------|------|-----------|
| Plan completion | After plan is finalized and tasks created | Plan context no longer needed for execution |
| Context > 150K | When token usage crosses 150K threshold | Prevent degradation in output quality |
| Major phase transition | Between Plan -> Execute, Execute -> Review | Fresh context for each phase improves focus |
| Long-running team ops | After each wave or team iteration completes | Prevent context saturation in multi-wave work |

### Context Window Zones

| Zone | Usage | Action |
|------|-------|--------|
| Green | 0-60% | Full operations, all features enabled |
| Yellow | 60-75% | Enable `--uc` mode, cache aggressively, defer non-critical ops |
| Orange | 75-85% | Compress outputs, skip optional enhancements, batch operations |
| Red | 85-95% | Force `--uc`, essential operations only, suggest `/clear` |
| Critical | 95%+ | Emergency: `/clear` required, preserve only active task context |

**Auto-Escalation**: When context enters Yellow zone, the orchestrator should proactively:
1. Activate token efficiency mode (`--uc`)
2. Summarize completed work before continuing
3. Suggest `/clear` if transitioning between phases
4. Defer reference documentation loading

**Decision Flow**:
```
Request -> Detect available tools -> Select orchestration mode -> Classify complexity -> Route

Mode Detection:
  TeamCreate available?  -> agent-teams mode (full team orchestration)
  Task() available?      -> sub-agent mode (background delegation via run_in_background=true)
  Neither available?     -> direct mode (orchestrator executes everything)

Routing (agent-teams mode):
  Score < 0.6: Sub-Agent (Task tool, no team)
  Score >= 0.6: Team Mode (TeamCreate -> spawn -> TaskCreate -> coordinate -> cleanup)

Routing (sub-agent mode):
  All tasks: Task(subagent_type, run_in_background=true) in parallel, orchestrator aggregates results

Routing (direct mode):
  All tasks: Sequential execution by orchestrator using Read/Write/Edit/Bash
```

### 8. Platform Compatibility

| Platform | Mode | Orchestration | Team Features |
|----------|------|---------------|---------------|
| Claude Code + env var | agent-teams | Full PDCA with teams | P2P messaging, shared tasks, plan approval |
| Claude Code (no env) | sub-agent | Parallel Task(run_in_background=true) delegation | Background delegation, result aggregation |
| Gemini CLI | direct | Sequential self-execution | Skills as context, adapted commands |
| Codex CLI | direct | Sequential self-execution | Skills as context, adapted commands |
| Cursor / Others | direct | Sequential self-execution | Rules-based instruction |

**Enabling Agent Teams** (Claude Code):
```json
// ~/.claude/settings.json
{ "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" } }
```
