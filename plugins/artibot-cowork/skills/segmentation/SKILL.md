---
context: fork
name: segmentation
description: "Develops audience segmentation strategies with lead scoring models, behavioral triggers, persona development, and RFM analysis across demographic, firmographic, and psychographic dimensions. Use when user asks about segmentation, audience segment, lead scoring, persona, behavioral targeting, cohort, RFM, 세그먼테이션, 타겟팅, 리드 스코어링, or 페르소나."
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "segmentation"
  - "audience segmentation"
  - "user segment"
  - "cohort"
  - "customer segment"
agents:
  - "data-analyst"
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

## Output Template

```
SEGMENTATION STRATEGY
=====================
Approach:   [segmentation dimensions used]
Segments:   [count]
Data Source: [sources used]
Method:     [RFM | Behavioral | Hybrid]

SEGMENT PROFILES
────────────────
SEGMENT [1]: [Name]
  Size:        [estimated count / %]
  RFM Score:   [R/F/M values, if applicable]
  Criteria:    [defining rules]
  Profile:     [key characteristics]

  JTBD (Jobs to Be Done):
    Primary:   [main job this segment hires the product for]
    Secondary: [secondary job]

  Sentiment:   [score -1.0 to +1.0] | [POSITIVE | NEUTRAL | NEGATIVE]
  Pain Points: [top frustrations]

  Strategy:    [engagement approach]
  Channels:    [preferred channels]
  KPIs:        [tracking metrics]

[repeat for each segment]

LEAD SCORING MODEL (if applicable)
───────────────────────────────────
Category     | Signal         | Points
─────────────|───────────────|────────
Demographic  | [signal]      | [+/- points]
Behavioral   | [signal]      | [+/- points]
Engagement   | [signal]      | [+/- points]
Negative     | [signal]      | [+/- points]

Thresholds:
  Cold (0-30) -> Nurture | MQL (31-50) -> Marketing | SQL (51-80) -> Sales | Ready (81-100) -> Immediate

SEGMENT COMPARISON MATRIX
─────────────────────────
Dimension    | Seg 1  | Seg 2  | Seg 3  | Seg 4
─────────────|────────|────────|────────|───────
Size         | [val]  | [val]  | [val]  | [val]
Sentiment    | [val]  | [val]  | [val]  | [val]
LTV          | [val]  | [val]  | [val]  | [val]
Conversion   | [val]  | [val]  | [val]  | [val]
Churn Risk   | [val]  | [val]  | [val]  | [val]

RECOMMENDATIONS
───────────────
Priority | Segment    | Action              | Expected Impact
---------|-----------|---------------------|----------------
P1       | [segment] | [action]            | [impact]
```

## Quick Reference

**Dimensions**: Demographic, Firmographic, Behavioral, Psychographic, Technographic, Intent
**RFM Model**: Recency x Frequency x Monetary (1-5 each)
**Lead Score**: Demographic (25%) + Behavioral (40%) + Engagement (20%) + Negative (15%)
**Validation**: Size, Measurable, Accessible, Differentiable, Actionable

---

## References

- See `${CLAUDE_SKILL_DIR}/references/segmentation-dimensions.md` for segmentation dimensions
- See `${CLAUDE_SKILL_DIR}/references/segment-activation-matrix.md` for segment activation matrix
