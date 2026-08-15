---
context: fork
name: orchestration
description: |
  Routing intelligence engine that analyzes requests and routes to optimal agents, skills, and commands.
  Supports two delegation modes: Sub-Agent (Task tool) for focused tasks and Team Mode (Agent Teams API) for complex multi-domain coordination.
  Auto-activates when: complex multi-step requests, team composition needed, multi-domain tasks, ambiguous intent.
  Triggers: orchestrate, build, implement, design, route, complex, multi-step, team, coordinate
  한국어: 오케스트레이션, 팀 구성, 복잡한 작업, 병렬 처리, 위임, 조율
lang: [en, ko]
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
progressive_disclosure:
  enabled: true
  level1_tokens: 100
  level2_tokens: 4000
triggers:
  - "orchestrate"
  - "build"
  - "design"
  - "route"
  - "complex"
  - "multi-step"
  - "team"
  - "coordinate"
  - "오케스트레이션"
  - "팀 구성"
  - "병렬 처리"
  - "위임"
agents:
  - "orchestrator"
tokens: "~3K"
category: "orchestration"
source_hash: 27f267d4
whenNotToUse: "Simple single-agent, single-file tasks under 30 lines where orchestration overhead exceeds the value; also not applicable outside the Artibot plugin environment."
---

# Orchestration & Routing Intelligence

## When This Skill Applies
- Multi-step requests requiring coordination across domains
- Ambiguous requests needing intent classification
- Team composition decisions (solo/sub-agent/team)
- Complex tasks requiring peer-to-peer agent communication

## Complexity Classification

| Level | Steps | Token Budget | Action |
|-------|-------|-------------|--------|
| simple | <3 | 5K | Direct execution |
| moderate | 3-10 | 15K | Sub-Agent |
| complex | >10 | 30K+ | Team mode |

## Delegation Mode Selection

**Score >= 0.5 → Team Mode** | **Score < 0.5 → Sub-Agent**

| Factor | Weight | Sub-Agent | Team |
|--------|--------|-----------|------|
| Complexity | 0.3 | < 0.5 | >= 0.5 |
| Parallel ops | 0.3 | 1-2 tasks | 3+ tasks |
| P2P comms | 0.2 | one-way | needed |
| File scale | 0.2 | <20 files | 20+ files |

Team mode auto-boost keywords: "전체", "모든", "all", "comprehensive", "audit", "병렬", "parallel", "codebase", "전수", "일괄"

## Team Patterns

| Pattern | Use case | Flow |
|---------|----------|------|
| Leader | Sequential with handoffs | Agent spawns -> TaskCreate -> assign -> aggregate |
| Council | Discussion-based decisions | spawn → SendMessage discussion → leader decides |
| Swarm | Independent parallel work | TaskCreate (all items) → teammates self-claim |
| Pipeline | Strict dependencies | TaskCreate with blockedBy chains |

## HARD-GATE: Design Before Implementation

For System 2 (complex) requests: **produce and get approval for a design doc before any Edit/Write/Bash**.

1. Write design to `docs/plans/{date}-{slug}.md`
2. Present to user, wait for explicit approval
3. Only proceed after "approve" / "LGTM" / "go ahead"

Bypass: System 1 requests, explicit user override ("just do it"), `--hotfix` flag.

## Quick Reference

**Team API Tools**: Agent(type, name), TaskCreate, TaskUpdate, TaskList, TaskGet, SendMessage. No create/delete calls: the session has one implicit team, and shutdown_request is the teardown.

**Token zones**: Green 0-60% | Yellow 60-75% (enable --uc) | Orange 75-85% (compress) | Red 85%+ (/clear)

**Full routing matrix**: See `references/routing-table.md`  
**DAG task dependency guide**: See `references/dag-guide.md`  
**Platform compatibility**: See `references/platform-compat.md`
