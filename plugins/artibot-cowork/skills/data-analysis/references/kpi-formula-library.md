# KPI Formula Library

**Core Principle**: Revenue impact always drives metric priority. Measure at acquisition, conversion, and retention layers separately before aggregating.

## Essential KPI Formulas

| KPI | Formula | Target Range | Category | Layer |
|-----|---------|--------------|----------|-------|
| CAC (Cost Per Acquisition) | Total Spend / New Customers | <$50 | Efficiency | Acquisition |
| CPC (Cost Per Click) | Total Ad Spend / Clicks | <$2.00 | Efficiency | Traffic |
| CPL (Cost Per Lead) | Marketing Spend / Leads | <$10 | Efficiency | Leads |
| CPA (Cost Per Action) | Campaign Cost / Conversions | <$25 | Efficiency | Conversion |
| ROAS (Return on Ad Spend) | Revenue / Ad Spend | >3.0x | Profitability | Revenue |
| CTR (Click-Through Rate) | Clicks / Impressions × 100 | >2% | Engagement | Traffic |
| Conversion Rate | Conversions / Visitors × 100 | >2% | Conversion | Funnel |
| Open Rate | Opened / Sent × 100 | >20% | Engagement | Email |
| Bounce Rate | Single-Page Sessions / Total × 100 | <50% | Quality | Web |
| LTV (Lifetime Value) | ARPU × Customer Lifespan | >3× CAC | Retention | Revenue |
| Churn Rate | Lost Customers / Start Customers × 100 | <5% | Retention | Retention |
| MRR (Monthly Recurring Revenue) | Sum of All Monthly Subscriptions | Trending up | Revenue | Recurring |
| ARPU (Average Revenue Per User) | Total Revenue / Active Users | Growing | Revenue | Efficiency |

## Attribution Model Comparison

| Model | Mechanism | Best For | Limitation | Implementation |
|-------|-----------|----------|-----------|-----------------|
| First-Touch | 100% credit to 1st source | Top-of-funnel optimization | Ignores conversion driver | Tag UTM at entry |
| Last-Touch | 100% credit to last source | Budget allocation | Undervalues awareness | Track final click |
| Linear | Equal credit to all touches | Balanced view | Assumes equal impact | Distribute 1/n |
| Time-Decay | More credit to recent touches | Multi-touch campaigns | Requires lookback window | Exponential weights |
| Position-Based | 40% first, 40% last, 20% middle | Funnel optimization | Simplifies reality | 40-20-40 split |

## Implementation Checklist

- [ ] Define revenue tier (customer value segment drives priority)
- [ ] Select attribution model based on sales cycle length (use Linear if >30 days)
- [ ] Set monthly review cadence (track 30/60/90 day trends, not daily)
- [ ] Create baseline (compare vs. prior month + YoY)
- [ ] Implement alert thresholds (flag if >20% variance)
- [ ] Document assumptions (CAC includes which channels, which costs)
- [ ] Validate data sources (reconcile between systems monthly)
