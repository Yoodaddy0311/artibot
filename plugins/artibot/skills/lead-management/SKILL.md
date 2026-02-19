---
name: lead-management
description: |
  Lead lifecycle management including lead scoring, qualification, nurture sequences, and CRM workflow design.
  Covers MQL/SQL handoff, lead routing, pipeline optimization, and lead-to-customer conversion.
  Auto-activates when: lead management, lead scoring, lead qualification, nurture workflows, MQL/SQL process.
  Triggers: lead management, lead scoring, lead qualification, MQL, SQL, lead nurture, pipeline, lead routing, CRM workflow, lead lifecycle, 리드 관리, 리드 스코어링, 리드 육성
level: 3
triggers:
  - "lead"
  - "lead generation"
  - "lead scoring"
  - "CRM"
  - "pipeline"
  - "prospect"
  - "lead nurture"
agents:
  - "persona-backend"
  - "persona-analyzer"
tokens: "~4K"
category: "marketing"
---

# Lead Management

## When This Skill Applies
- Designing lead scoring and qualification models
- Building lead nurture workflows and automation
- Defining MQL/SQL criteria and handoff processes
- Optimizing lead-to-customer conversion pipelines
- Planning lead routing and assignment rules

## Core Guidance

### 1. Lead Management Process
```
Capture -> Score -> Qualify -> Route -> Nurture -> Handoff -> Follow-up -> Convert -> Analyze
```

### 2. Lead Lifecycle Stages

| Stage | Definition | Owner | Actions |
|-------|-----------|-------|---------|
| Raw Lead | Form fill, contact info only | Marketing | Data enrichment, initial scoring |
| MQL | Meets marketing criteria | Marketing | Nurture sequence, content delivery |
| SAL | Sales accepted, agrees to work | Sales (BDR) | Initial outreach, qualification |
| SQL | Sales qualified, ready for pipeline | Sales (AE) | Discovery call, needs assessment |
| Opportunity | Active deal in pipeline | Sales (AE) | Demo, proposal, negotiation |
| Customer | Closed-won | CS/Account | Onboarding, expansion |

### 3. Lead Scoring Model

#### Explicit Score (Fit)
| Factor | Signal | Points |
|--------|--------|--------|
| Title | C-level | +25 |
| | VP/Director | +20 |
| | Manager | +10 |
| | Individual contributor | +5 |
| Company Size | 500+ employees | +20 |
| | 100-499 | +15 |
| | 20-99 | +10 |
| | <20 | +5 |
| Industry | Target industry | +15 |
| | Adjacent industry | +10 |
| Geography | Primary market | +10 |

#### Implicit Score (Engagement)
| Factor | Signal | Points |
|--------|--------|--------|
| Web | Pricing page view | +20 |
| | Product page view | +10 |
| | Blog post view | +3 |
| | 3+ pages/session | +5 |
| Email | Email open | +2 |
| | Email click | +5 |
| | Unsubscribe | -20 |
| Content | Whitepaper download | +10 |
| | Webinar registration | +15 |
| | Webinar attendance | +20 |
| | Case study download | +15 |
| Direct | Demo request | +30 |
| | Contact form | +25 |
| | Free trial signup | +25 |
| Negative | 30+ days inactive | -15 |
| | Competitor email domain | -30 |
| | Student/free email | -10 |

#### Score Thresholds
| Score Range | Stage | Action |
|-------------|-------|--------|
| 0-20 | Cold | Awareness content, retargeting |
| 21-40 | Warm | Nurture sequence |
| 41-60 | MQL | Marketing nurture + BDR notification |
| 61-80 | SAL | BDR outreach within 24h |
| 81-100 | SQL | AE engagement, demo scheduling |

### 4. Lead Routing Rules

| Rule Type | Logic | Example |
|-----------|-------|---------|
| Round-robin | Distribute evenly | New leads alternate between BDRs |
| Territory | Geographic assignment | APAC leads -> APAC team |
| Account-based | Existing accounts | Lead from existing account -> assigned AE |
| Size-based | Company size routing | Enterprise -> dedicated AE |
| Score-based | Priority routing | Score >80 -> senior AE |
| Specialty | Product/industry match | Fintech leads -> fintech specialist |

