---
description: (Artibot) Educational explanations of code, concepts, and systems with progressive depth
argument-hint: '[topic] e.g. "이벤트 루프 동작 원리"'
allowed-tools: [Read, Glob, Grep, Bash, Agent]
---

# /explain

Educational explanations that prioritize understanding over brevity. Uses mentor persona for progressive scaffolding and Context7 for authoritative references.

## Arguments

Parse $ARGUMENTS:
- `topic-or-path`: Code file, concept name, pattern, or `@<path>` reference
- `--depth [level]`: `shallow` (overview) | `medium` (detailed) | `deep` (comprehensive with internals)
- `--audience [level]`: `beginner` | `intermediate` | `senior` (adjusts terminology and assumed knowledge)
- `--examples`: Include executable code examples
- `--compare`: Compare with alternative approaches

## Execution Flow

1. **Parse**: Identify whether target is code path, concept, or pattern
2. **Context**: If code path:
   - Read the file and surrounding context
   - Map dependencies and call sites
   - Identify framework and language idioms used
   If concept:
   - Gather relevant code examples from the codebase
   - Use Context7 for authoritative documentation
3. **Structure**: Build explanation with progressive complexity:
   - **What**: Core concept or purpose (1-2 sentences)
   - **Why**: Motivation and problem it solves
   - **How**: Mechanism and implementation details
   - **When**: Usage patterns and applicability
   - **Pitfalls**: Common mistakes and misconceptions
4. **Examples**: If `--examples`, include runnable code demonstrating the concept
5. **Compare**: If `--compare`, show alternative approaches with trade-offs
6. **Report**: Output structured explanation

## Depth Levels

| Level | Content | Token Budget |
|-------|---------|-------------|
| shallow | What + Why, 1 example | ~2K |
| medium | What + Why + How + When, 2-3 examples | ~5K |
| deep | Full breakdown + internals + alternatives + pitfalls | ~10K |

## Output Format

```
EXPLANATION
===========
Topic:    [topic or file path]
Depth:    [shallow|medium|deep]
Audience: [beginner|intermediate|senior]

WHAT
----
[Core concept in 1-2 sentences]

WHY
---
[Motivation and problem context]

HOW
---
[Mechanism and implementation details]

EXAMPLES
--------
[Runnable code examples with annotations]

PITFALLS
--------
[Common mistakes and how to avoid them]
```

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 설명 문서화 | `/document` | 설명 내용 문서로 저장 |
| 2 | 심층 분석 | `/analyze` | 관련 영역 심층 분석 |
| 3 | 자료화 | `/ppt` | 설명 내용을 발표자료로 |
