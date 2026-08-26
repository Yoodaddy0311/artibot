# Artibot Plugin Development Context

Auto-loads when Claude accesses `plugins/artibot/`.

## Stack

Claude Native Agent Teams API (named `Agent` spawns into the session's single implicit team + SendMessage + TaskCreate family) + 28 agents + 114 skills + 79 commands. ESM only, `"type": "module"`, zero runtime deps, Node >=20.

> **Honesty note (runtime middleware):** the default prompt pipeline runs an **11-stage** chain (`create-artibot-agent.js#defaultPipeline`) composed from the **15 middleware module files** in `lib/runtime/middleware/`. "11-stage" = the assembled default chain, not the module count; the remaining modules (aci-constraint, cache-roi, context-reset, otel-middleware, skill-trigger) are wired by other entry points or opt-in, not the default chain.

## 5-Layer Architecture

| Layer | Dir | Responsibility |
|---|---|---|
| 5 Runtime | `lib/runtime/` | 11-stage default middleware chain (of 15 modules), agent factory |
| 4 Cognitive | `lib/cognitive/` | System 1/2 routing, EFFORT_POLICY |
| 3 Learning | `lib/learning/` | memory, lifelong, knowledge-transfer, swarm sync |
| 2 Auxiliary | `lib/{adapters,swarm,privacy,visual,git,...}/` | Domain services |
| 1 Core | `lib/core/` | Config, I/O, cache, event-bus, guards |

Upper layers import lower only (5 → 4 → 3 → 2 → 1). Per-module detail lives in each source file's JSDoc `@module` header.

## DEV Protocol (Mandatory)

1. **DECOMPOSE** — numbered atomic items before any action
2. **EXECUTE** — Read target → change → re-read to confirm
3. **VERIFY** — report per item with `file:line` evidence

**Zero-Skip**: never silently drop any part of a multi-part request. If blocked, explain why + propose alternative.

## Problem-First Gate (Mandatory — 제안/개선/감사 작업)

제안·개선·감사 작업은 제시 **전에** `problem-validation` 스킬 검증 게이트를 통과해야 한다. null-result("변경 불필요")는 정당한 결과다. 사용자가 재검증을 지시하게 만들지 마라.

적용 범위: `/team` · `/improve` · `/analyze` · `/ultraplan` · `/implement` · `/go` · `/repo` — 모두 동일 규율(공유 진실원: `problem-validation` 스킬). 2026-08-16 기준 7개이며, 현재 목록은 `grep -rl problem-validation plugins/artibot/commands/` 가 정본이다.

## Operator-Waits DNA (auto-team)

Orchestrator delegates by default. Teammates execute and cross-check.

| Situation | Runner |
|---|---|
| <30 lines, single file, no domain risk | Orchestrator inline |
| ≥2 independent subtasks OR ≥2 files/domains OR medium+ complexity | **Parallel teammates** via `/team` (auto-triggered) |
| Any feature / bugfix / refactor | planner → parallel executors → reviewer |

Violation symptom: "all work done inline by main thread" = DNA breach. Opt-out: `--no-team` in prompt, or `team.autoApply: false` in `artibot.config.json`.

**Claude 4.8 Auto-Team**: 4.8 natively supports large-scale parallel delegation — ultracode (xhigh effort + always-on multi-agent permission via mid-conversation system messages) makes this a model-level capability. (`ultracode` is the official Claude Code **2.1.160** rename of the former "workflow" trigger keyword.) Artibot's Operator-Waits DNA still owns the *automatic* trigger: parallel teams fire on intent without the user typing `/team`. Note: the harness `Workflow` tool (deterministic JS orchestration via `agent()`/`parallel()`/`pipeline()`) is a SEPARATE, explicit-opt-in mechanism — it does not auto-fire.

> **Naming collision (external)** — Claude Code **2.1.154** shipped a platform feature called **"Dynamic Workflows"** (auto-orchestration across tens–hundreds of background agents). It is NOT the same as the harness `Workflow` tool, NOT Artibot's `team`/Auto-Team, and NOT `ultracode`. Six referents share the word "workflow" — bare "workflow" is banned in orchestration prose; use the [Canonical Naming Convention](docs/ORCHESTRATION-GLOSSARY.md#canonical-naming-convention) (Artibot's deterministic mechanism = **orchestrate**, classifier label `workflow`).

**Canonical evaluator**: the team trigger AND per-teammate effort/budget are both derived from one complexity classification by `lib/cognitive/workflow-plan.js#buildWorkflowPlan`; the numeric thresholds live only in `artibot.config.json#/team/autoApplyTriggers` (the table above is a summary).

