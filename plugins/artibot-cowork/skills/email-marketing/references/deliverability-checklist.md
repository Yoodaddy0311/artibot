# Deliverability Checklist

**Core: Deliverability = Authentication + List Hygiene + Content Quality. Fail any pillar, land in spam.**

## Authentication Setup

| Protocol | Purpose | Record Type | Priority |
|----------|---------|-------------|----------|
| **SPF** | Authorize sending IPs | TXT on domain DNS | Critical |
| **DKIM** | Cryptographic signature verification | TXT (public key) | Critical |
| **DMARC** | Policy for auth failures | TXT (`_dmarc.domain`) | Critical |
| **BIMI** | Brand logo in inbox | TXT + SVG certificate | Nice-to-have |

**DMARC Policy Progression**: `p=none` (monitor 2 wks) → `p=quarantine` (2 wks) → `p=reject` (enforce)

## Domain Warm-Up Schedule

| Week | Daily Volume | Ramp Strategy |
|------|-------------|---------------|
| 1 | 50-100 | Engaged subscribers only |
| 2 | 200-500 | Recent openers (90 days) |
| 3 | 500-2,000 | Active subscribers (6 months) |
| 4 | 2,000-5,000 | Full engaged list |
| 5+ | Full volume | Monitor and maintain |

## List Hygiene Rules

| Action | Frequency | Criteria | Impact |
|--------|-----------|----------|--------|
| **Remove hard bounces** | Immediate | Invalid address | Protects sender score |
| **Suppress soft bounces** | After 3 consecutive | Temp failure | Reduces bounce rate |
| **Sunset inactive** | Monthly | No open/click 6+ months | Improves engagement metrics |
| **Re-confirm stale** | Quarterly | No activity 3-6 months | Cleans list, compliance |
| **Validate new imports** | Pre-send | Email verification API | Prevents traps |

## Compliance Quick Reference

| Regulation | Region | Key Requirements |
|-----------|--------|------------------|
| **CAN-SPAM** | US | Unsubscribe link, physical address, no deceptive headers |
| **GDPR** | EU/EEA | Explicit consent, right to erasure, data portability |
| **CASL** | Canada | Express consent, sender ID, unsubscribe within 10 days |
| **CCPA** | California | Right to know, right to delete, opt-out of sale |

## Pre-Send Checklist

- [ ] SPF, DKIM, DMARC records verified (use MXToolbox)
- [ ] Sending domain warmed up (or established)
- [ ] List cleaned: hard bounces removed, inactive suppressed
- [ ] Spam score tested (<5.0 via Mail-Tester or Litmus)
- [ ] Text-to-image ratio: 60:40 minimum text
- [ ] No URL shorteners (bit.ly triggers spam filters)
- [ ] Subject line clear of spam triggers (FREE!!!, $$$, Act Now)
- [ ] Unsubscribe link in footer, one-click functional
- [ ] Physical mailing address included
- [ ] Reply-to address is monitored inbox
- [ ] Test send to Gmail, Outlook, Yahoo verified
- [ ] Suppression list current (bounces + unsubscribes + complaints)
