# Analysis Types Guide

**Core Principle**: Answer specific business questions with appropriate methods. Sequence: Descriptive → Diagnostic → Predictive → Prescriptive drives insight maturity.

## Analysis Type Comparison

| Type | Question | Methods | Tools | Output | Timeline |
|------|----------|---------|-------|--------|----------|
| Descriptive | What happened? | Aggregation, summary stats, trends | SQL, Tableau | Dashboards, reports | Historical |
| Diagnostic | Why did it happen? | Cohort analysis, segmentation, correlation | R, Python, SQL | Root causes, patterns | Historical |
| Predictive | What will happen? | Regression, time series, ML models | Python, statsmodels | Forecasts, probabilities | Future |
| Prescriptive | What should we do? | Optimization, A/B testing, simulations | Python, spreadsheets | Recommendations, actions | Actionable |

## Cohort Analysis Framework

**Dimensions**: Time-based (weekly, monthly), Behavioral (user actions), Channel (acquisition source), Plan/Tier (customer segment)

| Dimension | Definition | Retention Metric | Visualization | Use Case |
|-----------|-----------|------------------|---------------|----------|
| Time-Based | Users acquired in same period | % Active after N days | Heatmap | Seasonal patterns |
| Behavioral | Users with same action pattern | % Repeat within 30d | Trend line | Feature adoption |
| Channel | Users from same source | % LTV by channel | Stacked bar | Budget allocation |
| Plan/Tier | Users in same pricing tier | % Upgrade rate | Waterfall | Pricing strategy |

## Cohort Analysis Checklist

- [ ] Define cohort window (weekly best for 30K+ users, monthly for smaller)
- [ ] Select retention metric (% active, LTV, purchase frequency)
- [ ] Set lookback period (minimum 3-6 months data before analysis)
- [ ] Calculate baselines (first cohort becomes reference point)
- [ ] Run monthly comparison (flag if cohort N-1 > cohort N trend)
- [ ] Validate sample size (minimum 100 users per cohort)
- [ ] Create retention curve (X=days since cohort start, Y=% retained)
- [ ] Document inflection points (where retention flattens = max value extraction)
