# Artibot Agent Coordination Rules

## Available Agents
28 specialized agents in `~/.claude/agents/`. Use Task() to delegate.

## Model Policy (fable 마이그레이션 — v4.38)
- **Fable** (20, high 버킷 옵트인): orchestrator, architect, frontend/backend-developer, code-reviewer, tdd-guide, database-reviewer, mcp-developer, typescript-pro, planner, refactor-cleaner, build-error-resolver, llm-architect, devops-engineer, performance-engineer, e2e-runner, marketing-strategist, repo-benchmarker, quality-reviewer, spec-reviewer
- **Opus** (8): security-reviewer (FABLE_DENYLIST로 opus 고정 — fable refusal classifier 오탐 회피) + doc-updater, content-marketer, data-analyst, presentation-designer, seo-specialist, cro-specialist, ad-specialist (구 sonnet 버킷)
- **Sonnet**: 0 (전량 opus로 상향)
- **Kill-switch (원복)**: `artibot.config.json#/agents/modelPolicy/fable/enabled=false` → 모든 fable 요청이 즉시 opus로 강등 (코드 수정 불필요). 완전 원복은 마이그레이션 커밋 git revert.

## Delegation Rules
- Complex features → use planner agent first
- After writing code → use code-reviewer agent
- Bug fix or new feature → use tdd-guide agent
- Architecture decisions → use architect agent
- Multiple independent tasks → launch agents in parallel

## Quality Enforcement
- Every agent MUST follow DEV protocol (Decompose-Execute-Verify)
- Orchestrator verifies completion evidence from all teammates
- "Done" without proof = NOT done
