# Attribution Models Selection Guide

**Core Principle**: Choose ONE model and stick with it. Model consistency matters more than model perfection. Different models for different decisions (budget vs. channel vs. creative).

## Attribution Model Comparison

| Model | How It Works | Best For | Limitation | Business Type | Implementation |
|-------|------------|----------|-----------|----------------|-----------------|
| First-Touch | 100% credit to discovery source | Awareness campaigns | Ignores conversion driver | B2C awareness | Tag all entry pages |
| Last-Touch | 100% credit to conversion source | Direct response campaigns | Undervalues awareness | B2C performance | Native platform (default) |
| Linear | Equal credit (1/n) to all touches | Balanced multi-touch view | Assumes equal impact | B2B complex sales | Manual calculation |
| Time-Decay | More credit to recent touches (exponential) | Consideration phase focus | Requires lookback window | B2B/B2C hybrid | Set half-life = 7 days |
| Position-Based | 40% first, 40% last, 20% middle | Funnel optimization | Simplifies reality | B2B opportunity-based | Split 40-20-40 |
| Data-Driven | ML learns true contribution | Maximum accuracy | Requires 15K conversions/month | Enterprise scale | Use platform ML (Google, Meta) |

## Selection Decision Tree

```
START: Select Attribution Model
├─ Is sales cycle < 7 days? → Last-Touch
│
├─ Is sales cycle 7-30 days?
│  ├─ Multiple touchpoints important? → Linear
│  └─ Recent touches more important? → Time-Decay (half-life=7d)
│
└─ Is sales cycle > 30 days?
   ├─ Top-of-funnel optimization? → First-Touch
   ├─ Balanced view needed? → Position-Based (40-20-40)
   └─ >15K conversions/month + resources? → Data-Driven
```

## Model Selection Checklist

- [ ] Determine average sales cycle length (days from first touch to conversion)
- [ ] Count average touchpoints per customer (if >5, need multi-touch model)
- [ ] Verify data availability (at least 30 days historical data with UTM tracking)
- [ ] Calculate conversion volume (need minimum 100 conversions/month for reliability)
- [ ] Document channels included (organic/paid, online/offline, direct email)
- [ ] Set lookback window (typically 30-90 days before conversion)
- [ ] Choose single model (don't rotate models monthly, it confuses stakeholders)
- [ ] Create baseline (compare model results vs. platform native for first 2 weeks)
- [ ] Build visualizations (show model inputs: touchpoint sequence, timeline, channels)
- [ ] Review quarterly (validate model assumptions still hold true)
