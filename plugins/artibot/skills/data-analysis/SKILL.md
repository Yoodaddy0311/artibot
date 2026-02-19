---
name: data-analysis
description: |
  Statistical data analysis, data cleaning, insight extraction, and marketing data processing frameworks.
  Covers KPI calculation, trend analysis, cohort analysis, funnel analysis, and attribution modeling.
  Auto-activates when: data analysis, KPI calculation, trend analysis, funnel analysis, statistical analysis.
  Triggers: data analysis, statistics, KPI, metrics, trend analysis, cohort analysis, funnel, attribution, data cleaning, forecast, 데이터 분석, 지표, 통계, 코호트, 퍼널
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "data analysis"
  - "analyze data"
  - "metrics"
  - "statistics"
  - "data insights"
  - "data patterns"
agents:
  - "code-reviewer"
  - "performance-engineer"
tokens: "~4K"
category: "analysis"
---

# Data Analysis

## When This Skill Applies
- Processing and cleaning marketing datasets
- Calculating marketing KPIs and metrics
- Performing trend, cohort, and funnel analysis
- Building attribution models for channel performance
- Generating forecasts and projections

## Core Guidance

### 1. Data Analysis Process
```
Define Question -> Collect Data -> Clean & Validate -> Explore -> Analyze -> Interpret -> Visualize -> Recommend
```

### 2. Data Cleaning Checklist

| Check | Action | Tool |
|-------|--------|------|
| Missing values | Impute, flag, or exclude | pandas/Excel |
| Duplicates | Identify and deduplicate | Sort + compare |
| Outliers | Z-score or IQR method | Statistical test |
| Data types | Validate dates, numbers, categories | Type casting |
| Consistency | Standardize formats, naming | Mapping tables |
| Completeness | Ensure required fields present | Validation rules |

### 3. Marketing KPI Formulas

#### Acquisition Metrics
| KPI | Formula | Good Benchmark |
|-----|---------|---------------|
| CAC | Total acquisition cost / New customers | Varies by industry |
| CPC | Total ad spend / Total clicks | $1-$5 (search) |
| CPL | Total spend / Total leads generated | $20-$200 (B2B) |
| CPA | Total spend / Total conversions | $50-$500 (B2B) |
| ROAS | Revenue from ads / Ad spend | 3x-5x |

#### Engagement Metrics
| KPI | Formula | Good Benchmark |
|-----|---------|---------------|
| CTR | Clicks / Impressions * 100 | 2-5% (search) |
| Open Rate | Opens / Delivered * 100 | 20-30% (email) |
| Bounce Rate | Single-page visits / Total visits * 100 | 30-50% |
| Engagement Rate | Interactions / Impressions * 100 | 1-5% (social) |

#### Revenue Metrics
| KPI | Formula | Good Benchmark |
|-----|---------|---------------|
| LTV | ARPU * Average customer lifespan | 3x+ of CAC |
| LTV:CAC | LTV / CAC | 3:1 or higher |
| MRR | Sum of all monthly recurring revenue | Growth MoM |
| ARR | MRR * 12 | Growth YoY |
| Churn Rate | Lost customers / Start customers * 100 | <5% monthly |

#### Conversion Metrics
| KPI | Formula | Good Benchmark |
|-----|---------|---------------|
| CVR | Conversions / Visitors * 100 | 2-5% (landing page) |
| MQL to SQL | SQLs / MQLs * 100 | 15-25% |
| SQL to Close | Closed / SQLs * 100 | 20-30% |
| Cart Abandonment | Abandoned / Initiated * 100 | 60-80% (lower is better) |

### 4. Analysis Types

| Type | Purpose | Method |
|------|---------|--------|
| Descriptive | What happened? | Aggregation, averages, distributions |
| Diagnostic | Why did it happen? | Segmentation, correlation, drill-down |
| Predictive | What will happen? | Trend lines, regression, time series |
| Prescriptive | What should we do? | Optimization, scenario modeling |

### 5. Funnel Analysis

```
Stage 1: [Visitors]     -> [count] (100%)
Stage 2: [Leads/MQLs]   -> [count] ([X]% conversion)
Stage 3: [SQLs]          -> [count] ([X]% conversion)
Stage 4: [Opportunities] -> [count] ([X]% conversion)
Stage 5: [Customers]     -> [count] ([X]% conversion)

Overall: [X]% end-to-end conversion
Biggest drop-off: Stage [n] -> Stage [n+1] ([X]% loss)
```

### 6. Cohort Analysis Framework

| Dimension | Segmentation | Insight |
|-----------|-------------|---------|
| Time-based | Signup month/week | Retention curves over time |
| Behavioral | First action type | Activation impact on retention |
| Channel | Acquisition source | Channel quality comparison |
| Plan/Tier | Subscription level | Revenue retention by tier |

### 7. Attribution Models

| Model | Logic | Best For |
|-------|-------|---------|
| First-touch | 100% credit to first interaction | Understanding awareness channels |
| Last-touch | 100% credit to last interaction | Understanding conversion channels |
| Linear | Equal credit to all touchpoints | Balanced view |
| Time-decay | More credit to recent touchpoints | Long sales cycles |
| Position-based | 40% first, 40% last, 20% middle | Most balanced B2B model |
| Data-driven | ML-based, weights by actual impact | High-volume data required |

## Output Format
```
DATA ANALYSIS REPORT
====================
Question:   [analysis question]
Dataset:    [source description]
Period:     [date range]
Records:    [count]

KEY FINDINGS
------------
1. [Finding with supporting metric]
2. [Finding with supporting metric]
3. [Finding with supporting metric]

KPI SUMMARY
-----------
Metric          | Current | Previous | Delta   | Status
----------------|---------|----------|---------|--------
[metric]        | [value] | [value]  | [+/--%] | [trend]

DETAILED ANALYSIS
-----------------
[Analysis sections by dimension]

RECOMMENDATIONS
---------------
Priority | Action           | Expected Impact
---------|-----------------|----------------
P1       | [action]        | [metric improvement]
```

## Quick Reference

**KPI Categories**: Acquisition (CAC, CPC, ROAS), Engagement (CTR, Bounce), Revenue (LTV, MRR, Churn), Conversion (CVR, MQL-SQL)
**Analysis Types**: Descriptive, Diagnostic, Predictive, Prescriptive
**Attribution Models**: First-touch, Last-touch, Linear, Time-decay, Position-based

See `references/kpi-formulas.md` for complete KPI formula reference.
See `references/reporting-templates.md` for analysis report templates.
