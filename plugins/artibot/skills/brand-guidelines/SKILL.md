---
context: fork
name: brand-guidelines
platforms: [claude-code, gemini-cli, codex-cli, cursor]
description: "Manages brand identity including voice guidelines, visual standards, messaging consistency, and brand governance with frameworks for style guides and cross-channel consistency. Use when user asks about brand guidelines, brand voice, style guide, brand identity, tone of voice, messaging framework, visual identity, 브랜드 가이드라인, 브랜드 보이스, or 스타일 가이드."
lang: [en, ko]
level: 3
triggers:
  - "brand"
  - "brand voice"
  - "brand identity"
  - "style guide"
  - "brand consistency"
  - "tone"
agents:
  - "doc-updater"
  - "frontend-developer"
tokens: "~3K"
category: "marketing"
source_hash: a9ef611d
whenNotToUse: "One-off copy tasks or campaign-specific content where brand system governance is not the goal; do not apply when the user only needs a single piece of text, not a reusable standard."
---

# Brand Guidelines

## When This Skill Applies
- Defining brand voice and tone guidelines
- Creating or updating brand style guides
- Ensuring messaging consistency across channels
- Establishing visual identity standards
- Building brand governance frameworks

## Core Guidance

### 1. Brand Guidelines Development
```
Brand Audit -> Define Core Identity -> Establish Voice -> Set Visual Standards -> Create Messaging Framework -> Document Guidelines -> Train Teams -> Monitor Consistency
```

### 2. Brand Voice Framework

#### Voice Dimensions
| Dimension | Spectrum | Your Position |
|-----------|---------|---------------|
| Formal <-> Casual | Corporate to conversational | [define] |
| Serious <-> Playful | Professional to humorous | [define] |
| Technical <-> Simple | Expert to accessible | [define] |
| Authoritative <-> Friendly | Commands to suggests | [define] |

#### Voice Definition Template
```
We are: [3 voice attributes]
  e.g., Confident, Approachable, Expert

We are NOT: [3 anti-attributes]
  e.g., Arrogant, Childish, Academic

We sound like: [description or persona]
  e.g., "A knowledgeable colleague who explains complex topics clearly"
```

### 3. Tone Adaptation by Context

| Context | Tone Shift | Example |
|---------|-----------|---------|
| Marketing website | Confident, aspirational | "Transform how your team works" |
| Social media | Casual, engaging | "Who else struggles with Monday reports?" |
| Email campaigns | Personal, helpful | "Here's something that might help you..." |
| Documentation | Clear, instructive | "Follow these steps to configure..." |
| Error messages | Empathetic, solution-oriented | "Something went wrong. Let's fix it." |
| Sales materials | Professional, compelling | "Organizations using our platform see..." |
| Support | Patient, reassuring | "We're here to help. Let's solve this." |

### 4. Messaging Architecture

```
BRAND PROMISE
├── [One sentence that defines your brand's commitment]
│
CORE VALUE PROPOSITIONS (3-5)
├── VP1: [Benefit statement]
│   └── Proof: [supporting evidence]
├── VP2: [Benefit statement]
│   └── Proof: [supporting evidence]
└── VP3: [Benefit statement]
    └── Proof: [supporting evidence]

AUDIENCE-SPECIFIC MESSAGING
├── Audience 1: [adapted message]
├── Audience 2: [adapted message]
└── Audience 3: [adapted message]

TAGLINE / ELEVATOR PITCH
└── [One-line brand summary]
```

### 5. Writing Style Rules

| Rule | Guideline | Example |
|------|-----------|---------|
| Active voice | Prefer active over passive | "We built" not "was built by us" |
| Concise | Remove unnecessary words | "Use" not "make use of" |
| Specific | Concrete over abstract | "50% faster" not "much faster" |
| Inclusive | Gender-neutral, accessible | "They" not "he/she" |
| Consistent | Same terms for same concepts | Pick "customer" OR "client", not both |
| Jargon-free | Explain or avoid industry jargon | Unless audience expects it |

### 6. Visual Identity Standards

