---
description: (Artibot) Diagnose the learning system — swarm sync, top/bottom tools by performance, risk signals, pattern file health, ambient ledger capture
argument-hint: 'e.g. "--top 5", "--swarm", "--raw", "review", "review approve <id>"'
allowed-tools: [Bash, Read]
toolset: meta
---

# /learning

> **vs /learn**: `/learning` **diagnoses the learning system** (swarm sync, tool/agent performance, ledger capture) — pure read-only inspection. `/learn` **extracts and saves patterns** from code or session to memory.

Inspect the on-disk state of the Artibot auto-learning + swarm federation system. Pure observation — never mutates state.

The command runs `scripts/learning-diag.js` which reads (in order):

- `~/.claude/artibot/grpo-history.json` — self-learning rounds + strategy weights
- `~/.claude/artibot/swarm-sync-state.json` — federation upload/download counters
- `~/.claude/artibot/swarm-merged-weights.json` — peer-merged tool/agent weights
- `~/.claude/artibot/patterns/{tool,agent,error,success,team,self-evaluation}-patterns.json`
- `~/.claude/artibot/memory/error-patterns.json` (fallback for error type)
- `<cwd>/.artibot/ledger/` — project-local ambient conversation ledger (capture/redaction/review metrics)

Then renders a markdown dashboard with **6 sections**:

1. **GRPO Self-Learning (은퇴)** — 라이브 writer가 없다. `grpo-history.json`이 디스크에 남아 있으면 과거 수치를 그대로 보여줄 뿐이며, 대시보드가 스스로 `Retired / dormant` 배너를 렌더한다 (`scripts/learning-diag.js#renderGrpo`). 새 데이터는 쌓이지 않는다
2. **Swarm (Federated Learning)** — sync state, merged-bucket sizes (tools / agents / errors / commands / teams)
3. **Top Performers** — ranked by `success × certainty` (or `success × confidence` when certainty absent)
4. **Risk Signals** — high confidence + low success entries (consistent failure patterns worth investigating)
5. **Pattern File Health** — per-type count + most-recent extraction timestamp
6. **Ledger (Ambient Capture)** — F-09 — sessions/lines captured, secrets redacted (count + % of lines), corpus reviewed into learning (consumed + %), pending review-queue size, on-disk size. Read from the **project-local** `<cwd>/.artibot/ledger/` (not the global install base). Empty-state line when no ledger exists.

A final **Recommendations** section calls out actionable findings (empty buckets, stale syncs, critical failure rates).

## Arguments

Parse `$ARGUMENTS`:

- _(none)_ — full dashboard, top-10 / bottom-10
- `--top N` — change top performer count (default 10, range 1–100)
- `--bottom N` — change risk-signal count (default 10, range 1–100)
- `--rounds N` — change recent-rounds window for strategy distribution (default 50)
- `--swarm` — render only the Swarm + Top Performers + Risk sections
- `--patterns` — render only the Pattern File Health section
- `--raw` — dump the underlying JSON state (compact form, rounds count only) instead of the formatted dashboard
- `--base <dir>` — override the artibot install dir (default `~/.claude/artibot`)
- `--by-agent` — **v4.7.0** — group Risk Signals and Top Performers by `callingAgent` so failures can be attributed to the spawning agent (e.g., "tool X is fine for orchestrator but failing every time `frontend-developer` calls it"). Records without attribution metadata appear under `__unattributed__`. Requires v4.7.0+ data; pre-v4.7.0 records render entirely under `__unattributed__`.
- `--help`, `-h` — print the script's own flag reference and exit

### `review` subcommand (F-06 — ledger learning-signal review gate)

The diagnostic above is **read-only**. The `review` subcommand is the **human
approval gate** that promotes denoised ambient-ledger corpus into the learning
store — the mutating counterpart, so it runs a separate script
(`scripts/ledger-review.js`) rather than the read-only `learning-diag.js`.

- `review` — stage any NEW conversation corpus from `<cwd>/.artibot/ledger/`
  into the review queue (advances the corpus watermark so nothing re-stages),
  then list what is pending approval.
- `review approve <id> [<id>…]` — promote those queue items into learning
  (`collectExperience`) and dequeue them.
- `review approve --all` — promote every pending item.
- `review reject <id> [<id>…]` / `review reject --all` — dequeue WITHOUT
  promoting (the corpus stays discarded, never fed to learning).
- `review --session <sid>` — stage only that session's corpus.

**Pull-model**: staging happens only when you run `review`; there is no
background/SessionEnd auto-enqueue (privacy-sensitive promotion stays explicit).

## Execution Flow

**If `$ARGUMENTS` begins with `review`** — run the review gate instead of the
dashboard. Pass everything AFTER the `review` token to the review script:

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/artibot}"
node "${PLUGIN_ROOT}/scripts/ledger-review.js" $ARGUMENTS
```

`$ARGUMENTS` is forwarded verbatim — the script ignores the leading `review`
token, so `review`, `review approve <id>`, and `review reject --all` all work.
Display the script output **exactly as printed**. When items are pending, remind
the user they can `approve`/`reject` by id (the output already prints the hint).

**Otherwise** (default — no `review` token):

1. Run the diagnostic script via Bash:

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/artibot}"
node "${PLUGIN_ROOT}/scripts/learning-diag.js" $ARGUMENTS
```

2. Display the full output of the script to the user **exactly as printed** (it is already formatted markdown).

3. If the dashboard's Recommendations section contains any critical-flagged entries or the empty-bucket / stale-sync warnings, briefly highlight them in a one-sentence summary at the end (do NOT re-format the dashboard itself). If the **Ledger (Ambient Capture)** section shows a non-zero "Pending review" count, mention that `/learning review` can approve or reject those items.

## Interpretation Guide

| Signal | Meaning |
|---|---|
| Top weights dominated by `fix` / `Bash` | Recent work is heavy on bug-fixes via shell — typical maintenance phase |
| Swarm `agents` bucket empty | No post-v4.6.2 peer upload yet, OR local agent patterns below filter (sample ≥ 3, conf ≥ 0.4) |
| Top performer has `cert` column populated | Post-v4.6.2 sample-size-aware certainty is flowing through pack/unpack |
| Risk signal `critical` | success < 25% AND conf ≥ 0.8 AND n ≥ 10 — consistent failure, investigate |
| `teamWeights` empty for long time | `updateTeamWeights()` API is dormant — by design or missed integration |
| `__unattributed__` dominates `--by-agent` view | Pre-v4.7.0 records, or hook didn't capture `agent_id`. Trigger pattern re-extract after a few sessions; new records will carry `callingAgent` |
| Same tool risk-signal scoped to one agent only | Attribution working — investigate that agent's prompt or context, not the tool itself |

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
```

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 상세 회고 | `/daily` | 오늘 세션 작업 + 학습 결과 회고 |
| 2 | 패턴 추출 강제 실행 | `/learn` | 신규 경험을 즉시 패턴으로 추출 |
| 3 | 전체 검증 | `/verify` | 학습 시스템 fix 후 회귀 확인 |
