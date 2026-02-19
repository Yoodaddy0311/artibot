---
name: competitive-intelligence
description: |
  Competitive analysis and market intelligence for positioning, differentiation, and strategic advantage.
  Provides frameworks for competitor monitoring, SWOT analysis, and market trend identification.
  Auto-activates when: competitor analysis, market positioning, differentiation strategy, market intelligence.
  Triggers: competitor, competitive analysis, SWOT, differentiation, market intelligence, positioning, benchmark, 경쟁 분석, 시장 정보, 포지셔닝
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "competitive"
  - "competitor"
  - "market analysis"
  - "competitive intelligence"
  - "landscape"
agents:
  - "persona-analyzer"
  - "persona-architect"
tokens: "~4K"
category: "marketing"
---

# Competitive Intelligence

## When This Skill Applies
- Analyzing competitor products, pricing, and messaging
- Building competitive positioning and differentiation maps
- Conducting SWOT analysis for strategic planning
- Identifying market gaps and opportunities
- Monitoring competitive landscape changes

## Core Guidance

### 1. Competitive Analysis Process
```
Identify Competitors -> Gather Intelligence -> Analyze Positioning -> Map Differentiation -> Identify Gaps -> Recommend Strategy
```

### 2. Competitor Identification

| Tier | Definition | Analysis Depth |
|------|-----------|---------------|
| Direct | Same product, same market | Deep (pricing, features, messaging, strategy) |
| Indirect | Different product, same need | Moderate (positioning, value prop, audience) |
| Aspirational | Category leaders to learn from | Light (strategy patterns, innovations) |
| Emerging | New entrants with potential | Monitor (funding, growth signals, tech) |

### 3. SWOT Analysis Framework

| Quadrant | Internal/External | Questions |
|----------|------------------|-----------|
| Strengths | Internal + Positive | What do we do better? Unique resources? |
| Weaknesses | Internal + Negative | Where do we underperform? Resource gaps? |
| Opportunities | External + Positive | Market trends? Competitor weaknesses? |
| Threats | External + Negative | New entrants? Changing regulations? |

**SWOT-to-Strategy Matrix**:
- S+O: Leverage strengths to capture opportunities
- S+T: Use strengths to mitigate threats
- W+O: Address weaknesses to unlock opportunities
- W+T: Defend against threats exposed by weaknesses

### 4. Competitive Dimensions

| Dimension | Data Points | Sources |
|-----------|------------|---------|
| Product | Features, UX, integrations, roadmap | Website, G2, Product Hunt, changelogs |
| Pricing | Plans, tiers, discounts, packaging | Pricing pages, sales outreach |
| Messaging | Value props, headlines, positioning | Website, ads, social, press releases |
| Distribution | Channels, partnerships, marketplace | App stores, partner pages, job posts |
| Content | Blog topics, SEO rankings, social presence | Ahrefs, social platforms, blog |
| Team | Size, key hires, expertise | LinkedIn, press, job boards |
| Funding | Rounds, investors, valuation | Crunchbase, press releases |

### 5. Feature Comparison Matrix

```
Feature           | Us    | Comp A | Comp B | Comp C
------------------|-------|--------|--------|--------
[Feature 1]       | [Y/N] | [Y/N]  | [Y/N]  | [Y/N]
[Feature 2]       | [Y/N] | [Y/N]  | [Y/N]  | [Y/N]
Pricing (entry)   | [$XX] | [$XX]  | [$XX]  | [$XX]
Free tier         | [Y/N] | [Y/N]  | [Y/N]  | [Y/N]
```

### 6. Positioning Map

Plot competitors on 2x2 matrices using relevant axes:
- **Price vs. Sophistication**: Where do we sit? Where is whitespace?
- **Ease of Use vs. Power**: Are we niche or mainstream?
- **Market Focus vs. Breadth**: Specialist or generalist?

### 7. Competitive Response Framework

| Competitor Action | Response Priority | Action |
|-------------------|------------------|--------|
| Price drop | Medium | Analyze impact, emphasize value, consider match |
| New feature | Low-High | Assess overlap, differentiate, accelerate roadmap |
| Market entry | High | Strengthen positioning, lock in customers |
| Messaging change | Medium | Monitor results, test counter-messaging |
| Partnership | Medium | Identify alternative partnerships |

## Output Format
```
COMPETITIVE INTELLIGENCE REPORT
================================
Competitors: [count analyzed]
Market:      [segment]
Date:        [analysis date]

COMPETITOR PROFILES
-------------------
[Competitor]: [one-line positioning]
  Strengths: [1-3 key strengths]
  Weaknesses: [1-3 key weaknesses]
  Pricing:   [model and entry price]
  Target:    [primary audience]

POSITIONING MAP
---------------
[2x2 matrix description with competitor placement]

SWOT ANALYSIS
-------------
Strengths:      [bullet list]
Weaknesses:     [bullet list]
Opportunities:  [bullet list]
Threats:        [bullet list]

DIFFERENTIATION
---------------
Our Advantage:  [key differentiator]
Gap to Close:   [where competitors lead]
Whitespace:     [unaddressed market need]

RECOMMENDATIONS
---------------
Priority | Action                    | Target Competitor
---------|---------------------------|-------------------
P1       | [strategic action]        | [competitor]
```

## Quick Reference

**Frameworks**: SWOT, Porter's Five Forces, Positioning Maps, Feature Matrix
**Data Sources**: G2, Capterra, Crunchbase, SimilarWeb, LinkedIn, Ahrefs
**Competitor Tiers**: Direct, Indirect, Aspirational, Emerging

See `references/analysis-templates.md` for detailed competitor analysis templates.
