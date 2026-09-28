# Artibot Agent Coordination Rules

## Available Agents
30 specialized agents in `~/.claude/agents/`. Use Agent() to delegate.

## Model Policy (단일 티어 opus — 오너 결정 2026-09-23 "fable 5.1 은 opus 5.5 로 대체")
- **Opus (30/30)**: 설계·검수·구현·마케팅 전부. `artibot.config.json#/agents/modelPolicy/fable/enabled=false` + 30개 `agents/<name>.md` frontmatter `model: opus`. `/team` 의 judge(검수) 팀원도 opus.
- **phase-role**: `agents.modelPolicy.phaseRoles { build: opus, review: opus }`. 코드 상수가 아니라 config 가 정본.
- **fable 티어는 휴면**: 카탈로그 `fable` 항목·`fable.allowlist` 10종(orchestrator, architect, planner, code-reviewer, spec-reviewer, quality-reviewer, llm-architect, repo-benchmarker, investigator, auditor)·`FABLE_DENYLIST`(security-reviewer — refusal 오탐률 미측정, 측정 전 해제 금지)는 남아 있으나 게이트가 꺼져 있어 전부 opus 로 해석된다. 2026-09-02~09-23 에는 allowlist 10종이 fable 인 2티어였다.
- **되살리기**: `fable.enabled=true` + `phaseRoles.review=fable` + 10개 frontmatter `model: fable` + `agents/INDEX.md` 재생성. `scripts/ci/validate-model-policy.js` 가 드리프트 게이트.
- **별칭(`deep-async`/`frontier`)**: `resolveModel(alias, { agentType })` 로 호출 에이전트를 넘겨야 allowlist·denylist 대조가 된다. agentType 없이 부르면 게이트 ON 여부만 본다(현재 OFF 라 전부 opus).
- **Sonnet / Haiku**: 정책 미사용.
- **단일 진실원**: `lib/core/model-policy.js#resolveModel` + `artibot.config.json#/agents/modelPolicy`. 티어→모델 ID는 `lib/core/model-catalog.js#MODELS`. 문서·프롬프트에 모델 ID를 하드코딩하지 말 것. 비용 계수는 `lib/core/model-catalog.js#getCostFactor`(fable 값은 토크나이저 계수 미측정 추정치).

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
