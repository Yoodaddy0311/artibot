---
description: Data analysis, report generation, dashboard design, and spreadsheet automation
argument-hint: '[type] e.g. "매출 데이터 대시보드 생성"'
allowed-tools: [Read, Write, Glob, Grep, Bash, Task, WebSearch, TodoWrite]
---

# /excel

Data analysis and reporting command that processes data sources, generates insights, creates formatted tables and charts, designs dashboards, and produces analysis reports. Can generate CSV/TSV outputs, formula recommendations, and pivot table designs.

## Arguments

Parse $ARGUMENTS:
- `analysis-type`: Analysis type - `report` | `dashboard` | `forecast` | `comparison` | `funnel` | `cohort` | `attribution` | `roi`
- `--data [source]`: Data source file path or description of data to analyze
- `--format [output]`: Output format - `table` | `chart` | `dashboard` | `narrative` | `all`
- `--export [type]`: Export format - `csv` | `markdown` | `json` | `html`
- `--period [range]`: Time period - `daily` | `weekly` | `monthly` | `quarterly` | `ytd` | `custom`
- `--compare [baseline]`: Comparison baseline - `previous-period` | `yoy` | `target` | `competitor`
- `--kpi [metrics]`: Focus KPIs (comma-separated) - e.g., `cac,ltv,churn,mrr,arpu`

## Analysis Types

| Type | Purpose | Key Output |
|------|---------|------------|
| report | Descriptive statistics and trends | Summary tables with highlights |
| dashboard | KPI scorecards and widgets | Dashboard layout with widgets |
| forecast | Trend projection and scenarios | Projections with confidence intervals |
| comparison | Delta analysis and benchmarking | Comparison tables with deltas |
| funnel | Stage conversion rates | Funnel diagram with drop-off analysis |
| cohort | Retention and behavioral analysis | Retention curves and segments |
| attribution | Channel attribution modeling | Attribution model comparison |
| roi | Investment return analysis | ROI calculations with payback period |

## Agent Delegation

- Primary: `data-analyst` - Data processing and analysis
- Supporting: `content-marketer` - Report narrative and insights storytelling

## Skills Required

- `data-analysis` - Statistical analysis, data cleaning, insight extraction
- `data-visualization` - Chart selection, dashboard layout, visual encoding
- `report-generation` - Report templates, executive summaries, data narratives

## Execution Flow

1. **Parse**: Extract analysis type, data source, output format, comparison parameters
2. **Ingest**: Read data source:
   - File-based: CSV, JSON, TSV, or markdown tables
   - Description-based: Generate sample data structure based on description
3. **Clean & Validate**: Data quality checks:
   - Missing value detection and handling strategy
   - Outlier identification
   - Data type validation
   - Consistency checks
4. **Analyze**: Apply analysis type:
   - **report**: Descriptive statistics, trends, highlights, anomalies
   - **dashboard**: KPI selection, layout design, widget recommendations
   - **forecast**: Trend projection, confidence intervals, scenario modeling
   - **comparison**: Delta analysis, percentage changes, benchmark comparison
   - **funnel**: Stage conversion rates, drop-off analysis, optimization recommendations
   - **cohort**: Retention curves, behavioral segmentation, lifetime value
   - **attribution**: Channel attribution models (first-touch, last-touch, linear, time-decay)
   - **roi**: Investment returns, payback period, cost-per-acquisition
5. **Visualize**: Recommend visualizations per insight:
   - Metric trends -> Line charts with annotations
   - Comparisons -> Grouped bar charts
   - Distributions -> Histograms or box plots
   - Funnels -> Funnel diagrams with conversion rates
6. **Generate**: Produce output in requested format
7. **Report**: Output analysis with insights and recommendations

## Output Format

```
DATA ANALYSIS REPORT
====================
Type:       [analysis-type]
Period:     [time range]
Data:       [source description]
Records:    [count]

EXECUTIVE SUMMARY
-----------------
[2-3 sentence summary of key findings]

KEY METRICS
-----------
Metric          | Current | Previous | Delta   | Status
----------------|---------|----------|---------|--------
[metric name]   | [value] | [value]  | [+/--%] | [up|down|stable]

DETAILED ANALYSIS
-----------------
[Section per analysis dimension]

INSIGHTS
--------
1. [High-impact finding with supporting data]
2. [Trend or pattern identified]
3. [Anomaly or concern flagged]

RECOMMENDATIONS
---------------
Priority | Action                    | Expected Impact
---------|---------------------------|----------------
P1       | [immediate action]        | [projected improvement]
P2       | [short-term optimization]  | [projected improvement]

VISUALIZATIONS
--------------
Chart 1: [type] - [title] - [data series]
Chart 2: [type] - [title] - [data series]

EXPORT
------
[File path or inline data in requested format]
```

## Example Usage

```
/excel report --data @marketing/q1-metrics.csv --period quarterly --compare yoy --format all
/excel dashboard --kpi cac,ltv,churn,mrr --period monthly --format dashboard
/excel funnel --data @analytics/signup-flow.json --compare previous-period
/excel roi --data @campaigns/ad-spend.csv --period quarterly --format narrative
/excel attribution --data @analytics/touchpoints.csv --kpi conversions
```
