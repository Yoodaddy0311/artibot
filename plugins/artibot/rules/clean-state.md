---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
---

# Artibot Clean State Rule

## Principle
"Always production-ready" — every completed task must leave the codebase in a clean state.

## Definition of "Clean"
- ESLint: 0 errors on changed files
- Tests: all related tests passing
- No unresolved merge conflicts
- No debug artifacts (console.log, TODO hacks)

## Enforcement Timing
- **When**: At task completion (TaskCompleted event)
- **Not when**: Mid-implementation — work-in-progress is allowed to be messy
- **Scope**: Only files changed in the current task

## Checklist (TaskCompleted)
- [ ] Run `npm run lint` — 0 errors on changed files
- [ ] Run `npm test` — all related tests pass
- [ ] No leftover console.log/debug statements
- [ ] Changed files re-read and verified

## Guideline
This rule is advisory at the hook level (warning, not blocking).
The agent or user decides when to run the actual lint/test commands.
The hook serves as a reminder to verify clean state before marking done.
