---
context: forked
name: verification-completion
description: |
  Evidence-before-claims verification enforcing proof of completion before any "done" claim.
  Auto-activates when: completing tasks, reporting results, claiming success, writing summaries.
  Triggers: done, complete, finished, implemented, fixed, resolved, verified, shipped
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "done"
  - "complete"
  - "finished"
  - "implemented"
  - "resolved"
  - "verified"
  - "shipped"
  - "!rv"
agents:
  - "code-reviewer"
  - "tdd-guide"
tokens: "~3K"
category: "quality"
---

# Verification Before Completion

## When This Skill Applies
- Before claiming any task is "done" or "complete"
- When summarizing work results
- When reporting to the user or team lead
- After making code changes, before confirming success
- When the `!rv` trigger is used for re-verification

## Core Guidance

### Iron Law: Evidence Before Claims

Every completion claim MUST be backed by executable evidence. No exceptions.

**Acceptable evidence types:**
- Test execution output (pass/fail with specific test names)
- Build/lint command output (exit code 0 + clean output)
- File re-read confirming the change exists at the expected location
- Command output proving the feature works
- Screenshot or visual diff showing UI changes

**NOT acceptable as evidence:**
- "I updated the file" (no proof of content)
- "This should work" (speculation, not verification)
- "The tests probably pass" (no execution)
- "Based on the code, it looks correct" (reading is not running)

### Red Flag Expressions

These phrases signal unverified claims. When you catch yourself writing them, STOP and verify.

| Red Flag | What It Reveals | Required Action |
|----------|----------------|-----------------|
| "should work" | Not tested | Run the test or command |
| "probably works" | Guess, not fact | Execute and verify |
| "likely correct" | Assumption | Re-read the file, confirm |
| "I believe this fixes" | Unverified belief | Run regression test |
| "this looks right" | Visual inspection only | Execute to prove |
| "based on the code" | Reading, not running | Run the actual code |
| "in theory" | Theoretical, not practical | Demonstrate in practice |
| "I think" | Uncertainty | Gather concrete evidence |
| "as expected" | Assumed outcome | Show the actual outcome |

### Rationalization Prevention

When you find an issue during verification, do NOT rationalize it away.

| Rationalization Pattern | What You Should Do Instead |
|------------------------|---------------------------|
| "That error is probably unrelated" | Investigate the error. Prove it's unrelated. |
| "It failed but the important part works" | Report the failure. Fix it or explain why it's acceptable. |
| "The test is flaky, not a real failure" | Re-run 3 times. If it fails >1 time, it's a real issue. |
| "That warning can be ignored" | Document why. Link to docs that confirm it's safe. |
| "It works on my machine" | Show the evidence. Test in the target environment. |
| "I'll fix that in a follow-up" | Fix it now, or explicitly flag as incomplete. |

### Verification Protocol

Before marking ANY task as complete, execute this checklist:

1. **RE-READ**: Open every modified file and confirm the change is present
2. **RE-RUN**: Execute tests covering the changed code
3. **RE-CHECK**: Verify no new warnings/errors were introduced
4. **EVIDENCE**: Collect concrete output (command results, file contents)
5. **REPORT**: Include evidence in your completion message

## Workflow Checklist

Copy this checklist and track progress:

```
Verification:
- [ ] Step 1: RE-READ every modified file (confirm changes exist)
- [ ] Step 2: RE-RUN relevant tests (paste pass/fail output)
- [ ] Step 3: RE-CHECK for new warnings or errors
- [ ] Step 4: Collect EVIDENCE (command output, file:line references)
- [ ] Step 5: Write completion REPORT with evidence attached
- [ ] Step 6: Self-check for Red Flag expressions in report
```

## Human Checkpoints

| After Step | Checkpoint | Type | Options |
|-----------|-----------|------|---------|
| Step 2 | Test results acceptable? | Go-No-Go | Accept / Fix failures first |
| Step 5 | Evidence sufficient? | Approval | Approve / Request more evidence |
| Step 6 | Red flags found in report? | Go-No-Go | Clean report / Revise language |

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Re-read files | LOW | Mandatory for every modified file |
| Re-run tests | LOW | Must execute, not assume |
| Check for errors | LOW | Must verify clean output |
| Collect evidence | MEDIUM | Choose relevant evidence types |
| Write report | MEDIUM | Format flexible, evidence mandatory |
| Self-check language | LOW | All red flag expressions must be eliminated |

## Quick Reference

| Completion Type | Minimum Evidence Required |
|----------------|--------------------------|
| Bug fix | Failing test -> passing test output |
| New feature | Test output + file:line of implementation |
| Refactor | All existing tests still pass + diff summary |
| Config change | Re-read of config file + relevant command output |
| Documentation | Re-read confirming content is present |
| Hook/plugin change | Syntax check + test output if tests exist |

## Integration with !rv Trigger

When the user types `!rv`, this skill's verification protocol is activated in maximum-skepticism mode:
- Every previous claim is audited
- Every completion assertion requires fresh evidence
- No rationalization is tolerated
- The correction report must be honest and direct
