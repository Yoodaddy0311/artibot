# Funnel Diagnostics & Stage Analysis Framework

**Core: Identify conversion drop-off stages against industry benchmarks, diagnose causes, and apply ICE prioritization to fixes**

## Stage Benchmarks & Problem Thresholds

| Stage | Funnel Type | Normal Drop-off | Problem Drop-off | Likely Causes | Quick Fixes |
|-------|-------------|-----------------|------------------|---------------|------------|
| Visit→Lead | SaaS | 2-5% | >10% | Unclear value prop, slow page | Hero clarity, page speed |
| Lead→MQL | SaaS | 20-30% | >50% | Irrelevant follow-up, poor segmentation | Email nurture, ICP targeting |
| MQL→SQL | SaaS | 50-70% | >80% | Sales readiness, bad handoff | Lead scoring, sales call CTA |
| Browse→Add | E-com | 95-98% | >98% | High shipping cost, product options | Shipping estimate, reviews |
| Cart→Checkout | E-com | 50-70% | >80% | Payment options, account requirements | Guest checkout, PayPal |
| Checkout→Complete | E-com | 80-90% | <70% | Error messaging, trust signals | SSL badge, live support |
| Form Start→Complete | Lead Gen | 60-75% | >85% | Field count, validation errors | Field reduction, inline help |

## ICE Prioritization Framework

**Score each drop-off stage (1-10 scale, multiply for priority)**

| Metric | Definition | Scoring |
|--------|-----------|---------|
| **Impact** | Est. revenue/conversion lift if fixed | High (10): >5% lift, Medium (5): 2-5%, Low (1): <2% |
| **Confidence** | How certain is the diagnosis? | High (10): Clear data, Medium (5): Pattern evident, Low (1): Speculation |
| **Ease** | Effort to implement fix | High (10): <1 day, Medium (5): 1-3 days, Low (1): >1 week |

**Prioritize by: Impact × Confidence × Ease** (sort descending)

Example: Cart abandonment (10 Impact × 8 Confidence × 7 Ease) = **560 priority score**

## Funnel Analysis Checklist

- [ ] Collect conversion data for all funnel stages (GA4 or equivalent)
- [ ] Compare each stage against benchmark for your funnel type
- [ ] Identify stages with drop-off >30% above benchmark
- [ ] For each problem stage, collect qualitative data (session replay, surveys)
- [ ] Score top 3 issues using ICE framework
- [ ] Test highest-ICE fix first (usually quick win)
- [ ] Set 80% confidence rule: require data to diagnose, not assumptions
- [ ] Re-measure after each fix (minimum 7 days for statistical significance)
- [ ] Document all learnings for future audits
