# state.yaml — Live Execution Truth

## Purpose

`state.yaml` is the canonical live state for multi-human / multi-agent work.

It answers:

> **What is happening right now?**

It should be machine-readable and concurrency-aware.

## Example

```yaml
project: artibot
state_version: 12
updated_at: 2026-09-02T13:40:00+09:00

active_missions:
  M-20260902-001:
    title: adaptive-intelligence-routing

    intent:
      path: missions/M-20260902-001/intent.md
      revision: 2

    plan:
      path: missions/M-20260902-001/plan.md
      revision: 5

    status: executing

    owners:
      humans:
        - user-001
      agents:
        - routing-worker
        - context-worker

    topology:
      mode: split
      performance_profile: maximum

    workers:
      routing-worker:
        status: executing
        owns:
          - plugins/artibot/lib/routing/**
        heartbeat_at: 2026-09-02T13:39:00+09:00

      context-worker:
        status: reviewing
        owns:
          - plugins/artibot/lib/context/**

    blocked_by: []

    review:
      required: true
      model: fable-5.1
      status: pending
```

## State is not history

Do not grow state.yaml forever.

When state changes:
- update the live state
- append the event to the ledger

`state.yaml` = now  
`ledger.jsonl` = history
