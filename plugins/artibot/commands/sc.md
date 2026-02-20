---
description: Artibot router - analyzes intent and routes to optimal command/agent/skill
argument-hint: '[request] e.g. "이 버그 분석해줘"'
allowed-tools: [Read, Glob, Grep, Bash, Task, TodoWrite]
---

# /sc

Main entry point for Artibot framework. Analyzes $ARGUMENTS to determine intent, complexity, and domain, then routes to the optimal command, agent, or skill.

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
| estimate, effort, sizing, complexity scoring | /estimate | 88% |
| design, architect, system design | /design | 90% |
| task, todo, track, progress | /task | 85% |
| git, commit, branch, PR | /git | 95% |
| test, coverage, assertion | /test | 90% |
| tdd, red-green, test-first | /tdd | 95% |
| review code, code review | /code-review | 92% |
| refactor, cleanup, dead code | /refactor-clean | 88% |
| clean up, unused imports, technical debt, dead code elimination | /cleanup | 88% |
| verify, validate, check | /verify | 90% |
| checkpoint, snapshot, save state | /checkpoint | 90% |
| troubleshoot, debug, why broken | /troubleshoot | 88% |
| explain, how does, what is, teach, understand | /explain | 90% |
| document, docs, readme | /document | 90% |
| content, blog, landing page copy | /content | 90% |
| marketing strategy, go-to-market, GTM, market analysis | /mkt | 92% |
| email campaign, newsletter, drip, email marketing | /email | 90% |
| presentation, slides, pitch deck, ppt, keynote | /ppt | 92% |
| data analysis, report, excel, spreadsheet, dashboard | /excel | 88% |
| social media, social post, twitter, linkedin, instagram | /social | 90% |
| ad copy, advertising, PPC, paid media, Google Ads | /ad | 88% |
| SEO, keyword research, search engine, ranking | /seo | 92% |
| CRM, customer journey, lead scoring, pipeline | /crm | 88% |
| marketing analytics, KPI dashboard, attribution, ROAS | /analytics | 88% |
| CRO, conversion rate, landing page optimization, funnel | /cro | 90% |
| orchestrate, team, coordinate | /orchestrate | 92% |
| spawn, multi-agent, parallel tasks, pipeline execution | /spawn | 92% |
| swarm, collective, federated, sync patterns | /swarm | 90% |
| learn, remember, pattern | /learn | 85% |
| index, browse, catalog, discover commands | /index | 85% |
| load, context, project scan, framework detect | /load | 88% |
| update, upgrade, version check, 업데이트 | /artibot:update | 95% |
| 어벤저스 어셈블, avengers assemble, assemble | /artibot:assemble | 99% |

## Execution Flow

1. **Parse**: Tokenize request, extract intent verbs, target nouns, flag modifiers
2. **Classify**: Score each candidate route using keyword match (40%) + context analysis (40%) + flag hints (20%)
3. **Resolve Ambiguity**: If top two scores within 10%, check for explicit `--force` or ask user
4. **Assess Complexity**: Count domains and steps FROM THE REQUEST TEXT ONLY to determine delegation mode (see below). Do NOT read files to assess.
5. **Route & Delegate**: Execute based on complexity level
6. **Report**: Display routing decision with confidence score

## Complexity-Based Delegation

### CRITICAL: Complex tasks MUST be delegated to keep the user's session responsive.

| Complexity | Domains | Steps | Delegation Mode |
|------------|---------|-------|-----------------|
| **Simple** | 1 | <3 | Direct execution by current agent (invoke the command inline) |
| **Moderate** | 2-3 | 3-10 | `Task(subagent_type)` - fire-and-forget sub-agent for the matched route |
| **Complex** | 4+ | >10 | `Task(orchestrator, run_in_background=true)` - background team orchestration |

### Delegation Flow for Complex Requests

When complexity is "Complex" (4+ domains OR explicit team/orchestrate/spawn keywords):

```
1. Tell the user: "복잡한 요청으로 판단됩니다. 팀장(orchestrator)에게 위임합니다."
2. Task(
     subagent_type="artibot:orchestrator",
     prompt="[user's original request with full context]",
     run_in_background=true,
     description="Team orchestration: [brief summary]"
   )
3. Return control to user immediately
4. User can continue giving other commands while orchestrator works
```

### Delegation Flow for Moderate Requests

When complexity is "Moderate" (2-3 domains):

```
1. Identify the primary route from the routing table
2. Task(
     subagent_type=[matched agent type],
     prompt="[user's request with context]",
     description="[brief summary]"
   )
3. Report result to user when sub-agent returns
```

## Anti-Patterns

- ❌ Do NOT analyze the codebase (Read/Glob/Grep) to determine complexity - classify from request keywords only
- ❌ Do NOT execute complex tasks directly - delegate to orchestrator via `Task(orchestrator, run_in_background=true)`
- ❌ Do NOT block the user's session with long-running operations - use background delegation

## Fallback

If no route scores above 70% confidence, present top 3 candidates and ask user to clarify.
