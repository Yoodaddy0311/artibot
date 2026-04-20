# Bidding Strategy & Audience Targeting Guide

**Match bidding algorithm to campaign objective and budget type—wrong strategy alignment wastes 20-40% of spend.**

## Bidding Strategy Selector

| Strategy | Algorithm | Best For | Budget Type | KPI Target | Setup Time |
|----------|-----------|----------|-------------|-----------|------------|
| Manual CPC | Fixed bid per click | Testing, niche audiences | Limited | CTR focus | 5 min |
| Enhanced CPC | Auto-adjusts ±15% per signal | Steady-state campaigns | Flexible | CVR balance | 10 min |
| Target CPA | Learns conversion value | Lead gen, sales channels | Flexible | Cost/conversion | 1-2 weeks |
| Target ROAS | Maximizes revenue per ad spend | E-commerce, product sales | Flexible | Return ratio | 2-4 weeks |
| Maximize Conversions | Spends all budget for max conversions | Conversion velocity required | Fixed daily | Volume | 1 week |
| Maximize Clicks | Spends all budget for max clicks | Awareness, traffic only | Fixed daily | Traffic | 3 days |
| Maximize Impressions | Cost-per-thousand impressions (CPM) | Awareness, brand recall | Fixed daily | Reach | Real-time |

## Audience Targeting Layers (Funnel Model)

**Layer 1: Demographic (Reach)**
- Age ranges: 18-24, 25-34, 35-44, 45-54, 55-64, 65+
- Gender: Male, Female, All
- Parental status: Parent, non-parent (Meta only)
- Household income: Top 10%, 10-25%, 25-50% (LinkedIn)

**Layer 2: Interest & Affinity (Qualification)**
- Behavior: Purchase history, brand affinity, frequent buyer (30-day active)
- In-market intent: Researching category, comparing competitors, ready to buy
- Custom intent: Brand website visitors, cart abandoners, past converters
- Lookalike scope: 1% (highest match) → 5% (broader reach) [expansion strategy]

**Layer 3: Intent & Keywords (Specificity)**
- Search keywords: High intent (buy, trial, demo, pricing keywords)
- Placement targeting: Competitor domains, industry publications, owned properties
- Topic/category: Auto, home, finance, tech, beauty (platform varies)
- Negative keywords: Generic terms, low-intent variants, competitor defense

**Layer 4: Engagement & Remarketing (Re-conversion)**
- Website visitors: All, specific pages (product, pricing, checkout), recency (7/14/30d)
- App users: High-value segment, installer-only, past purchasers
- Customer match: Email list upload, CRM segments, first-party data
- Sequential remarketing: Add-to-cart → viewed product → homepage visitor

**Layer 5: Lookalike & Expansion (Scale)**
- Lookalike (Google): 1% (precision), 3% (balance), 5% (reach)
- Lookalike (Meta): 1% (high match), 5% (mid), 10% (broad)
- Similar audiences (LinkedIn): Seed from engaged audiences, expand 2-3% per iteration
- In-market (expansion): Broaden from convert-focused to research-phase audience

## Targeting Combination Matrix (Audience + Bidding)

| Audience Type | Size Impact | Bidding Strategy | Max CPC | Frequency Cap |
|---|---|---|---|---|
| High-intent (Layer 3 only) | 500K-2M | Manual CPC / ECPC | $2-8 | 3/day |
| Retargeting (Layer 4 only) | 50K-500K | Target CPA / ROAS | $1-5 | 5/day |
| Lookalike 1% (Layer 5) | 100K-500K | Enhanced CPC | $1-3 | 2/day |
| Demographic + Interest (L1+L2) | 2M-50M+ | Maximize Conversions | Auto | 1/day |
| Broad + Negative keywords (L3) | 10M-100M+ | Target CPA | Auto | 1/day |
| Stacked (L1+L2+L3) | 500K-5M | Enhanced CPC | $0.50-2 | 2/day |
| Exclusion-heavy (L1+L3+Neg) | 50K-500K | Manual CPC | $3-10 | 4/day |

## Bid Adjustment Rules

**Time of day**: -30% to +50% (adjust for conversion window)
- Morning (6am-9am): +20% for B2B, -15% for B2C
- Business hours (9am-5pm): +30% for work-related, -10% for leisure
- Evening (5pm-9pm): +40% for B2C, -20% for B2B
- Night (9pm-6am): -50% (reduce wasted spend unless 24/7 audience)

**Device**: Mobile typically converts lower (reduce 10-20% unless mobile-optimized)
- Desktop: Baseline
- Mobile: -15% to +10% (depends on site experience)
- Tablet: -5% to +5%

**Network**: Search vs. Display perform differently
- Search Network: Higher intent, baseline
- Display Network: -25% to -40% (awareness, lower conversion)
- YouTube: -10% to -20% (video pre-roll lower CVR)

## Implementation Checklist

**Week 1-2: Manual/ECPC Setup**
- [ ] Campaign objective aligned to strategy (awareness, traffic, conversion, sales)
- [ ] Daily budget set to 3× typical daily ad spend (buffer for algorithm learning)
- [ ] Bidding strategy selected + Max CPC set to 2× historical average
- [ ] 4+ audience layers defined (demographic + interest + intent minimum)
- [ ] Negative keywords added (100+ for search, 20+ for display)

**Week 3-6: Learning Phase**
- [ ] At least 50 conversions collected (for CPA/ROAS models)
- [ ] CTR monitored (expect 10-15% lift by week 4)
- [ ] Audience performance compared; worst 20% excluded
- [ ] Bid adjustments applied by time-of-day (±15%)

**Week 7+: Optimization**
- [ ] Shift to Target CPA/ROAS if conversion volume allows (≥30 conversions/week)
- [ ] Lookalike audience created from best converters; scale to 3% cohort
- [ ] Frequency capped if same user seeing >5/day (burnout risk)
- [ ] ROAS target set ±10% from historical performance (avoid aggressive cutoff)

---

**Reference**: Bidding strategies learn 10-14 days minimum. Avoid switching mid-cycle. Last verified: Feb 2026.
