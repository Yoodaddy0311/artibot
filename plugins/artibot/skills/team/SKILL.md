---
description: Parallel team execution with cross-check — leader delegates, all opus teammates work independently then verify each other
triggers:
  - team
  - 팀
  - parallel team
  - 병렬 팀
  - cross-check
  - 크로스체크
  - 팀원들
  - 병렬로
---

# /team — Parallel Team with Cross-Check

Leader delegates work to opus-only teammates running in parallel. After completion, teammates cross-check each other's output.

## Activation
Auto-activates when: user mentions "team", "팀", "병렬로", "cross-check", or requests parallel independent work with verification.

## Workflow

### 1. Leader Decomposes (no file reading — from request text only)
```
요청 분해:
1. [work unit] → [agent-type]
2. [work unit] → [agent-type]
```

### 2. Team Setup + Parallel Spawn
```javascript
TeamCreate({ team_name: "team-{slug}" })

// Spawn ALL in single message (parallel):
Task({ subagent_type: "artibot:{type}", model: "opus", team_name: "team-*", name: "{role}" })
```

### 3. All Teammates Work Independently
- NO blockedBy between peer tasks
- Each teammate follows DEV Protocol (Decompose-Execute-Verify)
- Leader monitors but does NOT do work

### 4. Cross-Check Phase
After main work completes:
- Teammate A reviews B's work
- Teammate B reviews C's work
- Teammate C reviews A's work (circular)

Each cross-checker verifies:
- Requirements met
- Code correctness
- Tests pass
- No regressions

### 5. Leader Reports Results
Present combined results with cross-check outcomes to user.

## Key Constraints
- Leader = delegation ONLY (never implements)
- ALL teammates = opus model
- ALL work = parallel (unless true dependency)
- Cross-check = mandatory (unless --skip-crosscheck)
- Cross-checker cannot review own work
