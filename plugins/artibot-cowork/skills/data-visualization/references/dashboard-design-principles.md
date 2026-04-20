# Dashboard Design Principles

**Core Principle**: 5-9 widgets organized by information hierarchy beat 50-widget sprawl. Audience determines refresh rate and metric depth. Consistent color encoding across all charts.

## Dashboard Type Configuration

| Type | Primary Audience | Refresh Rate | Widget Count | Top 3 Metrics | Layout |
|------|-----------------|--------------|--------------|---------------|--------|
| Executive (C-suite) | Leadership | Daily | 4-6 | Revenue, Growth %, Churn | 2 cols, large |
| Operational (managers) | Team leads | 4-hourly | 7-9 | Volume, Quality, SLA | 3 cols, mixed |
| Analytical (analysts) | Data team | Hourly | 6-8 | Detailed funnels, cohorts | 4 cols, dense |
| Campaign | Marketers | Real-time | 5-7 | CTR, CPA, ROI, Conversions | 2-3 cols, large |

## Information Hierarchy Rules

| Priority | Placement | Size | Update | Audience Action |
|----------|-----------|------|--------|-----------------|
| Critical (1 metric) | Top-left (F-pattern) | 40-50% width | Most frequent | Immediate action if anomaly |
| Primary (2-3 metrics) | Top row remaining | 20-30% each | Frequent | Monitor daily |
| Secondary (3-4 metrics) | Middle row | 20-25% each | Standard | Weekly review |
| Supporting (2-3 metrics) | Bottom row | 15-20% each | Less frequent | Context only |

## Visual Encoding Standards

| Element | Rule | Example | Violation Prevention |
|---------|------|---------|---------------------|
| Color | Same metric = same color across all charts | Revenue always green | Create color dictionary |
| Status | Red/Yellow/Green for health only | Status only, not trends | Use separate KPI card |
| Format | Currency, %, counts clearly labeled | "$2.3M" not "2300000" | Set format rules upfront |
| Precision | Show only significant digits | 2.3M not 2,347,832 | Round to 2-3 sig figs |

## Dashboard Design Checklist

- [ ] Identify primary audience (executive, operational, analytical, or campaign)
- [ ] Define 1 critical metric (top priority, largest visualization)
- [ ] Select 5-9 total widgets (more = cognitive overload)
- [ ] Set refresh rate (real-time = cost & complexity, daily = sufficient for most)
- [ ] Create color palette (5 primary colors max, consistent across all charts)
- [ ] Add contextual filters (date range, segment, channel)
- [ ] Include prior period comparison (week-over-week, month-over-month)
- [ ] Design mobile version (4-6 widgets, vertical stack)
- [ ] Add drill-down capability (click metric → detailed view)
- [ ] Test with target audience (5-min comprehension target)
