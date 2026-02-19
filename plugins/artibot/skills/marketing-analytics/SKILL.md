---
name: marketing-analytics
description: |
  Marketing-specific analytics including KPI dashboards, channel performance, attribution analysis, and campaign ROI measurement.
  Provides frameworks for marketing measurement, forecasting, and performance benchmarking.
  Auto-activates when: marketing analytics, KPI tracking, attribution analysis, campaign performance, marketing dashboard.
  Triggers: marketing analytics, KPI dashboard, attribution, ROAS, CAC, LTV, channel performance, campaign ROI, marketing measurement, 마케팅 분석, KPI 대시보드, 어트리뷰션, ROAS
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "marketing analytics"
  - "ROI"
  - "attribution"
  - "conversion tracking"
  - "marketing metrics"
agents:
  - "persona-analyzer"
  - "persona-performance"
tokens: "~4K"
category: "marketing"
---

# Marketing Analytics

## When This Skill Applies
- Building marketing KPI dashboards
- Analyzing channel performance and attribution
- Measuring campaign ROI and ROAS
- Creating marketing forecasts and projections
- Benchmarking performance against industry standards

## Core Guidance

### 1. Analytics Process
```
Define KPIs -> Instrument Tracking -> Collect Data -> Analyze Performance -> Attribute Results -> Generate Insights -> Recommend Actions -> Forecast
```

### 2. Marketing Metrics Hierarchy

```
Level 1 (Business): Revenue, Profit, Market Share
  |
Level 2 (Marketing): CAC, LTV, LTV:CAC, Marketing ROI
  |
Level 3 (Channel): Channel ROAS, Channel CAC, Channel CVR
  |
Level 4 (Campaign): Campaign CPA, Campaign CTR, Campaign Revenue
  |
Level 5 (Tactical): Ad CTR, Email Open Rate, Page Bounce Rate
```

### 3. Channel Performance Framework

| Channel | Key Metrics | Benchmarks | Attribution Role |
|---------|-----------|-----------|-----------------|
| Organic Search | Traffic, rankings, conversions | 2-5% CVR | Awareness + Conversion |
| Paid Search | CPC, CTR, ROAS, quality score | 3-5% CTR | Conversion |
| Social Organic | Engagement, reach, followers | 1-3% engagement | Awareness |
| Social Paid | CPM, CPC, CPA, ROAS | $5-$15 CPM | Awareness + Conversion |
| Email | Open rate, CTR, revenue per email | 20-30% open | Nurture + Conversion |
| Content | Traffic, time on page, leads | 2-5% CTR | Awareness + Nurture |
| Referral | Referral traffic, CVR | 3-7% CVR | Conversion |
| Direct | Direct visits, branded search | Varies | Brand strength indicator |

### 4. Attribution Models Comparison

| Model | Logic | Pros | Cons |
|-------|-------|------|------|
| First-touch | 100% to first channel | Simple, awareness focus | Ignores nurture |
| Last-touch | 100% to last channel | Simple, conversion focus | Ignores awareness |
| Linear | Equal across all touches | Balanced | Oversimplified |
| Time-decay | More to recent touches | Recency-weighted | Devalues awareness |
| Position-based | 40/20/40 first/mid/last | Good B2B model | Arbitrary weights |
| Data-driven | ML-weighted by impact | Most accurate | Requires high volume |

**Recommendation**: Start with Position-based for B2B, Last-touch for B2C with short cycles, Data-driven when volume supports it (10K+ conversions/month).

### 5. Marketing Funnel Metrics

| Funnel Stage | Volume Metric | Efficiency Metric | Cost Metric |
|-------------|--------------|-------------------|------------|
| Impressions | Total impressions | -- | CPM |
| Clicks | Total clicks | CTR | CPC |
| Visits | Sessions | Bounce rate | Cost per visit |
| Leads | MQLs | Visit-to-lead % | CPL |
| Opportunities | SQLs | MQL-to-SQL % | Cost per SQL |
| Customers | New customers | SQL-to-close % | CAC |
| Revenue | Total revenue | ARPU | LTV:CAC |

