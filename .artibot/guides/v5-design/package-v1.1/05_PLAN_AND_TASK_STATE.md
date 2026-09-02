# Plan vs Task State

## Plan

`plan.md` answers:

> **How will the current mission be achieved?**

It contains:

- work decomposition
- dependencies
- intended execution order
- model/topology expectations where relevant
- verification checkpoints
- rollback points

## Plan can change often

Plan is a route, not the destination.

Therefore plan revisions are normal.

Do not create:

```text
plan-v2.md
plan-final.md
plan-new.md
```

Use:

```yaml
plan_revision: 4
```

and Git history.

---

# Why Artibot should not adopt todo.md as another canonical document

A standalone `todo.md` tends to duplicate:

- plan
- progress
- state
- completion

Over time this creates multiple truths.

Instead:

```text
Goal / why       → intent.md
Execution plan   → plan.md
Live tasks       → state.yaml
Execution events → ledger.jsonl
Final result     → outcome.md
```

## Manus principle retained

The valuable Manus-like principle is:

> Keep goal and current execution state outside the ephemeral model context.

Artibot implements that through canonical files and structured state rather than another duplicated todo document.
