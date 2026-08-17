---
context: fork
name: problem-validation
description: |
  Auto-activates when the user asks to improve, enhance, audit, or propose changes without specifying a concrete problem —
  especially "개선", "보완", "발전방안", "제안", "감사", "전수조사", "업그레이드", "더 좋게",
  "추가하면 좋을", "enhance", "improve", "propose", "audit", "optimization", YAGNI, over-engineering,
  "필요한가", "어떻게 하면 더 좋아질까", "무엇을 더 보강할 수 있을까", "개선안 좀 찾아봐".
  Also fires when a candidate list of proposals exists and none has been cross-checked against live code evidence yet.
lang: [en, ko]
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 2
triggers:
  - "개선"
  - "보완"
  - "발전방안"
  - "제안"
  - "감사"
  - "전수조사"
  - "업그레이드"
  - "더 좋게"
  - "추가하면 좋을"
  - "enhance"
  - "improve"
  - "propose"
  - "audit"
  - "optimization"
  - "필요한가"
  - "over-engineering"
  - "YAGNI"
  - "어떻게 하면 더 좋아질까"
  - "개선안 좀 찾아봐"
agents:
  - "orchestrator"
  - "architect"
tokens: "~2K"
category: "quality"
source_hash: ""
whenNotToUse: "Do not apply when the user has already specified a concrete, bounded problem (e.g. 'fix this bug', 'implement X feature'). This skill is for open-ended improvement/audit requests where the set of problems is not yet determined."
---

# Problem Validation Gate

A skeptical pre-flight check that runs before proposing improvements, enhancements, or audit findings.
Every candidate problem must survive this gate before it reaches the user.

## When This Skill Applies

- An improvement/audit request is open-ended: "어떻게 하면 더 좋아질까?", "개선점 찾아봐", "감사 좀 해줘"
- A list of proposals exists but has not been cross-checked against actual code
- A recommendation is about to be presented and its real-world necessity is unverified
- The word "could", "might", "should probably", or "트렌드상" appears in a draft proposal

## Core Rule: Default = REJECT

Each candidate starts at REJECT and must earn NECESSARY through evidence.
Presenting a proposal without passing this gate is a quality violation.

## Pre-step: Decompose the Proposal List First

Before running the 4-check gate, enumerate every candidate as a discrete, named item. A vague "improve X" is not a candidate — split it until each item names one specific change. Candidates that cannot be named specifically at this stage are not ready for validation and must be clarified before proceeding.

If a candidate is a compound feature, decompose it into independent sub-functions first, then apply the checklist to each sub-function separately. A "bulk REJECT" on a compound candidate is a signal that check 1 was not run per sub-function. When sub-functions yield different verdicts, report them as PARTIAL adoption rather than collapsing to a single verdict.

복합 후보는 named 확인 후 **독립 하위기능으로 더 분해**해 각 조각에 체크리스트를 개별 적용한다. 덩어리 REJECT는 조각별 check 1을 안 돌린 신호다.

## Checklist (per candidate — all four must pass for NECESSARY)

Run each check with actual tooling (Grep, Read, Glob) — never from memory.

| # | Check | Method | FAIL signal |
|---|-------|--------|-------------|
| 1 | Already implemented? | `Grep` the relevant function, flag, or config key | Feature/flag/function found in codebase |
| 2 | Hard evidence exists? | Point to a real incident, failing test, or documented friction with `file:line` | Only trend/hunch/training-data pattern |
| 3 | Not YAGNI? | Confirm real current demand exists, not speculative future need | "Might be useful someday", "best practice says" |
| 4 | Maintenance cost < value? | Estimate upkeep burden vs concrete benefit | Ongoing cost likely exceeds realistic gain |

check 2 의 `file:line` 표기 정본은 [CITATION-SYNTAX.md](../../docs/CITATION-SYNTAX.md) 이고, 그 인용이 실제로 해소되는지는 술어 `tests/firewall/citation-resolution.js#checkDocument` 로 기계 판정할 수 있다 (규칙은 그 두 곳에만 산다 — 여기 복제하지 않는다). 다만 술어는 **"매달린 인용이 아님"만** 증명한다. 인용한 줄이 주장을 실제로 뒷받침하는지는 열어서 확인해야 check 2 가 충족된다.

## Verdicts

| Verdict | Meaning | Condition |
|---------|---------|-----------|
| NECESSARY | Include in proposal | All 4 checks pass with evidence |
| PARTIAL | Adopt only the NECESSARY sub-functions | 분해 시 일부 조각만 4-check 통과 — 통과 조각 ADOPT, 나머지 REJECT/DEFER 병기 |
| DEFER | Value exists but no current demand | Checks 1/2/4 pass, check 3 weak |
| REJECT | Drop — do not present | Fails check 1 (already done), 2 (no evidence), or 3+4 (YAGNI/too costly) |

## Null Result is a First-Class Outcome

If zero candidates reach NECESSARY verdict, the correct response is:

> "검증 결과 변경할 것 없음 — 현재 구현이 이미 건강합니다."

Do NOT manufacture proposals to avoid an empty list. An empty list is evidence of quality, not failure.

## Transparency Rule

When presenting results to the user, always include:

- NECESSARY list with evidence (`file:line` for each)
- REJECT list with one-line reason per item
- DEFER list with brief rationale

The user needs the full picture to make informed decisions. Hiding REJECTs is a quality violation.

## Adversarial Self-Check

Before finalizing any proposal list, ask: "Am I presenting this because it is genuinely needed, or because it looks thorough?" If the honest answer is the latter, re-run the checklist.

The instinct to propose more is a bias, not a virtue. Restraint supported by evidence is higher quality than volume without it.

## Anti-Patterns

These patterns indicate the gate was skipped or gamed:

- Proposals backed only by "industry best practice" or "trend" without a `file:line`
- A feature appearing in the proposal list that `grep` would have found already implemented
- No REJECT items in a list of 5+ proposals (statistically implausible — almost certainly means the gate was not applied)
- Framing DEFER items as NECESSARY to pad the list
- Omitting the REJECT list from the user-facing output

## Red Flags

- Submitting proposals without running any `Grep`/`Read` verification first
- "I checked mentally" as a substitute for actual tool use
- Proposal list with zero REJECT or DEFER entries when scope is broad
- Using "could improve" or "might help" language without pointing to evidence
- Presenting a null result as a failure rather than a valid outcome
- Hiding rejected candidates from the user to make the proposal look more substantial

## Rationalizations

| Rationalization | Rebuttal |
|---|---|
| "These are standard best practices, no need to check the code" | Best practices are a starting point, not evidence. The code may already implement them — grep first. |
| "I'll present everything and let the user decide" | Unvalidated proposals waste the user's attention. The gate exists so the user only reads vetted items. |
| "A null result makes me look like I did nothing" | A null result backed by evidence means the system is healthy — that is a useful, honest finding. |
| "YAGNI only applies to implementation, not proposals" | Proposing future-proofing without current demand is the same debt, just deferred. |
| "I can't run grep without more context" | Lack of context is a reason to ask for clarification, not to skip validation. |
