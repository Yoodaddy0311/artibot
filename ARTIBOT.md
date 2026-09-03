# ARTIBOT

This repository uses Artibot v5.

This file is the canonical entry point for humans and agents. It navigates; it does
not restate. Do not duplicate detailed project instructions here — link to the
canonical artifact instead.

Entries marked `not yet landed` do not exist in this tree yet. The marker is
enforced by `plugins/artibot/tests/firewall/artibot-entry-parity.test.js`: it must
be removed in the same change that creates the artifact, and it must be present
while the artifact is absent.

## Read Order

1. `.artibot/project.md`
2. `.artibot/state.yaml` — not yet landed
3. Active mission `intent.md` — not yet landed
4. Active mission `plan.md` — not yet landed
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
