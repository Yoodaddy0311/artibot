---
context: fork
name: case-study
description: "Builds customer success case studies across B2B SaaS, D2C ecommerce, and professional services using a 5-block Challenge-Strategy-Execution-Results-Lessons structure with STAR-to-marketing mapping. Covers title formulas, TL;DR boxes, quantitative KPIs, and quote-approval workflow. Use when user asks about case study, customer success story, success case, 고객 사례, 성공 사례, 케이스 스터디, B2B 사례, or 고객 스토리."
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "case study"
  - "customer success story"
  - "success story"
  - "customer case"
  - "client story"
  - "고객 사례"
  - "성공 사례"
  - "케이스 스터디"
  - "고객 스토리"
  - "도입 사례"
agents:
  - "content-marketer"
  - "doc-updater"
tokens: "~4K"
category: "marketing"
depends_on:
  - copywriting
  - long-form-writing
suggests:
  - voice-reference
  - ai-slop-reviewer
---

# Case Study

## When This Skill Applies

- Drafting a customer success story for a B2B SaaS account
- Building a D2C ecommerce brand's customer showcase
- Turning a professional services engagement into a published narrative
- Converting an internal win-report into a sales enablement asset
- Any brief where the goal is to translate one customer outcome into a repeatable story

## Core Guidance

### 1. Title Formula

| Pattern | Template | When to Use |
|---------|----------|-------------|
| Primary | `How [Company] [Result] in [Timeframe]` | Clear quantitative result, named customer |
| Variation A | `[Company]: From [Before State] to [After State]` | Transformation is the main hook |
| Variation B | `Why [Company] Chose [Approach] to [Solve Problem]` | Decision narrative matters more than metric |

The primary formula wins most of the time. Use variations only when the quantitative result is weak or when the selection process itself is the story.

### 2. TL;DR Box

Place immediately under the title, above any image or author byline. 40-60 words, three lines.

| Line | Content |
|------|---------|
| 1 | Challenge in one sentence, name the pain |
| 2 | Solution in one sentence, name the approach (not the vendor pitch) |
| 3 | Key metric with before and after numbers |

A reader who stops at the TL;DR should still come away with the single most important fact.

### 3. Five-Block Structure

| # | Block | Purpose | Word Count |
|---|-------|---------|-----------|
| 1 | Challenge | Frame the customer's pain with context and stakes | 150-250 |
| 2 | Strategy | The decision, why this approach over alternatives | 150-250 |
| 3 | Execution | What was actually done, in sequence, with details | 250-400 |
| 4 | Results | Quantitative KPIs, qualitative shifts, timeline | 200-300 |
| 5 | Lessons | Transferable takeaways for a reader in a similar seat | 100-200 |

Total target: 850-1,400 words. Execution and Results carry the most weight because they are the least substitutable.

### 4. STAR to Marketing Mapping

STAR (Situation-Task-Action-Result) is an interview framework. It maps cleanly to the case study structure with one addition.

| STAR Element | Case Study Block | Adjustment |
|--------------|------------------|-----------|
| Situation | Challenge | Add stakes: what happens if not solved |
| Task | Strategy | Reframe from "what I had to do" to "what we chose to do" |
| Action | Execution | Break into sequenced steps with named tools |
| Result | Results | Require before/after numbers, not just the after |
| — | Lessons | New block; STAR has no forward-looking element |

### 5. Data Section Requirements

Every case study must carry quantitative evidence, qualitative evidence, and a timeline.

| Evidence Type | Minimum | Format |
|---------------|---------|--------|
| Quantitative KPIs | 2 before/after pairs | `Metric: before -> after (% change)` |
| Qualitative quote | 1-2, from named stakeholder | Direct quote with title and company |
| Timeline | Required | Month labels from kickoff to measured result |

If before/after numbers are unavailable, the case study is not yet ready to publish. State this to the customer team rather than filling with soft language.

### 6. Quote Approval Workflow

| Step | Action | Artifact |
|------|--------|----------|
| 1 | Draft the quote from interview notes or transcript | Quote draft with context |
| 2 | Send confirmation email to the named stakeholder | See template below |
| 3 | Wait for explicit written approval before publish | Approval on file |

**Confirmation email core line** (adapt for your voice):
`Subject: Quick approval for your quote in the upcoming [Company] case study`
`Body opening: "Can you confirm the quote below is accurate and approved for public use on our site and in marketing materials? Reply with 'approved' or any edits."`

**Approval checkbox** — never publish without all three:
- [ ] Quote text confirmed verbatim or edited version received
- [ ] Title and company attribution approved
- [ ] Public use consent received in writing

### 7. Three Industry Template Variations

| Industry | Differentiator | Metric Emphasis | Quote Type |
|----------|---------------|-----------------|-----------|
| B2B SaaS | Buying committee has 3-7 stakeholders; decision cycle long | Revenue impact, CAC, time-to-value, seat expansion | Operator or director titles |
| D2C Ecommerce | Single decision-maker; story closer to brand narrative | AOV, conversion rate, CAC payback, repeat rate | Founder or head-of-growth |
| Professional Services | Custom engagement; outcome tied to named partner | Hours saved, quality score, client retention | Partner or engagement lead |

**B2B SaaS specifics**: Name the product modules used. Identify the champion and the economic buyer. Results section should map to the buying committee's stated KPIs.

**D2C ecommerce specifics**: Lead with the brand story, not the tool. Show creative or product photography near the Execution block. Include a second-purchase or LTV metric if possible.

**Professional services specifics**: The named partner or consultant is part of the story. Scope boundaries and deliverables belong in Execution. Client confidentiality may require anonymizing certain figures; state the anonymization rule openly.

## Output Format

```
CASE STUDY PACKAGE
==================
Title:        [How [Company] [Result] in [Timeframe]]
Industry:     [B2B SaaS | D2C | Professional Services]
Word Count:   [850-1,400]

TL;DR BOX
─────────
[Line 1: Challenge]
[Line 2: Solution approach]
[Line 3: Key metric before -> after]

BLOCK WORD COUNTS
─────────────────
| Block     | Target  | Actual |
|-----------|---------|--------|
| Challenge | 150-250 | [n]    |
| Strategy  | 150-250 | [n]    |
| Execution | 250-400 | [n]    |
| Results   | 200-300 | [n]    |
| Lessons   | 100-200 | [n]    |

KPI TABLE
─────────
| Metric | Before | After | Change |
|--------|--------|-------|--------|
| [name] | [num]  | [num] | [%]    |

QUOTE APPROVAL LOG
──────────────────
| Quote source  | Title/Company | Approval status |
|---------------|---------------|-----------------|
| [stakeholder] | [title]       | [approved/pending] |
```

## Quick Reference

**Title formula**: `How [Company] [Result] in [Timeframe]`
**TL;DR**: 40-60 words, 3 lines, Challenge / Solution / Metric
**Five blocks**: Challenge -> Strategy -> Execution -> Results -> Lessons
**Block weights**: Execution and Results are heaviest
**Data minimum**: 2 before/after KPI pairs, 1-2 named quotes, 1 timeline
**Approval**: Written consent required before publish
**Industry variants**: B2B SaaS, D2C, Professional Services

---

## References

- See `${CLAUDE_SKILL_DIR}/../copywriting/references/anti-ai-writing.md` for slop patterns that commonly infect Challenge and Lessons blocks
