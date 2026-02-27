# Artibot Agent Coordination Rules

## Available Agents
26 specialized agents in `~/.claude/agents/`. Use Task() to delegate.

## Model Policy
- **Opus** (73%): orchestrator, architect, security-reviewer, frontend/backend-developer, code-reviewer, tdd-guide, database-reviewer, mcp-developer, typescript-pro, planner, refactor-cleaner, build-error-resolver, llm-architect, devops-engineer, performance-engineer, e2e-runner, marketing-strategist, repo-benchmarker
- **Sonnet** (27%): doc-updater, content-marketer, data-analyst, presentation-designer, seo-specialist, cro-specialist, ad-specialist

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
