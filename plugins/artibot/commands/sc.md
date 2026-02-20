---
description: Artibot router - analyzes intent and routes to optimal command/agent/skill
argument-hint: '[request] e.g. "이 버그 분석해줘"'
allowed-tools: [Read, Glob, Grep, Bash, Task, TaskCreate]
---

# /sc

Main entry point for Artibot framework. Analyzes $ARGUMENTS to determine intent, complexity, and domain, then routes to the optimal command, agent, or skill.

## Arguments

Parse $ARGUMENTS:
- `request`: Natural language description of the task
- `--plan`: Show routing decision before execution
- `--force [command]`: Override auto-routing to specific command
- `--team`: Force team orchestration mode (bypass complexity assessment)
- `--solo`: Force single sub-agent mode (bypass complexity assessment)

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

### CRITICAL: Non-simple tasks MUST be delegated to keep the user's session responsive.

Target delegation ratio: **Simple ~25% | Sub-Agent ~35% | Team ~40%**

| Complexity | Conditions | Delegation Mode |
|------------|-----------|-----------------|
| **Simple** | 1 domain AND <3 steps AND no team hints | Direct execution by current agent |
| **Moderate** | 1-2 domains AND 3-5 steps AND no team hints | `Task(subagent_type, run_in_background=true)` — background sub-agent |
| **Team** | ANY of the team triggers below | `Task(orchestrator, run_in_background=true)` — background team orchestration |

### Team Mode Triggers (ANY one is sufficient)

| Trigger | Examples |
|---------|---------|
| `--team` flag present | `/sc --team 보안 점검해줘` |
| 3+ domains detected | 코드 + 테스트 + 문서 + 보안 |
| 2 domains AND >5 steps | 구현 + 테스트 (여러 파일) |
| Multi-target keywords | "전체", "모든", "전부", "all", "every", "across", "comprehensive" |
| Pipeline keywords | "파이프라인", "pipeline", "순차", "단계별", "phase" |
| Team/parallel keywords | "팀", "team", "병렬", "parallel", "동시에", "coordinate", "orchestrate", "spawn" |
| Scope keywords | "프로젝트 전체", "project-wide", "codebase", "전수", "일괄" |
| Evaluation/audit keywords | "평가", "감사", "audit", "evaluate", "점검", "검증", "verify" |
| Multi-file hints | "여러 파일", "multiple files", "모듈별", "디렉토리별" |

### Delegation Flow for Team Requests

When ANY team trigger matches:

```
1. Tell the user: "팀 오케스트레이션으로 처리합니다. 백그라운드에서 진행됩니다."
2. Task(
     subagent_type="artibot:orchestrator",
     prompt="[user's original request with full context]",
     run_in_background=true,
     description="Team orchestration: [brief summary]"
   )
3. Return control to user immediately
4. User can continue giving other commands while team works
```

### Delegation Flow for Moderate Requests

When no team trigger matches AND complexity is Moderate (1-2 domains, 3-5 steps):

```
1. Tell the user: "서브 에이전트에게 위임합니다. 백그라운드에서 진행됩니다."
2. Task(
     subagent_type=[matched agent type],
     prompt="[user's request with context]",
     run_in_background=true,
     description="[brief summary]"
   )
3. Return control to user immediately
4. User can continue giving other commands while sub-agent works
5. When sub-agent completes, summarize result to user
```

### Delegation Flow for Simple Requests

When 1 domain, <3 steps, no team hints, and no `--team` flag:

```
1. Execute the matched command inline (direct execution)
2. No background delegation needed (fast enough)
```

### Flag Overrides

| Flag | Effect |
|------|--------|
| `--team` | Force team mode regardless of complexity assessment |
| `--solo` | Force single sub-agent mode even if team triggers match |

## Anti-Patterns

- ❌ Do NOT analyze the codebase (Read/Glob/Grep) to determine complexity - classify from request keywords only
- ❌ Do NOT execute team-level tasks directly - delegate to orchestrator via `Task(orchestrator, run_in_background=true)`
- ❌ Do NOT block the user's session with long-running operations - use background delegation
- ❌ Do NOT default to sub-agent when team triggers are present - prefer team mode (target ~40%)
- ❌ Do NOT ignore `--team` / `--solo` flag overrides

## Fallback

If no route scores above 70% confidence, present top 3 candidates and ask user to clarify.
