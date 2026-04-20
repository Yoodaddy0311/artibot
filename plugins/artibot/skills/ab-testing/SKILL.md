---
context: fork
name: ab-testing
description: "Designs A/B tests with statistical methodology, sample sizing, and significance analysis covering hypothesis formulation, variant design, and result interpretation. Use when user asks about A/B test, split test, experiment design, hypothesis, statistical significance, sample size, multivariate test, AB 테스트, 실험 설계, or 통계적 유의성."
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "A/B test"
  - "split test"
  - "experiment"
  - "hypothesis"
  - "variant"
  - "statistical significance"
  - "sample size"
agents:
  - "code-reviewer"
  - "performance-engineer"
tokens: "~4K"
category: "testing"
source_hash: 701661e8
---

# A/B Testing

## When This Skill Applies
- Designing A/B or multivariate tests for campaigns
- Calculating sample sizes and test duration
- Formulating test hypotheses with measurable outcomes
- Analyzing test results for statistical significance
- Recommending test priorities by expected impact

## Core Guidance

### 1. A/B Test Process
```
Hypothesis -> Variant Design -> Sample Sizing -> Test Setup -> Run Test -> Analyze Results -> Implement Winner -> Document Learnings
```

### 2. Hypothesis Framework

**Template**: "If we [change X], then [metric Y] will [improve/decrease] by [estimated %] because [rationale based on evidence]."

| Component | Description | Example |
|-----------|-------------|---------|
| Change | What is being modified | "change CTA color to green" |
| Metric | Primary success metric | "click-through rate" |
| Direction | Expected outcome | "increase by 10-15%" |
| Rationale | Evidence-based reasoning | "green contrasts better with page design" |

### 3. Test Element Priorities

| Element | Impact Potential | Test Complexity | Priority |
|---------|-----------------|-----------------|----------|
| Value proposition / headline | High | Low | P1 |
| CTA text and placement | High | Low | P1 |
| Page layout / hero section | High | Medium | P1 |
| Form fields (count, order) | High | Medium | P2 |
| Social proof placement | Medium | Low | P2 |
| Image / visual content | Medium | Medium | P2 |
| Color scheme / button color | Low-Medium | Low | P3 |
| Microcopy / label text | Low | Low | P3 |

### 4. Sample Size Calculation

**Key Parameters**:
- **Baseline conversion rate**: Current performance
- **Minimum detectable effect (MDE)**: Smallest meaningful improvement
- **Statistical significance**: Typically 95% (alpha = 0.05)
- **Statistical power**: Typically 80% (beta = 0.20)

**Quick Reference Table** (95% confidence, 80% power):

| Baseline CVR | MDE 5% relative | MDE 10% relative | MDE 20% relative |
|-------------|-----------------|------------------|------------------|
| 1% | ~1,500K/variant | ~380K/variant | ~95K/variant |
| 5% | ~60K/variant | ~15K/variant | ~4K/variant |
| 10% | ~28K/variant | ~7K/variant | ~1.8K/variant |
| 20% | ~12K/variant | ~3K/variant | ~800/variant |

### 5. Test Duration Guidelines

**Minimum**: 1 full business week (capture day-of-week effects)
**Maximum**: 4 weeks (avoid history effects and novelty bias)
**Rule**: Run until BOTH conditions met:
1. Required sample size reached
2. At least 7 days of data collected

### 6. Common Test Types

| Test Type | Variants | Best For |
|-----------|----------|---------|
| A/B | 2 (control + treatment) | Single element tests |
| A/B/C | 3+ | Multiple approaches to same element |
| Multivariate | Combinations of elements | Testing interactions between elements |
| Bandit | Dynamic allocation | Optimizing during test |

### 7. Result Analysis

**Winner Criteria**:
- Statistical significance >= 95%
- Practical significance (lift is meaningful for business)
- Consistent across segments
- No negative impact on secondary metrics

