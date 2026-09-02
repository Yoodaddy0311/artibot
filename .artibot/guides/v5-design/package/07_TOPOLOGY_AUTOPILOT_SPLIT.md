# Execution Topology — Solo / Team / Autopilot / Split

## Default topology policy

For ordinary requests, use the simplest topology that can reliably complete the mission.

```text
ParallelGain = ParallelizableWork - CoordinationCost - ContextDuplication - MergeConflictRisk - WorkerStartupCost - TokenDuplication
```

Parallelize when net gain is positive.

# Special Mode 1 — `autopilot --fast`

User intent: **Use more compute/tokens if needed. I care about finishing quickly and accurately.**

Recommended behavior:

- wider parallel exploration,
- larger reasoning/task budget,
- faster escalation to Opus/Fable,
- speculative safe work in parallel,
- independent Fable review,
- aggressive verification,
- preserve quality target.

Optimization:

```text
Primary: Time-to-Verified-Outcome ↓, Accuracy ↑
Secondary: Cost within a generous ceiling
```

# Special Mode 2 — `split`

Split is for large work where the user intentionally wants broad parallelism, high token usage, fast throughput, isolated work ownership and high accuracy through multiple workers.

Recommended behavior:

- worktree/file ownership isolation,
- durable worker state,
- context package per worker,
- shared evidence index,
- minimal human monitoring,
- automatic health/status checks,
- merge planning,
- conflict detection,
- independent final review,
- run ledger reconciliation.

Measure wall-clock reduction, accepted outcome, merge conflicts, duplicated exploration, human monitoring burden, retry waste and final review quality.

## Natural-language activation

Potential `autopilot --fast` phrases:
- “최대한 빨리 정확하게 끝내줘.”
- “토큰 아끼지 말고 제대로 처리해.”
- “시간이 중요해. 병렬로 최대한 진행해.”

Potential `split` phrases:
- “작업량이 크니까 여러 작업으로 나눠 동시에 해.”
- “파일별로 병렬 작업하고 합쳐줘.”
- “이 대규모 변경 최대한 병렬로 처리해.”
