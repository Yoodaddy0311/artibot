# Brief: Customer Case Study

> **Fixture type**: smoke-test input for `case-study` skill
> **Fictional customer** — all names, metrics, and quotes are invented.

---

## Customer Context (fictional)

| Field | Value |
|-------|-------|
| Customer | Beacon Logistics |
| Industry | Regional third-party logistics (3PL), US Midwest |
| Size | ~140 employees, 9 warehouses, ~$42M annual revenue |
| Segment | SMB 3PL serving mid-size ecommerce shippers |
| Prior tooling | Spreadsheet-based dock scheduling + email confirmations |
| Vendor in story | Acme Dock Orchestrator (fictional dock scheduling SaaS) |

---

## Narrative Inputs

### Challenge (150-250 words target)

Beacon's dock scheduling was run out of a shared Excel file. By late 2025 they had 11 confirmed mis-scheduled trailers in one quarter, 6 detention-fee disputes exceeding $3,400 each, and driver wait-time complaints from two anchor carriers. The operations lead calculated that mis-scheduling absorbed roughly 14 hours per warehouse per week of coordinator time.

Stakes: losing the carrier-of-choice relationship with one of those anchor carriers would have required contracting spot-market capacity at an estimated $210k annual premium.

### Strategy (150-250 words target)

Beacon evaluated three approaches:
1. Hire two additional dock coordinators
2. Build an internal Airtable + Zapier workflow
3. License a purpose-built dock scheduling platform

They chose option 3 because the evaluation team projected that options 1 and 2 would hit the same coordination ceiling within 12-18 months. Acme Dock Orchestrator was selected over two alternatives because it exposed a carrier-facing portal that did not require carriers to create accounts.

### Execution (250-400 words target)

The rollout happened in sequenced phases over 10 weeks:

| Phase | Weeks | Action |
|-------|-------|--------|
| 1 | 1-2 | Import of historical dock slot data from 3 flagship warehouses |
| 2 | 3-4 | Pilot at Columbus warehouse with top 4 carriers |
| 3 | 5-7 | Progressive rollout to remaining 8 warehouses, one per 2-3 days |
| 4 | 8-10 | Carrier portal training sessions, 12 named carriers onboarded |

Named tools and decisions to reference:
- SSO integration with Beacon's Okta tenant
- Slack webhook on detention-risk alerts (threshold: 20 min past slot)
- Saturday go-live freeze after two carriers complained about mid-week disruption

### Results (200-300 words target)

**Fictional before/after pairs** (writers should present these exactly as given; do not invent additional metrics):

| Metric | Before | After (6 months post-go-live) | Change |
|--------|--------|-------------------------------|--------|
| Trailer mis-schedules per quarter | 11 | 2 | -82% |
| Detention-fee disputes per quarter | 6 | 1 | -83% |
| Coordinator time on scheduling (hrs/warehouse/week) | 14 | 4 | -71% |
| Carrier NPS (anchor carrier panel, n=9) | 22 | 51 | +29 pts |

Timeline label: "Go-live March 2026; measurement window September 2026."

### Lessons (100-200 words target)

Required takeaways the writer should surface:
1. Pilot warehouse selection mattered more than feature selection
2. Carrier-facing UX beat operations-facing UX as an adoption driver
3. Slack alert threshold required tuning three times before teams trusted it

---

## Quotes (use verbatim; these are fictional stakeholder quotes pre-approved for the fixture)

> "We stopped losing arguments with carriers over who was late. The timestamps settled it for us."
> — Priya Anand, Director of Operations, Beacon Logistics

> "The first week the carrier portal went live we got three emails from dispatchers saying thank you. I have never received a thank-you email about scheduling software."
> — Marcus Reyes, Warehouse Manager (Columbus), Beacon Logistics

> "Detention was our least predictable cost line. It is now our most predictable."
> — Sam Whitaker, CFO, Beacon Logistics

---

## Required Article Elements

| Element | Requirement |
|---------|-------------|
| Title | Use the primary formula: `How Beacon Logistics Cut Mis-Scheduled Trailers by 82% in Six Months` |
| TL;DR | 40-60 words, 3 lines (Challenge / Solution / Metric) |
| Industry tag | B2B SaaS variant (logistics ops buyer; buying committee of 3) |
| Quote approval log | All three quotes marked "approved (fixture)" |
| Word count total | 850-1,400 words |

---

## What "pass" looks like for this fixture

A case study drafted from this brief passes when all 5 blocks hit their word-count range, the TL;DR block is present with 3 lines, 2+ before/after KPI pairs are cited, 2 named quotes are used verbatim, and the `ai-slop-reviewer` score is ≥ 75. Checklist in `../writing-pack.test.md`.
