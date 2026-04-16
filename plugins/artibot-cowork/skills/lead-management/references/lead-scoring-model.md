# Lead Scoring Model & Pipeline Metrics

**Calibrated scoring increases MQL→SQL rate by 20-35% and reduces sales cycle length 15-25%.**

## Scoring Categories & Signals

### Category 1: Explicit Fit (25% weight = 25 points max)

| Signal | Points | How to Collect |
|--------|--------|---|
| Company in target industry (ICP) | 10 | Company domain lookup or form question |
| Company size in revenue/headcount range | 8 | LinkedIn, Crunchbase, G2 enrichment |
| Decision title (VP+, Director+, Manager) | 5 | LinkedIn profile, email analysis |
| Not in exclude list (competitor, small co) | 2 | Firmographic data, manual review |

**Implementation**: Auto-score via enrichment API (Clearbit, Apollo, Hunter); manual review for borderline cases.

### Category 2: Behavioral Engagement (40% weight = 40 points max)

| Signal | Points | Decay/Trigger |
|--------|--------|---|
| Form submission (demo request, contact) | 15 | 90-day window; +5 bonus if CTQ form |
| Email open rate ≥50% in sequence (5+ opens) | 12 | 30-day rolling window; recalc daily |
| Click-through rate ≥25% (2+ link clicks) | 10 | 30-day rolling window; recalc daily |
| Website visitor (product page, pricing page) | 8 | 60-day window; +3 if 3+ visits in 7 days |
| Webinar/event attendance | 6 | 90-day window; -2 if no follow-up interaction |
| Competitor research (viewed competitor page) | 4 | 14-day window (high-intent signal) |
| No engagement signals detected | -5 | Applied if 90+ days inactive |

**Implementation**: Sync from: email platform, website analytics (heatmap/GA), event CRM, ad platform. Daily recalc.

### Category 3: Content Interaction (20% weight = 20 points max)

| Signal | Points | Recency Window |
|--------|--------|---|
| Downloaded resource (whitepaper, case study, ROI calc) | 8 | 60 days |
| Attended webinar or demo (watched ≥50%) | 7 | 90 days |
| Viewed product tutorial or help content | 4 | 45 days |
| Engages with sales content (proposal, spec sheet) | 6 | 30 days (high intent) |
| Clicked sales email (3+ clicks total) | 5 | 30 days |

**Implementation**: Track via email platform (Mailchimp, HubSpot), content library (Marketo, Pardot), or CDM (account-based platform).

### Category 4: Negative Signals (-15% weight = -15 points max)

| Signal | Points | Action |
|---|---|---|
| Unsubscribed from email | -5 | Remove from nurture; pause outreach |
| Marked email as spam | -8 | Remove from all lists |
| Account dormant >180 days | -3 | Recycle to lower-touch list |
| Explicit decline message | -15 | Remove from active pipeline |
| Role not decision-influencer (IC, coordinator) | -4 | Lower priority; nurture for future |

**Implementation**: Pull from email platform unsubscribe logs, CRM notes, and activity history.

## Score Thresholds & Stage Gates

| Score | Stage | Designation | Marketing Action | Sales Action |
|---|---|---|---|---|
| 0-29 | Lead | Cold Prospect | Nurture sequence (monthly email) | None |
| 30-49 | Lead | Warm Prospect | Nurture sequence (2x/month) | None |
| 50-59 | MQL | Engaged Lead | Warm outreach ready; segment by interest | BDR research, LinkedIn research |
| 60-69 | MQL | Marketing Qualified | BDR outreach; schedule call | First touchpoint (email + call) |
| 70-79 | SAL | Sales Qualified Lead (in review) | Brief sales team; BDR qualifies | Qualification call 1 (BANT initial) |
| 80-89 | SQL | Sales Qualified Lead (accepted) | Monitor for stall | Discovery call; BANT deep-dive |
| 90-100 | Opp | Opportunity (active deal) | Sales-led, marketing supports | Proposal/demo stage |

## Calibration: Convert vs. Non-Convert Analysis

**Retrospective Analysis** (Monthly):

```
Cohort: Leads scored 60-79 in Jan 2026 (n=150)
  ├─ Converted to Opp: 85 leads (56.7%)
  │   └─ Avg score at conversion: 72 (INSIGHT: 70+ high converter rate)
  │
  ├─ Stalled (no activity 30d+): 45 leads (30%)
  │   └─ Avg score: 65 (INSIGHT: 65-69 needs re-nurture at day 14)
  │
  └─ Disqualified: 20 leads (13.3%)
      └─ Avg score: 68 but wrong industry/role (INSIGHT: refine fit signals)

Action: Raise MQL threshold from 50 to 60; add "stall re-engage" at day 14 for 65-69 band
```

## Pipeline Metrics & Health Dashboard

### Conversion Rates

| Metric | Target | Calculation | Review Frequency |
|---|---|---|---|
| Lead→MQL | 15-20% | MQL count / Total leads | Weekly |
| MQL→SAL | 30-40% | SAL count / MQL count | Weekly |
| SAL→SQL | 40-50% | SQL count / SAL count | Weekly |
| SQL→Opp | 60-70% | Opp count / SQL count | Weekly |
| Opp→Won | 25-35% | Won deals / Total opps | Monthly |

### Sales Cycle & Pipeline Velocity

| Metric | Calculation | Target | Action If Below |
|---|---|---|---|
| Avg Sales Cycle | Days from SQL→Won | 45-60 days | Analyze bottleneck (stuck at proposal stage?) |
| Pipeline Velocity | New opps/week | 3-5 opps | Increase SQL-stage lead flow |
| Forecast Accuracy | (Actual revenue / Predicted revenue) × 100 | 85%+ accuracy | Recalibrate win rates by deal size/segment |
| Time to MQL | Days from lead creation to MQL score | 14 days avg | Reduce nurture time or improve engagement signals |

### Scoring Health

| Metric | Target | Red Flag |
|---|---|---|
| % Leads Recycled (score decline) | <10% | High churn in nurture; signals misaligned |
| Avg Score Decay (per 30 days inactive) | -5 to -10 points | >-15 points/month = engagement tools failing |
| MQL Stall Rate (>30 days no activity) | <15% of MQL pool | >25% = SLA or messaging misalignment |

## Implementation Checklist

**Scoring Model Setup**:
- [ ] Categories defined (explicit fit, behavioral, content, negative)
- [ ] Point values set and weighted (25%, 40%, 20%, -15%)
- [ ] Recency windows applied per signal (30/45/60/90/180 days)
- [ ] Lead scoring automation enabled in marketing platform

**Data Integration**:
- [ ] Email platform connected (opens, clicks, unsubscribes)
- [ ] Website analytics or pixel integrated (page visits, scroll depth)
- [ ] CRM synced for enrichment (company size, industry, title)
- [ ] Firmographic data provider integrated (Clearbit, Zoominfo, Apollo)

**Threshold & Stage Gates**:
- [ ] MQL threshold documented (target 60 points for high-fit leads)
- [ ] SAL acceptance criteria logged (fit score + behavioral combo)
- [ ] SQL stage clearly defines BANT minimum
- [ ] Opp stage requires champion + timeline

**Monthly Calibration**:
- [ ] Win rate analysis by score band (find optimal threshold)
- [ ] Stall analysis: leads >30 days inactive, reason, re-engagement plan
- [ ] Conversion rate trending: MQL→SQL declining? Adjust nurture or sales process
- [ ] Score decay tracking: are dormant leads decaying fast enough?

---

**Reference**: Adjust point values if win rates by score band deviate >10% from target. Last verified: Feb 2026.
