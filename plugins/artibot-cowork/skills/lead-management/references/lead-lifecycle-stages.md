# Lead Lifecycle Stages & BANT Qualification Framework

**Consistent stage definitions and clear ownership prevent lead stalling—typical stall rate without SLA: 35-50% of leads.**

## Lead Lifecycle Stages

| Stage | Definition | Owner | Actions | SLA | Metrics |
|-------|-----------|-------|---------|-----|---------|
| Raw Lead | Form submission or list import; no contact attempted | Marketing | Score, segment, tag source | 2 days | Inbound volume |
| MQL | Marketing Qualified Lead (score ≥30, behavioral engagement shown) | Marketing | Nurture sequence, content path mapped | 7 days | MQL→SAL rate (target 30%) |
| SAL | Sales Accepted Lead (sales reviews, meets ICP, schedules outreach) | Sales Dev | First touch call/email, discovery qualify | 5 days | SAL→SQL rate (target 40%) |
| SQL | Sales Qualified Lead (BANT scored, budget+authority confirmed, timelines aligned) | Account Exec | Discovery meeting, solution fit validated, proposal preparation | 14 days | SQL→Opp rate (target 60%) |
| Opportunity | Deal created, value proposition documented, champion identified | Account Exec | Needs analysis, competing options, solution design | 30 days | Win rate (target 25-35%) |
| Customer | Deal closed, contract signed, onboarding started | Customer Success | Activation, training, adoption tracking | N/A | NRR, expansion |
| Advocate | Active user providing referrals, testimonials, case study participation | CS/Marketing | Reference request, community program, expansion upsell | N/A | NPS, expansion revenue |

## BANT Qualification Framework

**B = Budget (25 points max)**

| Signal | Points | Assessment Method |
|--------|--------|------------------|
| Budget allocated to category | 15 | "Is there a budget approved for [solution category]?" |
| Explicit dollar range stated | 7 | Quote request, contract review, CFO conversation |
| Funding source confirmed | 3 | "Where will funding come from? Has it been approved?" |
| Zero budget or TBD | -10 | "We're exploring options" (red flag, deprioritize) |

**A = Authority (25 points max)**

| Signal | Points | Assessment Method |
|--------|--------|------------------|
| Champion is economic buyer (VP+) | 15 | Role title, budget approval authority, signature line |
| Champion influences decision (manager+) | 10 | "Who else needs to sign off? Can you influence them?" |
| Champion can advance (IC+) | 5 | Can schedule meetings, introduce others, gather feedback |
| No economic buyer identified | -5 | Committee of equals (longer sales cycle, stall risk) |

**N = Need (30 points max)**

| Signal | Points | Assessment Method |
|--------|--------|------------------|
| Specific business problem stated | 15 | "What's the top priority we should solve first?" |
| Problem impacts revenue or cost | 10 | Quantify: "How many hours/week wasted?" "Lost revenue impact?" |
| Timeline creates urgency | 5 | Q1 deadline, new initiative, audit discovery |
| Vague or exploratory need | -10 | "Just exploring" or no timeline (nurture, don't qualify) |

**T = Timeline (20 points max)**

| Signal | Points | Assessment Method |
|--------|--------|------------------|
| Decision timeline < 90 days | 15 | "When do you need to make a decision?" |
| Budget cycle aligns (fiscal Q1-Q2) | 5 | "When does your budget renew?" |
| No timeline or "exploring" | -5 | Nurture list, not SQL; revisit quarterly |

## Scoring Thresholds & Actions

| Score Range | Stage | Action | Next SLA |
|---|---|---|---|
| 0-29 | Raw Lead | Nurture: content, email sequence, event invites | Recycle quarterly |
| 30-59 | MQL | Segment by intent; warm outreach (BDR email + phone attempt 2x) | 7 days to SAL |
| 60-79 | SAL | Discovery call, BANT assessment, champion validation | 5 days to SQL |
| 80+ | SQL | Proposal, demo, value quantification, champion alignment | 14 days to Opp |

## Common Stall Patterns & Recovery

| Stall Signal | Root Cause | Recovery Action | Escalation |
|---|---|---|---|
| No response to 3+ emails | Wrong contact or low fit | Switch champion; re-score; nurture if fit exists | Recycle to MQL if fit valid |
| "Great, let's talk in Q3" | Timing misalignment, exploratory | Calendar meeting 30d before Q3; nurture monthly | Keep in nurture, monthly touch |
| "Need to get CFO buy-in" | No authority with contact | Request CFO intro or attend next CFO meeting | Mark deal stalled; 60d recheck |
| Silent after proposal | Deal stalled, competing vendors | 7-day follow-up; ask directly "Still interested?"; offer alternative timeline | Recycle to SAL if re-engaged |

## Pipeline Velocity Metrics (Rolling 90-Day)

```
MQL Volume           → MQL→SAL Rate    → SAL→SQL Rate    → SQL→Opp Rate    → Opp→Won Rate
(target 200/mo)         (target 30%)       (target 40%)       (target 60%)       (target 30%)

Example: 200 MQL × 30% = 60 SAL × 40% = 24 SQL × 60% = 14 Opp × 30% = 4 Wins/month
Pipeline Value = 14 Opp × Avg Deal Size ($50K) = $700K pipeline
Forecast (3mo) = 14 Opp × 30% win rate = 4 wins × $50K = $200K revenue
Sales Cycle = Avg days from SQL→Won (target 45-60 days B2B SaaS)
```

## Implementation Checklist

**Stage Definitions**:
- [ ] MQL score threshold set (behavioral + explicit score ≥30)
- [ ] SAL acceptance criteria documented (ICP match, score, source quality)
- [ ] SQL definition clear (BANT: all 4 scored; minimum: B+A+N ≥15 of 20)
- [ ] Opp structure: deal value, champion, timeline, stage gate (discovery/proposal/negotiation)

**BANT Assessment**:
- [ ] Discovery call scripted with BANT questions in order
- [ ] Score recorded in CRM at each stage
- [ ] Scoring rules automated where possible (budget source from form, title from LinkedIn)
- [ ] Recalibration every 30 days (compare forecast vs. actual win rate by BANT score)

**SLA Enforcement**:
- [ ] Each stage has max days before escalation/recycle (see table above)
- [ ] Weekly stall report: leads >SLA, reason, next action
- [ ] Monthly velocity report: conversion rates, average sales cycle, bottleneck identification

---

**Reference**: BANT thresholds adjust by company; B2B SaaS baseline shown. Last verified: Feb 2026.
