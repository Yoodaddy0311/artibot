---
name: cro-forms
description: |
  Form optimization for lead generation, signups, and data collection with friction reduction and UX best practices.
  Covers field optimization, validation UX, progressive profiling, and form analytics.
  Auto-activates when: form optimization, lead capture form, signup form, form field reduction, form UX.
  Triggers: form optimization, form fields, lead form, signup form, contact form, form completion, form friction, progressive profiling, form UX, 폼 최적화, 양식, 리드 폼
level: 3
triggers:
  - "form optimization"
  - "form conversion"
  - "CRO form"
  - "form UX"
  - "form design"
agents:
  - "frontend-developer"
  - "tdd-guide"
tokens: "~3K"
category: "testing"
---

# CRO - Form Optimization

## When This Skill Applies
- Optimizing lead generation and signup forms
- Reducing form field count and friction
- Improving form validation and error handling UX
- Designing progressive profiling strategies
- Analyzing form abandonment and completion rates

## Core Guidance

### 1. Form Optimization Process
```
Audit Current Form -> Analyze Abandonment -> Identify Friction -> Reduce Fields -> Improve UX -> Test Changes -> Validate -> Iterate
```

### 2. Field Count Impact

| Fields | Avg Completion Rate | Recommendation |
|--------|-------------------|---------------|
| 1-3 | 25-30% | Best for top-of-funnel, signups |
| 4-5 | 20-25% | Good for lead gen with qualification |
| 6-7 | 15-20% | Acceptable for high-intent (demo, quote) |
| 8-10 | 10-15% | Only for high-value offers |
| 10+ | <10% | Avoid; use progressive profiling |

**Rule**: Every field removed can increase conversions 5-10%.

### 3. Field Necessity Audit

| Question | If Yes | If No |
|----------|--------|-------|
| Is it needed to fulfill the request? | Keep | Remove |
| Can it be auto-detected? | Auto-fill | Remove field |
| Can it be asked later? | Progressive profile | Remove from form |
| Is it truly needed for qualification? | Keep | Remove |
| Can a smart default work? | Default + optional change | Simplify |

### 4. Field Ordering Best Practices

| Position | Best Fields | Rationale |
|----------|-----------|-----------|
| First | Name, email (easy fields) | Build momentum |
| Middle | Company, role (medium effort) | Committed by now |
| Last | Phone, detailed questions | Foot-in-the-door effect |

**Rules**:
- Easy fields first, hard fields last
- Group related fields together
- Single-column layout (25% faster than multi-column)
- Label above field (vs. beside or inside)

### 5. Input Type Optimization

| Data Type | Best Input | Avoid |
|-----------|-----------|-------|
| Email | `type="email"` with validation | Free text |
| Phone | `type="tel"` with country code | Free text |
| Date | Date picker | Free text |
| Country | Dropdown with search | Long dropdown |
| Industry | Dropdown or radio (<7 options) | Free text |
| Budget | Range slider or radio | Free text |
| Message | Textarea with char count | No guidance |
| Yes/No | Toggle or radio | Dropdown |

### 6. Validation UX

| Practice | Impact | Implementation |
|----------|--------|---------------|
| Inline validation | +22% completion | Validate on field blur |
| Descriptive errors | +15% recovery | "Please enter a valid email" not "Invalid input" |
| Success indicators | +10% completion | Green check on valid field |
| Format hints | +12% reduction in errors | "e.g., john@company.com" |
| Preserve input on error | Critical | Never clear fields on validation failure |
| Scroll to first error | +8% recovery | Auto-scroll with highlight |

### 7. Progressive Profiling

**Concept**: Collect data over multiple interactions instead of all at once.

| Interaction | Data Collected | Form Size |
|------------|---------------|-----------|
| First visit | Email only | 1 field |
| Content download | Name, company | 2 fields |
| Webinar signup | Role, company size | 2 fields |
| Demo request | Phone, timeline, budget | 3 fields |

**Rules**:
- Never ask for data you already have
- Each interaction adds 1-3 fields max
- Higher intent = more fields acceptable
- Always provide clear value exchange for data

### 8. Form Analytics Metrics

| Metric | Formula | Good Benchmark |
|--------|---------|---------------|
| Form View Rate | Form views / Page views | 30-60% |
| Start Rate | Form interactions / Form views | 40-70% |
| Completion Rate | Submissions / Form starts | 60-85% |
| Abandonment Rate | 1 - Completion rate | 15-40% |
| Field Drop-off | Users stopping at field N | Varies |
| Error Rate | Errors / Submissions attempts | <10% |
| Time to Complete | Average seconds | <60s for short forms |

### 9. Form Design Patterns

| Pattern | When to Use | Benefit |
|---------|------------|---------|
| Single-step | <5 fields, simple data | Fast completion |
| Multi-step wizard | 6+ fields, complex data | Lower perceived effort |
| Conversational | B2C, casual brand | Higher engagement |
| Inline (in-content) | Blog CTAs, sidebar | Contextual capture |
| Popup/Modal | Exit intent, delayed trigger | Focused attention |
| Sticky bar | Persistent low-friction | Always available |

## Output Format
```
FORM OPTIMIZATION AUDIT
========================
Form Type:   [lead gen|signup|contact|demo|checkout]
Current Fields: [count]
Completion Rate: [%]
Score:       [/100]

FIELD ANALYSIS
--------------
Field           | Status    | Recommendation
----------------|-----------|----------------
[field name]    | [KEEP|REMOVE|MODIFY] | [rationale]

FRICTION POINTS
---------------
Issue           | Impact    | Fix                    | Est. Lift
----------------|-----------|------------------------|----------
[issue]         | [high/med]| [recommendation]       | +[X]%

OPTIMIZED FORM
--------------
Step [n]: [fields in this step]
  Field: [name] | Type: [input type] | Required: [Y/N]

RECOMMENDATIONS
---------------
Priority | Change             | Est. Lift
---------|-------------------|----------
P1       | [change]          | +[X]%
```

## Quick Reference

**Field Count Rule**: Every field removed = +5-10% conversions
**Field Order**: Easy first, hard last, single column
**Validation**: Inline, descriptive errors, preserve input on failure
**Progressive Profiling**: 1-3 new fields per interaction, match to intent level

See `references/form-patterns.md` for form design pattern examples.
See `references/field-optimization.md` for field-by-field optimization guide.