**Common Pitfalls**:
- Peeking at results before reaching sample size (inflated false positives)
- Running tests too short (novelty effect, day-of-week bias)
- Testing too many variants (diluted traffic, longer duration)
- Ignoring secondary metrics (winning CTR but losing revenue)
- Not segmenting results (overall winner may lose in key segments)

### 8. Documentation Template

```
TEST: [Test Name]
Hypothesis: [If/then/because statement]
Element:    [What is being tested]
Metric:     [Primary success metric]
Duration:   [Start - End dates]
Sample:     [Required per variant]

Variant A (Control): [Description]
Variant B (Treatment): [Description]

Results:
  Variant A: [metric] = [value] (n = [sample])
  Variant B: [metric] = [value] (n = [sample])
  Lift:      [+/- X%]
  Confidence: [X%]
  Status:    [WINNER|INCONCLUSIVE|LOSER]

Learnings: [Key takeaway for future tests]
```

## Output Template

```
A/B TEST ANALYSIS REPORT
=========================
Test ID:     [test-id]
Hypothesis:  [if X then Y because Z]
Duration:    [start] -> [end] ([n] days)
Sample Size: Control [n] / Variant [n]
Status:      [RUNNING | CONCLUDED | STOPPED]

RESULTS SUMMARY
───────────────
Metric         | Control | Variant | Delta  | Confidence | Significant?
───────────────|─────────|─────────|────────|────────────|─────────────
[primary KPI]  | [value] | [value] | [+/-%] | [%]        | [YES|NO]
[secondary KPI]| [value] | [value] | [+/-%] | [%]        | [YES|NO]

GUARDRAIL METRICS (must not degrade)
─────────────────────────────────────
Metric          | Baseline | Current | Status
────────────────|──────────|─────────|───────
[guardrail 1]   | [value]  | [value] | [OK | DEGRADED | BREACHED]
[guardrail 2]   | [value]  | [value] | [OK | DEGRADED | BREACHED]

DECISION MATRIX
───────────────
             | Significant     | Not Significant
─────────────|─────────────────|─────────────────
Positive     | SHIP            | EXTEND (need more data)
Negative     | STOP            | EXTEND or REDESIGN
Guardrail Hit| STOP            | STOP

RECOMMENDATION: [SHIP | EXTEND | STOP | REDESIGN]
Rationale:     [1-2 sentence justification]

NEXT STEPS
──────────
[1] [action based on decision]
[2] [follow-up test or rollout plan]
[3] [monitoring plan post-ship]
```

## Quick Reference

**Hypothesis Template**: "If we [change], then [metric] will [direction] by [%] because [evidence]"
**Confidence Level**: 95% standard, 99% for high-stakes
**Power**: 80% standard, 90% for critical tests
**Duration**: 7-28 days, minimum 1 full week

---

## References

- See `${CLAUDE_SKILL_DIR}/references/statistical-foundations.md` for statistical foundations for A/B testing
- See `${CLAUDE_SKILL_DIR}/references/test-design-framework.md` for test design framework and experiment roadmap


## Rationalizations

The following table captures common excuses agents make to skip the rigor of this marketing practice, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "The trend already looks clear, let's call it." | Early peeking inflates false positives 3-5x; significance must be evaluated only at the pre-declared sample size or via sequential testing with alpha-spending. |
| "p < 0.05, so we have a winner." | p-value without effect size, CI width, and power analysis is meaningless; report lift, confidence interval, and minimum detectable effect together. |
| "We don't need a pre-registered hypothesis." | Without a written hypothesis, primary metric, and stopping rule before launch, any positive result is indistinguishable from HARKing (hypothesizing after results known). |
| "Novelty effect will wear off, ship it anyway." | Novelty and primacy effects require a minimum 1-2 full business cycles of observation; shipping early bakes in regression risk. |
| "Sample size calculators are overkill for this test." | Running underpowered tests wastes traffic and produces coin-flip conclusions; MDE-based sizing is 5 minutes and non-negotiable. |
