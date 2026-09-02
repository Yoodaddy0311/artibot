# ARTIBOT

This repository uses Artibot v5.

## Read Order

1. `.artibot/project.md`
2. `.artibot/state.yaml`
3. Active mission `intent.md`
4. Active mission `plan.md`
5. Relevant ADRs
6. Review / Outcome when applicable

## Canonical Rules

- Never create derived intent, plan, todo, progress, or status files.
- `state.yaml` is the live execution truth.
- `intent.md` defines what success means.
- `plan.md` defines the current execution strategy.
- Workers may own tasks/files, but may not silently redefine mission intent.
- ADR contains durable decisions, not task progress.
- Runtime history is written to the central ledger.
- Substantive work requires independent review against the same canonical intent.
