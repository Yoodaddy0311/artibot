---
description: (Artibot) Visual and brand design direction with presentation-designer agent
argument-hint: '[target] e.g. "신제품 랜딩 페이지 비주얼 방향 잡아줘"'
allowed-tools: [Read, Glob, Grep, Bash, Agent, TaskCreate]
---

# /design

Visual and brand design direction. Delegates to the presentation-designer agent for concept generation, alternative evaluation, and a documented design rationale.

## Arguments

Parse $ARGUMENTS:
- `target`: Asset, campaign, or surface to design (landing page, deck, social set, brand system)
- `--type [domain]`: `brand` | `deck` | `social` | `landing` | `full`
- `--rationale`: Generate a formal design rationale document
- `--alternatives [n]`: Number of design directions to evaluate (default: 2)

## Execution Flow

1. **Parse**: Identify the design target and domain type
2. **Context**: Gather existing design context:
   - Brand guidelines, palette, and typography in use
   - Existing assets and templates for the surface
   - Audience, tone of voice, and campaign objective
   - Channel constraints (aspect ratios, safe areas, file limits)
3. **Delegate**: Route to Agent(presentation-designer) for:
   - Requirement extraction from the target description
   - Design direction generation (N alternatives)
   - Trade-off matrix evaluation per direction
   - Recommended direction with rationale
4. **Rationale** (if `--rationale`): Generate a design rationale record:
   - Title, Status, Context, Decision, Consequences
   - Store alongside the campaign or brand documentation
5. **Validate**: Check the direction against brand guidelines, accessibility contrast, and channel specs
6. **Report**: Output the design recommendation with trade-off analysis

## Design Evaluation Criteria

| Criterion | Weight | Measures |
|-----------|--------|----------|
| Brand fit | 30% | Guideline adherence, tone consistency, recognizability |
| Clarity | 25% | Message hierarchy, focal point, reading order |
| Accessibility | 20% | Contrast ratio, legible type sizes, colorblind safety |
| Reusability | 15% | Template potential, component reuse, asset count |
| Production cost | 10% | Effort to produce, dependency on external assets |

## Output Format

Use GFM markdown tables:

**Summary**

| 항목 | 값 |
|------|-----|
| Target | [asset/campaign] |
| Domain | [brand/deck/social/landing] |
| Status | PROPOSED/ACCEPTED |

**Design Directions**

| Option | Description | Advantages | Disadvantages | Score |
|--------|-------------|------------|---------------|-------|
| A: [name] | [summary] | [advantages] | [disadvantages] | [score] |
| B: [name] | [summary] | [advantages] | [disadvantages] | [score] |

**Recommendation**: [A/B] — [rationale]

**Asset Plan**

| Asset | Channel | Spec |
|-------|---------|------|
| [asset] | [channel] | [dimensions/format] |

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 자료 제작 | `/ppt` | 확정된 방향으로 덱·자료 제작 |
| 2 | 방향 검증 | `/analyze` | 콘텐츠·전환 관점에서 방향 점검 |
| 3 | 가이드 문서화 | `/document` | 디자인 근거 및 가이드 문서 작성 |
