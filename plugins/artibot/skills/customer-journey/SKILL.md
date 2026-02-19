---
name: customer-journey
description: |
  Customer journey mapping, touchpoint analysis, lifecycle stage management, and experience optimization.
  Provides frameworks for mapping customer journeys from awareness through advocacy.
  Auto-activates when: customer journey mapping, touchpoint analysis, lifecycle management, experience optimization.
  Triggers: customer journey, journey map, touchpoint, lifecycle, customer experience, onboarding, retention, advocacy, CX, 고객 여정, 터치포인트, 라이프사이클
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "customer journey"
  - "user journey"
  - "touchpoint"
  - "customer experience"
  - "journey map"
agents:
  - "persona-architect"
  - "persona-frontend"
tokens: "~4K"
category: "marketing"
---

# Customer Journey

## When This Skill Applies
- Mapping end-to-end customer journeys
- Identifying touchpoints and moments of truth
- Designing lifecycle stage transitions and triggers
- Optimizing customer experience at each stage
- Building journey-based automation workflows

## Core Guidance

### 1. Journey Mapping Process
```
Define Personas -> Map Stages -> Identify Touchpoints -> Capture Emotions -> Measure Metrics -> Find Gaps -> Design Improvements -> Validate
```

### 2. Lifecycle Stages

| Stage | Goal | Entry Criteria | Exit Criteria |
|-------|------|---------------|---------------|
| Awareness | Capture attention | First interaction | Engagement signal |
| Consideration | Build trust | Content engagement | Intent signal |
| Decision | Convert | Demo/trial/pricing | Purchase/signup |
| Onboarding | Activate | Account created | First value achieved |
| Adoption | Deepen usage | Core feature used | Regular usage pattern |
| Retention | Maintain | Active user | Renewal/continued use |
| Expansion | Grow | Engaged user | Upsell/cross-sell |
| Advocacy | Amplify | Satisfied user | Referral/review |

### 3. Journey Map Template

```
STAGE: [Stage Name]
--------------------
Goal:        [What customer is trying to achieve]
Touchpoints: [Channels and interactions]
  - [touchpoint 1]: [description]
  - [touchpoint 2]: [description]
Actions:     [What customer does]
Thoughts:    [What customer is thinking]
Emotions:    [How customer feels] (scale: frustrated -> neutral -> delighted)
Pain Points: [Friction or frustration]
Opportunities: [Improvement areas]
Metrics:     [KPIs for this stage]
  - [metric 1]: [target]
  - [metric 2]: [target]
```

### 4. Touchpoint Categories

| Category | Channels | Owned/Earned/Paid |
|----------|----------|-------------------|
| Digital | Website, app, email, social | Owned |
| Content | Blog, video, podcast, webinar | Owned |
| Advertising | Search ads, display, social ads | Paid |
| Social Proof | Reviews, testimonials, case studies | Earned |
| Sales | Demo, call, proposal, negotiation | Owned |
| Support | Help center, chat, tickets, phone | Owned |
| Product | In-app experience, notifications | Owned |
| Community | Forums, events, user groups | Earned/Owned |

### 5. Moments of Truth

| Moment | Stage | Description | Impact |
|--------|-------|-------------|--------|
| First Impression | Awareness | Initial brand/product encounter | Sets expectations |
| Aha Moment | Onboarding | First experience of core value | Activation predictor |
| Habit Moment | Adoption | Usage becomes routine | Retention predictor |
| Pain Moment | Any | Friction, error, or frustration | Churn risk |
| Delight Moment | Any | Exceeds expectations | Advocacy trigger |

### 6. Journey Metrics by Stage

| Stage | Primary Metric | Secondary Metrics |
|-------|---------------|-------------------|
| Awareness | Reach, traffic | Impressions, brand search volume |
| Consideration | Engagement, MQLs | Time on site, content downloads |
| Decision | Conversion rate, SQLs | Demo requests, trial starts |
| Onboarding | Activation rate | Time-to-value, setup completion |
| Adoption | Feature adoption | DAU/MAU ratio, session depth |
| Retention | Churn rate, NPS | Support tickets, renewal rate |
| Expansion | Expansion revenue | Upsell rate, cross-sell rate |
| Advocacy | Referral rate | NPS, reviews posted, case studies |

### 7. Journey-Based Automation

| Trigger | Stage | Automated Action |
|---------|-------|-----------------|
| First website visit | Awareness | Cookie + retargeting pixel |
| Content download | Consideration | Nurture email sequence |
| Pricing page visit | Decision | Sales notification + email |
| Account creation | Onboarding | Welcome sequence + setup guide |
| 7 days inactive | Adoption | Re-engagement email |
| Support ticket | Retention | Follow-up satisfaction survey |
| High NPS score | Advocacy | Referral program invitation |
| Usage milestone | Expansion | Upsell recommendation |

### 8. Journey Optimization Framework

| Step | Action | Output |
|------|--------|--------|
| Audit | Map current journey with data | As-is journey map |
| Identify | Find pain points and drop-offs | Problem inventory |
| Prioritize | Score by impact x effort | Priority matrix |
| Design | Create improved experience | To-be journey map |
| Test | A/B test improvements | Test results |
| Measure | Track journey metrics | Performance data |
| Iterate | Continuous improvement | Updated journey |

## Output Format
```
CUSTOMER JOURNEY MAP
====================
Persona:    [customer persona]
Stages:     [count]
Touchpoints:[total count]

JOURNEY
-------
[Stage]: [Stage Name]
  Goal:        [customer goal]
  Touchpoints: [channel list]
  Actions:     [customer actions]
  Emotions:    [emotional state]
  Pain Points: [friction areas]
  Metrics:     [KPIs + targets]
  Automation:  [triggered actions]

GAPS & OPPORTUNITIES
--------------------
Priority | Stage       | Gap              | Recommendation
---------|-------------|------------------|----------------
P1       | [stage]     | [pain point]     | [improvement]
```

## Quick Reference

**Stages**: Awareness, Consideration, Decision, Onboarding, Adoption, Retention, Expansion, Advocacy
**Moments of Truth**: First Impression, Aha Moment, Habit Moment, Pain Moment, Delight Moment
**Journey Metrics**: Stage-specific KPIs from reach to referral rate

See `references/journey-templates.md` for industry-specific journey map templates.
See `references/automation-triggers.md` for journey-based automation patterns.
