---
context: forked
name: vibe-coding
description: "Quality enforcement for casual/natural language coding requests. Ensures every part of the user's request is decomposed, executed, verified, and reported. Use when handling natural language coding requests, multi-part instructions, or casual Korean/English coding commands."
level: 1
triggers:
  - "해줘"
  - "만들어"
  - "수정해"
  - "바꿔"
  - "추가해"
  - "고쳐"
  - "변경해"
  - "업데이트"
  - "fix"
  - "change"
  - "update"
  - "add"
  - "create"
  - "modify"
  - "implement"
  - "build"
  - "make"
  - "do"
tokens: "~2K"
category: "workflow"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
---

# Vibe Coding Quality Protocol

Quality enforcement for ALL coding requests, especially casual/natural language ("vibe coding").

## When This Skill Applies
- ANY natural language request that involves code changes
- Requests without explicit slash commands
- Multi-part requests ("A 해주고 B도 해줘")
- Casual Korean/English coding instructions

## MANDATORY Protocol: DEV (Decompose-Execute-Verify)

Full protocol defined in `.claude/rules/artibot/dev-protocol.md` (auto-loads on file access).

Summary: DECOMPOSE request into numbered items → EXECUTE each (read-first) → VERIFY with evidence per item.

## Zero-Skip Mandate

These behaviors are STRICTLY FORBIDDEN:

| Forbidden | Required Instead |
|-----------|-----------------|
| "I'll skip this for now" | Do it now or explain the blocker |
| "This can be done later" | Do it now or explicitly ask the user to defer |
| Silently ignoring a sub-request | Track and address every sub-request |
| "Done!" without evidence | Show what changed with file paths and line numbers |
| Guessing file contents | Read the file first |
| Claiming a change was made without verifying | Re-read the file after modification |
| Making unasked changes | Only change what was requested |

## Multi-Part Request Handling

When the user's request contains multiple parts (common in Korean):
- "이것도 하고 저것도 해줘" → 2 items
- "A 수정하고, B 추가하고, C 삭제해" → 3 items
- "전체적으로 개선해줘" → Ask for specific targets before proceeding
- Conjunctions: 하고, 그리고, 또, 또한, 및, 랑, 이랑 → item boundary markers

## Quality Checklist (Quick)

Before reporting completion:
- [ ] All action items from decomposition addressed
- [ ] Every modified file was read BEFORE modification
- [ ] Every modified file was re-read AFTER modification
- [ ] Evidence provided for each completed item
- [ ] No silent skips or deferrals
- [ ] No unasked-for changes introduced

## Workflow Checklist

Copy this checklist and track progress:

```
Progress:
- [ ] Step 1: Parse request — identify all sub-requests and action items
- [ ] Step 2: DECOMPOSE — number each atomic item
- [ ] Step 3: Read target files BEFORE any modification
- [ ] Step 4: EXECUTE — apply changes for each item
- [ ] Step 5: Re-read modified files AFTER each modification
- [ ] Step 6: VERIFY — report evidence (file:line) per item
- [ ] Step 7: Zero-skip audit — confirm no items were dropped
```

## Human Checkpoints

| After Step | Checkpoint | Type | Options |
|-----------|-----------|------|---------|
| Step 2 | All sub-requests captured in decomposition? | Approval | Complete / Missing items identified |
| Step 4 | Ambiguous request — clarify intent? | Selection | Interpretation A / Interpretation B / Ask user |
| Step 7 | All items addressed with evidence? | Go-No-Go | Complete / Items missing — address now |

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Parse request | MEDIUM | Conjunction markers defined, but intent can be ambiguous |
| Decompose into items | LOW | Every sub-request must be captured, no skipping |
| Read before modify | LOW | Mandatory, no exceptions |
| Execute changes | MEDIUM | Implementation approach flexible, scope must match request exactly |
| Re-read after modify | LOW | Mandatory, no exceptions |
| Report evidence | LOW | file:line format required |
| Zero-skip audit | LOW | Every item must be addressed or explicitly blocked with reason |
