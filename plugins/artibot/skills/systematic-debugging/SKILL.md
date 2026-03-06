---
context: forked
name: systematic-debugging
description: |
  Systematic debugging methodology enforcing root cause investigation before any fix.
  Iron Law: NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.
  Auto-activates when: debugging errors, investigating failures, fixing bugs, troubleshooting issues.
  Triggers: debug, bug, error, fix, investigate, troubleshoot, root cause, regression, crash, 디버그, 버그, 에러, 수정
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 2
triggers:
  - "debug"
  - "bug"
  - "error"
  - "fix"
  - "investigate"
  - "troubleshoot"
  - "root cause"
  - "regression"
  - "crash"
agents:
  - "tdd-guide"
  - "backend-developer"
tokens: "~3K"
category: "debugging"
---

# Systematic Debugging

## Contents
- [When This Skill Applies](#when-this-skill-applies)
- [Iron Law](#iron-law)
- [Core Guidance](#core-guidance)
- [Quick Reference](#quick-reference)
- [Workflow Checklist](#workflow-checklist)
- [Human Checkpoints](#human-checkpoints)
- [Freedom Levels](#freedom-levels)

## When This Skill Applies
- Investigating runtime errors, exceptions, or crashes
- Debugging failing tests or unexpected behavior
- Fixing reported bugs (user-reported or CI-detected)
- Diagnosing regressions after code changes
- Troubleshooting configuration or environment issues

## Iron Law

> **NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.**

Do NOT apply any code change, patch, workaround, or configuration tweak until you have:
1. Reproduced the problem (or confirmed reproduction steps)
2. Identified the root cause with evidence (stack trace, log, code path)
3. Formed a hypothesis and validated it

Applying fixes without understanding the root cause leads to:
- Masking deeper issues that resurface later
- Introducing new bugs from incorrect assumptions
- Accumulating technical debt through band-aid patches

## Core Guidance

### Phase 1: Root Cause Investigation

**Reproduce** the issue in a controlled environment:
- Capture the exact error message, stack trace, or unexpected output
- Identify minimal reproduction steps (smallest input that triggers the bug)
- Note environment details: OS, Node version, config state

**Trace** the execution path:
- Read the code path from entry point to failure point
- Identify the exact line where behavior diverges from expectation
- Check recent changes (`git log`, `git diff`) that may have introduced the issue
- See `${CLAUDE_SKILL_DIR}/references/root-cause-tracing.md` for tracing techniques

**Classify** the root cause:
| Category | Examples | Typical Fix |
|----------|----------|-------------|
| Logic error | Wrong condition, off-by-one, missing case | Correct the logic |
| State corruption | Mutation, stale cache, race condition | Enforce immutability or synchronization |
| Contract violation | Wrong types, missing validation, API mismatch | Add validation at boundary |
| Environment | Missing dep, wrong config, path issue | Fix config or add guard |
| Regression | Recent change broke existing behavior | Revert or fix the change |

### Phase 2: Hypothesis Validation

Before writing any fix:
1. **State your hypothesis** explicitly: "The bug occurs because X causes Y when Z"
2. **Predict** what a fix would change: "If I change A, then B should stop happening"
3. **Validate** the hypothesis with evidence:
   - Add a temporary log/assertion at the suspected failure point
   - Write a failing test that reproduces the exact bug
   - Confirm the test fails for the predicted reason, not a different one

If the hypothesis is wrong, return to Phase 1. Do NOT guess-and-check with random fixes.

### Phase 3: Fix Application

Apply the **minimal correct fix**:
- Change only what is necessary to resolve the root cause
- Prefer targeted fixes over broad refactors (fix the bug, not the neighborhood)
- Follow existing code patterns and conventions
- See `${CLAUDE_SKILL_DIR}/references/defense-in-depth.md` for layered protection strategies

**Fix quality rules**:
- The fix must address the root cause, not just suppress the symptom
- No `try/catch` that silently swallows errors unless explicitly justified
- No `// TODO: fix later` — if it needs more work, create a tracked issue
- Immutable patterns: create new objects rather than mutating existing state

### Phase 4: Fix Verification

**Confirm** the fix resolves the issue:
1. Run the reproduction test — it must now pass
2. Run the full test suite — no regressions introduced
3. Verify edge cases related to the fix
4. Check that error handling is correct (errors propagate, not silently ignored)

**Document** the resolution:
- What was the root cause?
- What was changed and why?
- What test covers this case going forward?

## Quick Reference
- Iron Law: investigate root cause BEFORE any fix
- 4 phases: Investigate -> Validate hypothesis -> Fix -> Verify
- Root cause tracing: `${CLAUDE_SKILL_DIR}/references/root-cause-tracing.md`
- Defense in depth: `${CLAUDE_SKILL_DIR}/references/defense-in-depth.md`

## Workflow Checklist

Copy this checklist and track progress:

```
Progress:
- [ ] Step 1: Reproduce the issue — capture error, minimal repro steps
- [ ] Step 2: Trace execution path — read code from entry to failure point
- [ ] Step 3: Classify root cause — logic/state/contract/environment/regression
- [ ] Step 4: Form hypothesis — state explicitly what causes the bug
- [ ] Step 5: Write failing test — reproduces the exact bug
- [ ] Step 6: Validate hypothesis — test fails for the predicted reason
- [ ] Step 7: Apply minimal fix — address root cause, not symptoms
- [ ] Step 8: Verify fix — repro test passes, full suite green, no regressions
- [ ] Step 9: Document resolution — root cause, fix rationale, test coverage
```

## Human Checkpoints

| After Step | Checkpoint | Type | Options |
|-----------|-----------|------|---------|
| Step 3 | Root cause classification correct? | Approval | Confirm / Investigate deeper |
| Step 4 | Hypothesis plausible? | Go-No-Go | Proceed / Revise hypothesis |
| Step 6 | Hypothesis validated? | Go-No-Go | Apply fix / Return to investigation |
| Step 8 | Fix verified, no regressions? | Approval | Ship / Add more tests / Revise fix |

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Reproduce issue | LOW | Must capture exact error and minimal repro steps |
| Trace execution | MEDIUM | Multiple valid approaches (logs, debugger, code reading) |
| Classify root cause | MEDIUM | Categories defined, but judgment needed for edge cases |
| Form hypothesis | HIGH | Creative thinking required, multiple valid hypotheses |
| Write failing test | LOW | Must reproduce the exact bug, not a similar one |
| Validate hypothesis | LOW | Evidence-based, no guessing |
| Apply fix | MEDIUM | Minimal change required, but approach is flexible |
| Verify fix | LOW | Full test suite must pass, no exceptions |
| Document resolution | MEDIUM | Format flexible, content must include root cause and fix rationale |