| Element | Specification | Usage Rules |
|---------|-------------|-------------|
| Logo | Primary, secondary, icon variations | Minimum size, clear space, backgrounds |
| Colors | Primary, secondary, accent, neutral palettes | Hex/RGB values, contrast ratios |
| Typography | Heading and body font families | Sizes, weights, line heights per context |
| Imagery | Photography style, illustration style | Do/don't examples, sourcing guidelines |
| Icons | Style (outlined/filled), size grid | Consistent weight and corner radius |
| Spacing | Grid system, margin/padding standards | 4px/8px base unit system |

### 7. Channel-Specific Guidelines

| Channel | Key Considerations |
|---------|-------------------|
| Website | Full brand expression, primary voice |
| Email | Personalized, slightly more casual |
| Social | Platform-adapted, most casual |
| Paid Ads | Concise, benefit-focused, platform constraints |
| Print | Formal, high visual quality |
| Presentations | Professional, data-supported |
| Product/UI | Clear, instructive, consistent terminology |

### 8. Brand Consistency Checklist

- [ ] Voice and tone match brand personality
- [ ] Key messages align with messaging architecture
- [ ] Visual elements follow identity standards
- [ ] Terminology is consistent across channels
- [ ] Cultural sensitivity reviewed for all markets
- [ ] Legal/compliance requirements met
- [ ] Accessibility standards maintained
- [ ] Templates updated and distributed

## Output Format
```
BRAND GUIDELINES
================
Brand:      [brand name]
Version:    [document version]

BRAND VOICE
-----------
We are:     [3 attributes]
We are NOT: [3 anti-attributes]
We sound:   [description]

MESSAGING
---------
Promise:    [brand promise]
Value Props:
  1. [VP1]: [proof]
  2. [VP2]: [proof]
  3. [VP3]: [proof]

TONE BY CONTEXT
---------------
Context     | Tone              | Example
------------|-------------------|---------
[context]   | [tone descriptor] | [example text]

WRITING RULES
-------------
[Numbered list of do/don't rules]

VISUAL STANDARDS
----------------
Colors:     [palette with hex codes]
Typography: [font families and usage]
Logo:       [usage rules and restrictions]
```

## Quick Reference

**Voice Dimensions**: Formal/Casual, Serious/Playful, Technical/Simple, Authoritative/Friendly
**Messaging Layers**: Brand Promise -> Value Props -> Audience Messages -> Tagline
**Tone Adaptation**: Varies by channel (website=full brand, social=casual, docs=instructive)
**Consistency**: Same terms, same voice, adapted tone per context

---

## Cold Start

When the user has no existing brand voice, style guide, or brand identity document:
1. What does the business do? (one sentence)
2. Who is the target customer? (demographics + psychographics)
3. What differentiates from competitors? (one sentence)
4. What is the primary goal? (awareness/leads/sales/retention)

Use answers to bootstrap the workflow. Mark assumptions with [ASSUMED].

## References

- See `${CLAUDE_SKILL_DIR}/references/voice-definition-framework.md` for voice definition framework
- See `${CLAUDE_SKILL_DIR}/references/messaging-architecture.md` for messaging architecture


## Rationalizations

The following table captures common excuses agents make to skip the rigor of this marketing practice, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "Designers know the brand, we don't need a written guide." | Tribal knowledge evaporates with turnover; without a documented style guide, visual drift compounds across 6-12 months. |
| "Voice and tone are subjective, can't be codified." | Voice attributes (e.g., confident not arrogant, warm not saccharine) can and must be expressed as do/don't pairs with examples. |
| "Color tokens are a nice-to-have." | Without semantic color tokens, every new surface re-invents palette decisions and accessibility contrast fails audit. |
| "We'll fix brand inconsistencies in the redesign." | Inconsistencies erode brand recall by measurable percentages each quarter; governance must be continuous, not batched. |
| "Logo lockup rules are too rigid for social." | Clear-space and minimum-size rules exist because violations reduce recognition at thumbnail sizes by up to 50%. |
