# KPI Scorecard Design

**Core: Every metric needs Current + Target + Delta + Trend + Status. No orphan numbers.**

## Scorecard Format

| Metric | Current | Target | Delta | Trend | Status |
|--------|---------|--------|-------|-------|--------|
| Revenue | $1.2M | $1.0M | +20% | ↑ | ABOVE |
| MQLs | 450 | 500 | -10% | → | AT RISK |
| CAC | $85 | $75 | +13% | ↑ | AT RISK |
| LTV:CAC | 3.2:1 | 3:1 | +7% | → | ON TRACK |
| CTR | 2.8% | 3.0% | -7% | ↓ | ON TRACK |

## Status Threshold Rules

| Status | Condition | Color | Action |
|--------|-----------|-------|--------|
| **ABOVE** | >+10% of target | Green | Document success factors, raise target |
| **ON TRACK** | Within ±10% | Blue/Gray | Monitor, no action needed |
| **AT RISK** | -10% to -20% | Yellow/Orange | Investigate root cause, prepare mitigation |
| **BELOW** | >-20% of target | Red | Immediate action, escalate to leadership |

**Note**: For cost metrics (CAC, CPC), invert the logic — lower is better.

## Trend Indicators

| Symbol | Meaning | Timeframe |
|--------|---------|-----------|
| ↑↑ | Strong improvement (>15% MoM) | Last 3 months |
| ↑ | Improving (5-15% MoM) | Last 3 months |
| → | Stable (±5% MoM) | Last 3 months |
| ↓ | Declining (5-15% MoM) | Last 3 months |
| ↓↓ | Rapid decline (>15% MoM) | Last 3 months |

## Delta Calculation

```
Delta % = ((Current - Target) / Target) × 100
MoM %   = ((This Month - Last Month) / Last Month) × 100
YoY %   = ((This Period - Same Period Last Year) / Same Period Last Year) × 100
```

## Update Cadence

| Scorecard Type | Frequency | Metrics Count | Review Meeting |
|---------------|-----------|---------------|----------------|
| **Executive** | Monthly | 5-8 top-line | Board/Leadership |
| **Marketing** | Weekly | 10-15 channel | Marketing team |
| **Campaign** | Daily/Weekly | 5-10 tactical | Campaign owners |
| **Operational** | Real-time | 3-5 critical | On-call / alerts |

## Checklist

- [ ] Every metric has all 5 fields (current, target, delta, trend, status)
- [ ] Status thresholds defined and applied consistently
- [ ] Cost metrics use inverted logic (lower = better)
- [ ] Trend calculated from 3+ data points (not just last period)
- [ ] Scorecard refreshed at defined cadence
- [ ] Color coding is colorblind-safe (use symbols + colors)
- [ ] Metrics ordered by business impact (revenue first)
- [ ] Anomalies annotated with brief explanation
