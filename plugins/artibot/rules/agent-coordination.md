# Artibot Agent Coordination Rules

## Available Agents
28 specialized agents in `~/.claude/agents/`. Use Agent() to delegate.

## Model Policy (단일 티어 — Opus 5)
- **Opus (28/28)**: 모든 에이전트가 `opus` 티어 = `claude-opus-5`. 설계·계획·검수·구현·마케팅 구분 없이 동일 티어.
- **Fable**: 0. `artibot.config.json#/agents/modelPolicy/fable/enabled=false`로 게이트 OFF — high 버킷이 `model: fable`을 선언해도 실효 티어는 opus로 강등된다. allowlist 20종은 보존(재활성 대비).
- **Sonnet / Haiku**: 정책 미사용.
- **되돌리기**: `fable.enabled=true` 한 줄 → v4.38 fable/opus 분리 복원. 단 `agents/<name>.md` frontmatter `model:`도 함께 되돌려야 한다 (`scripts/ci/validate-model-policy.js`가 드리프트 게이트).
- **단일 진실원**: `lib/core/model-policy.js#resolveModel`. 티어→모델 ID는 `lib/core/model-catalog.js#MODELS`. 문서·프롬프트에 모델 ID를 하드코딩하지 말 것.

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
