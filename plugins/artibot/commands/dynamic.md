---
description: (Artibot) Dynamic Workflows-style deterministic multi-agent run — explicit opt-in entry to the harness Workflow tool (fan-out, pipeline, adversarial verify, migration sweep)
argument-hint: '[task] e.g. "lib/legacy/*.js 전부 ESM으로 변환" --preset migrate'
allowed-tools: [Read, Glob, Grep, Bash, Workflow]
disable-model-invocation: true
---

# /dynamic

Explicit opt-in entry point for **harness `Workflow` tool** runs — deterministic, script-driven
multi-agent orchestration over a known worklist (fan-out, pipelines, adversarial verification,
loop-until-dry sweeps).

> **Naming (canonical — [ORCHESTRATION-GLOSSARY](../docs/ORCHESTRATION-GLOSSARY.md#canonical-naming-convention)):**
> - `/dynamic` authors and runs a **harness `Workflow` tool** script (`agent()`/`parallel()`/`pipeline()`).
> - It is **NOT `/orchestrate`** (Agent Teams pattern pipelines — feature/bugfix/refactor/security) and
>   **NOT "Dynamic Workflows (platform)"** (session-level auto-orchestration, opted in via `ultracode`).
> - **Monitoring**: `/dynamic` runs DO appear in the native **`/workflows` monitor** (unlike `/orchestrate`
>   runs, which live on Agent Teams and are tracked via `TaskList`).

## Opt-in Contract

Invoking this command **is** the explicit user opt-in the Workflow tool requires. The reverse is
forbidden: never auto-fire this command from a classifier hint — `[artibot:hint recommend=workflow]`
stays advisory-only (see [ORCHESTRATION-ROUTING](../docs/ORCHESTRATION-ROUTING.md), Harness Constraint).

## Arguments

Parse $ARGUMENTS:
- `task`: What to run (required)
- `--preset [review|research|migrate|sweep]`: Workflow shape (auto-detected from task if omitted)
- `--items "<glob|list>"`: Explicit worklist override (skips scouting)
- `--budget <tokens>`: Token target passed to the run (hard ceiling — agent() calls throw past it)
- `--dry-run`: Author and show the script + estimated agent count; do not execute

## Presets

| Preset | Shape | Use when |
|---|---|---|
| `review` | dimensions → find → adversarially verify each finding | 브랜치/PR 버그 사냥, 품질 감사 |
| `research` | multi-modal sweep → deep-read → synthesize with citations | 조사·비교 리포트 |
| `migrate` | discover sites → transform each (worktree isolation) → verify | N-파일 기계적 변환 |
| `sweep` | loop-until-dry finders + dedup-vs-seen + judge panel | 규모 미지수 탐색 (버그/이슈/엣지케이스) |

## Execution Flow

1. **Scout inline first (hybrid rule)**: resolve the concrete worklist BEFORE orchestrating —
   Glob/Grep/Bash to enumerate files, modules, or sources. Never guess the fan-out set.
   `--items` skips this step.
2. **Author the script**: `export const meta = { name, description, phases }` (pure literal) +
   script body. **pipeline() is the default**; use a parallel() barrier only when a stage genuinely
   needs ALL prior results (dedup/merge, zero-count early-exit). Use `schema` for structured agent
   returns. No `Date.now()`/`Math.random()` in scripts (breaks resume) — stamp timestamps after return.
3. **Run** via the Workflow tool (script inline). The tool result returns `runId` and a persisted
   `scriptPath`.
4. **Monitor / resume**: progress is visible in the native `/workflows` monitor. After a pause,
   kill, or script edit: re-invoke with `{ scriptPath, resumeFromRunId }` — the unchanged prefix
   of agent() calls returns cached results.
5. **Report**: synthesize the returned structured results for the user. `log()` any dropped
   coverage (top-N caps, skipped items) — no silent truncation. When a completed run returns an
   empty/odd result, read `<transcriptDir>/journal.jsonl` before diagnosing.

## Guardrails

- **Worktree isolation** (`isolation: 'worktree'`) only when agents mutate files in parallel — it is
  expensive; read-only stages never need it.
- **Effort/model overrides**: omit by default (inherit session); `effort: 'low'` for mechanical
  stages, higher tiers only for verify/judge stages.
- **Honest reporting**: journal is the source of truth for agent returns; never present cached or
  partial results as fresh full coverage.

## vs Other Entry Points

| Command | Engine | Control flow | Auto-fires? |
|---|---|---|---|
| `/dynamic` | harness `Workflow` tool | script-driven (deterministic) | No — this command IS the opt-in |
| `/orchestrate` | Agent Teams | predefined dev patterns | No |
| `/team` | Agent Teams | model-driven (adaptive) | Yes (Operator-Waits DNA) |
| `/workflows` | — (native monitor) | n/a — watches `Workflow` tool runs only | n/a |

## Next Steps

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 실행 모니터 | `/workflows` | 진행 중 run 관찰 |
| 2 | 결과 검증 | `/verify` | 변경분 lint/test/build 게이트 |
| 3 | 코드 리뷰 | `/code-review` | 산출 코드 심각도 리뷰 |
