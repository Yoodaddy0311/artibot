# Test Design Framework & Experiment Roadmap

**Structured test methodology increases learning rate 3-5x and prevents false conclusions from statistical flukes.**

## Test Design Workflow: Hypothesis → Test → Analyze → Learn → Iterate

### Phase 1: Hypothesis Definition

**Template**:
```
IF we [change X]
THEN [metric] will increase by [Y%]
BECAUSE [user insight/assumption]
```

**Example**:
- Change: Add social proof (3-star review badge) to checkout button
- Metric: Checkout completion rate
- Expected lift: +8% (conservative estimate from competitor benchmarking)
- Because: Users trust social proof; badge reduces checkout abandonment fear

**Hypothesis Scoring** (0-100, higher = higher priority):
- Expected impact × probability (e.g., 8% lift × 60% confidence = 4.8 expected value)
- Effort to implement (1-10 points; deduct from priority)
- Alignment with strategic goal (0-20 bonus points if revenue-critical)

---

## Phase 2: Test Type Selection

| Test Type | Design | Variables | Sample Split | Duration | Cost | Best For |
|---|---|---|---|---|---|---|
| **A/B (Simple)** | 1 control, 1 test variant | 1 element (button color, copy, layout) | 50/50 | 7-14 days | Low | Single high-impact change; fast decision |
| **A/B/n (Multi-Variant)** | 1 control, 3+ test variants | 1 element (3+ options) | Equal (e.g., 25% each) | 14-30 days | Medium | Optimal design selection (4 CTA copy options) |
| **Multivariate** | Factorial design; test multiple elements simultaneously | 2-3 elements × 2-3 levels each | Equal split across combinations | 21-45 days | High | Understand element interactions (color + copy + size) |
| **Bandit / Adaptive** | Dynamic allocation; learning algorithm shifts traffic to winners | 2+ variants | Unequal; favors winner mid-test | 7-14 days | Medium | High traffic; fast decision needed (homepage hero) |
| **Sequential** | Fixed target confidence; stop when statistical significance reached | 1 variant | 50/50 | 3-21 days (variable) | Low | Efficient power usage; early stopping rule |

### Test Type Decision Matrix

| Scenario | Recommendation | Why |
|---|---|---|
| 1 high-impact hypothesis, 2-week runway | A/B Simple | Fastest decision; lowest risk |
| 4 button copy variations; optimize headline | A/B/n Multi-Variant | Test all 4 options in parallel; find optimal |
| Testing button color + button copy interaction | Multivariate | Reveals if color effect depends on copy |
| 500K daily visitors; need answer in 3 days | Bandit | Allocates traffic to winner; faster decision |
| No fixed deadline; high traffic volume | Sequential | Stops when statistical significance hit automatically |

---

## Phase 3: Test Execution Parameters

### Traffic Allocation & Duration

**Rule of Minimum Duration**: Test ≥ 1 full business cycle (7 days minimum, include weekday + weekend)

| Traffic per Day | Min Days to Power (5% baseline, 10% MDE) | Recommended Test Duration |
|---|---|---|
| 10K | 5 days (100K samples) | 7-10 days (include 1+ business cycle) |
| 100K | 1 day (100K samples) | 7-14 days (avoid Monday-Wed skew) |
| 1M+ | <6 hours | 7-14 days (full week minimum) |

**Duration Considerations**:
- **Minimum**: 7 days (capture Mon-Sun variation)
- **Typical**: 14 days (2 business cycles; captures bi-weekly patterns)
- **Maximum**: 30 days (avoid novelty bias erosion or seasonal shifts)

### Sample Size Verification

```
Daily traffic × (test duration in days) × (% assigned to variant) = Sample size per variant

Example: 100K daily × 7 days × 50% = 350K samples per variant
Required per variant (from stat power calc): 100K (for 5% baseline + 10% lift target)
Status: POWERED ✅ (350K > 100K)
```

---

## Phase 4: Test Monitoring & Validation

### Early Stopping Criteria (DO NOT DEPLOY before addressing)

| Red Flag | Severity | Action |
|---|---|---|
| Traffic split ≠ expected (48/52 instead of 50/50) | Medium | Investigate assignment algorithm; ensure random allocation |
| First 48 hours: one variant 5%+ better than other | Medium | WAIT—likely novelty bias; continue test |
| Metric direction reversed mid-test (winner becomes loser) | High | STOP—technical issue likely (tracking error, external event) |
| External event during test (outage, competitor promo, campaign) | High | PAUSE or EXTEND—document event; consider separate cohort analysis |
| Baseline metric suddenly drops (CVR 5% → 2%) | High | STOP—data issue; audit tracking implementation |

### Segment Analysis (Planned, Not Post-Hoc)

**Pre-planned Segments** (document before launch):