**SLA**: Respond to MQLs within 5 minutes (conversion drops 80% after 5 min).

### 5. Nurture Sequence Design

| Sequence | Target | Duration | Emails | Goal |
|----------|--------|----------|--------|------|
| New Lead | Raw leads | 2-3 weeks | 4-5 | Qualify to MQL |
| MQL Nurture | MQLs | 3-4 weeks | 5-7 | Move to SAL |
| Re-engagement | Stale leads | 2 weeks | 3 | Reactivate or archive |
| Post-demo | Post-demo leads | 1-2 weeks | 3-4 | Close decision |
| Lost deal | Lost opportunities | 2-3 months | 4-6 | Re-enter pipeline |

### 6. MQL-to-SQL Handoff Process

```
1. Marketing scores lead to MQL threshold
2. Automated notification to assigned BDR
3. BDR reviews lead within SLA (<5 min for hot, <1 hour for warm)
4. BDR performs qualification call (BANT/MEDDIC)
5. Qualified -> Convert to SQL, assign to AE
   Not qualified -> Return to marketing with reason code
6. AE accepts SQL within 24h
7. AE conducts discovery, moves to Opportunity
```

**BANT Qualification**:
- **Budget**: Can they afford the solution?
- **Authority**: Is this the decision maker?
- **Need**: Do they have a real pain point?
- **Timeline**: When do they need to solve this?

### 7. Pipeline Metrics

| Metric | Formula | Good Benchmark |
|--------|---------|---------------|
| MQL-to-SQL Rate | SQLs / MQLs * 100 | 15-25% |
| SQL-to-Opp Rate | Opps / SQLs * 100 | 30-50% |
| Win Rate | Closed-Won / Total Opps * 100 | 20-30% |
| Sales Cycle | Avg days from SQL to close | 30-90 days (B2B) |
| Pipeline Velocity | (Opps * Win% * ACV) / Cycle Days | Higher = better |
| Lead Response Time | Time from MQL to first contact | <5 min ideal |

### 8. Lead Data Hygiene

| Task | Frequency | Impact |
|------|-----------|--------|
| Deduplication | Weekly | Prevents double outreach |
| Enrichment | On capture | Better scoring, routing |
| Decay scoring | Monthly | Reflects engagement freshness |
| Archive inactive | Quarterly | Clean database, lower costs |
| Validation | On capture | Valid email, phone |
| Merge accounts | Monthly | Unified view per company |

## Output Format
```
LEAD MANAGEMENT STRATEGY
=========================
Pipeline:   [stages defined]
Scoring:    [model type]
Routing:    [assignment method]

SCORING MODEL
-------------
Category     | Signal              | Points
-------------|---------------------|--------
[category]   | [signal]            | [+/- pts]

Thresholds:
  Cold:  [0-X]    -> [action]
  MQL:   [X-Y]    -> [action]
  SAL:   [Y-Z]    -> [action]
  SQL:   [Z-100]  -> [action]

ROUTING RULES
-------------
Rule         | Criteria            | Assignment
-------------|---------------------|------------
[rule]       | [condition]         | [team/person]

NURTURE SEQUENCES
-----------------
Sequence: [name]
  Target: [audience]
  Duration: [timeframe]
  Emails: [count]
  Goal: [objective]

HANDOFF PROCESS
---------------
[Step-by-step MQL-to-SQL process]

PIPELINE METRICS
----------------
Metric              | Target  | Current
--------------------|---------|--------
[metric]            | [value] | [value]
```

## Quick Reference

**Lifecycle**: Raw Lead -> MQL -> SAL -> SQL -> Opportunity -> Customer
**Scoring**: Explicit (fit) + Implicit (engagement), threshold-based stages
**SLA**: Respond to MQLs <5 minutes (80% conversion drop after)
**Qualification**: BANT (Budget, Authority, Need, Timeline)
**Key Metric**: Pipeline Velocity = (Opps * Win% * ACV) / Cycle Days

See `references/scoring-templates.md` for lead scoring model templates.
See `references/nurture-sequences.md` for nurture sequence blueprints.
