# Artifact & Document Governance

## Core rule

> Every artifact type must have one non-overlapping responsibility.

## Canonical artifacts

| Artifact | Responsibility | Persistence |
|---|---|---|
| `ARTIBOT.md` | navigation entry | permanent |
| `project.md` | project-level purpose/rules | permanent |
| `state.yaml` | live execution state | mutable/live |
| `intent.md` | mission purpose/success | mission permanent |
| `plan.md` | current execution strategy | mission permanent |
| `ADR-xxx.md` | durable decision rationale | permanent |
| `review.md` | independent review result | mission permanent |
| `outcome.md` | accepted final result | mission permanent |
| `ledger.jsonl` | append-only runtime history | permanent/rotatable |
| raw logs | low-level execution evidence | temporary/archivable |
| memory | reusable validated knowledge | promoted only |

## No derivative file rule

Forbidden by default:

```text
intent-final.md
intent-v3.md
plan2.md
status.md
progress.md
todo.md
new-plan.md
```

Reason:
They create competing sources of truth.

## Update rule

Modify the canonical file and update:
- revision
- timestamp
- reason
- evidence if relevant

## Archive rule

Closed missions remain immutable except:
- factual correction
- explicit retrospective annotation

## Memory promotion

Not every artifact becomes memory.

Flow:

```text
Mission artifacts
 ↓
Outcome review
 ↓
Reusable?
 ├─ no → archive only
 └─ yes
      ↓
Deduplicate
 ↓
Validate
 ↓
Memory promotion
```

## What should be promoted

Examples:
- stable architectural decisions
- verified failure patterns
- reusable conventions
- high-value user/project preferences
- durable API/tool constraints

## What should not be promoted

- transient logs
- one-off retries
- stale plans
- temporary guesses
- superseded intent interpretations
- duplicated summaries
