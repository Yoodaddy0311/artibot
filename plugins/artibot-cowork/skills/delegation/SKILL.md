---
context: fork
name: delegation
description: |
  Delegation strategies for parallel and complex multi-file operations using Sub-Agent or Team Mode.
  Sub-Agent Mode: Agent tool for focused, single-session tasks.
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

## Contents
- [When This Skill Applies](#when-this-skill-applies)
- [Core Guidance](#core-guidance)
- [Sub-Agent Mode (Lightweight)](#sub-agent-mode-lightweight)
- [Team Mode (Agent Teams API)](#team-mode-agent-teams-api)
- [Workflow Checklist](#workflow-checklist)
- [Human Checkpoints](#human-checkpoints)
- [Freedom Levels](#freedom-levels)
- [Anti-Patterns](#anti-patterns)
- [Quick Reference](#quick-reference)

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

**Score < 0.5 -> Sub-Agent Mode** | **Score >= 0.5 -> Team Mode**

Target ratio: **Sub-Agent ~35% | Team ~40%** (remaining ~25% is direct/simple execution).

Team mode is preferred when any of: 3+ domains, 2 domains with >5 steps, multi-target scope keywords ("전체", "all", "comprehensive"), pipeline/parallel keywords, or explicit `--team` flag.

---

## Sub-Agent Mode (Lightweight)

Use the `Agent` tool to spawn focused sub-agents for bounded work.

**When to use**:
- Complexity < 0.6, single domain, < 20 files
- One-way delegation: assign task, agent works independently
- No inter-agent communication needed

**Blocking modes**:
- `Agent(subagent_type, run_in_background=false)` — blocks caller until result (use inside command pipelines)
- `Agent(subagent_type)` — non-blocking, the default (use when routing from /sc or keeping user session responsive)

**Strategies** (see `${CLAUDE_SKILL_DIR}/references/delegation-matrix.md`):
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

**Worktree Isolation** (optional):
병렬 Sub-Agent가 동일 파일을 수정할 가능성이 있을 때, `isolation: "worktree"` 옵션으로 각 에이전트를 독립 Git worktree에서 실행할 수 있습니다.

```
Agent(subagent_type, { isolation: "worktree" })
```

- 이 플러그인은 `artibot.config.json`을 출하하지 않으므로, 전역 기본값을 켜 두는 설정 항목이 없습니다. 격리가 필요한 호출마다 위 옵션을 직접 지정하세요
- 기본값: `false` (opt-in)
- 완료 후 결과가 메인 worktree로 자동 병합 (`mergeStrategy: "auto"`)

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

The session has ONE implicit team — there is no team to create or delete. A
teammate exists from the moment `Agent(name=...)` spawns it until it finishes or
accepts a shutdown request.

```
1. Fix a run slug       - Prefix teammate names with it so runs stay distinguishable
2. Agent(type, name)    - Spawn named teammates (do NOT pass team_name; it is ignored)
3. TaskCreate           - Populate shared task list
4. TaskUpdate           - Assign tasks or let agents self-claim
5. SendMessage          - Coordinate, discuss, resolve blockers
6. TaskUpdate           - Mark tasks completed as work finishes
7. SendMessage(shutdown_request) - Request teammates to shut down
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

## Workflow Checklist

Copy this checklist and track progress:

```
Progress:
- [ ] Step 1: Score task (complexity, parallelism, communication, scale)
- [ ] Step 2: Select mode — Sub-Agent (<0.5) or Team (>=0.5)
- [ ] Step 3: Define scope and success criteria per agent/task
- [ ] Step 4: Spawn agents or create team with appropriate pattern
- [ ] Step 5: Monitor execution and handle blockers
- [ ] Step 6: Collect and aggregate results (dedup, cross-ref, prioritize)
- [ ] Step 7: Cleanup — every teammate confirmed shutdown, or sub-agent completion confirmed
```

## Human Checkpoints

### Checkpoint 1: 위임 모드 선택 (After Step 2)
**Context**: 복잡도/병렬성/소통 필요/규모 점수를 산출하여 Sub-Agent 또는 Team 모드를 선택한 시점. 잘못된 모드 선택은 리소스 낭비 또는 조율 실패로 이어진다.
**Ask**: "점수 **[X.X]** 기반으로 **[Sub-Agent / Team / Direct]** 모드를 선택했습니다. 이 결정이 맞나요?"
**Options**:
1. Sub-Agent — Agent 툴로 독립적 단일 도메인 작업 위임
2. Team — Agent Teams API로 멀티도메인 복잡 조율
3. Direct execution — 위임 없이 직접 실행
**Default**: 점수 기반 자동 선택
**Skippable**: Yes (use default) — 자동 점수 기반 모드로 진행
**Freedom**: MEDIUM

### Checkpoint 2: 범위 경계 승인 (After Step 3)
**Context**: 각 에이전트 또는 태스크의 책임 범위와 성공 기준을 정의한 시점. 모호한 범위 경계는 중복 작업이나 누락으로 이어진다.
**Ask**: "각 에이전트의 **범위와 성공 기준**이 명확하게 정의되었나요?"
**Options**:
1. Approve scopes — 정의된 범위 승인, 에이전트 생성 진행
2. Refine boundaries — 특정 에이전트의 범위를 추가로 조정
**Default**: 1 (범위가 구체적으로 작성되었다면 승인)
**Skippable**: No — 범위가 불명확하면 에이전트 결과의 품질을 보장할 수 없음
**Freedom**: HIGH

### Checkpoint 3: 팀 패턴 선택 (After Step 4)
**Context**: Team 모드에서 에이전트 간 조율 방식을 결정하는 시점. 패턴 선택은 리더십 구조, 소통 방식, 태스크 분배 전략에 영향을 미친다.
**Ask**: "이 작업에 **어떤 팀 패턴**이 가장 적합한가요?"
**Options**:
1. Leader — 명확한 권한, 리더가 태스크 할당 및 결과 수집
2. Council — 합의 필요, 팀원이 토론 후 리더가 결정
3. Swarm — 독립 태스크, 팀원이 TaskList에서 자율 선택
4. Pipeline — 순차 의존성, blockedBy로 실행 순서 강제
**Default**: 3 (대부분의 병렬 작업은 Swarm이 효율적)
**Skippable**: Yes (use default) — 기본값인 Swarm 패턴으로 진행
**Freedom**: MEDIUM

### Checkpoint 4: 결과 수락 여부 결정 (After Step 6)
**Context**: 모든 에이전트의 결과를 취합하고 중복 제거, 교차 검증, 우선순위 정렬을 완료한 시점. 요구사항을 충족하지 못한 결과는 추가 작업이 필요하다.
**Ask**: "취합된 결과가 **요구사항을 충족**하나요?"
**Options**:
1. Accept — 결과를 최종 산출물로 수락
2. Request additional work — 특정 에이전트에 추가 작업 요청
3. Retry — 전체 또는 일부 에이전트를 다시 실행
**Default**: 1 (명시적 충족 기준 달성 시 수락)
**Skippable**: No — 불완전한 결과를 그대로 수락하면 품질 보장 불가
**Freedom**: MEDIUM

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Score task | MEDIUM | Weighted formula defined, but factor estimation requires judgment |
| Select mode | MEDIUM | Thresholds defined, edge cases need interpretation |
| Define scope | HIGH | Scope boundaries are design decisions |
| Spawn agents/team | MEDIUM | Patterns defined, team sizing flexible |
| Monitor execution | HIGH | Intervention timing and strategy are situational |
| Aggregate results | MEDIUM | Process defined, synthesis requires judgment |
| Cleanup | LOW | Shutdown request to every teammate is mandatory |

## Complexity Budget Guide

Use `ComplexityBudget` from `lib/orchestration/complexity-budget.js` to objectively assess whether a task should be split before delegation.

### Import

```js
import { ComplexityBudget } from '../../lib/orchestration/complexity-budget.js';
```

### Using `shouldSplit()`

Call `shouldSplit()` with the task description text to get a split recommendation. The budget analyzes line count, subtask count, and file references against configurable thresholds:

```
const budget = new ComplexityBudget();
// Default thresholds: lines > 150, subtasks > 5, files > 7

const result = budget.shouldSplit(taskDescription);
// result = { shouldSplit: true, reasons: ['Subtask count (8) exceeds threshold (5)'] }

if (result.shouldSplit) {
  // Use suggestSplits() to find natural break points
  const splits = budget.suggestSplits(taskDescription);
  // splits.headings -> markdown heading boundaries
  // splits.numberedGroups -> numbered list items
  // splits.fileGroups -> files grouped by directory
}
```

### Integration with Delegation Mode Decision

Add complexity budget as a pre-check before delegation mode selection:

| Step | Action |
|------|--------|
| 1. Receive task description | Parse the raw request text |
| 2. `budget.shouldSplit(text)` | Check if the task exceeds complexity thresholds |
| 3. If `shouldSplit: true` | Decompose into sub-tasks using `suggestSplits()` |
| 4. Score each sub-task | Apply delegation mode scoring (complexity/parallelism/communication/scale) |
| 5. Delegate sub-tasks | Sub-Agent or Team mode per sub-task score |

### Custom Thresholds

Adjust thresholds for different contexts:

```
// Stricter thresholds for sub-agent mode (smaller tasks)
const subAgentBudget = new ComplexityBudget({ lines: 80, subtasks: 3, files: 5 });

// Relaxed thresholds for team mode (larger tasks acceptable)
const teamBudget = new ComplexityBudget({ lines: 300, subtasks: 10, files: 15 });
```

### Quick Complexity Check

Use `getScore()` for a quick complexity level assessment without split recommendations:

```
const score = budget.getScore(taskDescription);
// score = { lines: 45, subtasks: 3, files: 2, level: 'LOW' }
// level: 'LOW' | 'MEDIUM' | 'HIGH'
```

## Anti-Patterns

- Delegating trivial tasks (complexity < 0.3) to sub-agents or teams
- Unclear scope boundaries in task descriptions
- Sequential execution when parallel is possible
- Over-splitting into too many tiny tasks
- No result aggregation after parallel work
- **Using sub-agents when inter-agent communication is needed** (use Team Mode instead)
- **Creating a full team for single-domain focused tasks** (use Sub-Agent instead)
- Leaving teammates running after team work completes (no `shutdown_request` sent)
- Broadcasting when a direct message suffices

## Quick Reference

**Decision**: Score complexity/parallelism/communication/scale -> Sub-Agent (<0.6) or Team (>=0.6)
**Delegation matrix**: `${CLAUDE_SKILL_DIR}/references/delegation-matrix.md`
**Auto-trigger**: >7 dirs OR >50 files OR complexity >0.8 OR multi-domain + communication need

**Sub-Agent Flow (pipeline)**: `Agent(subagent_type, run_in_background=false)` -> receive result (blocking, for internal pipelines)
**Sub-Agent Flow (routing)**: `Agent(subagent_type)` -> return control to user (non-blocking default, for /sc delegation)
**Team Flow**: `Agent(type, name)` -> `TaskCreate` -> coordinate -> `SendMessage(shutdown_request)`

Always aggregate and cross-reference results from both modes.
Prefer Swarm pattern for independent tasks, Pipeline for dependencies, Council for consensus.
