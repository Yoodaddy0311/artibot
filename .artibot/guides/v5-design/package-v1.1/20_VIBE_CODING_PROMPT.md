# Artibot v5 Canonical State — Implementation Prompt

Implement the canonical-state architecture described in this package.

## Primary objective

Make Artibot safe for multi-human and multi-agent collaboration by ensuring that all workers share one canonical project truth.

## Required architecture

```text
ARTIBOT.md
→ .artibot/project.md
→ .artibot/state.yaml
→ active mission intent.md
→ active mission plan.md
→ ADR/review/outcome
→ .artibot/runtime/ledger.jsonl
```

## Non-negotiable rules

1. Do not create duplicate/derived intent or plan files.
2. Do not introduce todo.md/progress.md/status.md as competing sources of truth.
3. Mission intent must be persistent for substantive work.
4. Runtime live state must be structured and machine-readable.
5. Runtime history must be append-only and centralized.
6. Workers may not silently modify mission intent.
7. Fable 5.1 review must evaluate against the same canonical intent used by implementation.
8. Model routing must be intent-aware.
9. Routing, switching, escalation, downgrade, and hysteresis must remain distinct concepts.
10. Git history/revision metadata handle versions; filenames do not.
11. Memory promotion happens only after outcome validation.
12. Preserve backward compatibility where reasonable.

## Implementation sequence

P0:
- entry contract
- project state
- intent artifact
- plan artifact
- artifact registry/validator
- central ledger
- execution profile
- routing/switching separation
- Fable review binding

P1:
- ADR gate
- worker ownership
- Split integration
- archive
- memory promotion

## Tests required

Add tests for:
- canonical artifact creation
- prevention of derived filenames
- state update correctness
- intent revision preservation
- worker inability to redefine intent
- model route changes from performance intent
- Fable review reading canonical intent
- ledger event append behavior
- mission close/archive behavior

Do not claim the architecture is complete until these behaviors are verified.
