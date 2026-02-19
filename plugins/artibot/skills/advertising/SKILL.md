---
name: advertising
description: |
  Paid advertising campaign design, creative briefs, platform constraints, and bidding strategy optimization.
  Covers Google Ads, Meta Ads, LinkedIn Ads, and programmatic advertising best practices.
  Auto-activates when: ad campaign creation, creative briefs, paid media strategy, bid optimization.
  Triggers: advertising, ad copy, paid media, Google Ads, Meta Ads, LinkedIn Ads, PPC, display ads, retargeting, creative brief, ad campaign, 광고, 유료 광고, PPC, 리타겟팅
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "advertising"
  - "ad copy"
  - "paid media"
  - "Google Ads"
  - "Meta Ads"
  - "PPC"
  - "creative brief"
agents:
  - "persona-frontend"
tokens: "~3K"
category: "marketing"
---

# Advertising

## When This Skill Applies
- Creating ad copy for search, social, and display campaigns
- Designing creative briefs and campaign structures
- Optimizing bidding strategies and quality scores
- Planning retargeting and lookalike audience campaigns
- Managing ad budget allocation across channels

## Core Guidance

### 1. Ad Campaign Process
```
Objective -> Audience -> Channel Selection -> Campaign Structure -> Creative Brief -> Ad Copy -> A/B Variants -> Launch -> Optimize -> Report
```

### 2. Campaign Objectives Mapping

| Objective | Best Channels | Bid Strategy | Primary Metric |
|-----------|-------------|-------------|---------------|
| Awareness | Display, Social, Video | CPM | Impressions, Reach |
| Traffic | Search, Social | CPC | Clicks, CTR |
| Leads | Search, Social, Display | CPA | Lead volume, CPL |
| Conversions | Search, Retargeting | Target CPA/ROAS | Conversions, CPA |
| Sales | Shopping, Retargeting | Target ROAS | Revenue, ROAS |

### 3. Platform Ad Formats

#### Google Ads
| Format | Specs | Best For |
|--------|-------|---------|
| Search | 15 headlines (30 chars), 4 descriptions (90 chars) | Intent capture |
| Display | 1200x628, 300x250, 728x90 | Awareness, retargeting |
| Video | 6s bumper, 15-30s skippable | Brand, consideration |
| Shopping | Product feed + images | E-commerce |
| Performance Max | All formats, automated | Full-funnel |

#### Meta Ads (Facebook/Instagram)
| Format | Specs | Best For |
|--------|-------|---------|
| Single Image | 1080x1080, 125 char primary | Awareness, traffic |
| Carousel | 2-10 cards, 1080x1080 each | Products, storytelling |
| Video | 1:1 or 9:16, 15-60s | Engagement, awareness |
| Stories/Reels | 9:16, 1080x1920 | Reach, younger demos |
| Lead Forms | In-platform form | Lead generation |

#### LinkedIn Ads
| Format | Specs | Best For |
|--------|-------|---------|
| Sponsored Content | 600x600 image, 150 char intro | B2B awareness |
| Message Ads | Direct to inbox | High-value B2B |
| Conversation Ads | Branching CTA messages | Lead gen, event |
| Document Ads | PDF/carousel in feed | Thought leadership |

### 4. Campaign Structure

```
Account
└── Campaign (objective, budget, schedule)
    └── Ad Group / Ad Set (targeting, bidding)
        └── Ads (creative variants)
```

**Best Practices**:
- 3-5 ad groups per campaign
- 3-5 ads per ad group for testing
- Single theme/intent per ad group
- Separate brand vs. non-brand campaigns
- Dedicated retargeting campaigns

### 5. Quality Score Factors (Google Ads)

| Factor | Weight | Optimization |
|--------|--------|-------------|
| Expected CTR | ~35% | Compelling headlines, strong CTAs |
| Ad Relevance | ~25% | Keyword-headline alignment |
| Landing Page | ~40% | Fast, relevant, mobile-friendly |

### 6. Audience Targeting Layers

| Layer | Type | Example |
|-------|------|---------|
| Demographics | Age, gender, income | "25-45, household income top 25%" |
| Interest | Topics, behaviors | "Marketing technology enthusiasts" |
| Intent | Search behavior, in-market | "Actively researching CRM software" |
| Custom | Website visitors, lists | "Visited pricing page last 30 days" |
| Lookalike | Similar to seed audience | "1% lookalike of converters" |

### 7. Ad Copy Variant Angles

| Angle | Approach | Example Headline |
|-------|----------|-----------------|
| Benefit | Lead with outcome | "Cut Your CAC by 40%" |
| Urgency | Time pressure | "Limited Spots - Enroll Today" |
| Social Proof | Credibility | "Trusted by 5,000+ Teams" |
| Curiosity | Intrigue | "The Secret to 3x Pipeline Growth" |
| Problem | Pain point | "Tired of Manual Reporting?" |

## Output Format
```
AD CAMPAIGN
===========
Objective:  [awareness|traffic|leads|conversions|sales]
Channel:    [platform]
Audience:   [targeting description]
Budget:     [amount/period]

CREATIVE BRIEF
--------------
Message:    [core value proposition]
Tone:       [voice/style]
CTA:        [desired action]

AD VARIANTS
-----------
Variant [n]: [angle]
  Headline:    [text] ([count]/[limit])
  Description: [text] ([count]/[limit])
  CTA:         [button text]
  Visual:      [concept/specs]

FORMAT COMPLIANCE
-----------------
[element]: [PASS|OVER LIMIT] ([count]/[limit])
```

## Quick Reference

**Channels**: Google Ads, Meta Ads, LinkedIn Ads, Twitter Ads, TikTok Ads
**Objectives**: awareness, traffic, leads, conversions, sales
**Ad Angles**: benefit, urgency, social proof, curiosity, problem

See `references/platform-specs.md` for detailed ad format specifications.
See `references/bidding-strategies.md` for bid optimization guides.
