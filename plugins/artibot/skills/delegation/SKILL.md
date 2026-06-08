---
context: fork
name: delegation
description: |
  Delegation strategies for parallel and complex multi-file operations using Sub-Agent or Team Mode.
  Sub-Agent Mode: Task tool for focused, single-session tasks.
  Team Mode: Agent Teams API for complex multi-domain coordination with peer communication.
  Auto-activates when: >7 directories, >50 files, multi-domain operations, high complexity tasks, team coordination needed.
  Triggers: delegate, parallel, sub-agent, team, concurrent, large-scale, orchestrate, coordinate, 위임, 병렬, 대규모, 팀
lang: [en, ko]
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
  - "concurrent"
  - "large-scale"
  - "위임 전략"
  - "병렬"
  - "대규모"
agents:
  - "orchestrator"
tokens: "~3K"
category: "orchestration"
source_hash: dd3cd6dd
whenNotToUse: "Do not delegate single-file changes under 30 lines to sub-agents or teams — the delegation overhead exceeds the task cost. Do not use Team Mode for tasks with strict sequential dependencies where all work would block on the first agent anyway."
---

# Delegation Strategies

## When This Skill Applies
- Operations spanning >7 directories or >50 files
- Multi-domain analysis (security + performance + quality)
- Complex tasks with parallelizable sub-operations
- Tasks requiring peer-to-peer agent communication

## Delegation Mode Decision

| Factor | Weight | Sub-Agent | Team |
|--------|--------|-----------|------|
| Complexity | 0.3 | < 0.5 | >= 0.5 |
| Parallel ops | 0.3 | 1-2 tasks | 3+ tasks |
| P2P comms | 0.2 | one-way | needed |
| File scale | 0.2 | <20 files | 20+ files |

**Score < 0.5 → Sub-Agent** | **Score >= 0.5 → Team**

Team auto-boost: "전체", "all", "comprehensive", "audit", "병렬", "parallel", "codebase", "전수"

## Sub-Agent Mode

- `Task(subagent_type)` — blocking (command pipelines)
- `Task(subagent_type, run_in_background=true)` — non-blocking (responsive UX)
- `Task(subagent_type, { isolation: "worktree" })` — worktree isolation for concurrent file edits
- Max concurrent: 7

**Parallelization gains**: by directory >7 dirs ~65% | by file batch >50 files ~60% | by domain >2 areas ~70%

## Team Mode (Agent Teams API)

**Lifecycle**: TeamCreate → Task(type, team, name) → TaskCreate → TaskUpdate → SendMessage → TaskUpdate(complete) → TeamDelete

| Pattern | Use when | Coordination |
|---------|----------|-------------|
| Leader | Clear authority | Leader assigns via TaskUpdate |
| Council | Consensus needed | SendMessage discussion → leader decides |
| Swarm | Independent tasks | Teammates self-claim from TaskList |
| Pipeline | Sequential deps | TaskCreate with blockedBy |

**Team sizing**: Squad 3 | Platoon 5 | Battalion 7+

## Complexity Budget Pre-Check

Before delegation, check `ComplexityBudget.shouldSplit(taskDescription)` from `lib/orchestration/complexity-budget.js`. Split if: lines >150, subtasks >5, files >7. Use `suggestSplits()` to find natural break points.

## Result Aggregation

Collect → Deduplicate → Cross-reference → Prioritize → Synthesize

**Full delegation matrix**: See `references/delegation-matrix.md`

## Common Rationalizations
- "한 줄이라 굳이 위임 안 해도 되지" → 위반: 범위가 아닌 복잡도가 기준
- "내가 더 빨라" → 측정 안 된 추정; 병렬 실행은 항상 직렬보다 빠름
- "에이전트 세팅이 귀찮아" → 오버헤드 비용 < 직렬 실행 비용 (3+ 파일 기준)
- "이번 한 번만" → 패턴이 굳어지면 DNA 위반 기본값이 됨

## Red Flags
- 메인 스레드가 3파일 이상 직접 편집
- 위임 없이 30분 이상 단독 작업
- Task() 없이 multi-domain 작업 진행
- Sub-Agent 결과 검증 없이 바로 머지
