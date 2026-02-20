---
description: CRM workflow design, customer journey mapping, segmentation strategy, and lifecycle automation
argument-hint: '[type] e.g. "고객 여정맵 설계"'
allowed-tools: [Read, Write, Task, WebSearch, TaskCreate]
---

# /crm

Designs CRM workflows, customer journey maps, segmentation strategies, and lifecycle automation sequences. Focuses on lead scoring, pipeline optimization, and customer retention strategies.

## Arguments

Parse $ARGUMENTS:
- `workflow-type`: Workflow type - `journey-map` | `lead-scoring` | `pipeline` | `segmentation` | `retention` | `onboarding` | `upsell`
- `--stage [lifecycle]`: Lifecycle stage focus - `awareness` | `consideration` | `decision` | `onboarding` | `retention` | `advocacy` | `all`
- `--segment [criteria]`: Segment criteria - `demographic` | `behavioral` | `firmographic` | `technographic`
- `--automation`: Generate automation workflows with triggers
- `--personas [n]`: Number of customer personas to create (default: 3)
- `--scoring`: Include lead scoring model design

## Workflow Types

| Type | Purpose | Key Output |
|------|---------|------------|
| journey-map | End-to-end customer journey | Touchpoint map with emotions/metrics |
| lead-scoring | Score model for MQL/SQL handoff | Scoring rubric with thresholds |
| pipeline | Sales pipeline optimization | Stage definitions with conversion targets |
| segmentation | Audience segmentation strategy | Segment definitions with strategies |
| retention | Churn prevention workflows | Retention campaigns with triggers |
| onboarding | New customer activation | Onboarding sequence with milestones |
| upsell | Expansion revenue strategy | Upsell triggers with offer mapping |

## Agent Delegation

- Primary: `marketing-strategist` - CRM strategy and journey design
- Supporting: `data-analyst` - Segmentation and scoring models

## Skills Required

- `customer-journey` - Journey mapping, touchpoint analysis, lifecycle stages
- `segmentation` - Audience segmentation, lead scoring, behavioral triggers
- `campaign-planning` - Automation design, workflow architecture

## Execution Flow

1. **Parse**: Extract workflow type, lifecycle stage, segmentation criteria
2. **Research**: Industry CRM benchmarks, conversion rates, lifecycle patterns
3. **Map**: Design customer journey:
   - Stages with entry/exit criteria
   - Touchpoints per stage (email, in-app, sales, support)
   - Emotions and pain points per stage
   - Key metrics per stage
4. **Segment**: Define audience segments:
   - Segmentation criteria and rules
   - Persona profiles
   - Behavioral triggers
5. **Score** (if `--scoring`): Design lead scoring model:
   - Demographic scoring (title, company size, industry)
   - Behavioral scoring (page views, email opens, demo requests)
   - Engagement scoring (frequency, recency, depth)
   - Score thresholds for MQL/SQL handoff
6. **Automate** (if `--automation`): Design CRM workflows:
   - Trigger events -> Actions -> Conditions -> Branches
   - Notification rules for sales team
   - Escalation paths
7. **Report**: Output CRM strategy document

## Output Format

```
CRM STRATEGY
============
Type:       [workflow-type]
Stage:      [lifecycle focus]
Segments:   [count]
Personas:   [count]

CUSTOMER JOURNEY MAP
--------------------
Stage           | Touchpoints      | Metrics          | Goal
----------------|------------------|------------------|------------------
[Awareness]     | [blog, ads, SEO] | [traffic, CTR]   | [capture interest]
[Consideration] | [email, webinar] | [engagement, MQL]| [build trust]
[Decision]      | [demo, trial]    | [SQL, conversion]| [close deal]
[Onboarding]    | [email, in-app]  | [activation]     | [time-to-value]
[Retention]     | [support, email] | [NPS, churn]     | [reduce churn]
[Advocacy]      | [referral, case] | [NPS, referrals] | [drive referrals]

LEAD SCORING MODEL (if --scoring)
----------------------------------
Category     | Signal              | Points | Threshold
-------------|---------------------|--------|----------
Demographic  | [title = VP+]       | +15    |
Behavioral   | [viewed pricing]    | +20    | MQL = 50pts
Engagement   | [3+ sessions/week]  | +10    | SQL = 80pts

AUTOMATION WORKFLOWS (if --automation)
--------------------------------------
Workflow: [name]
  Trigger: [event/condition]
  -> Action: [send email / assign task / update field]
  -> Wait: [delay]
  -> Condition: [if/then branch]
    -> Yes: [action]
    -> No: [action]

SEGMENTS
--------
Segment: [name]
  Criteria: [rules]
  Size: [estimated %]
  Strategy: [engagement approach]
```

## Example Usage

```
/crm journey-map --stage all --personas 4 --automation
/crm lead-scoring --scoring --segment behavioral,firmographic
/crm retention --stage retention --automation --segment behavioral
/crm pipeline --stage consideration,decision --scoring
/crm onboarding --automation --stage onboarding --personas 2
```
