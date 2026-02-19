---
name: segmentation
description: |
  Audience segmentation strategies, lead scoring models, behavioral triggers, and persona development.
  Covers demographic, firmographic, behavioral, and psychographic segmentation approaches.
  Auto-activates when: audience segmentation, lead scoring, persona creation, behavioral targeting, customer grouping.
  Triggers: segmentation, audience segment, lead scoring, persona, behavioral trigger, targeting, customer group, cohort, RFM, 세그먼테이션, 타겟팅, 리드 스코어링, 페르소나
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "segmentation"
  - "audience segmentation"
  - "user segment"
  - "cohort"
  - "customer segment"
agents:
  - "persona-analyzer"
tokens: "~3K"
category: "marketing"
---

# Segmentation

## When This Skill Applies
- Defining audience segments for campaigns
- Building lead scoring models
- Creating customer personas from data
- Designing behavioral trigger rules
- Planning personalization strategies

## Core Guidance

### 1. Segmentation Process
```
Define Objectives -> Collect Data -> Choose Dimensions -> Create Segments -> Validate Segments -> Profile Segments -> Activate -> Monitor
```

### 2. Segmentation Dimensions

| Dimension | Criteria | Data Sources |
|-----------|----------|-------------|
| Demographic | Age, gender, income, education, role | CRM, forms, surveys |
| Firmographic | Company size, industry, revenue, location | CRM, enrichment tools |
| Behavioral | Purchase history, engagement, feature usage | Analytics, product data |
| Psychographic | Values, interests, pain points, motivations | Surveys, interviews |
| Technographic | Tech stack, tools used, platforms | Enrichment, surveys |
| Intent | Search behavior, content consumed, buying signals | Analytics, ads |

### 3. RFM Segmentation Model

| Metric | Definition | Scoring (1-5) |
|--------|-----------|---------------|
| Recency | Time since last interaction | Recent = 5, Old = 1 |
| Frequency | Number of interactions/purchases | High = 5, Low = 1 |
| Monetary | Total spend or engagement value | High = 5, Low = 1 |

**RFM Segment Examples**:
| RFM Score | Segment Name | Strategy |
|-----------|-------------|----------|
| 555 | Champions | Reward, loyalty program |
| 5X1-2 | Recent but Low Value | Upsell, education |
| 1X5 | At Risk (High Value) | Win-back campaign |
| 111 | Lost | Re-engagement or archive |
| 3-4, 3-4, 3-4 | Core Customers | Maintain, nurture |

### 4. Lead Scoring Model

#### Scoring Categories
| Category | Weight | Signal | Points |
|----------|--------|--------|--------|
| Demographic | 25% | Title = VP+ | +15 |
| | | Company size 50-500 | +10 |
| | | Target industry | +10 |
| Behavioral | 40% | Pricing page visit | +20 |
| | | Demo request | +30 |
| | | Content download | +5 |
| | | Email open (3+ times) | +10 |
| Engagement | 20% | 3+ sessions/week | +10 |
| | | Webinar attendance | +15 |
| | | Social interaction | +5 |
| Negative | 15% | Unsubscribed | -20 |
| | | Competitor employee | -30 |
| | | 30+ days inactive | -15 |

#### Score Thresholds
| Range | Classification | Action |
|-------|---------------|--------|
| 0-30 | Cold Lead | Nurture sequence |
| 31-50 | Warm Lead | MQL - marketing nurture |
| 51-80 | Hot Lead | SQL - sales outreach |
| 81-100 | Sales Ready | Immediate sales contact |

### 5. Persona Template

```
PERSONA: [Name]
================
Demographics:
  Role:     [job title]
  Company:  [size, industry]
  Age:      [range]
  Location: [geography]

Goals:
  - [Primary goal]
  - [Secondary goal]

Pain Points:
  - [Primary frustration]
  - [Secondary frustration]

Behavior:
  Channels:  [preferred channels]
  Content:   [preferred content types]
  Decision:  [buying process description]
  Triggers:  [what prompts action]

Messaging:
  Value Prop: [what resonates]
  Tone:      [preferred communication style]
  Objections:[common concerns]
```

### 6. Segment Activation

| Segment | Channel Strategy | Content Strategy | Offer Strategy |
|---------|-----------------|-----------------|----------------|
| New visitors | Display, social ads | Educational content | Free trial/demo |
| Active users | Email, in-app | Feature education | Upsell |
| At-risk | Email, retargeting | Value reinforcement | Retention offer |
| Champions | Email, community | Exclusive content | Referral program |
| Enterprise | Sales, events | Case studies | Custom pricing |

### 7. Segment Validation Criteria

| Criterion | Minimum Threshold | Ideal |
|-----------|------------------|-------|
| Size | Statistically significant | 1000+ per segment |
| Measurable | Can track and quantify | Real-time metrics |
| Accessible | Can reach through channels | Multi-channel reach |
| Differentiable | Distinct from other segments | Clear boundaries |
| Actionable | Can take specific action | Unique strategy per segment |

## Output Format
```
SEGMENTATION STRATEGY
=====================
Approach:   [segmentation dimensions]
Segments:   [count]
Data Source: [sources used]

SEGMENTS
--------
Segment: [name]
  Size:     [estimated count / %]
  Criteria: [defining rules]
  Profile:  [key characteristics]
  Strategy: [engagement approach]
  KPIs:     [tracking metrics]

LEAD SCORING (if applicable)
-----------------------------
Category     | Signal         | Points
-------------|---------------|--------
[category]   | [signal]      | [+/- points]

Thresholds:
  Cold:        [0-X]
  MQL:         [X-Y]
  SQL:         [Y-Z]
  Sales Ready: [Z-100]
```

## Quick Reference

**Dimensions**: Demographic, Firmographic, Behavioral, Psychographic, Technographic, Intent
**RFM Model**: Recency x Frequency x Monetary (1-5 each)
**Lead Score**: Demographic (25%) + Behavioral (40%) + Engagement (20%) + Negative (15%)
**Validation**: Size, Measurable, Accessible, Differentiable, Actionable

See `references/scoring-models.md` for lead scoring model templates.
See `references/persona-templates.md` for industry-specific persona examples.
