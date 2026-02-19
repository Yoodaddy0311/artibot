---
name: orchestration
description: |
  Intelligent routing and orchestration engine for Artibot.
  Analyzes user intent, selects optimal personas/agents/tools,
  manages flag activation, and coordinates multi-step workflows.

  Use proactively when user submits any request requiring
  tool selection, persona activation, or multi-agent coordination.

  Triggers: analyze, build, implement, improve, design, plan,
  task, test, troubleshoot, review, refactor, deploy,
  분석, 빌드, 구현, 개선, 설계, 계획, 태스크, 테스트, 리팩토링,
  分析, ビルド, 実装, 改善, 設計

  Do NOT use for: simple single-file edits, direct answers,
  or tasks with explicitly specified tools.
---

# Orchestration Engine

> Intelligent routing that maps user intent to optimal execution strategy.

## When This Skill Applies

- Any multi-step task requiring tool/persona/agent selection
- Requests with `--flags` that need resolution
- Complex operations spanning multiple files or domains
- Team orchestration and agent delegation decisions

## Intent Detection

### 1. Parse Request

Extract from user input:
- **Keywords**: Match against domain/operation matrices
- **Scope**: file | module | project | system
- **Complexity**: simple (<3 steps) | moderate (3-10) | complex (>10)

### 2. Domain Classification

| Domain | Indicators | File Patterns |
|--------|-----------|---------------|
| frontend | UI, component, React, CSS, responsive | *.tsx, *.css, *.scss |
| backend | API, database, server, endpoint | *.ts, *.py, controllers/* |
| security | vulnerability, auth, encryption | *auth*, *security* |
| infrastructure | deploy, Docker, CI/CD, monitoring | Dockerfile, *.yml |
| documentation | document, README, guide, wiki | *.md, docs/* |

### 3. Operation Classification

| Type | Verbs | Typical Tools |
|------|-------|---------------|
| analysis | analyze, review, investigate | Grep, Read, Sequential |
| creation | create, build, implement | Write, Magic, Context7 |
| modification | update, refactor, improve | Edit, Sequential |
| debugging | debug, fix, troubleshoot | Grep, Sequential |
| testing | test, validate, verify | Playwright, Sequential |

## Routing Decision

### Complexity-Based Strategy

**Simple** (single file, <3 steps):
- Direct execution, no delegation
- Token budget: ~5K

**Moderate** (multi-file, 3-10 steps):
- Persona activation + MCP selection
- Token budget: ~15K

**Complex** (system-wide, >10 steps):
- Agent delegation + team orchestration
- Token budget: ~30K+

### Agent Delegation Triggers

| Condition | Action |
|-----------|--------|
| >7 directories | Auto-delegate with parallel-dirs |
| >50 files | Auto-delegate with file-level agents |
| >3 domains | Auto-delegate with parallel-focus |
| Complexity >0.8 | Enable thinking flags + sequential |

## Team Orchestration Patterns

| Pattern | When | Description |
|---------|------|-------------|
| Leader | Planning, decisions | Orchestrator distributes, agents execute |
| Council | Design, review | Multi-perspective collection, consensus |
| Swarm | Large implementation | Parallel distributed execution |
| Pipeline | Sequential deps | A -> B -> C chain execution |

## Quality Gates

Every operation passes through validation:
1. Pre-execution: Scope confirmed, resources available
2. Mid-execution: Progress tracked, blockers identified
3. Post-execution: Results verified, evidence collected

## References

- `references/routing-table.md` - Complete routing decision matrix
- `references/flag-system.md` - Flag activation and precedence rules
- `references/persona-activation.md` - Persona auto-activation scoring
