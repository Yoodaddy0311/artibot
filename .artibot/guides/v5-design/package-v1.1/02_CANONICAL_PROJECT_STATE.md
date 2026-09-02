# Canonical Project State

## Why this is needed

A single developer can often keep current state in their head.

A shared project cannot.

When multiple humans and agents work simultaneously, they need a shared answer to:

- What is currently active?
- Which mission is authoritative?
- Who owns which work?
- Which plan revision is current?
- Which files are locked/owned?
- What is blocked?
- Which review is pending?
- What outcome has been accepted?

## Canonical layout

```text
PROJECT ROOT
│
├── ARTIBOT.md
│
└── .artibot/
    ├── project.md
    ├── state.yaml
    │
    ├── missions/
    │   ├── M-20260902-001/
    │   │   ├── intent.md
    │   │   ├── plan.md
    │   │   ├── review.md
    │   │   └── outcome.md
    │   │
    │   └── M-.../
    │
    ├── adr/
    │   ├── ADR-001.md
    │   └── ADR-002.md
    │
    ├── memory/
    │   └── ...
    │
    └── runtime/
        └── ledger.jsonl
```

## State responsibilities

### `ARTIBOT.md`
Navigation contract only.

### `project.md`
Project-wide intent, constraints, conventions, invariant principles.

### `state.yaml`
Live machine-readable current state.

### Mission folder
Human-readable mission truth.

### `runtime/ledger.jsonl`
Append-only execution history.

## State precedence

When sources conflict:

```text
Current verified repository/environment state
>
state.yaml
>
active mission intent.md
>
active mission plan.md
>
ADR
>
historical outcome
>
memory
>
old runtime logs
```

This precedence should be encoded in runtime policy.
