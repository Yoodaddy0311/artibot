# ARTIBOT.md — Project Navigation Contract

`ARTIBOT.md` must be short.

It is not a project wiki.
It is the canonical entry point for humans and agents.

## Recommended template

```markdown
# ARTIBOT

This repository uses Artibot v5.

## Read Order

1. `.artibot/project.md`
2. `.artibot/state.yaml`
3. Active mission `intent.md`
4. Active mission `plan.md`
5. Relevant ADRs
6. Current review/outcome if applicable

## Canonical Rules

- Never create derived intent/plan/status files.
- `state.yaml` is the live execution truth.
- `intent.md` defines mission success.
- `plan.md` defines the current execution route.
- Plans may change; mission intent should remain stable unless evidence requires refinement.
- ADRs contain decisions, not progress logs.
- Runtime history goes to the central ledger.
- Substantive completion requires independent review.
```

## Important rule

Do not duplicate detailed project instructions here.
Link to canonical artifacts instead.
