# Artibot Agent Coordination Rules

## Available Agents
28 specialized agents in `~/.claude/agents/`. Use Agent() to delegate.

## Model Policy (2티어 — 설계·검수 Fable 5.1 / 구현 Opus 5, 오너 결정 2026-09-02)
- **Fable (8/28)**: 설계·검수 역할만 — orchestrator, architect, planner, code-reviewer, spec-reviewer, quality-reviewer, llm-architect, repo-benchmarker. `artibot.config.json#/agents/modelPolicy/fable/enabled=true` + `fable.allowlist` 8종 + 해당 `agents/<name>.md` frontmatter `model: fable`. 근거: 오너 9/1 정책 "구현·테스트 서브에이전트 = opus, 검수·설계 = fable"(Ontology queue.md).
- **Opus (20/28)**: 구현·마케팅 에이전트 전부. `high` 버킷이 `model: fable` 을 선언해도 allowlist 밖이면 게이트가 opus 로 강등한다(의도된 동작). `security-reviewer` 는 `FABLE_DENYLIST` 로 영구 opus(refusal 오탐 — 5.1 오탐률 미측정, 측정 전 해제 금지).
- **phase-role**: `agents.modelPolicy.phaseRoles { build: opus, review: fable }` — `/team` 구현 phase 는 opus, 크로스체크·인스펙션은 fable. 코드 상수가 아니라 config 가 정본.
- **별칭(`deep-async`/`frontier`)**: `resolveModel(alias, { agentType })` 로 호출 에이전트를 넘겨야 allowlist·denylist 대조가 된다. agentType 없이 부르면 게이트 ON 여부만 본다.
- **Sonnet / Haiku**: 정책 미사용.
- **되돌리기(단일 티어 opus)**: `fable.enabled=false` 한 줄 + 8개 frontmatter `model: opus`. `scripts/ci/validate-model-policy.js` 가 드리프트 게이트.
- **단일 진실원**: `lib/core/model-policy.js#resolveModel`. 티어→모델 ID는 `lib/core/model-catalog.js#MODELS`(fable = `claude-fable-5-1`). 문서·프롬프트에 모델 ID를 하드코딩하지 말 것. 비용 계수 2.6× 는 미검증 수치.

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
