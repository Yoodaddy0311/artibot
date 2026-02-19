---
name: marketing-strategy
description: |
  Marketing strategy frameworks for market analysis, positioning, segmentation, and go-to-market planning.
  Provides structured approaches to TAM/SAM/SOM analysis, Porter's Five Forces, and channel strategy.
  Auto-activates when: marketing strategy planning, market analysis, go-to-market design, growth planning.
  Triggers: marketing strategy, market analysis, go-to-market, GTM, positioning, segmentation, growth strategy, value proposition, channel strategy, 마케팅 전략, 시장 분석, GTM 전략
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "marketing strategy"
  - "go-to-market"
  - "GTM"
  - "market positioning"
  - "growth strategy"
agents:
  - "persona-architect"
tokens: "~4K"
category: "marketing"
---

# Marketing Strategy

## When This Skill Applies
- Creating or refining marketing strategies and go-to-market plans
- Market sizing and opportunity analysis (TAM/SAM/SOM)
- Positioning and value proposition development
- Channel strategy and budget allocation planning
- Growth strategy and scaling roadmaps

## Core Guidance

### 1. Strategy Development Process
```
Market Research -> Audience Analysis -> Positioning -> Channel Strategy -> Budget Allocation -> KPI Framework -> Execution Plan
```

### 2. Market Analysis Frameworks

#### TAM/SAM/SOM Sizing
| Level | Definition | Method |
|-------|-----------|--------|
| TAM | Total Addressable Market | Industry reports, top-down |
| SAM | Serviceable Available Market | Geographic + segment filters |
| SOM | Serviceable Obtainable Market | Realistic capture rate |

#### Porter's Five Forces
Assess competitive dynamics:
- Threat of new entrants
- Bargaining power of suppliers
- Bargaining power of buyers
- Threat of substitutes
- Competitive rivalry intensity

### 3. Positioning Framework

**Positioning Statement Template**:
```
For [target audience] who [need/pain point],
[product/brand] is a [category]
that [key benefit/differentiator].
Unlike [competitor/alternative],
we [unique value proposition].
```

**Positioning Axes**:
- Price vs. quality
- Simplicity vs. feature-richness
- General vs. specialized
- Self-serve vs. high-touch

### 4. Audience Segmentation

| Dimension | Criteria | Example |
|-----------|----------|---------|
| Demographic | Age, role, company size | "VP+ at 100-500 employee SaaS" |
| Firmographic | Industry, revenue, geography | "Series A-C fintech in NA" |
| Behavioral | Usage patterns, engagement | "Active trial users, >3 logins/week" |
| Psychographic | Values, pain points, goals | "Growth-focused, data-driven CMOs" |

### 5. Channel Strategy Matrix

| Channel | Best For | Cost Model | Time to Results |
|---------|---------|------------|-----------------|
| Content/SEO | Awareness, authority | Low variable | 3-6 months |
| Paid Search | Intent capture | CPC | Immediate |
| Social Paid | Awareness, retargeting | CPM/CPC | 1-4 weeks |
| Email | Nurturing, retention | Low fixed | 2-4 weeks |
| Partnerships | Distribution | Revenue share | 1-3 months |
| Events | Relationships, brand | High fixed | Variable |

### 6. Budget Allocation Guidelines

| Budget Tier | Allocation Strategy |
|-------------|-------------------|
| Bootstrap (<$5K/mo) | 70% content/SEO, 20% social, 10% email |
| Growth ($5K-$50K/mo) | 40% paid, 30% content, 20% email, 10% partnerships |
| Scale ($50K-$500K/mo) | 35% paid, 25% content, 15% email, 15% events, 10% partnerships |
| Enterprise ($500K+/mo) | Diversified across all channels with attribution-based optimization |

### 7. KPI Framework

| Stage | Primary KPIs | Secondary KPIs |
|-------|-------------|----------------|
| Awareness | Traffic, impressions, reach | Brand search volume, share of voice |
| Consideration | MQLs, engagement rate, time on site | Content downloads, webinar signups |
| Decision | SQLs, demo requests, trial signups | Win rate, sales cycle length |
| Retention | NPS, churn rate, expansion revenue | Feature adoption, support tickets |

## Output Format
```
MARKETING STRATEGY
==================
Type:       [strategy type]
Market:     [target segment]
Budget:     [tier and allocation]
Timeline:   [period]

MARKET ANALYSIS
---------------
Market Size:   [TAM/SAM/SOM]
Growth Rate:   [YoY%]
Key Trends:    [trend list]

POSITIONING
-----------
Statement:  [positioning statement]
Differentiators: [1-3 key differentiators]

CHANNEL PLAN
------------
Channel       | Budget % | Expected ROI | Priority
--------------|----------|-------------|----------
[channel]     | [%]      | [ROI]       | [P1-P3]

KPI FRAMEWORK
-------------
Metric:    [KPI]  | Target: [value] | Tracking: [method]
```

## Quick Reference

**Frameworks**: TAM/SAM/SOM, Porter's Five Forces, SWOT, Value Proposition Canvas
**Strategy Types**: go-to-market, content, growth, brand, product-launch, repositioning
**Budget Tiers**: bootstrap (<$5K), growth ($5K-$50K), scale ($50K-$500K), enterprise ($500K+)

See `references/strategy-frameworks.md` for detailed framework templates.
See `references/channel-playbooks.md` for channel-specific execution guides.
