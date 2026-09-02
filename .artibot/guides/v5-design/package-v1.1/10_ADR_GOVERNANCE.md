# ADR Governance

## ADR purpose

ADR stores:

> Why did we make this durable decision?

It is not:
- a task list
- a progress log
- a daily status file

## Create ADR when

A decision materially affects:
- architecture
- public API
- storage/data model
- provider strategy
- security boundary
- durable runtime behavior
- migration strategy

## Initial human question gate

Artibot may invoke `questionUserAnswer` early when:

- multiple legitimate choices remain,
- the choice materially changes the system,
- repository evidence cannot decide,
- business/product preference is required,
- guessing would create expensive rework.

Do not ask the user for discoverable facts.

## ADR relationship

```text
Intent
 ↓
Decision Surface
 ↓
ADR
 ↓
Plan
```

ADR should not redefine intent unless the user explicitly changes the goal.
