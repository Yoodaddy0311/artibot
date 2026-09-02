# Artibot 5.0 — Canonical State & Intent Architecture v1.1

## Purpose

This package refines Artibot 5.0 around four primary foundations:

1. **Intent**
2. **Canonical Project State**
3. **Adaptive Model Routing / Switching**
4. **Artifact & Document Governance**

The goal is to make Artibot safe and coherent for **multi-human + multi-agent collaboration** without document sprawl, duplicated truth, or conflicting task histories.

## Core principle

> Everyone and every agent must know exactly where the current truth lives.

Artibot v5 therefore uses one canonical navigation path:

```text
ARTIBOT.md
  ↓
.artibot/project.md
  ↓
.artibot/state.yaml
  ↓
.artibot/missions/<mission_id>/intent.md
  ↓
.artibot/missions/<mission_id>/plan.md
  ↓
ADR / review / outcome
  ↓
.artibot/runtime/ledger.jsonl
```

## What this package changes

Compared with the previous v5 design:

- `intent.md` becomes a **first-class persistent mission artifact**
- `state.yaml` becomes the **single machine-readable live state**
- `todo.md` is **not adopted as a separate canonical artifact**
- task progress is represented in structured runtime state, not duplicated Markdown
- versioning happens through Git/history/revision fields, **not filename proliferation**
- model routing is explicitly **intent-aware**
- model switching, escalation, downgrade, and hysteresis are separate concepts
- multi-user and multi-agent collaboration rules are defined
- document creation/update/archive/promotion rules are standardized

## Anti-sprawl rule

Do not create:

```text
intent-v2.md
intent-final.md
plan-final-final.md
todo.md
progress.md
status.md
current-plan.md
```

unless an explicit migration/compatibility reason exists.

Use canonical filenames and structured revision history instead.
