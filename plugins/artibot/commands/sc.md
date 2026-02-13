---
description: SuperClaude router - analyzes intent and routes to optimal command/agent/skill
argument-hint: [request] [--flags]
allowed-tools: [Read, Glob, Grep, Bash, Task, TodoWrite]
---

# /sc

Main entry point for SuperClaude framework. Analyzes $ARGUMENTS to determine intent, complexity, and domain, then routes to the optimal command, agent, or skill.

## Arguments

Parse $ARGUMENTS:
- `request`: Natural language description of the task
- `--plan`: Show routing decision before execution
- `--force [command]`: Override auto-routing to specific command

## Routing Algorithm

1. **Parse Intent**: Extract verbs, nouns, domains, and complexity indicators from request
2. **Score Candidates**: Match against routing table below
3. **Select Route**: Pick highest-confidence match
4. **Delegate**: Execute the selected command/agent with original arguments

## Routing Table

| Intent Pattern | Route | Confidence |
|----------------|-------|------------|
| analyze, review, investigate | /analyze | 90% |
| build, scaffold, setup | /build | 90% |
| build error, compile fail | /build-fix | 95% |
| implement, create feature, develop | /implement | 88% |
| improve, optimize, enhance | /improve | 85% |
| plan, breakdown, scope | /plan | 90% |
| design, architect, system design | /design | 90% |
| task, todo, track, progress | /task | 85% |
| git, commit, branch, PR | /git | 95% |
| test, coverage, assertion | /test | 90% |
| tdd, red-green, test-first | /tdd | 95% |
| review code, code review | /code-review | 92% |
| refactor, cleanup, dead code | /refactor-clean | 88% |
| verify, validate, check | /verify | 90% |
| checkpoint, snapshot, save state | /checkpoint | 90% |
| troubleshoot, debug, why broken | /troubleshoot | 88% |
| document, docs, readme | /document | 90% |
| content, blog, social, seo | /content | 90% |
| orchestrate, team, coordinate | /orchestrate | 92% |
| learn, remember, pattern | /learn | 85% |

## Execution Flow

1. **Parse**: Tokenize request, extract intent verbs, target nouns, flag modifiers
2. **Classify**: Score each candidate route using keyword match (40%) + context analysis (40%) + flag hints (20%)
3. **Resolve Ambiguity**: If top two scores within 10%, check for explicit `--force` or ask user
4. **Route**: Invoke selected command with passthrough arguments
5. **Report**: Display routing decision with confidence score

## Complexity Assessment

- **Simple** (1 route): Direct delegation, no sub-agents
- **Moderate** (2-3 domains): Select primary route, suggest follow-up commands
- **Complex** (4+ domains): Recommend /orchestrate for multi-agent coordination

## Fallback

If no route scores above 70% confidence, present top 3 candidates and ask user to clarify.
