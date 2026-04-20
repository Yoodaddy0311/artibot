# Field Optimization & Completion Rate Guide

**Core: Completion rate drops exponentially with field count—strategically reduce and order fields for maximum conversion**

## Completion Rate by Field Count

| Field Count | SaaS Benchmark | E-commerce Benchmark | Lead Gen Benchmark | Strategy |
|-------------|----------------|----------------------|-------------------|----------|
| 1-3 fields | 75-85% | 85-90% | 45-55% | Optimal—use whenever possible |
| 4-6 fields | 60-70% | 70-80% | 25-35% | Acceptable—break into steps if possible |
| 7-9 fields | 40-50% | 50-65% | 10-20% | High friction—progressive profiling |
| 10+ fields | <25% | <40% | <10% | AVOID—multi-step mandatory |

**Rule of thumb:** Every additional field = -5% completion rate on average

## Field Type Decision Matrix

| Field Type | Best Input Method | Auto-fill? | Necessity Test | Mobile UX |
|------------|------------------|-----------|---------------|-----------|
| Email | Email (native) | Yes | Always required | Input[type=email] |
| Name | Text (single) | Yes (if available) | High: yes, Low: optional | Split first/last only |
| Phone | Tel (native, +country) | Yes | Geographic: required, Global: optional | Mask format |
| Company | Text (autocomplete) | Yes | B2B: required, B2C: delete | Dropdown (500+ options) |
| State/Province | Select (dropdown) | Yes | Shipping-dependent: required | Hidden unless address entered |
| Zip Code | Text (masked) | Yes | Shipping required: yes | Hide if state not entered |
| Password | Password (strength meter) | No | Only if sign-up, not lead gen | Show/hide toggle |
| Checkbox (terms) | Single checkbox | No | Legal required, optional preferred | Required for sign-up only |

## Field Ordering Rules

**Principle: Easy → Hard, Required → Optional**

**Optimal Order:**
1. Email (fastest, recognizable)
2. First Name (social normalization)
3. Last Name (completes context)
4. Company (B2B only, required)
5. Password (sign-up forms only)
6. State/Province (if shipping, conditional)
7. Checkboxes (terms, consent—last)

**Label Positioning:** Place labels above field (not inside placeholder) on mobile; left-aligned on desktop

## Field Optimization Checklist

- [ ] Minimum viable form: 3 fields or less for lead capture
- [ ] All auto-fillable fields marked with autocomplete attribute
- [ ] Single-column layout on mobile (test at 375px width)
- [ ] Labels visible, not hidden in placeholders
- [ ] Required fields marked with asterisk or "Required"
- [ ] Optional fields labeled "(Optional)" to clarify
- [ ] Field descriptions (help text) appear on focus, not at page load
- [ ] Phone field includes country code selector or mask
- [ ] Dropdown instead of text for >10 predefined options (state, country)
- [ ] Conditional fields hidden until parent field completed
- [ ] Form width 300-500px maximum (wider = harder to scan)
- [ ] No CAPTCHA unless spam detected (kills conversion)
