---
context: fork
name: copywriting
description: "Applies persuasive writing frameworks (AIDA, PAS, BAB) for headlines, CTAs, ad copy, email subjects, and landing pages with platform-specific character constraints. Use when user asks about copywriting, headline, CTA, ad copy, subject line, landing page copy, persuasive writing, tagline, 카피라이팅, 헤드라인, or 광고 문구."
lang: [en, ko]
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "copywriting"
  - "copy"
  - "sales copy"
  - "headline"
  - "CTA"
  - "conversion copy"
  - "value proposition"
agents:
  - "doc-updater"
tokens: "~3K"
category: "marketing"
source_hash: b03c3667
whenNotToUse: "Technical documentation, neutral informational writing, or internal prose where persuasion frameworks (AIDA, PAS) are inappropriate or would distort the content's intent."
---

# Copywriting

## When This Skill Applies
- Writing headlines, taglines, and value propositions
- Creating CTAs for emails, ads, and landing pages
- Crafting ad copy within platform character limits
- Writing email subject lines and preheaders
- Developing brand messaging and key narratives

## Core Guidance

### 1. Copywriting Frameworks

#### AIDA (Attention-Interest-Desire-Action)
- **Attention**: Hook with bold statement, question, or statistic
- **Interest**: Elaborate on the problem or opportunity
- **Desire**: Show the solution and benefits
- **Action**: Clear CTA with urgency

#### PAS (Problem-Agitate-Solution)
- **Problem**: State the audience's pain point directly
- **Agitate**: Amplify the consequences of not solving it
- **Solution**: Present your offering as the answer

#### BAB (Before-After-Bridge)
- **Before**: Current painful state
- **After**: Desired future state
- **Bridge**: How your product gets them there

#### 4Ps (Promise-Picture-Proof-Push)
- **Promise**: Bold benefit claim
- **Picture**: Vivid scenario of success
- **Proof**: Evidence (testimonials, data, case studies)
- **Push**: Urgency-driven CTA

### 2. Headline Formulas

| Formula | Pattern | Example |
|---------|---------|---------|
| How-to | "How to [achieve goal] without [pain]" | "How to double leads without increasing ad spend" |
| Number | "[N] ways to [benefit]" | "7 ways to reduce churn by 30%" |
| Question | "[Pain point question]?" | "Still losing customers to slow onboarding?" |
| Proof | "[Result] in [timeframe]" | "3x pipeline growth in 90 days" |
| Curiosity | "[Unexpected claim]" | "Why top marketers are abandoning email blasts" |

### 3. CTA Best Practices

**Structure**: Action verb + benefit + urgency (optional)

| Weak CTA | Strong CTA | Why Better |
|----------|-----------|-----------|
| Submit | Start My Free Trial | Benefit-oriented |
| Click Here | Get the Report Now | Specific action + urgency |
| Learn More | See How It Works | Clearer expectation |
| Sign Up | Join 10,000+ Marketers | Social proof |
| Buy Now | Claim Your 50% Discount | Value-oriented |

### 4. Platform Copy Constraints

| Platform | Element | Limit | Best Practice |
|----------|---------|-------|---------------|
| Google Ads | Headline | 30 chars x 15 | Keyword-rich, benefit-led |
| Google Ads | Description | 90 chars x 4 | CTA, differentiator, proof |
| Meta/FB | Primary text | 125 chars | Hook in first line |
| Meta/FB | Headline | 40 chars | Benefit or offer |
| LinkedIn | Intro text | 150 chars | Professional tone, value-first |
| Twitter/X | Post | 280 chars | Hook + insight + CTA |
| Email | Subject line | 30-50 chars | Personalization, curiosity |
| Email | Preheader | 40-100 chars | Extends subject value |

### 5. Tone Modifiers

| Tone | Characteristics | Best For |
|------|----------------|---------|
| Professional | Formal, authoritative, data-driven | B2B, enterprise, finance |
| Casual | Conversational, friendly, relatable | B2C, SaaS, lifestyle |
| Urgent | Time-sensitive, FOMO, scarcity | Sales, limited offers |
| Educational | Informative, helpful, mentoring | Content marketing, onboarding |
| Witty | Clever, unexpected, memorable | Brand building, social media |
| Provocative | Challenging, contrarian, bold | Thought leadership |

### 6. Power Words by Category

| Category | Words |
|----------|-------|
| Urgency | Now, today, limited, expires, last chance, don't miss |
| Exclusivity | Secret, insider, VIP, invitation-only, exclusive |
| Trust | Proven, guaranteed, certified, trusted, verified |
| Value | Free, bonus, save, discount, complimentary |
| Emotion | Transform, breakthrough, revolutionary, effortless |

### 7. Copy Quality Checklist

- [ ] Clear single message (one idea per piece)
- [ ] Benefit-focused (not feature-focused)
- [ ] Specific (numbers, timeframes, results)
- [ ] Active voice throughout
- [ ] No jargon unless audience-appropriate
- [ ] CTA is clear, visible, and action-oriented
- [ ] Meets platform character/format limits
- [ ] Tone matches brand voice and audience

## Output Format
```
COPY PACKAGE
============
Framework:  [AIDA|PAS|BAB|4Ps]
Tone:       [professional|casual|urgent|educational|witty|provocative]
Platform:   [target platform]

HEADLINE OPTIONS
----------------
1. [headline] ([char count])
2. [headline] ([char count])
3. [headline] ([char count])

BODY COPY
---------
[Copy following selected framework]

CTA OPTIONS
-----------
1. [CTA text] - [rationale]
2. [CTA text] - [rationale]
```

## Quick Reference

**Frameworks**: AIDA, PAS, BAB, 4Ps
**Key Elements**: Headlines, CTAs, subject lines, body copy, taglines
**Tone Options**: professional, casual, urgent, educational, witty, provocative

---

## References

- See `${CLAUDE_SKILL_DIR}/references/persuasion-frameworks.md` for persuasion frameworks
- See `${CLAUDE_SKILL_DIR}/references/cta-best-practices.md` for CTA best practices


## Rationalizations

The following table captures common excuses agents make to skip the rigor of this marketing practice, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "List every feature, customers will figure out the value." | Features without benefit translation force cognitive load on the reader; conversion drops 20-40% vs. benefit-led copy. |
| "Jargon signals expertise." | Industry jargon excludes buyers outside the inner circle and reduces comprehension; plain language at 6th-8th grade reads highest. |
| "Long copy always outperforms short copy." | Copy length must match decision complexity; short copy wins for impulse purchases, long copy for high-consideration, never the reverse. |
| "The client approved it, so it's done." | Client approval is not market validation; copy must be tested against real audiences via A/B or 5-second tests. |
| "AIDA is old, we don't need a framework." | Frameworks (AIDA, PAS, BAB) are scaffolds for completeness, not creativity caps; skipping them produces copy missing attention or action. |
