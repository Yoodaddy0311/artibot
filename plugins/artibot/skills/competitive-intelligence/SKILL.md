---
context: forked
name: competitive-intelligence
description: "Conducts competitive analysis and market intelligence for positioning, differentiation, and strategic advantage using SWOT analysis and competitor monitoring frameworks. Use when user asks about competitor analysis, competitive intelligence, SWOT, differentiation, market positioning, benchmark, 경쟁 분석, 시장 정보, or 포지셔닝."
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "competitive"
  - "competitor"
  - "market analysis"
  - "competitive intelligence"
  - "landscape"
agents:
  - "code-reviewer"
  - "architect"
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

## Output Template

```
COMPETITIVE INTELLIGENCE REPORT
================================
Date:     [YYYY-MM-DD]
Market:   [target market/segment]
Scope:    [# competitors analyzed]

COMPETITOR PROFILES (Top 5)
───────────────────────────
[1] [Competitor Name]
    Category:     [direct | indirect | emerging]
    Positioning:  [1-line positioning statement]
    Strengths:    [key strength 1], [key strength 2]
    Weaknesses:   [key weakness 1], [key weakness 2]
    Recent Moves: [notable recent action]
    Threat Level: [LOW | MEDIUM | HIGH | CRITICAL]

[2-5] [repeat structure]

QUICK COMPARISON MATRIX
───────────────────────
Feature/Capability | Us | Comp1 | Comp2 | Comp3 | Comp4 | Comp5
───────────────────|────|───────|───────|───────|───────|──────
[feature 1]        | ●  | ●     | ○     | ●     | ○     | ○
[feature 2]        | ○  | ●     | ●     | ○     | ●     | ○
Legend: ● = strong, ◐ = partial, ○ = absent

DIFFERENTIATION MAP
───────────────────
Our Unique Strengths:
  [1] [strength]: [why competitors cannot easily replicate]
  [2] ...

Competitive Gaps (we lag):
  [1] [gap]: [competitor leading] -> Effort to close: [LOW|MEDIUM|HIGH]
  [2] ...

LANDMINES TO PLANT
──────────────────
[1] [strategic action]: [makes our strength their weakness]
[2] ...

RECOMMENDATIONS
───────────────
Priority | Action                    | Effort | Impact | Timeline
---------|---------------------------|--------|--------|----------
P1       | [action]                  | [L/M/H]| [L/M/H]| [timeframe]
P2       | [action]                  | [L/M/H]| [L/M/H]| [timeframe]
```

## Quick Reference

**Frameworks**: SWOT, Porter's Five Forces, Positioning Maps, Feature Matrix
**Data Sources**: G2, Capterra, Crunchbase, SimilarWeb, LinkedIn, Ahrefs
**Competitor Tiers**: Direct, Indirect, Aspirational, Emerging

---

## References

- See `${CLAUDE_SKILL_DIR}/references/competitor-analysis-framework.md` for competitor analysis framework
- See `${CLAUDE_SKILL_DIR}/references/feature-comparison-matrix.md` for feature comparison matrix
