---
context: fork
name: campaign-planning
description: "Designs campaign architecture, timelines, cross-channel coordination, and budget allocation for marketing campaigns from planning through measurement. Use when user asks about campaign planning, launch coordination, cross-channel marketing, campaign calendar, UTM tracking, budget allocation, 캠페인 기획, 캠페인 런칭, or 멀티채널."
lang: [en, ko]
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "campaign"
  - "marketing campaign"
  - "campaign planning"
  - "campaign strategy"
  - "launch"
agents:
  - "architect"
tokens: "~4K"
category: "marketing"
source_hash: e10b1cd2
whenNotToUse: "Single-channel tactical execution (e.g., writing one email or one ad) where cross-channel orchestration and budget allocation are not needed."
---

# Campaign Planning

## When This Skill Applies
- Designing multi-channel marketing campaigns
- Planning product launches and promotional campaigns
- Creating campaign timelines and milestone schedules
- Coordinating cross-channel content and messaging
- Allocating campaign budgets across channels

## Core Guidance

### 1. Campaign Planning Process
```
Define Objectives -> Audience Targeting -> Channel Selection -> Content Planning -> Timeline Design -> Budget Allocation -> UTM Setup -> Launch -> Monitor -> Optimize -> Report
```

### 2. Campaign Types

| Type | Duration | Channels | Complexity |
|------|----------|----------|------------|
| Product Launch | 4-8 weeks | All relevant | High |
| Seasonal/Event | 2-4 weeks | Paid + social + email | Medium |
| Evergreen | Ongoing | Content + SEO + email | Low-Medium |
| Re-engagement | 2-3 weeks | Email + retargeting | Low |
| Brand Awareness | 8-12 weeks | Paid + social + PR | High |
| Lead Generation | 4-6 weeks | Paid + content + email | Medium |

### 3. Campaign Brief Template

```
CAMPAIGN BRIEF
==============
Name:       [campaign name]
Objective:  [specific, measurable goal]
Audience:   [primary and secondary segments]
Timeline:   [start date] - [end date]
Budget:     [total budget]
Channels:   [channel list]
KPIs:       [primary and secondary metrics]
Owner:      [campaign lead]

KEY MESSAGES
------------
Primary:    [core message/value proposition]
Supporting: [2-3 supporting messages]
CTA:        [desired audience action]

SUCCESS CRITERIA
----------------
Metric          | Target    | Stretch Goal
----------------|-----------|-------------
[primary KPI]   | [value]   | [value]
[secondary KPI] | [value]   | [value]
```

### 4. Campaign Timeline Structure

| Phase | Duration | Activities |
|-------|----------|-----------|
| Planning | 1-2 weeks | Brief, creative, audience, channels |
| Pre-launch | 1 week | Teaser content, list building, setup |
| Launch | 1-3 days | Coordinated cross-channel activation |
| Sustain | 2-6 weeks | Content cadence, optimization, nurturing |
| Wind-down | 3-5 days | Final push, urgency elements |
| Analysis | 1 week | Performance review, learnings capture |

### 5. Cross-Channel Coordination

| Channel | Role in Campaign | Timing |
|---------|-----------------|--------|
| Email | Direct reach, nurturing, conversions | Pre-launch + launch + sustain |
| Social Organic | Awareness, engagement, community | All phases |
| Social Paid | Reach, retargeting, conversions | Launch + sustain |
| Search Paid | Intent capture, conversions | Launch + sustain |
| Content/Blog | SEO, authority, education | Pre-launch + sustain |
| Landing Pages | Conversion, information | Launch + sustain |
| PR/Partnerships | Amplification, credibility | Pre-launch + launch |

### 6. UTM Parameter Framework

```
utm_source:   [traffic source] (google, facebook, newsletter)
utm_medium:   [marketing medium] (cpc, social, email)
utm_campaign: [campaign name] (q2-launch, summer-sale)
utm_content:  [content variant] (hero-cta, sidebar-banner)
utm_term:     [keyword/targeting] (marketing-automation)
```

**Naming Convention**: lowercase, hyphens, consistent across channels.

### 7. Budget Allocation by Phase

| Phase | Budget % | Focus |
|-------|----------|-------|
| Pre-launch | 10-15% | Teaser content, audience building |
| Launch | 35-45% | Maximum reach and impact |
| Sustain | 30-40% | Optimization, nurturing, retargeting |
| Analysis | 5-10% | Reporting tools, post-mortem |

## Output Format
```
CAMPAIGN PLAN
=============
Name:       [campaign name]
Type:       [campaign type]
Objective:  [measurable goal]
Timeline:   [date range]
Budget:     [total with allocation]

TIMELINE
--------
Week 1: [Pre-launch activities]
Week 2: [Launch activities]
Week 3-4: [Sustain activities]
Week 5: [Wind-down + analysis]

CHANNEL MIX
-----------
Channel       | Budget % | Content Type      | Frequency
--------------|----------|-------------------|-----------
[channel]     | [%]      | [content format]  | [cadence]

UTM TRACKING
------------
Source     | Medium  | Campaign         | Content
-----------|---------|------------------|----------
[source]   | [medium]| [campaign-name]  | [variant]

SUCCESS METRICS
---------------
KPI            | Target  | Tracking Method
---------------|---------|----------------
[metric]       | [value] | [tool/method]
```

## Quick Reference

**Campaign Types**: product-launch, seasonal, evergreen, re-engagement, brand-awareness, lead-gen
**Phases**: planning, pre-launch, launch, sustain, wind-down, analysis
**UTM Format**: lowercase, hyphenated, source/medium/campaign/content/term

---

## Rules

- Always define success metrics and KPI targets before launch.
- Always complete a competitive landscape check during the planning phase.
- Always set UTM parameters for every trackable link before go-live.
- Always include a written kill criterion (stop-loss trigger) in the campaign brief.
- Always allocate budget by phase, not as a single lump sum.
- Never launch without a measurement plan that includes baselines and tracking methods.
- Never skip the competitive check during the planning phase.
- Never approve creative in the final week without localization and legal review.
- Never allocate budget by copying the previous quarter without re-evaluating channel CAC.
- Never run a campaign without cross-channel coordination documented in the brief.

## References

- See `${CLAUDE_SKILL_DIR}/references/campaign-brief-template.md` for campaign brief template
- See `${CLAUDE_SKILL_DIR}/references/timeline-phases.md` for campaign timeline phases


## Rationalizations

The following table captures common excuses agents make to skip the rigor of this marketing practice, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "We'll figure out measurement after launch." | Measurement plan built post-launch produces unattributable spend; KPIs, baselines, and tracking must be frozen before go-live. |
| "One channel is enough if it's working." | Single-channel campaigns cap reach at that channel's ceiling and ignore cross-channel lift; integrated plans outperform siloed by 15-35%. |
| "Budget allocation mirrors last quarter." | Copy-paste budgets ignore CAC trends and channel saturation; allocation must be re-derived from current marginal CAC per channel. |
| "Creative can come together in the last week." | Rushed creative skips localization, legal, and A/B variant production, reducing campaign effectiveness by 20-40%. |
| "We don't need a kill criterion." | Without written stop-loss triggers (CPA ceiling, ROAS floor), underperforming campaigns run 2-3x longer than they should. |