Routing: see [docs/ORCHESTRATION-ROUTING.md](docs/ORCHESTRATION-ROUTING.md) — canonical decision tree, 2-axis model, and auto-fire rules for all four mechanisms.

## Auto-invoke Principle

Never tell the user to type slash-commands. Detect intent and trigger the right command/skill/agent without surfacing the slash syntax. Users include non-developers. Applies to `/team`, `/implement`, `/plan`, `/code-review`, `/verify`, `/daily` — all commands. Inner command workflows (phases, checklists) must run in full, never shortened.

**How it actually fires (hybrid, not pure code-autofire).** There is no hook that deterministically executes a command from a regex. "Auto-invoke" is two cooperating mechanisms:

1. **Native skill activation** — Claude Code matches the user's request against each skill's frontmatter `description` and loads matching skills on its own. The skill `description` quality is therefore the *real* lever: a precise, trigger-rich description is what makes a skill fire; a vague one silently won't. (This is why the description linter — R1 trigger floor, R2 anti-CSO — is a load-bearing gate, not cosmetics.)
2. **Meta-prose injection** — `scripts/hooks/runtime-prompt.js` injects advisory directives (e.g. `[artibot:hint recommend=X]`) into the prompt. These are *advisory*: the model surfaces a recommendation and acts on intent; they never force-execute `/orchestrate` or `/autopilot`.

So "Claude auto-triggers without the user typing a slash" is accurate at the behavior level, but the engine is description-driven model activation + advisory hints — not a hidden dispatcher that runs commands from keywords.

**Recommend-hint surfacing rule**: When the model receives an `[artibot:hint recommend=X]` directive (injected by `scripts/hooks/runtime-prompt.js`), it **must** surface the recommendation to the user as a single Korean sentence and wait for confirmation before acting. This is advisory only — the hint never auto-fires `/orchestrate` or `/autopilot`. Example phrasings:

- `recommend=workflow` (= orchestrate 추천, 동형 반복 감지): "이 작업은 같은 패턴 반복이라 고정 파이프라인(orchestrate)으로 돌리면 더 빠르고 결과가 일정해요. 그렇게 할까요?"
- `recommend=autopilot` (대형 무인작업 적합): "자리 비우셔도 되면 오토파일럿으로 돌릴 수 있어요."
- `recommend=split` (창 N개 분할 적합 — 파일 소유권이 갈리는 대형 작업): "이 작업은 줄기가 갈려서 창을 나눠 병렬로 돌리면 빨라요. `/split plan` 으로 나눠 볼까요?" → 사용자 확인 전 자동 실행 없음(`/split` 은 사람이 창을 여는 표면이라 모델은 제안만 한다).
- `recommend=watch` (유튜브 URL 감지): **명시적 예외 — 확인 없이 즉시 실행** (orchestrate/autopilot과 달리 사전 확인 불필요). transcript 모드는 경량·로컬·인바운드 전용(공개 자막 텍스트만)이라 advisory-only 원칙의 예외로 승인된 동작. frames(프레임 판독)는 여전히 opt-in — 토큰 비용이 있으므로 자동 실행 금지, 필요 시 한 줄 제안. yt-dlp 미설치 시 실행 대신 설치 안내만 출력.

See also: `commands/team.md` (hint cross-reference), `commands/autopilot.md` (hint cross-reference), `commands/watch.md` (watch hint cross-reference), `docs/ORCHESTRATION-ROUTING.md` (advisory-only rule).

## Quality Gates

- Read before write (no blind modifications)
- Functions < 50 lines, files < 800 lines
- Immutable patterns (spread/create new, never mutate)
- 80%+ coverage target; CI gate (`scripts/ci/validate-coverage.js`): Statements 85 / Branches 76 / Functions 85 / Lines 85 (vitest.config.js local gate is 80/76/80/80)

## Context Efficiency

- Instruction files ≤ 4K chars each, ≤ 12K chars total
- Front-load critical info in first 160 chars of outputs (compaction survival)
- Static instructions above dynamic context (cache hit rate)

## Testing

```
npm test               # 9,300+ tests via vitest
npm run test:coverage
npm run lint           # 0 errors/warnings target
npm run ci             # validate + skill:check + lint + test + eval:runtime
```

Config: `artibot.config.json` (model policy, team, cognitive). Manifest: `.claude-plugin/plugin.json`.

## Artibot Integration

See `~/.claude/rules/artibot/` for DEV Protocol, Agent Delegation, Quality Gates, and team auto-apply rules.
