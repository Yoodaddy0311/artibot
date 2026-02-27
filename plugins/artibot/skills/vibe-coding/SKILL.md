---
name: vibe-coding
description: "Quality enforcement for casual/natural language coding requests. Ensures every part of the user's request is decomposed, executed, verified, and reported. Prevents silent skips, partial execution, and unverified claims."
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
