# Statistical Foundations for A/B Testing

**Underpowered tests (insufficient sample size) fail to detect real effects 80%+ of the time—always calculate sample size first.**

## Core Statistical Concepts

| Concept | Definition | Typical Value | Why It Matters |
|---|---|---|---|
| **Significance Level (α)** | Probability of claiming false positive (Type I error) | p < 0.05 (5%) | Controls false discovery rate; standard in industry |
| **Statistical Power (1 - β)** | Probability of detecting true effect if it exists | 80% (target) | Higher power = fewer missed real effects; 80% is practical standard |
| **Type I Error (False Positive)** | Concluding effect exists when it doesn't | 5% (α=0.05) | Risk of rolling out losing variant; controlled by α |
| **Type II Error (False Negative)** | Missing real effect (underpowered test) | 20% (β=0.20) | Risk of ditching winner; controlled by power (1-β) |
| **MDE (Minimum Detectable Effect)** | Smallest lift you want to detect reliably | 2-10% typical | Determines sample size; smaller MDE = larger sample needed |
| **Confidence Interval (CI)** | Range containing true effect with probability (1-α) | 95% CI standard | Interval not crossing zero indicates significance |
| **Effect Size (Cohen's d or relative lift)** | Magnitude of difference: (Test - Control) / Baseline | 0.2 (small), 0.5 (medium), 0.8 (large) | Determines power; larger effects need smaller samples |

## Sample Size Quick Reference

**Formula** (simplified for 2-group test):
```
n = 2 × (Z_α/2 + Z_β)² × (p₁ × (1-p₁) + p₂ × (1-p₂)) / (p₂ - p₁)²

Where:
  Z_α/2 = 1.96 (for α=0.05)
  Z_β = 0.84 (for power=80%)
  p₁ = control baseline conversion rate
  p₂ = expected test conversion rate
  n = sample size per group (double for both control + test)
```

### Baseline CVR 2% (Typical SaaS Trial Signup)

| MDE | Required Sample/Group | Total Duration (100K/day traffic) | Confidence |
|---|---|---|---|
| 1% relative (2.0% → 2.02%) | 196,000 | 3.9 days | p < 0.05, Power 80% |
| 2% relative (2.0% → 2.04%) | 49,000 | ~1 day | p < 0.05, Power 80% |
| 5% relative (2.0% → 2.10%) | 7,840 | 3.9 hours | p < 0.05, Power 80% |
| 10% relative (2.0% → 2.20%) | 1,960 | 1 hour | p < 0.05, Power 80% |

### Baseline CVR 5% (Typical E-Commerce Landing Page)

| MDE | Required Sample/Group | Total Duration (100K/day traffic) | Confidence |
|---|---|---|---|
| 1% relative (5.0% → 5.05%) | 78,400 | ~1.6 days | p < 0.05, Power 80% |
| 2% relative (5.0% → 5.10%) | 19,600 | 9.8 hours | p < 0.05, Power 80% |
| 5% relative (5.0% → 5.25%) | 3,136 | 1.6 hours | p < 0.05, Power 80% |
| 10% relative (5.0% → 5.50%) | 784 | 23 min | p < 0.05, Power 80% |

### Baseline CVR 10% (Typical E-Commerce Product Page)

| MDE | Required Sample/Group | Total Duration (100K/day traffic) | Confidence |
|---|---|---|---|
| 1% relative (10.0% → 10.1%) | 39,200 | ~12 hours | p < 0.05, Power 80% |
| 2% relative (10.0% → 10.2%) | 9,800 | 3 hours | p < 0.05, Power 80% |
| 5% relative (10.0% → 10.5%) | 1,568 | 28 min | p < 0.05, Power 80% |
| 10% relative (10.0% → 11.0%) | 392 | 7 min | p < 0.05, Power 80% |

## Confidence Interval Interpretation

**Example Test Result**:
- Control: 5.2% CVR (n=10,000)
- Test: 5.8% CVR (n=10,000)
- 95% CI for test: [5.4%, 6.2%]

| CI vs. Baseline | Interpretation | Action |
|---|---|---|
| Overlaps control (CI includes 5.2%) | Inconclusive; insufficient power | Continue test or accept null hypothesis |
| Above baseline, doesn't overlap (CI: [5.4%, 6.2%]) | Statistically significant; effect likely real | Deploy winner; calculate impact |
| Crosses zero after normalization | Not significant; no reliable difference | Keep control; test failed |

## Statistical Pitfalls & Mitigation

| Pitfall | Risk | Mitigation |
|---|---|---|
| **Peeking at Results** | Inflates Type I error; false confidence in winner at day 3 | Lock test duration upfront; use sequential testing framework |
| **Underpowered Test** | Miss real 5% lift (Type II error); keep loser as control | Calculate required sample size before launch |
| **Multiple Comparisons** | Testing 20 variants inflates false positive rate to 64% | Use Bonferroni correction (α/number of tests) or Bayesian methods |
| **Novelty Bias** | New variant outperforms for 1-2 weeks, reverts after | Test minimum 2 full business cycles (14+ days); exclude first 3 days |
| **Selection Bias** | Sample not random; only engaged users see test | Ensure random assignment; check traffic split 50/50 actual |
| **Seasonality Effect** | Test Mon-Fri behavior different from weekends | Ensure test includes full week; avoid partial weeks |

## Power Analysis & Sample Size Calculator Quick-Use

**Online Tool**: [Optimizely Stats Engine](https://www.optimizely.com/sample-size-calculator/) or similar

**Rule of Thumb** (rough check):
- 80% power, p=0.05: Need ~1,600 samples per variant for 5% baseline + 10% relative lift
- For smaller lift (5% relative): Multiply by 4 = 6,400 per variant
- For larger lift (20% relative): Divide by 4 = 400 per variant

---

## Decision Tree: Is My Test Powered Enough?

```
START: Test running?
  ├─ YES, reached planned sample size?
  │   ├─ YES → Check p-value
  │   │   ├─ p < 0.05 → Statistically Significant (deploy if business impact positive)
  │   │   └─ p ≥ 0.05 → Not Significant (keep control; test inconclusive)
  │   │
  │   └─ NO → How many more days?
  │       ├─ <2 days → Wait; don't peek
  │       └─ >7 days short → Underpowered; stop and replan
  │
  └─ NO (test not yet launched)
      └─ Calculate required sample size
          ├─ (Baseline × Expected Lift × [Formula]) ÷ Daily Visitors
          └─ If >30 days → MDE too small; increase target lift
```

---

**Reference**: Assumes Chi-square test (conversion rate testing). For continuous metrics (revenue, time-on-page) use t-tests. Last verified: Feb 2026.
