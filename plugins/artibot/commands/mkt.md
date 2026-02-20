---
description: Marketing strategy planning with market analysis, competitive intelligence, and campaign architecture
argument-hint: '[topic] e.g. "GTM 전략 수립"'
allowed-tools: [Read, Write, Glob, Grep, Task, WebSearch, TodoWrite]
---

# /mkt

End-to-end marketing strategy command. Analyzes market conditions, competitive landscape, and audience segments to produce actionable marketing plans with budget allocation and channel strategy.

## Arguments

Parse $ARGUMENTS:
- `strategy-type`: Type of strategy - `go-to-market` | `content` | `growth` | `brand` | `product-launch` | `repositioning`
- `--market [segment]`: Target market segment or industry vertical
- `--competitor [names]`: Competitor names for comparative analysis (comma-separated)
- `--campaign [name]`: Campaign context for strategy alignment
- `--budget [range]`: Budget tier - `bootstrap` (<$5K) | `growth` ($5K-$50K) | `scale` ($50K-$500K) | `enterprise` ($500K+)
- `--channels`: Include channel strategy and allocation recommendations
- `--timeline [period]`: Strategy timeline - `quarterly` | `half-year` | `annual`

## Strategy Types

| Type | Focus | Output |
|------|-------|--------|
| go-to-market | Market entry, positioning, launch | GTM plan with channel strategy |
| content | Content-led growth, editorial calendar | Content strategy with topic map |
| growth | Growth loops, acquisition, retention | Growth model with experiment backlog |
| brand | Brand positioning, messaging, identity | Brand guidelines with messaging matrix |
| product-launch | Launch sequence, PR, demand gen | Launch playbook with timeline |
| repositioning | Market pivot, new segment targeting | Repositioning roadmap |

## Agent Delegation

- Primary: `marketing-strategist` - Strategy formulation and market analysis
- Supporting: `content-marketer` - Content strategy alignment
- Supporting: `data-analyst` - Market data analysis and forecasting

## Skills Required

- `marketing-strategy` - Market analysis frameworks, positioning, segmentation
- `competitive-intelligence` - Competitor analysis, SWOT, differentiation
- `campaign-planning` - Campaign architecture, funnel design, budget allocation

## Execution Flow

1. **Parse**: Extract strategy type, market context, constraints, and budget parameters
2. **Research**: Use WebSearch for:
   - Market size and growth trends
   - Competitor positioning and messaging
   - Industry benchmarks and best practices
   - Channel performance data
3. **Analyze**: Delegate to Task(marketing-strategist) for:
   - SWOT analysis of current position
   - Target audience segmentation and personas
   - Competitive differentiation mapping
   - Channel-market fit assessment
4. **Strategize**: Build marketing plan:
   - Positioning statement and value propositions
   - Channel strategy with budget allocation
   - Campaign calendar with milestones
   - KPI framework with targets
5. **Validate**: Cross-reference strategy against budget constraints and timeline
6. **Report**: Output structured strategy document

## Output Format

```
MARKETING STRATEGY
==================
Type:       [go-to-market|content|growth|brand|product-launch|repositioning]
Market:     [target segment]
Budget:     [tier and allocation]
Timeline:   [period]

MARKET ANALYSIS
---------------
Market Size:   [TAM/SAM/SOM]
Growth Rate:   [YoY%]
Key Trends:    [trend list]

COMPETITIVE LANDSCAPE
---------------------
[Competitor]: [positioning] | [strengths] | [weaknesses]

STRATEGY
--------
Positioning: [statement]
Value Props:  [1-3 key value propositions]

CHANNEL PLAN
------------
Channel       | Budget % | Expected ROI | Priority
--------------|----------|-------------|----------
[channel]     | [%]      | [ROI]       | [P1-P3]

CAMPAIGN CALENDAR
-----------------
[Month]: [campaign/initiative] -> [channel] -> [KPI target]

KPI FRAMEWORK
-------------
Metric:    [KPI]  | Target: [value] | Tracking: [method]
```

## Example Usage

```
/mkt go-to-market --market "B2B SaaS" --competitor "Notion,Coda,Airtable" --budget growth --timeline quarterly
/mkt content --channels --market "developer tools"
/mkt growth --budget bootstrap --timeline half-year
/mkt brand --market "enterprise HR" --competitor "Workday,BambooHR"
```
