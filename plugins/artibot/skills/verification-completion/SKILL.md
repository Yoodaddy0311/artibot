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

### Checkpoint 1: 테스트 결과 수용 여부 (After Step 2)
**Context**: 관련 테스트를 재실행한 직후입니다. 실패하는 테스트가 있는 상태에서 완료를 주장하는 것은 Iron Law 위반입니다. 이 시점에서 결과를 확정해야 합니다.
**Ask**: "테스트 결과가 **수용 가능한가요**? 실패한 테스트가 없는지 확인해 주세요."
**Options**:
1. Accept — 모든 테스트가 통과하거나, 실패가 변경 사항과 무관하게 문서화됨
2. Fix failures first — 실패한 테스트를 먼저 수정한 후 재검증 진행
**Default**: 1 (테스트를 성실히 실행했다면 통과 상태가 기본)
**Skippable**: No — 실패한 테스트가 있는 채로 완료를 주장하는 것은 허용되지 않음
**Freedom**: LOW

### Checkpoint 2: 증거 충분성 승인 (After Step 5)
**Context**: 완료 보고서를 작성한 후, 포함된 증거가 실제로 완료를 입증하기에 충분한지 판단하는 시점입니다. "충분한 증거"의 기준은 완료 유형에 따라 다릅니다.
**Ask**: "완료 보고서에 포함된 **증거가 충분한가요**? 증거 유형과 구체성을 검토해 주세요."
**Options**:
1. Approve — 증거가 완료를 충분히 입증함 (테스트 출력, 파일 경로 등 포함)
2. Request more evidence — 특정 항목에 대한 추가 증거가 필요함
**Default**: 1 (Verification Protocol을 따랐다면 충분한 증거가 수집되어 있음)
**Skippable**: No — 증거 없는 완료 주장은 Iron Law 위반임
**Freedom**: MEDIUM

### Checkpoint 3: 레드 플래그 표현 최종 점검 (After Step 6)
**Context**: 보고서 언어를 자가 점검한 후, "should work", "probably", "I think" 같은 비검증 표현이 남아있는지 최종 확인하는 시점입니다.
**Ask**: "보고서에 **레드 플래그 표현이 없나요**? 모든 주장이 검증된 사실에 기반하는지 확인해 주세요."
**Options**:
1. Clean report — 레드 플래그 표현이 없고 모든 주장이 증거에 기반함
2. Revise language — 비검증 표현이 발견됨, 구체적 사실로 교체 필요
**Default**: 1 (자가 점검을 성실히 수행했다면 클린 상태가 기본)
**Skippable**: No — 레드 플래그 표현은 미검증 완료 주장의 신호이므로 반드시 제거해야 함
**Freedom**: LOW

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
