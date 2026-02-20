---
description: Marketing analytics dashboards, KPI tracking, performance reports, and attribution analysis
argument-hint: '[report-type] e.g. "캠페인 ROI 리포트"'
allowed-tools: [Read, Write, Glob, Grep, Bash, Task, WebSearch, TaskCreate]
---

# /analytics

Marketing-specific analytics command that generates performance dashboards, KPI reports, channel attribution analysis, and campaign ROI reports. Complementary to `/excel` with a marketing-domain focus.

## Arguments

Parse $ARGUMENTS:
- `report-type`: Report type - `dashboard` | `campaign-report` | `channel-report` | `attribution` | `executive-summary` | `forecast`
- `--kpi [metrics]`: Focus KPIs (comma-separated) - e.g., `cac,ltv,roas,ctr,cvr,mrr,arr,churn,nps`
- `--period [range]`: Time period - `daily` | `weekly` | `monthly` | `quarterly` | `ytd` | `custom`
- `--channel [channels]`: Marketing channels - `organic` | `paid` | `email` | `social` | `referral` | `direct` | `all`
- `--compare [baseline]`: Comparison - `previous-period` | `yoy` | `target` | `budget`
- `--data [source]`: Data source file
- `--segment [dim]`: Segment dimension - `channel` | `campaign` | `audience` | `geography` | `device`

## Report Types

| Type | Purpose | Key Output |
|------|---------|------------|
| dashboard | Real-time KPI overview | Scorecard with trend indicators |
| campaign-report | Campaign performance analysis | Campaign metrics with ROI |
| channel-report | Channel efficiency comparison | Channel ranking with ROAS |
| attribution | Multi-touch attribution analysis | Attribution model comparison |
| executive-summary | High-level performance overview | Summary with key decisions |
| forecast | Forward-looking projections | Trend projections with scenarios |

## Marketing KPI Reference

| Category | KPIs |
|----------|------|
| Acquisition | CAC, CPC, CPL, CPA, ROAS |
| Engagement | CTR, Open Rate, Bounce Rate, Time on Site |
| Conversion | CVR, MQL->SQL rate, Win Rate, ACV |
| Retention | Churn Rate, NPS, LTV, LTV:CAC ratio |
| Revenue | MRR, ARR, ARPU, Expansion Revenue |

## Agent Delegation

- Primary: `data-analyst` - Analytics and reporting
- Supporting: `marketing-strategist` - Strategic interpretation

## Skills Required

- `marketing-analytics` - Marketing KPIs, attribution models, funnel metrics
- `data-visualization` - Dashboards and charts
- `report-generation` - Executive summaries

## Execution Flow

1. **Parse**: Extract report type, KPIs, time period, channel scope
2. **Ingest**: Load data from source or generate template structure
3. **Calculate**: Compute marketing metrics:
   - **Acquisition**: CAC, CPC, CPL, CPA, ROAS
   - **Engagement**: CTR, Open Rate, Bounce Rate, Time on Site
   - **Conversion**: CVR, MQL->SQL rate, Win Rate, ACV
   - **Retention**: Churn Rate, NPS, LTV, LTV:CAC ratio
   - **Revenue**: MRR, ARR, ARPU, Expansion Revenue
4. **Attribute** (if `attribution`): Apply attribution models:
   - First-touch, Last-touch, Linear, Time-decay, Position-based
   - Cross-channel attribution comparison
5. **Visualize**: Design dashboard layout:
   - KPI scorecards with trend indicators
   - Channel performance comparison charts
   - Funnel visualization with conversion rates
   - Time series for trend analysis
6. **Interpret**: Generate narrative insights:
   - Performance vs target analysis
   - Channel efficiency ranking
   - Anomaly flagging
   - Opportunity identification
7. **Report**: Output analytics report

## Output Format

```
MARKETING ANALYTICS
===================
Report:     [report-type]
Period:     [date range]
Channels:   [scope]
Segments:   [dimensions]

KPI SCORECARD
-------------
Metric | Current | Target | Delta  | Trend | Status
-------|---------|--------|--------|-------|-------
[CAC]  | [$XX]   | [$XX]  | [-XX%] | [dwn] | [GOOD]
[LTV]  | [$XX]   | [$XX]  | [+XX%] | [up]  | [GOOD]
[ROAS] | [X.Xx]  | [X.Xx] | [+X%]  | [up]  | [GOOD]

CHANNEL PERFORMANCE
-------------------
Channel  | Spend    | Revenue  | ROAS | CAC    | Conv.
---------|----------|----------|------|--------|------
[Paid]   | [$XX,XXX]| [$XX,XXX]| [Xx] | [$XX]  | [XX%]
[Email]  | [$X,XXX] | [$XX,XXX]| [Xx] | [$XX]  | [XX%]
[Organic]| [$0]     | [$XX,XXX]| [--] | [$XX]  | [XX%]

ATTRIBUTION (if attribution)
-----------------------------
Model           | Top Channel | Share
----------------|-------------|------
First-Touch     | [channel]   | [XX%]
Last-Touch      | [channel]   | [XX%]
Linear          | [channel]   | [XX%]
Time-Decay      | [channel]   | [XX%]

INSIGHTS
--------
1. [Key insight with supporting data]
2. [Trend or pattern identified]
3. [Optimization opportunity]

RECOMMENDATIONS
---------------
Priority | Action                  | Channel  | Expected Impact
---------|-------------------------|----------|----------------
P1       | [action]                | [channel]| [+XX% metric]
```

## Example Usage

```
/analytics dashboard --kpi cac,ltv,roas,churn --period monthly --channel all
/analytics campaign-report --data @campaigns/q1-results.csv --compare target
/analytics attribution --channel paid,organic,email --period quarterly
/analytics executive-summary --period quarterly --compare yoy --kpi mrr,arr,churn,nps
/analytics forecast --kpi mrr,cac --period quarterly --data @revenue/history.csv
```
