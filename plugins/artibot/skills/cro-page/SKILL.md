---
name: cro-page
description: |
  Landing page conversion rate optimization covering above-the-fold analysis, value proposition clarity, CTA optimization, and trust signals.
  Provides frameworks for page audit, heuristic analysis, and conversion barrier identification.
  Auto-activates when: landing page optimization, page conversion audit, CTA optimization, value proposition analysis.
  Triggers: landing page, page CRO, conversion rate, above the fold, value proposition, CTA optimization, hero section, trust signals, landing page audit, 랜딩페이지, 페이지 CRO, 전환율 최적화
level: 3
triggers:
  - "landing page"
  - "page optimization"
  - "CRO page"
  - "conversion page"
  - "page design"
agents:
  - "persona-frontend"
  - "persona-performance"
tokens: "~3K"
category: "testing"
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

See `references/page-audit-checklist.md` for comprehensive page audit template.
See `references/cta-formulas.md` for high-converting CTA patterns.
