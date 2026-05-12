---
description: (Artibot) Diagnose the learning system — GRPO weights, swarm sync, top/bottom tools by performance
argument-hint: 'e.g. "--top 5", "--swarm", "--raw"'
allowed-tools: [Bash, Read]
toolset: meta
---

# /learning

Inspect the on-disk state of the Artibot auto-learning + swarm federation system. Pure observation — never mutates state.

The command runs `scripts/learning-diag.js` which reads (in order):

- `~/.claude/artibot/grpo-history.json` — self-learning rounds + strategy weights
- `~/.claude/artibot/swarm-sync-state.json` — federation upload/download counters
- `~/.claude/artibot/swarm-merged-weights.json` — peer-merged tool/agent weights
- `~/.claude/artibot/patterns/{tool,agent,error,success,team,self-evaluation}-patterns.json`
- `~/.claude/artibot/memory/error-patterns.json` (fallback for error type)

Then renders a markdown dashboard with **5 sections**:

1. **GRPO Self-Learning** — round count, top learned strategy weights, recent strategy distribution
2. **Swarm (Federated Learning)** — sync state, merged-bucket sizes (tools / agents / errors / commands / teams)
3. **Top Performers** — ranked by `success × certainty` (or `success × confidence` when certainty absent)
4. **Risk Signals** — high confidence + low success entries (consistent failure patterns worth investigating)
5. **Pattern File Health** — per-type count + most-recent extraction timestamp

A final **Recommendations** section calls out actionable findings (empty buckets, stale syncs, critical failure rates).

## Arguments

Parse `$ARGUMENTS`:

- _(none)_ — full dashboard, top-10 / bottom-10, last-50 GRPO rounds
- `--top N` — change top performer count (default 10, range 1–100)
- `--bottom N` — change risk-signal count (default 10, range 1–100)
- `--rounds N` — change recent-rounds window for strategy distribution (default 50)
- `--swarm` — render only the Swarm + Top Performers + Risk sections
- `--patterns` — render only the Pattern File Health section
- `--raw` — dump the underlying JSON state (compact form, rounds count only) instead of the formatted dashboard
- `--base <dir>` — override the artibot install dir (default `~/.claude/artibot`)
- `--help`, `-h` — print the script's own flag reference and exit

## Execution Flow

1. Run the diagnostic script via Bash:

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/artibot}"
node "${PLUGIN_ROOT}/scripts/learning-diag.js" $ARGUMENTS
```

2. Display the full output of the script to the user **exactly as printed** (it is already formatted markdown).

3. If the dashboard's Recommendations section contains any critical-flagged entries or the empty-bucket / stale-sync warnings, briefly highlight them in a one-sentence summary at the end (do NOT re-format the dashboard itself).

## Interpretation Guide

| Signal | Meaning |
|---|---|
| GRPO rounds rising | Self-learning is actively recording per-session outcomes |
| Top weights dominated by `fix` / `Bash` | Recent work is heavy on bug-fixes via shell — typical maintenance phase |
| Swarm `agents` bucket empty | No post-v4.6.2 peer upload yet, OR local agent patterns below filter (sample ≥ 3, conf ≥ 0.4) |
| Top performer has `cert` column populated | Post-v4.6.2 sample-size-aware certainty is flowing through pack/unpack |
| Risk signal `critical` | success < 25% AND conf ≥ 0.8 AND n ≥ 10 — consistent failure, investigate |
| `teamWeights` empty for long time | `updateTeamWeights()` API is dormant — by design or missed integration |

## When to use

- **After a long session**: see what got learned, which strategies are reinforced
- **Before benchmarking a change**: snapshot the baseline metrics
- **Debugging "Claude keeps using tool X even though it fails"**: check the risk-signals table — the swarm may have learned X is broken but the router hasn't caught up
- **Auditing federated learning**: confirm uploads/downloads are flowing and merged buckets are non-empty
- **Onboarding a new machine**: see whether swarm download has populated the local cache

## Output Examples

A healthy install on a mature project will show:

```
- Total rounds: 300+
- Top weights: fix / Bash / session / Read / teammate (descending)
- Uploads / Downloads both > 10
- Top Performers: Bash, Edit, Read, Glob all > 0.7 score
- Risk Signals: 1–3 entries (typical, monitor flagged)
- Recommendations: _no actionable signals_  ← ideal
```

A fresh install (no learning yet) will show:

```
- Total rounds: 0
- _no `grpo-history.json` found_
- _no swarm state on disk — sync may not have run yet_
- Recommendations: "GRPO has no rounds — auto-learning may not be running"
```

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 상세 회고 | `/daily` | 오늘 세션 작업 + 학습 결과 회고 |
| 2 | 패턴 추출 강제 실행 | `/learn` | 신규 경험을 즉시 패턴으로 추출 |
| 3 | 전체 검증 | `/verify` | 학습 시스템 fix 후 회귀 확인 |
