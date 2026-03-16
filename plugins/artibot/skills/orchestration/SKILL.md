---
context: forked
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

## Contents
- [When This Skill Applies](#when-this-skill-applies)
- [Core Guidance](#core-guidance)
- [Quick Reference](#quick-reference)
- [Token Budget Management](#token-budget-management)
- [HARD-GATE: Design Before Implementation](#hard-gate-design-before-implementation)
- [Workflow Checklist](#workflow-checklist)
- [Human Checkpoints](#human-checkpoints)
- [Freedom Levels](#freedom-levels)

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

**Routing**: See `${CLAUDE_SKILL_DIR}/references/routing-table.md` for the full routing matrix.
**Flags**: See `${CLAUDE_SKILL_DIR}/references/flag-system.md` for flag precedence and auto-activation.
**Personas**: See `${CLAUDE_SKILL_DIR}/references/persona-activation.md` for persona trigger conditions.

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

## HARD-GATE: Design Before Implementation

<HARD-GATE>
**Applies to**: System 2 classified requests (complexity score >= threshold)

**Rule**: Do NOT invoke any implementation action (Edit, Write, Bash build/deploy, TaskCreate for implementation) until a design document has been produced and approved.

**Gate Protocol**:
1. **Produce Design** — Write a design plan covering: goal, approach, affected files, risk assessment, rollback strategy
2. **Save Design** — Store the plan in `docs/plans/{date}-{slug}.md` (e.g., `docs/plans/2026-03-06-auth-refactor.md`)
3. **Request Approval** — Present the design to the user (or team lead in team mode) and wait for explicit approval
4. **Gate Check** — Only after receiving "approve", "LGTM", "go ahead", or equivalent confirmation, proceed to implementation
5. **Link Back** — Reference the approved design document in commit messages and task descriptions

**Bypass Conditions** (gate is NOT enforced):
- System 1 classified requests (simple, low complexity) — fast execution preserved
- Explicit user override: "skip design", "just do it", "no plan needed"
- Emergency hotfix with `--hotfix` flag

**Violation Recovery**: If implementation begins without design approval, STOP immediately, document what was done, and produce the missing design before continuing.
</HARD-GATE>

## Workflow Checklist

Copy this checklist and track progress:

```
Progress:
- [ ] Step 1: Parse request — extract keywords, match domain
- [ ] Step 2: Score complexity (simple / moderate / complex)
- [ ] Step 3: Identify delegation mode (direct / sub-agent / team)
- [ ] Step 3.5: HARD-GATE — If System 2, produce design doc and get approval before proceeding
- [ ] Step 4: Select personas and MCP servers to activate
- [ ] Step 5: Compose team or spawn sub-agents as needed
- [ ] Step 6: Execute with token budget monitoring
- [ ] Step 7: Aggregate results and validate quality gates
- [ ] Step 8: Report outcomes with evidence
```

## Human Checkpoints

### Checkpoint 1: 복잡도 분류 확인 (After Step 2)
**Context**: 요청의 복잡도가 simple/moderate/complex로 분류된 시점. 잘못된 분류는 토큰 예산과 위임 모드 전체에 영향을 주므로 초기에 확인이 필요하다.
**Ask**: "요청이 **[분류된 레벨]**로 분류되었습니다. 이 복잡도 분류가 맞나요?"
**Options**:
1. Confirm — 분류 확인, Step 3 위임 모드 선택으로 진행
2. Override level — simple / moderate / complex 중 다른 레벨로 재분류
**Default**: 1 (자동 분류 알고리즘을 신뢰)
**Skippable**: No — 복잡도는 토큰 예산과 위임 전략의 기반이 됨
**Freedom**: MEDIUM

### Checkpoint 2: 위임 모드 선택 (After Step 3)
**Context**: Direct / Sub-Agent / Team Mode 중 위임 방식이 결정된 시점. 실제 태스크 특성과 팀 리소스를 고려해 사용자가 조정할 수 있다.
**Ask**: "이 태스크에 **[선택된 위임 모드]**가 제안되었습니다. 이 방식이 적절한가요?"
**Options**:
1. Direct — 오케스트레이터가 직접 실행
2. Sub-Agent — Task 툴로 단일 에이전트 위임
3. Team Mode — Agent Teams API로 팀 구성 및 조율
**Default**: 자동 점수 기반 결정 (Score >= 0.5 → Team, < 0.5 → Sub-Agent)
**Skippable**: Yes (기본값 사용) — 자동 선택 모드로 진행
**Freedom**: HIGH

### Checkpoint 3: 팀 구성 승인 (After Step 5)
**Context**: 팀 멤버와 역할 배분이 확정된 시점. 팀 크기와 구성이 태스크 범위에 비해 과하거나 부족할 수 있어 사람의 검토가 필요하다.
**Ask**: "팀이 구성되었습니다. **제안된 팀 멤버와 역할 배분이 이 작업에 적합한가요?**"
**Options**:
1. Approve team — 구성 확인, 실행 시작
2. Adjust members — 특정 에이전트 추가/제거 후 진행
3. Reduce scope — 작업 범위를 좁혀 더 작은 팀으로 재구성
**Default**: 1 (자동 팀 구성 로직을 신뢰)
**Skippable**: No — 팀 구성 후 변경은 비용이 크므로 사전 승인 필요
**Freedom**: HIGH

### Checkpoint 4: 결과 품질 검토 (After Step 7)
**Context**: 모든 에이전트의 결과가 집계되고 품질 게이트 통과 여부가 확인된 시점. 최종 수락 전 사람의 판단으로 추가 수정이나 에스컬레이션 여부를 결정한다.
**Ask**: "작업 결과가 집계되었습니다. **결과물이 기대한 품질 기준을 충족하나요?**"
**Options**:
1. Accept — 결과 수락, 보고서 출력
2. Request revision — 특정 부분 재작업 요청
3. Escalate — 더 높은 복잡도 레벨로 재분류하여 재시작
**Default**: 1 (품질 게이트를 통과한 결과는 수락)
**Skippable**: No — 최종 결과의 수락/거절은 사람의 판단이 필요
**Freedom**: MEDIUM

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Parse request | MEDIUM | Keyword matching is defined, but intent interpretation requires judgment |
| Score complexity | MEDIUM | Scoring formula exists, but edge cases need interpretation |
| Select delegation mode | HIGH | Multiple valid approaches depending on context |
| Activate personas/MCP | MEDIUM | Auto-activation rules apply, manual override allowed |
| Compose team | HIGH | Team size, pattern (leader/council/swarm) are context-dependent |
| Execute with budget | LOW | Token budgets must be respected, /clear strategy mandatory |
| Aggregate results | MEDIUM | Dedup and cross-reference, but synthesis requires judgment |
| Report outcomes | LOW | Evidence-based reporting required, no claims without proof |
