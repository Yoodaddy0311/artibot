---
name: team
context: fork
description: "Parallel team execution with cross-check — the leader delegates, teammates work independently, then verify each other. Use when the user asks for parallel independent work with cross-verification. Triggers: team, parallel team, cross-check, verification, 팀, 병렬 팀, 팀원들, 병렬로."
lang: [en]
triggers:
  - team
  - 팀
  - parallel team
  - 병렬 팀
  - cross-check
  - verification
  - 팀원들
  - 병렬로
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 2
category: orchestration
tokens: 2500
agents: [orchestrator, planner]
source_hash: 6dea8d09
whenNotToUse: "Single-file edits under 30 lines, simple single-domain tasks, or requests explicitly flagged with --no-team where inline execution is more efficient than parallel team overhead. Deterministic homogeneous fan-out (the same command repeated across many inputs) should prefer the harness Workflow tool over /team, since /team is adaptive model-driven orchestration while a repeated-command batch fits a deterministic pipeline."
---

# /team

리더가 직접 구현하지 않고 작업을 분해해 병렬 팀으로 위임한 뒤, 마지막에 교차 검증까지 수행하는 스킬입니다.

## Activation

다음과 같은 요청에서 사용합니다.
- 병렬로 나눠서 진행해줘
- 팀으로 처리해줘
- 서로 검증하면서 병렬 작업해줘
- cross-check가 필요한 독립 작업

## Workflow

1. 리더가 요청을 독립 작업 단위로 분해합니다.
2. 팀을 만들고 모든 작업을 병렬로 위임합니다.
3. 각 팀원은 자기 작업을 독립적으로 수행합니다.
4. 1차 결과가 모이면 서로의 결과를 교차 검증합니다.
5. 리더가 전체 결과와 검증 의견을 합쳐 사용자에게 보고합니다.

## Checklist

```text
Progress:
- [ ] 요청을 작업 단위로 분해
- [ ] 팀 생성 및 역할 할당
- [ ] 병렬 실행 시작
- [ ] 각 결과 수집
- [ ] 교차 검증 수행
- [ ] 최종 통합 보고
```

## Worktree 격리 모드 (선택)

병렬 작업 시 파일 충돌을 원천 방지하려면 팀원을 격리된 Git worktree에서 생성합니다.
각 팀원이 독립된 worktree에서 작업하므로 동일 파일 동시 수정이 안전합니다.

**TEAM SETUP 시 적용**:
격리는 `Agent(...)` 호출마다 지정합니다. `isolation: "worktree"` 를 준 팀원만
격리된 worktree에서 생성되고, 주지 않은 팀원은 공유 워킹트리에서 작업합니다.

```
Agent(subagent_type, name="{run-slug}-{role}", { isolation: "worktree" })
```

런 슬러그 = `team-{task-slug}-{sid}`, `{sid}` 는 세션 판별자 — `commands/team.md` Phase 2 참조.

**주의사항**:
- 격리를 전역 기본값으로 켜는 설정은 없습니다 — 켜려면 호출마다 옵션을 주십시오.
- 변경이 없는 worktree는 자동 정리됩니다. 변경이 있으면 남습니다.
- **결과 병합은 자동이 아닙니다.** 격리된 팀원의 산출물을 메인 워킹트리로
  가져오는 것은 리더의 책임이며, 통합 절차를 명시해야 합니다.

## Auto-Apply Mode

`team.autoApply: true` (default) in `artibot.config.json` enables automatic team mode.
When enabled, Claude automatically uses /team workflow for requests that meet ALL criteria:

1. **2+ independent subtasks** that can be parallelized
2. **2+ different files or domains** (e.g., frontend + backend, hook + config)
3. **Medium or higher complexity** (not a simple single-file edit or question)

### Opt-out

| Method | Scope | How |
|--------|-------|-----|
| Config | Permanent | `team.autoApply: false` in `artibot.config.json` |
| Local | Per-user | Add `team.autoApply: false` in `CLAUDE.local.md` |
| Prompt | Per-request | Include `--no-team` in the prompt |

## Guardrails

See: [docs/ORCHESTRATION-ROUTING.md](../../docs/ORCHESTRATION-ROUTING.md) — canonical routing reference; explains when team auto-fires vs. when workflow/autopilot require explicit opt-in.

- 리더는 직접 구현보다 분해와 조정에 집중합니다.
- 실제 의존성이 없는 작업만 병렬화합니다.
- 교차 검증 없이 결과를 바로 합치지 않습니다.
- 같은 사람이 자기 결과를 검증하지 않습니다.
- 최종 보고에는 “무엇을 했는지”뿐 아니라 “무엇을 검증했는지”를 함께 적습니다.

## Rationalizations

The following table captures common excuses agents make to skip the rigor of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "solo is faster than coordinating" | solo hits sequential limits; parallel teams finish in wall-clock time, not agent-time |
| "agents will duplicate work" | that is what cross-check is for — duplication is caught and reconciled |
| "the orchestrator is overhead" | orchestrator enforces decomposition and verification — without it you get drift |
| "I will just do it myself" | that scales to one task; teams scale to domains |
| "cross-check is redundant review" | cross-check is independent verification from a different lens — that is how bugs get caught |
