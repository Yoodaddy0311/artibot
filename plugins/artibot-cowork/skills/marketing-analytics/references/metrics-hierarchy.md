# Metrics Hierarchy

**Core Principle**: Metrics flow top-down from business to tactical. Revenue impact decreases as you go down levels. Measure all 5 levels; optimize only top 3.

## Metrics by Organizational Level

| Level | Example Metrics | Audience | Update Frequency | Budget Impact | Decision Horizon |
|-------|-----------------|----------|------------------|---------------|-----------------|
| Business | Revenue, Profit, Growth %, Market Share | C-suite, board | Monthly | Highest | Quarterly |
| Marketing | CAC, LTV, ROAS, CAC Payback | CMO, CFO | Monthly | High | Monthly |
| Channel | CPC, CPL, CPA, CPMS, CTR, Impression Share | Channel leads | Weekly | Medium | Weekly |
| Campaign | Conversions, Cost, CPA by campaign, Quality Score | Campaign mgrs | Daily | Medium | Daily |
| Tactical | Impressions, Clicks, Spend, Bid Price | Specialists | Real-time | Low | Hourly |

## Analytics Maturity Model

| Level | Capability | Metrics Focus | Tools | Insight Quality |
|-------|------------|---------------|-------|-----------------|
| L1: Basic | Data collection | Impressions, clicks, spend | Spreadsheet | Descriptive only |
| L2: Intermediate | Standard reporting | CTR, CPC, conversions | Google Analytics, native platforms | Historical trends |
| L3: Advanced | Cross-channel analysis | CAC, LTV, attribution | SQL database, Tableau | Why questions answered |
| L4: Expert | Predictive modeling | Forecasts, cohorts, lookalike | Python, statistical models | What-if scenarios |
| L5: Prescriptive | ML optimization | Auto-bidding, budget allocation | ML models, custom algorithms | Recommended actions |

## Metric Dependencies (Cause → Effect)

```
Spend ↓ → Impressions ↓ → Clicks ↓ → CTR ↓ → Conversions ↓ → ROAS ↓ → Revenue ↓
```

Example: If ROAS drops, diagnose left to right. If CTR normal but conversions low, quality-score or landing-page issue (not media buy).

## Marketing Analytics Checklist

- [ ] Define business goal (revenue growth %, market penetration, cost reduction)
- [ ] Select metrics for each level (don't optimize all 5 simultaneously)
- [ ] Set baseline and targets (current vs. competitive benchmark vs. target)
- [ ] Establish update cadence (monthly for business, daily for campaigns)
- [ ] Create attribution model (select single model, not multiple conflicting ones)
- [ ] Implement data validation (reconcile platform metrics monthly)
- [ ] Build dashboards per audience (not one dashboard for all levels)
- [ ] Calculate unit economics (CAC < LTV/3 minimum viable threshold)
- [ ] Document assumptions (what costs included in CAC, what counts as conversion)
