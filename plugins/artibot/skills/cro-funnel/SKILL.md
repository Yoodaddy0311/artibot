---
name: cro-funnel
description: |
  Multi-step funnel analysis, conversion drop-off identification, and funnel optimization strategies.
  Covers signup flows, onboarding funnels, checkout processes, and lead qualification pipelines.
  Auto-activates when: funnel analysis, conversion funnel, drop-off analysis, signup flow optimization, checkout optimization.
  Triggers: funnel, conversion funnel, drop-off, signup flow, checkout flow, onboarding funnel, pipeline, multi-step, funnel optimization, 퍼널, 전환 퍼널, 이탈 분석
level: 3
triggers:
  - "funnel"
  - "conversion funnel"
  - "funnel optimization"
  - "CRO"
  - "conversion rate"
agents:
  - "performance-engineer"
  - "code-reviewer"
tokens: "~4K"
category: "testing"
---

# CRO - Funnel Optimization

## When This Skill Applies
- Analyzing multi-step conversion funnels for drop-offs
- Optimizing signup, onboarding, and checkout flows
- Identifying and fixing conversion barriers at each stage
- Designing A/B tests for funnel improvement
- Benchmarking funnel performance against industry standards

## Core Guidance

### 1. Funnel Analysis Process
```
Map Funnel -> Measure Steps -> Identify Drop-offs -> Diagnose Causes -> Prioritize Fixes -> Test Improvements -> Validate -> Iterate
```

### 2. Common Funnel Types

| Funnel | Stages | Key Metric |
|--------|--------|-----------|
| Marketing | Visit -> Lead -> MQL -> SQL -> Customer | End-to-end CVR |
| Signup | Landing -> Registration -> Verification -> Onboarding | Signup completion % |
| Onboarding | Account -> Setup -> First Action -> Aha Moment -> Habit | Activation rate |
| E-commerce | Browse -> Cart -> Checkout -> Payment -> Confirmation | Cart-to-purchase % |
| SaaS Trial | Signup -> Activation -> Engagement -> Conversion | Trial-to-paid % |
| Lead Gen | Ad -> Landing -> Form -> Thank You -> Follow-up | Form completion % |

### 3. Funnel Analysis Template

```
STAGE          | USERS   | CVR     | DROP-OFF | BENCHMARK
---------------|---------|---------|----------|----------
[Stage 1]      | [count] | 100%    | --       | --
[Stage 2]      | [count] | [X]%    | [Y]%    | [Z]%
[Stage 3]      | [count] | [X]%    | [Y]%    | [Z]%
[Stage 4]      | [count] | [X]%    | [Y]%    | [Z]%
End-to-End     | [count] | [X]%    | [Y]%    | [Z]%

Biggest Drop-off: Stage [n] -> Stage [n+1] ([Y]% loss)
```

### 4. Drop-off Diagnostic Framework

| Symptom | Likely Causes | Investigation |
|---------|-------------|---------------|
| High bounce at entry | Mismatch with ad/source, slow load, unclear VP | Check source-page alignment, page speed |
| Registration abandonment | Too many fields, unclear value, no social login | Audit field count, test progressive profiling |
| Verification drop-off | Complex process, email delivery, friction | Test SMS vs email, simplify steps |
| Onboarding incomplete | Long process, unclear next steps, no motivation | Test guided tours, reduce steps |
| Cart abandonment | Unexpected costs, complex checkout, trust issues | Show costs early, simplify, add guarantees |
| Payment failure | Limited options, technical errors, security concerns | Add payment methods, fix errors, add badges |

### 5. Funnel Optimization Strategies

| Strategy | Description | Expected Lift |
|----------|-------------|---------------|
| Reduce Steps | Combine or eliminate unnecessary stages | 10-30% |
| Progressive Disclosure | Show only what's needed at each step | 5-15% |
| Social Login/SSO | Reduce registration friction | 15-25% |
| Progress Indicators | Show completion percentage | 5-10% |
| Smart Defaults | Pre-fill fields where possible | 5-15% |
| Exit-Intent Recovery | Capture abandoning users | 5-10% |
| Micro-Commitments | Small steps leading to bigger commitment | 10-20% |
| Urgency/Scarcity | Create time pressure at key steps | 5-15% |

### 6. Funnel Benchmarks

#### SaaS Signup Funnel
| Stage | Benchmark CVR |
|-------|--------------|
| Visit -> Signup | 2-5% |
| Signup -> Activation | 20-40% |
| Activation -> Engagement | 15-30% |
| Trial -> Paid | 10-25% |
| End-to-End | 0.5-3% |

#### E-commerce Checkout
| Stage | Benchmark CVR |
|-------|--------------|
| Product View -> Cart | 8-15% |
| Cart -> Checkout | 40-60% |
| Checkout -> Payment | 60-80% |
| Payment -> Confirmation | 90-95% |
| End-to-End | 2-4% |

#### Lead Generation
| Stage | Benchmark CVR |
|-------|--------------|
| Visit -> Form View | 30-60% |
| Form View -> Start | 40-70% |
| Form Start -> Submit | 60-85% |
| Submit -> Qualified | 20-40% |
| End-to-End | 3-8% |

### 7. Micro-Conversion Tracking

| Micro-Conversion | Stage | Indicates |
|-----------------|-------|-----------|
| Scroll depth >50% | Engagement | Content interest |
| CTA hover | Intent | Considering action |
| Form field focus | Initiation | Starting the process |
| Field completion | Progress | Moving forward |
| Error encounter | Friction | Potential drop-off |
| Back button click | Hesitation | Reconsidering |

### 8. A/B Test Prioritization for Funnels

**ICE Framework**: Impact (1-10) x Confidence (1-10) x Ease (1-10)

| Test Idea | Impact | Confidence | Ease | Score | Priority |
|-----------|--------|-----------|------|-------|----------|
| Reduce form fields | 8 | 7 | 9 | 504 | P1 |
| Add progress bar | 5 | 6 | 8 | 240 | P2 |
| Social login | 7 | 8 | 5 | 280 | P2 |
| Exit popup | 4 | 5 | 9 | 180 | P3 |

## Output Format
```
FUNNEL ANALYSIS
===============
Funnel:     [funnel type]
Period:     [date range]
Total Users:[count]
End-to-End: [%] CVR

STAGE ANALYSIS
--------------
Stage         | Users   | CVR    | Drop-off | vs Benchmark
--------------|---------|--------|----------|-------------
[stage]       | [count] | [%]    | [%]      | [above|below]

CRITICAL DROP-OFFS
------------------
Stage [n] -> [n+1]: [Y]% drop-off
  Root Cause: [diagnosis]
  Fix: [recommendation]
  Est. Lift: +[X]%

OPTIMIZATION PLAN
-----------------
Priority | Stage    | Action            | Est. Lift | Test
---------|---------|-------------------|----------|------
P1       | [stage] | [specific action] | +[X]%    | [A/B test]
```

## Quick Reference

**Funnel Types**: Marketing, Signup, Onboarding, E-commerce, SaaS Trial, Lead Gen
**Optimization Strategies**: Reduce steps, progressive disclosure, social login, progress indicators
**Prioritization**: ICE framework (Impact x Confidence x Ease)
**Key Insight**: Focus on the biggest drop-off stage first for maximum impact

See `references/funnel-benchmarks.md` for industry-specific funnel benchmarks.
See `references/optimization-playbook.md` for step-by-step funnel optimization guides.
