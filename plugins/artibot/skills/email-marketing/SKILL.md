---
context: fork
name: email-marketing
description: "Creates email campaigns, automation sequences, and deliverability optimization covering drip campaigns, newsletters, onboarding, and cold outreach with compliance best practices. Use when user asks about email campaign, newsletter, drip sequence, email automation, deliverability, cold outreach, 이메일 마케팅, 이메일 캠페인, 뉴스레터, or 자동화 시퀀스."
lang: [en, ko]
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "email"
  - "email campaign"
  - "newsletter"
  - "email marketing"
  - "drip campaign"
  - "email sequence"
agents:
  - "doc-updater"
tokens: "~3K"
category: "marketing"
source_hash: b6ebf44a
whenNotToUse: "Internal team communications, transactional system notifications, or developer-facing alerts that are not part of a marketing or nurture campaign."
---

# Email Marketing

## When This Skill Applies
- Creating email campaigns (newsletters, announcements, launches)
- Designing automation/drip sequences with trigger logic
- Optimizing email deliverability and engagement rates
- Ensuring CAN-SPAM/GDPR compliance
- Designing email A/B tests

## Core Guidance

### 1. Email Campaign Process
```
Define Goal -> Segment Audience -> Write Copy -> Design Template -> Set Automation -> A/B Test -> Send -> Analyze
```

### 2. Campaign Types

| Type | Purpose | Typical Series | Key Metric |
|------|---------|---------------|------------|
| Newsletter | Regular engagement | 1 (recurring) | Open rate |
| Drip/Nurture | Lead warming | 5-7 emails | Click-through rate |
| Onboarding | User activation | 3-5 emails | Activation rate |
| Launch | Product/feature announce | 3-4 emails | Conversion rate |
| Re-engagement | Win back inactive | 3 emails | Reactivation rate |
| Transactional | Triggered by action | 1 per event | Delivery rate |
| Cold Outreach | B2B prospecting | 3-5 emails | Reply rate |

### 3. Email Structure Best Practices

**Subject Line**: 30-50 characters, personalization, urgency or curiosity
**Preheader**: 40-100 characters, extends subject line value
**Body**: Single column, scannable, one primary CTA
**CTA**: Action-oriented, contrasting color, above the fold
**Footer**: Unsubscribe link, physical address, preference center

### 4. Automation Sequence Design

```
Trigger Event
  -> [Delay: 0-24h] -> Email 1: Welcome/Hook
  -> [Delay: 2-3d]  -> Email 2: Value/Education
  -> [Delay: 2-3d]  -> Email 3: Social Proof
    -> IF clicked:  -> Email 4a: Offer/CTA
    -> IF not opened: -> Email 4b: Re-engage (new subject)
  -> [Delay: 3-5d]  -> Email 5: Final push/Summary
  -> Exit: Converted OR unsubscribed OR sequence complete
```

**Branch Logic**:
- Opened -> continue sequence
- Clicked CTA -> accelerate to conversion email
- Not opened after 2 sends -> switch subject line angle
- Unsubscribed -> exit immediately
- Converted -> move to post-purchase sequence

### 5. Deliverability Checklist

- [ ] SPF, DKIM, DMARC records configured
- [ ] Sending domain warmed up (if new)
- [ ] List hygiene: remove bounces, unengaged (>90 days)
- [ ] Text-to-image ratio: 60/40 minimum
- [ ] Spam score check before sending
- [ ] Unsubscribe link prominent and functional
- [ ] Physical mailing address included
- [ ] No purchased or scraped email lists

### 6. Personalization Tokens

| Token | Description | Example |
|-------|-------------|---------|
| `{{first_name}}` | Recipient first name | "Hi Sarah" |
| `{{company}}` | Company name | "How {{company}} can grow" |
| `{{industry}}` | Industry vertical | "{{industry}} trends for 2026" |
| `{{last_action}}` | Last engagement | "Since you {{last_action}}" |
| `{{custom_field}}` | Any CRM field | Dynamic content blocks |

### 7. Industry Benchmarks

| Metric | B2B Average | B2C Average | Top Quartile |
|--------|------------|------------|-------------|
| Open Rate | 21% | 18% | 30%+ |
| Click Rate | 2.5% | 2.1% | 5%+ |
| Unsubscribe | 0.3% | 0.2% | <0.1% |
| Bounce Rate | 0.7% | 0.5% | <0.3% |
| Conversion | 1-3% | 2-5% | 5%+ |

### 8. Compliance Requirements

| Regulation | Key Requirements |
|-----------|-----------------|
| CAN-SPAM | Unsubscribe within 10 days, physical address, no deceptive headers |
| GDPR | Explicit consent, right to erasure, data portability, DPO contact |
| CASL | Express/implied consent tracking, consent expiry management |
| CCPA | Opt-out mechanism, data disclosure on request |

## Output Format
```
EMAIL CAMPAIGN
==============
Type:       [campaign type]
Segment:    [audience criteria]
Series:     [n emails]

EMAILS
------
Email [n]: [subject line]
  Preheader: [text]
  Body: [content with {{tokens}}]
  CTA: [text] -> [URL]
  Send Time: [recommended]

AUTOMATION (if sequence)
------------------------
Trigger: [event]
  -> [delay] -> Email 1
  -> [delay] -> Email 2
    -> IF [condition]: [branch]

COMPLIANCE
----------
CAN-SPAM: [PASS|ISSUE]
GDPR:     [PASS|ISSUE]
```

## Quick Reference

**Campaign Types**: newsletter, drip, onboarding, launch, re-engagement, transactional, cold-outreach
**Key Metrics**: open rate, click rate, conversion rate, unsubscribe rate, deliverability
**Compliance**: CAN-SPAM, GDPR, CASL, CCPA

---

## Rules

- Always include a functional unsubscribe link and physical mailing address in every email.
- Always verify subject lines are under 50 characters.
- Always declare compliance status (CAN-SPAM, GDPR) in the output.
- Always segment the audience before sending; batch-and-blast is never acceptable.
- Always include a plain-text alternative alongside HTML.
- Never exceed 50-word subject lines.
- Never send to purchased or scraped email lists.
- Never skip SPF, DKIM, and DMARC verification for the sending domain.
- Never omit A/B test variants for subject lines in campaigns over 1,000 recipients.
- Never design an automation sequence without explicit exit criteria.

## Iteration

After delivering the first draft:
1. Ask if changes are needed
2. Apply feedback and regenerate
3. Maximum 3 revision rounds
4. On round 3, deliver final with "this is the final version" note

## References

- See `${CLAUDE_SKILL_DIR}/references/campaign-types-guide.md` for campaign types guide
- See `${CLAUDE_SKILL_DIR}/references/deliverability-checklist.md` for deliverability checklist


## Rationalizations

The following table captures common excuses agents make to skip the rigor of this marketing practice, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "Send frequency doesn't matter if content is good." | Send frequency drives list fatigue and unsubscribe rates independently of content quality; cadence must be tested per segment. |
| "Open rates are the main KPI." | Open rates became unreliable after Apple MPP (2021); click rate, reply rate, and conversion are the true health metrics now. |
| "Skip the plain-text version, everyone uses HTML." | Missing plain-text alternative triggers spam filters and excludes screen readers; multipart/alternative is a deliverability baseline. |
| "We don't need authentication records, our ESP handles it." | SPF, DKIM, and DMARC must be aligned for your sending domain; ESP defaults alone produce Gmail/Yahoo bulk-sender violations since 2024. |
| "Batch-and-blast is faster than segmentation." | Batch sends pollute engagement reputation with disinterested subscribers; segmented sends yield 2-5x revenue per send. |
