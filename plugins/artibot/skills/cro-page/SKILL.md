---
context: fork
name: cro-page
description: "Optimizes landing page conversion rates covering above-the-fold analysis, value proposition clarity, CTA optimization, and trust signal placement with heuristic evaluation. Use when user asks about landing page optimization, page CRO, conversion rate, above the fold, CTA optimization, trust signals, hero section, 랜딩페이지, 페이지 CRO, or 전환율 최적화."
lang: [en, ko]
level: 3
triggers:
  - "landing page"
  - "page optimization"
  - "CRO page"
  - "conversion page"
  - "page design"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
agents:
  - "frontend-developer"
  - "performance-engineer"
tokens: "~3K"
category: "marketing"
source_hash: 69eb51e1
whenNotToUse: "Internal dashboards, admin panels, or developer tooling where conversion-rate optimization and persuasion heuristics are not relevant goals."
---

# CRO - Page Optimization

## When This Skill Applies
- Auditing landing pages for conversion barriers
- Optimizing above-the-fold content and layout
- Improving value proposition clarity and CTA effectiveness
- Evaluating trust signals and social proof placement
- Analyzing page speed impact on conversions

## Core Guidance

### 1. Page Audit Process
```
First Impression -> Value Proposition -> CTA Analysis -> Trust Signals -> Content Hierarchy -> Page Speed -> Mobile Check -> Recommendations
```

### 2. 5-Second Test Framework

Within 5 seconds, a visitor should understand:
1. **What** is this product/service?
2. **Who** is it for?
3. **Why** should I care (benefit)?
4. **What** should I do next (CTA)?

### 3. Above-the-Fold Checklist

| Element | Best Practice | Priority |
|---------|-------------|----------|
| Headline | Clear benefit, <10 words, matches ad/source | Critical |
| Subheadline | Explains how, supports headline | High |
| Hero Image/Video | Shows product in use or outcome | High |
| CTA Button | Contrasting color, action verb, above fold | Critical |
| Trust Indicator | Logo strip, testimonial snippet, stat | High |
| Navigation | Minimal or hidden (for landing pages) | Medium |

### 4. Value Proposition Scoring

| Criterion | Score (1-5) | Assessment |
|-----------|------------|-----------|
| Clarity | | Is the offering immediately clear? |
| Relevance | | Does it address visitor's need? |
| Uniqueness | | How is it different from alternatives? |
| Specificity | | Are claims backed by numbers/proof? |
| Urgency | | Is there a reason to act now? |

**Score Interpretation**: 20-25 (Excellent), 15-19 (Good), 10-14 (Needs Work), <10 (Major Issues)

### 5. CTA Optimization

| Factor | Low Conversion | High Conversion |
|--------|---------------|----------------|
| Text | "Submit", "Click Here" | "Start Free Trial", "Get My Report" |
| Color | Same as page palette | High contrast, stands out |
| Size | Small, hard to find | Large, prominent, above fold |
| Position | Below the fold only | Above fold + repeated |
| Count | Multiple competing CTAs | One primary CTA per section |
| Urgency | No urgency element | "Limited spots", countdown, scarcity |

### 6. Trust Signal Inventory

| Signal Type | Placement | Impact |
|------------|-----------|--------|
| Customer Logos | Below hero, above fold | High |
| Testimonials | Near CTA, with photos/names | High |
| Review Stars | Near headline or CTA | High |
| Security Badges | Near form/checkout | Medium-High |
| Case Study Links | Supporting content | Medium |
| Guarantees | Near CTA or footer | Medium |
| Media Mentions | Social proof section | Medium |
| User Count | Headline area or near CTA | Medium |

### 7. Page Speed Impact on Conversions

| Load Time | Conversion Impact |
|-----------|------------------|
| 0-2 seconds | Baseline (optimal) |
| 2-3 seconds | -7% conversion rate |
| 3-5 seconds | -16% conversion rate |
| 5-7 seconds | -26% conversion rate |
| 7+ seconds | -40%+ conversion rate |

### 8. Heuristic Evaluation Framework

| Heuristic | Question | Weight |
|-----------|----------|--------|
| Relevance | Does the page match the visitor's intent? | 25% |
| Clarity | Is the message clear without thinking? | 25% |
| Motivation | Are there compelling reasons to act? | 20% |
| Friction | Are there unnecessary barriers? | 20% |
| Distraction | Do elements compete for attention? | 10% |

**Score = Relevance + Clarity + Motivation - Friction - Distraction**

## Output Format
```
PAGE CRO AUDIT
==============
URL:        [page URL]
Type:       [landing page|product|pricing|signup]
Score:      [/100]

5-SECOND TEST
-------------
What:       [PASS|FAIL] - [notes]
Who:        [PASS|FAIL] - [notes]
Why:        [PASS|FAIL] - [notes]
CTA:        [PASS|FAIL] - [notes]

ABOVE THE FOLD
--------------
Element         | Status    | Recommendation
----------------|-----------|----------------
Headline        | [OK|FIX]  | [suggestion]
Value Prop      | [OK|FIX]  | [suggestion]
CTA             | [OK|FIX]  | [suggestion]
Trust Signals   | [OK|FIX]  | [suggestion]

FINDINGS
--------
[P1] [category]: [issue] -> [fix] (est. +[X]% lift)

RECOMMENDATIONS
---------------
Priority | Category | Action        | Est. Lift
---------|----------|---------------|----------
P1       | [cat]    | [action]      | +[X]%
```

## Quick Reference

**5-Second Test**: What, Who, Why, CTA -- all must be clear
**CTA Rules**: Contrast color, action verb, above fold, benefit-oriented
**Value Prop Score**: Clarity + Relevance + Uniqueness + Specificity + Urgency (25 max)
**Page Speed**: Every second over 2s costs ~7% conversions

---

## References

- See `${CLAUDE_SKILL_DIR}/references/heuristic-evaluation.md` for heuristic page evaluation framework
- See `${CLAUDE_SKILL_DIR}/references/trust-signals-inventory.md` for trust signal placement and impact inventory


## Rationalizations

The following table captures common excuses agents make to skip the rigor of this marketing practice, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "The hero looks great in design review." | Design review is not ATF performance review; hero must be validated on real devices within the 3-second attention window. |
| "One CTA per page is a rule we can break." | Multiple competing CTAs split attention and reduce primary conversion 10-25%; secondary CTAs belong below the fold or in a different weight. |
| "Social proof is optional if the product is strong." | Trust signals (testimonials, logos, counts) are heuristics that reduce purchase anxiety; their absence measurably increases bounce. |
| "Page speed is a dev problem, not CRO." | Every 100ms of LCP delay drops conversion 1-2%; Core Web Vitals are a CRO lever, not an engineering ticket. |
| "Our value prop is obvious from the product name." | Value prop must answer what/for-whom/why-better within 5 seconds; relying on the name loses 40%+ of first-time visitors. |
