---
name: brand-guidelines
description: |
  Brand identity management including voice guidelines, visual standards, messaging consistency, and brand governance.
  Provides frameworks for brand voice definition, style guides, and cross-channel brand consistency.
  Auto-activates when: brand voice definition, brand guidelines, style guide creation, brand consistency, messaging framework.
  Triggers: brand guidelines, brand voice, style guide, brand identity, brand consistency, tone of voice, brand standards, messaging framework, visual identity, 브랜드 가이드라인, 브랜드 보이스, 스타일 가이드
level: 3
triggers:
  - "brand"
  - "brand voice"
  - "brand identity"
  - "style guide"
  - "brand consistency"
  - "tone"
agents:
  - "persona-scribe"
  - "persona-frontend"
tokens: "~3K"
category: "marketing"
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

See `references/voice-templates.md` for brand voice definition templates.
See `references/style-guide-checklist.md` for comprehensive style guide creation checklist.