### 6. Forecasting Methods

| Method | Best For | Data Required |
|--------|---------|--------------|
| Trend Extrapolation | Stable growth patterns | 12+ months historical |
| Seasonal Adjustment | Seasonal businesses | 2+ years data |
| Cohort-Based | Subscription businesses | Cohort retention data |
| Regression | Multi-variable prediction | Large datasets |
| Scenario Modeling | Strategic planning | Assumptions + baselines |

**Forecast Template**:
```
Scenario     | Q1       | Q2       | Q3       | Q4       | Annual
-------------|----------|----------|----------|----------|--------
Conservative | [value]  | [value]  | [value]  | [value]  | [total]
Base Case    | [value]  | [value]  | [value]  | [value]  | [total]
Optimistic   | [value]  | [value]  | [value]  | [value]  | [total]
```

### 7. Industry Benchmarks

| Metric | B2B SaaS | E-commerce | Media | Marketplace |
|--------|----------|-----------|-------|-------------|
| CAC | $200-$1000 | $20-$100 | $5-$30 | $50-$300 |
| LTV:CAC | 3:1 - 5:1 | 3:1 - 4:1 | 2:1 - 3:1 | 3:1 - 5:1 |
| Churn (monthly) | 3-7% | N/A | 5-10% | 5-8% |
| Email Open Rate | 20-25% | 15-20% | 18-22% | 17-21% |
| Landing Page CVR | 3-5% | 2-4% | 5-10% | 3-6% |
| ROAS (Paid) | 3x-5x | 4x-8x | 2x-4x | 3x-6x |

### 8. Analytics Maturity Model

| Level | Capability | Tools |
|-------|-----------|-------|
| L1: Basic | Page views, session tracking | GA4 basic setup |
| L2: Standard | Event tracking, goal tracking | GA4 + tag manager |
| L3: Advanced | Multi-touch attribution, cohort | GA4 + CDP + BI tool |
| L4: Predictive | Forecasting, propensity models | ML models + data warehouse |
| L5: Prescriptive | Automated optimization, real-time | Full MarTech stack |

## Output Format
```
MARKETING ANALYTICS REPORT
===========================
Period:     [date range]
Channels:   [scope]
Model:      [attribution model]

KPI SCORECARD
-------------
Metric | Current | Target | Delta  | Trend | Status
-------|---------|--------|--------|-------|-------
[KPI]  | [value] | [value]| [+/-]  | [dir] | [status]

CHANNEL PERFORMANCE
-------------------
Channel  | Spend    | Revenue  | ROAS | CAC    | CVR
---------|----------|----------|------|--------|-----
[channel]| [spend]  | [revenue]| [Xx] | [cost] | [%]

ATTRIBUTION
-----------
Model      | Top Channel | Revenue Share
-----------|-------------|-------------
[model]    | [channel]   | [%]

FORECAST
--------
Scenario     | Next Period | Confidence
-------------|------------|----------
[scenario]   | [value]    | [%]

RECOMMENDATIONS
---------------
Priority | Action          | Expected Impact
---------|----------------|----------------
P1       | [action]       | [metric lift]
```

## Quick Reference

**Metrics Hierarchy**: Business -> Marketing -> Channel -> Campaign -> Tactical
**Attribution**: Position-based (B2B), Last-touch (B2C short cycle), Data-driven (high volume)
**Forecasting**: Trend, Seasonal, Cohort, Regression, Scenario
**Maturity**: Basic (L1) -> Standard (L2) -> Advanced (L3) -> Predictive (L4) -> Prescriptive (L5)

See `references/kpi-definitions.md` for marketing KPI formula reference.
See `references/attribution-guide.md` for attribution model implementation guides.
