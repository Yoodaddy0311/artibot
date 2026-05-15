---
context: fork
name: vibe-coding
description: "Quality enforcement for casual/natural language coding requests. Ensures every part of the user's request is decomposed, executed, verified, and reported. Use when handling natural language coding requests, multi-part instructions, or casual Korean/English coding commands."
lang: [en]
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
agents: [orchestrator, code-reviewer]
platforms: [claude-code, gemini-cli, codex-cli, cursor]
source_hash: f721ef83
whenNotToUse: "Non-coding requests (documentation, analysis, design discussion) where the DEV decompose-execute-verify loop is not applicable."
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

### Checkpoint 1: 분해 완전성 승인 (After Step 2)
**Context**: 요청을 원자적 항목으로 분해한 직후입니다. 누락된 항목이 있으면 Zero-Skip Mandate 위반으로 사용자 요청이 묵살됩니다. 실행 전에 반드시 확인합니다.
**Ask**: "요청의 **모든 하위 항목이 분해에 포함되었나요**? 누락된 작업이 없는지 검토해 주세요."
**Options**:
1. Complete — 모든 하위 요청이 번호가 매겨진 항목으로 캡처됨
2. Missing items identified — 누락된 항목을 명시하면 분해 목록에 추가 후 재확인
**Default**: 1 (명확한 요청은 분해가 완전할 가능성이 높음)
**Skippable**: No — 불완전한 분해는 조용한 스킵을 발생시켜 Zero-Skip Mandate를 위반함
**Freedom**: LOW

### Checkpoint 2: 모호한 요청 해석 선택 (After Step 4)
**Context**: 실행 중 요청의 의도가 불명확하여 해석이 갈리는 경우에만 활성화됩니다. 잘못된 해석으로 실행을 완료하면 불필요한 재작업이 발생합니다.
**Ask**: "요청의 의도가 **모호합니다**. 어떤 해석으로 진행할지 선택해 주세요."
**Options**:
1. Interpretation A — [첫 번째 해석 설명]
2. Interpretation B — [두 번째 해석 설명]
3. Ask user — 해석이 너무 불확실하여 사용자에게 직접 확인 필요
**Default**: 3 (불확실할 때는 추측보다 물어보는 것이 안전함)
**Skippable**: Yes (의도가 명확한 경우 자동으로 가장 자연스러운 해석 선택)
**Freedom**: HIGH

### Checkpoint 3: 완료 증거 최종 확인 (After Step 7)
**Context**: Zero-Skip 감사를 포함한 모든 작업이 완료된 후, 각 항목에 대한 증거가 빠짐없이 보고에 포함되었는지 최종 점검하는 시점입니다.
**Ask**: "**모든 항목이 증거와 함께 완료**되었나요? 누락된 항목이나 증거 없는 완료 주장이 없는지 확인해 주세요."
**Options**:
1. Complete — 모든 분해 항목이 file:line 증거와 함께 완료됨
2. Items missing — address now — 미완료 항목이 발견됨, 지금 즉시 처리
**Default**: 1 (DEV 프로토콜을 따랐다면 모든 항목이 완료된 상태)
**Skippable**: No — 증거 없는 완료는 허용되지 않으며 누락 항목은 즉시 처리해야 함
**Freedom**: LOW

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

## Rationalizations

The following table captures common excuses agents make to skip the discipline of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "casual request = casual implementation" | casual phrasing hides sharp requirements; decompose every request, regardless of tone |
| "the user said 'just' so it's simple" | "just" is a linguistic tell for underestimated scope; treat it as a red flag, not a permission slip |
| "vibes mean I can skip verification" | vibes mean the requirements are implicit, which means verification is MORE necessary, not less |
| "I'll interpret freely" | free interpretation is where user-agent alignment fails; enforce DECOMPOSE-EXECUTE-VERIFY regardless of register |
| "natural language requests don't need formal specs" | every request becomes a formal spec the moment you execute it — the only question is whether YOU write it or it emerges accidentally |
