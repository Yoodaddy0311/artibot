---
context: fork
name: long-form-writing
description: "Structures in-depth blog posts (1,500-2,500 words) that win both Google rankings and AI citations in the AEO/GEO era. Applies answer-first leads, question-style H2 ratios, citable passage rules, and hook frameworks. Use when user asks about long-form blog, pillar post, in-depth article, AEO optimization, GEO content, AI citation, 롱폼 글쓰기, 블로그 심층 포스트, 필러 콘텐츠, AI 인용 최적화, or 검색 답변 최적화."
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "long-form"
  - "long form blog"
  - "pillar post"
  - "in-depth article"
  - "deep dive post"
  - "AEO content"
  - "GEO content"
  - "AI citation"
  - "answer engine"
  - "롱폼"
  - "심층 포스트"
  - "필러 콘텐츠"
  - "AI 인용"
agents:
  - "content-marketer"
  - "doc-updater"
tokens: "~4K"
category: "marketing"
depends_on:
  - copywriting
suggests:
  - voice-reference
  - ai-slop-reviewer
---

# Long-Form Writing

## When This Skill Applies

- Drafting pillar blog posts between 1,500 and 2,500 words
- Rewriting existing posts for AEO (Answer Engine Optimization) and GEO (Generative Engine Optimization)
- Producing content designed to be quoted by AI assistants and featured snippets
- Building topical authority through structured deep-dives
- Any brief where both SEO ranking and AI citability are success criteria

## Core Guidance

### 1. Answer-First Lead

The first paragraph answers the search query directly in 40-60 words. The rest of the post earns the reader's attention by expanding, qualifying, and proving that answer.

| Element | Specification |
|---------|--------------|
| Word count | 40-60 words |
| Position | Immediately after H1, before any image |
| Content | Direct answer to the implied search question |
| Forbidden | "In this post we will explore...", throat-clearing, topic announcement |

**Pattern**: `[One-sentence direct answer]. [One-sentence qualifier or exception]. [One-sentence stakes or payoff for reading on]`.

Example of the intent (not copy-paste):
- Query: "how long should a case study be"
- Lead: "A B2B case study works best at 800-1,200 words, with 60% of that space on Results and Execution. Shorter pieces under 500 words read as testimonials; longer than 1,500 loses mid-funnel readers. The right length depends on the deal size you are trying to influence, which this guide maps section by section."

### 2. Question-Style H2 Ratio

Between 60% and 70% of H2 headings should be phrased as questions (Why / How / What / When / Who). This structure maps cleanly to FAQ schema, People Also Ask, and LLM retrieval patterns.

| H2 Count | Recommended Question H2s | Statement H2s |
|----------|--------------------------|---------------|
| 5 | 3 | 2 |
| 7 | 5 | 2 |
| 9 | 6 | 3 |
| 11 | 7 | 4 |

Statement H2s are reserved for transitional sections, examples, and conclusions. Question H2s cover every substantive claim.

### 3. Citable Passage Rule

Every major section must contain at least one 120-180 word passage that can be quoted in full without requiring surrounding context. An AI assistant should be able to lift the block verbatim and have it still make sense to the end reader.

| Requirement | Why It Matters |
|-------------|----------------|
| Self-contained | Reader arriving cold from a snippet still understands |
| Contains a proper noun, number, or named mechanism | Gives the passage retrievability and citation value |
| Source linked within the block | Protects the claim when the passage is excerpted |
| No ambiguous pronouns referring to earlier text | "This" and "that" resolve only to words inside the block |
| Declarative, not conditional | Hedged claims are rarely quoted |

### 4. Sentence and Paragraph Discipline

| Unit | Target | Hard Limit |
|------|--------|-----------|
| Sentence average | 15-20 words | 30 words |
| Paragraph length | 40-80 words | 110 words |
| Ideas per paragraph | 1 | 1 |
| Consecutive long sentences | Max 2 | 3 forces a rewrite |

One idea per paragraph. If a second idea appears, start a new paragraph, even if the current one is short. Rhythm matters more than symmetry.

### 5. Five Hook Frames

Each frame opens the post with a different promise. Pick one based on the reader's entry state.

