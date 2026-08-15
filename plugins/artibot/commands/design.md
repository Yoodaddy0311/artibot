---
description: (Artibot) System design with architect agent and ADR generation
argument-hint: '[module] e.g. "인증 시스템 아키텍처 설계"'
allowed-tools: [Read, Glob, Grep, Bash, Agent, TaskCreate]
toolset: design
lifecycle: design
---

# /design

System design and architecture planning. Delegates to architect agent for structural analysis, trade-off evaluation, and Architecture Decision Record (ADR) generation.

## Arguments

Parse $ARGUMENTS:
- `system-or-module`: Target system, module, or feature to design
- `--type [domain]`: `api` | `data` | `infra` | `ui` | `full`
- `--adr`: Generate formal Architecture Decision Record
- `--alternatives [n]`: Number of design alternatives to evaluate (default: 2)

## Execution Flow

1. **Parse**: Identify design target and domain type
2. **Context**: Gather existing architecture:
   - Project structure and module boundaries
   - Current dependency graph
   - Existing design patterns in use
   - Technology stack and framework constraints
3. **Delegate**: Resolve the route via the CLI bridge, then spawn the agent:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/route-lifecycle.mjs" design "$ARGUMENTS"
   ```
   This calls `routeLifecycle('design', { hint })` from `lib/core/lifecycle-router.js` and prints the `{agent, toolset, skills, candidates}` resolution as a single JSON line (default agent: `architect`). Route to Agent(<resolved agent>) for:
   - Requirements analysis from target description
   - Design alternative generation (N options)
   - Trade-off matrix evaluation per alternative
   - Recommended approach with rationale
4. **ADR** (if `--adr`): Generate Architecture Decision Record:
   - Title, Status, Context, Decision, Consequences
   - Store in `docs/adr/` or project-specific ADR directory
5. **Validate**: Check design against SOLID principles, existing patterns, scalability needs
6. **Report**: Output design recommendation with trade-off analysis

## Design Evaluation Criteria

| Criterion | Weight | Measures |
|-----------|--------|----------|
| Maintainability | 30% | Complexity, readability, modification cost |
| Scalability | 25% | Load capacity, horizontal scaling, statelessness |
| Modularity | 20% | Coupling, cohesion, interface clarity |
| Simplicity | 15% | Abstraction count, learning curve |
| Extensibility | 10% | Plugin points, open/closed adherence |

## Output Format

Use GFM markdown tables:

**Summary**

| 항목 | 값 |
|------|-----|
| Target | [system/module] |
| Domain | [api/data/infra/ui] |
| Status | PROPOSED/ACCEPTED |

**Design Options**

| Option | Description | Advantages | Disadvantages | Score |
|--------|-------------|------------|---------------|-------|
| A: [name] | [summary] | [advantages] | [disadvantages] | [score] |
| B: [name] | [summary] | [advantages] | [disadvantages] | [score] |

**Recommendation**: [A/B] — [rationale]

**Dependency Map**

| From | To | Coupling |
|------|----|----------|
| [module] | [module] | tight/loose |

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 설계 구현 | `/implement` | 설계 결과 기반 구현 시작 |
| 2 | 설계 검증 | `/analyze` | 설계 품질 및 의존성 분석 |
| 3 | 설계 문서화 | `/document` | ADR 및 설계 문서 작성 |
