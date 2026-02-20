---
description: Conversion rate optimization for landing pages, signup flows, forms, onboarding, and pricing pages
argument-hint: '[target] e.g. "랜딩페이지 전환율 개선"'
allowed-tools: [Read, Write, Glob, Grep, Bash, Task, WebSearch, TaskCreate]
---

# /cro

Analyzes and optimizes conversion funnels, landing pages, signup flows, forms, and pricing pages. Produces prioritized recommendations with A/B test hypotheses. Based on 6 CRO patterns: page-cro, signup-flow-cro, onboarding-cro, form-cro, popup-cro, paywall-upgrade-cro.

## Arguments

Parse $ARGUMENTS:
- `target-type`: CRO target - `landing-page` | `signup-flow` | `onboarding` | `form` | `pricing` | `checkout` | `popup`
- `--url [target]`: URL of page to analyze
- `--funnel [stages]`: Funnel stages to audit (comma-separated)
- `--ab-test`: Generate A/B test hypotheses with recommended variants
- `--benchmark [industry]`: Industry benchmark for comparison
- `--focus [area]`: Focus area - `copy` | `layout` | `cta` | `trust` | `speed` | `mobile` | `all`
- `--data [source]`: Existing analytics data for the page/funnel

## Target Types

| Target | Audit Focus | Key Metrics |
|--------|-------------|-------------|
| landing-page | Hero, value prop, social proof, CTA | Conversion rate, bounce rate |
| signup-flow | Step count, friction, progressive disclosure | Completion rate, drop-off per step |
| onboarding | Time-to-value, activation, personalization | Activation rate, time-to-first-value |
| form | Field count, labels, validation, smart defaults | Completion rate, field abandonment |
| pricing | Plan comparison, anchor pricing, trust signals | Plan selection rate, upgrade rate |
| checkout | Cart abandonment, payment options, urgency | Checkout completion, cart recovery |
| popup | Trigger timing, relevance, offer value | Conversion rate, dismiss rate |

## Agent Delegation

- Primary: `cro-specialist` - Conversion analysis and recommendations
- Supporting: `content-marketer` - Copy optimization
- Supporting: `data-analyst` - Funnel data analysis

## Skills Required

- `cro-page` - Landing page conversion optimization, above-the-fold analysis
- `cro-funnel` - Multi-step funnel analysis, drop-off identification
- `cro-forms` - Form field optimization, friction reduction
- `ab-testing` - Hypothesis design, test methodology

## Execution Flow

1. **Parse**: Extract target type, URL, funnel definition, focus area
2. **Audit**: Analyze current state:
   - **Landing Page**: Hero section, value proposition clarity, social proof, CTA prominence, page speed, mobile responsiveness
   - **Signup Flow**: Step count, field count, friction points, progressive disclosure, error handling
   - **Onboarding**: Time-to-value, activation metrics, drop-off points, personalization
   - **Form**: Field count, label clarity, validation UX, smart defaults, field ordering
   - **Pricing**: Plan comparison clarity, anchor pricing, CTA differentiation, trust signals
   - **Checkout**: Cart abandonment triggers, payment options, trust signals, urgency elements
   - **Popup**: Trigger timing, relevance, offer value, exit intent, frequency
3. **Benchmark**: Compare against industry conversion rates
4. **Prioritize**: Score recommendations by impact x effort:
   - Quick wins (high impact, low effort) -> P1
   - Strategic improvements (high impact, high effort) -> P2
   - Incremental gains (low impact, low effort) -> P3
5. **A/B Hypotheses** (if `--ab-test`): Generate test plans:
   - Hypothesis statement
   - Control vs treatment description
   - Primary metric
   - Sample size estimate
   - Expected lift range
6. **Report**: Output structured CRO audit

## Output Format

```
CRO AUDIT REPORT
=================
Target:     [target-type]
URL:        [page URL]
Focus:      [area]
Score:      [conversion health score /100]

CURRENT STATE
-------------
Metric          | Value    | Benchmark | Status
----------------|----------|-----------|-------
Conversion Rate | [%]      | [%]       | [above|below]
Bounce Rate     | [%]      | [%]       | [above|below]
Time on Page    | [sec]    | [sec]     | [above|below]
Form Completion | [%]      | [%]       | [above|below]

FINDINGS
--------
[P1] [Quick Win] [copy|layout|cta|trust|speed|mobile]
  Issue:  [description]
  Impact: [estimated conversion lift]
  Fix:    [specific recommendation]

[P2] [Strategic] [category]
  Issue:  [description]
  Impact: [estimated conversion lift]
  Fix:    [specific recommendation]

A/B TEST HYPOTHESES (if --ab-test)
-----------------------------------
Test 1: [name]
  Hypothesis: "If we [change], then [metric] will [improve] because [rationale]"
  Control:    [current state]
  Treatment:  [proposed change]
  Metric:     [primary success metric]
  Est. Lift:  [+X% to +Y%]
  Duration:   [recommended test period]

RECOMMENDATIONS SUMMARY
------------------------
Priority | Category | Recommendation        | Est. Lift
---------|----------|-----------------------|----------
P1       | [cat]    | [specific action]     | +[X]%
P2       | [cat]    | [specific action]     | +[X]%
```

## Example Usage

```
/cro landing-page --url example.com/signup --ab-test --focus all
/cro signup-flow --funnel "landing,register,verify,onboard" --data @analytics/signup.csv
/cro pricing --url example.com/pricing --ab-test --benchmark saas
/cro form --url example.com/contact --focus mobile,speed
/cro onboarding --funnel "signup,setup,first-action,aha-moment" --ab-test
```