| Frame | One-Line Definition | Use When | Anti-Pattern |
|-------|---------------------|----------|--------------|
| Counterintuitive | Surfaces a claim that contradicts common belief in the field | Reader expects the standard answer | Don't invert for shock value without evidence |
| Transformation | Contrasts a before state with a measurable after state | Reader wants proof of change | Don't use vague before/after with no metric |
| Secret | Reveals knowledge normally held by insiders or experts | Reader feels locked out of a field | Don't imply conspiracy or gatekeeping that isn't real |
| Mistake | Names a common error the reader is likely making | Reader is mid-execution and may be wrong | Don't scold; show the error neutrally |
| Data | Leads with a surprising statistic or research finding | Reader trusts evidence over narrative | Don't cite unsourced numbers; the hook dies without the link |

### 6. Statistic and Source Requirements

| Rule | Specification |
|------|--------------|
| Minimum cited facts | 8 per 2,000 words |
| Source URL | Required on every statistic, named study, or quoted expert |
| Verification protocol | Manual read of the source; no statistic quoted from a summary of a summary |
| Date stamp on cited data | Include the publication year in-line ("2025 report from X") |
| Replacement rule | If a source is paywalled or broken, replace before publish, don't publish with a dead link |

### 7. Internal and External Link Policy

| Type | Count | Placement |
|------|-------|-----------|
| Internal links | 2-3 | Within first half of post; anchor text uses target page's primary keyword |
| External authoritative links | 1-2 | Near the statistic or claim they support; open in same tab |
| Forbidden | Affiliate swaps inside informational sections, link trades to low-authority domains |

### 8. Structural Template

```
[H1: primary keyword variation, 55-65 chars]

[Answer-first lead: 40-60 words]

## [Question H2 #1: Why/How/What]
[120-180 word citable passage]
[2-3 supporting paragraphs, 40-80 words each]

## [Question H2 #2]
[Citable passage]
[Table or comparison if data-rich]
[Supporting prose]

## [Statement H2: example or transition]
[Worked example with named details]

## [Question H2 #3]
[Citable passage]
[Quote from named source with link]

## [Question H2 #4 or #5]
[Citable passage]
[Counterargument or edge case addressed]

## [Statement H2: synthesis or framework]
[Decision table or workflow]

## [Conclusion phrased as a question or next-step prompt]
[Payoff paragraph, 60-100 words]
[CTA tied to content theme, not generic]
```

## Output Format

```
LONG-FORM DRAFT PACKAGE
=======================
Title:         [H1 headline]
Meta:          [meta description, 150-160 chars]
Target query:  [primary search query]
Word count:    [1,500-2,500]
Hook frame:    [counterintuitive | transformation | secret | mistake | data]

ANSWER-FIRST LEAD
─────────────────
[40-60 word block]

H2 OUTLINE
──────────
| # | Type (Q/S) | Heading                                 |
|---|-----------|-----------------------------------------|
| 1 | Q         | [Why ...]                               |
| 2 | Q         | [How ...]                               |
| 3 | S         | [Example: ...]                          |
| 4 | Q         | [What ...]                              |

CITABLE PASSAGE INVENTORY
─────────────────────────
| Section | Word Count | Contains (proper noun / number / mechanism) |
|---------|-----------|---------------------------------------------|
| H2 #1   | 145       | [what makes it retrievable]                 |

SOURCE LIST
───────────
| Claim | Source URL | Verified? |
|-------|-----------|-----------|
| [stat]| [URL]     | [yes/no]  |
```

## Quick Reference

**Lead**: 40-60 words, direct answer, no preamble
**H2 ratio**: 60-70% question-style
**Citable block**: 120-180 words per section, self-contained
**Sentence target**: 15-20 words average
**Paragraph target**: 40-80 words, one idea
**Minimum sources**: 8 per 2,000 words, URL required
**Links**: 2-3 internal, 1-2 external authoritative
**Hook frames**: counterintuitive, transformation, secret, mistake, data

---

## References

- See `${CLAUDE_SKILL_DIR}/../copywriting/references/anti-ai-writing.md` for slop patterns to avoid in every section
