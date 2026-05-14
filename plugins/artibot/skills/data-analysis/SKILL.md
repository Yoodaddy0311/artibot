---
context: fork
name: data-analysis
description: "Performs statistical data analysis, data cleaning, and insight extraction covering KPI calculation, trend analysis, cohort analysis, funnel analysis, and attribution modeling. Use when user asks about data analysis, statistics, KPI, metrics, trend analysis, cohort, funnel analysis, attribution, forecast, 데이터 분석, 지표, 통계, 코호트, or 퍼널."
lang: [en, ko]
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "data analysis"
  - "analyze data"
  - "metrics"
  - "statistics"
  - "data insights"
  - "data patterns"
agent: Explore
agents:
  - "code-reviewer"
  - "performance-engineer"
tokens: "~4K"
category: "analysis"
source_hash: fd7e2af1
whenNotToUse: "Qualitative research, code review, or system design tasks where numerical data, metrics, or statistical analysis are not the primary deliverable."
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

## Output Template

```
DATA ANALYSIS REPORT
=====================
Dataset:    [source/name]
Period:     [date range]
Scope:      [rows/records analyzed]
Method:     [analysis technique]

METRICS HIERARCHY
─────────────────
TIER 1 - NORTH STAR
  [metric name]: [current value] ([+/-% vs previous period])
  Target: [target value] | Status: [ON TRACK | AT RISK | OFF TRACK]

TIER 2 - INPUT METRICS (drive North Star)
  [input metric 1]: [value] ([trend])
  [input metric 2]: [value] ([trend])

TIER 3 - HEALTH METRICS (system stability)
  [health metric 1]: [value] ([threshold: acceptable range])
  [health metric 2]: [value] ([threshold: acceptable range])

TIER 4 - BUSINESS METRICS (outcomes)
  [business metric 1]: [value]
  [business metric 2]: [value]

KEY FINDINGS
────────────
[1] [finding]: [evidence - metric, data point, or pattern]
[2] [finding]: [evidence]
[3] [finding]: [evidence]

ANOMALIES & OUTLIERS
────────────────────
[1] [anomaly]: [expected vs actual] -> Possible cause: [hypothesis]

DASHBOARD SNAPSHOT
──────────────────
+------------------+  +------------------+
| North Star: [val]|  | Health:    [OK]   |
| Trend:  [up/dn]  |  | Uptime:   [val]  |
| vs Target: [%]   |  | Err Rate: [val]  |
+------------------+  +------------------+
+------------------+  +------------------+
| Input 1:  [val]  |  | Input 2:  [val]  |
| Trend:  [up/dn]  |  | Trend:  [up/dn]  |
+------------------+  +------------------+

RECOMMENDATIONS
───────────────
Priority | Action             | Expected Impact | Data Confidence
---------|--------------------|-----------------|----------------
P1       | [action]           | [impact]        | [HIGH|MEDIUM|LOW]
```

## Quick Reference

**KPI Categories**: Acquisition (CAC, CPC, ROAS), Engagement (CTR, Bounce), Revenue (LTV, MRR, Churn), Conversion (CVR, MQL-SQL)
**Analysis Types**: Descriptive, Diagnostic, Predictive, Prescriptive
**Attribution Models**: First-touch, Last-touch, Linear, Time-decay, Position-based

---

## References

- See `${CLAUDE_SKILL_DIR}/references/kpi-formula-library.md` for KPI formula library
- See `${CLAUDE_SKILL_DIR}/references/analysis-types-guide.md` for analysis types guide

## Rationalizations

The following table captures common excuses agents make to skip the rigor of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "the number looks right, ship it" | right to whom? validate against a second source before acting on a single query |
| "I will clean the data later" | dirty data contaminates downstream decisions — clean before you analyze, not after |
| "correlation is close enough to causation" | acting on correlation is how teams ship wrong features — establish causality or caveat the finding |
| "the outliers are errors, drop them" | outliers often contain the signal — investigate before excluding |
| "averages tell the story" | averages hide distribution tails where the real users (and problems) live — show p50/p95 |
