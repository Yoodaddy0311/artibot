---
description: Email campaign creation with A/B testing, segmentation, automation sequences, and deliverability optimization
argument-hint: [campaign-type] [--segment] [--ab] [--automation] [--template]
allowed-tools: [Read, Write, Task, WebSearch, TodoWrite]
---

# /email

Full email marketing workflow from audience segmentation through campaign creation, A/B test design, and automation sequence building. Produces ready-to-deploy email assets with HTML templates.

## Arguments

Parse $ARGUMENTS:
- `campaign-type`: Email type - `newsletter` | `drip` | `announcement` | `onboarding` | `re-engagement` | `transactional` | `launch` | `nurture`
- `--segment [criteria]`: Audience segment - `all` | `active` | `churned` | `trial` | `enterprise` | custom criteria
- `--ab [element]`: A/B test element - `subject` | `cta` | `layout` | `timing` | `sender`
- `--automation`: Generate automation sequence with triggers and delays
- `--template [style]`: Email template style - `minimal` | `branded` | `rich` | `plain-text`
- `--tone [voice]`: Content tone - `professional` | `casual` | `urgent` | `educational` | `celebratory`
- `--series [n]`: Number of emails in sequence (default: 1, max: 12)

## Campaign Types

| Type | Purpose | Typical Series |
|------|---------|----------------|
| newsletter | Regular content updates | 1 (recurring) |
| drip | Nurture over time | 5-7 |
| announcement | Product/feature launch | 1-2 |
| onboarding | New user activation | 5-8 |
| re-engagement | Win back inactive users | 3-5 |
| transactional | Event-triggered notices | 1 |
| launch | Product launch sequence | 3-5 |
| nurture | Lead warming sequence | 7-12 |

## Agent Delegation

- Primary: `content-marketer` - Email copy and content creation
- Supporting: `data-analyst` - A/B test design and segment analysis

## Skills Required

- `email-marketing` - Email best practices, deliverability, CAN-SPAM compliance
- `ab-testing` - Statistical testing design, sample sizing, significance calculation
- `copywriting` - Persuasive writing, subject lines, CTAs

## Execution Flow

1. **Parse**: Extract campaign type, segment, A/B requirements, tone
2. **Research**: Benchmark subject line patterns, industry open rates, best send times
3. **Segment**: Define audience criteria and personalization variables
4. **Create**: Generate email content:
   - Subject line variants (3-5 options with A/B scoring rationale)
   - Preheader text
   - Email body with personalization tokens
   - CTA variants with placement recommendations
   - Plain-text fallback version
5. **Automate** (if `--automation`): Design sequence:
   - Trigger events and conditions
   - Delay intervals between emails
   - Branch logic (opened/clicked/ignored)
   - Exit conditions
6. **A/B Design** (if `--ab`): Specify test parameters:
   - Test hypothesis
   - Variants (control + treatment)
   - Sample size recommendation
   - Success metric and significance threshold
7. **Compliance Check**: Verify CAN-SPAM/GDPR compliance:
   - Unsubscribe link present
   - Physical address included
   - Permission-based sending confirmed
8. **Report**: Output email package with metrics predictions

## Output Format

```
EMAIL CAMPAIGN
==============
Type:       [campaign-type]
Segment:    [audience criteria]
Series:     [n emails]
Template:   [style]

EMAILS
------
Email 1: [subject line]
  Preheader: [text]
  Body: [content with {{personalization}} tokens]
  CTA: [primary CTA text] -> [URL placeholder]
  Send Time: [recommended time/day]

A/B TEST (if --ab)
------------------
Hypothesis: [what we're testing]
Variant A:  [control description]
Variant B:  [treatment description]
Sample:     [recommended size]
Duration:   [test period]
Metric:     [primary success metric]

AUTOMATION (if --automation)
----------------------------
Trigger: [event]
  -> [delay] -> Email 1: [subject]
  -> [delay] -> Email 2: [subject]
    -> IF opened: [branch A]
    -> IF not opened: [branch B]
  -> Exit: [condition]

COMPLIANCE
----------
CAN-SPAM:   [PASS|ISSUE]
GDPR:       [PASS|ISSUE]
Unsubscribe: [present|missing]

PREDICTIONS
-----------
Est. Open Rate:    [%] (industry avg: [%])
Est. Click Rate:   [%] (industry avg: [%])
Est. Conversion:   [%]
```

## Example Usage

```
/email onboarding --series 5 --automation --segment trial --tone educational
/email newsletter --ab subject --template branded --tone professional
/email launch --segment active --ab cta --tone urgent
/email re-engagement --segment churned --automation --series 3
```