| Segment | Size | Rationale | Expected Interaction |
|---|---|---|---|
| New visitors (first session) | ~40% of traffic | Ad message resonance; first impression critical | Larger effect expected (novelty) |
| Returning visitors (2+ sessions) | ~60% | Habit, brand familiarity reduces message impact | Smaller effect likely |
| Mobile traffic | ~60% typically | Device constraints; button size matters more | May differ by test type |
| Desktop traffic | ~40% typically | Screen space; full copy visible | Effect baseline |

**Analysis Rule**: Document segments before launching; don't fish for significant segments post-hoc (inflates false positives).

---

## Phase 5: Winner Analysis & Decision Framework

### Statistical Significance Criteria

**Criterion 1: p-value < 0.05**
```
Test metric: 5.8% CVR vs. Control: 5.2% CVR
p-value: 0.032 → SIGNIFICANT ✅
(Probability difference due to chance: 3.2%, acceptable)
```

**Criterion 2: 95% Confidence Interval doesn't cross zero**
```
Lift: +0.6 percentage points
95% CI: [+0.1%, +1.1%]
Crosses zero? NO → SIGNIFICANT ✅
```

**Criterion 3: Minimum Effect Size Reached**
```
Observed lift: +0.6 pp = 11.5% relative
Target MDE: 10% relative
Meets MDE? YES → SIGNIFICANT ✅
```

### Business Impact & Deployment Decision

| Stat Sig? | Business Impact | Decision |
|---|---|---|
| YES | Positive (lift >0) | DEPLOY winner |
| YES | Negative (lift <0) | DISCARD test variant; keep control |
| NO | But >0 observed | INCONCLUSIVE—repower test or archive for future analysis |
| NO | And <0 observed | FAIL—keep control; document learning |

---

## Phase 6: Documentation & Learning Loop

### Test Report Template (3-minute read)

```
HYPOTHESIS: [If we add social proof badge, checkout CVR will increase 8%]

RESULTS:
  Control CVR:  5.2% (n=10,000)
  Test CVR:     5.8% (n=10,000)
  Lift:         +11.5% relative (+0.6 pp absolute)
  p-value:      0.031 ✅ SIGNIFICANT
  Confidence:   95% CI [+0.1%, +1.1%]

SEGMENT ANALYSIS:
  New visitors: +15% lift (p=0.008) ← Highest impact
  Returning:    +8% lift (p=0.12) → Not significant separately

BUSINESS IMPACT:
  Lift × Annual Checkout Volume × AOV = $X annual revenue
  Example: 11.5% × 1M checkouts × $50 = $575K annual impact

NEXT STEPS:
  ✅ Deploy to 100% (gradual rollout 10%/day for 10 days)
  → Monitor CVR for deviation; set alert if drops below 5.0%
  → Analyze if new visitors sustained lift after 30 days

LEARNINGS:
  - Social proof works for cold visitors; consider different copy for returning users
  - Badge color/placement: test positioning next to optimize further (+5% potential upside)
```

### Iteration Roadmap

**Hypothesis 1 (Deployed)**: Social proof badge +11.5% ✅
  ├─ **Hypothesis 2**: Badge placement optimization (left vs. right) → A/B test (7 days)
  └─ **Hypothesis 3**: Different copy for returning users → Segment personalization

---

## Implementation Checklist

**Pre-Launch (Day -3)**:
- [ ] Hypothesis documented with rationale and expected lift
- [ ] Sample size calculated; test powered for target MDE
- [ ] Variant implementation validated (correct copy, design, tracking)
- [ ] Tracking confirmed (events firing correctly in analytics)
- [ ] Traffic split tested (50/50 ±2%)
- [ ] Minimum duration set (calendar hold: 7-14 days)

**During Test (Day 1-7+)**:
- [ ] No peeking at results before power threshold crossed
- [ ] Monitor tracking quality; alert if metric suddenly drops
- [ ] Log external events (campaigns, outages, competitor moves)
- [ ] Segment baseline documented (new vs. returning split observed)

**Post-Test Analysis (Day 7+)**:
- [ ] Statistical significance verified (p < 0.05 AND CI doesn't cross zero)
- [ ] Business impact calculated (revenue/engagement dollar impact)
- [ ] Segment differences analyzed (pre-planned segments only)
- [ ] Decision made: deploy, discard, or continue

**Post-Deployment (Day 14-30)**:
- [ ] Winner validated in production (confirm lift persists)
- [ ] Set monitoring alert if metric declines 5%+ (potential reversion)
- [ ] Next hypothesis prioritized from roadmap
- [ ] Learning documented (update playbook if unexpected interactions found)

---

**Reference**: Sequential testing adds complexity; start with fixed-horizon A/B for predictability. Last verified: Feb 2026.
