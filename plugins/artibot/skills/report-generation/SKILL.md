---
name: report-generation
description: |
  Structured report creation for marketing analytics including executive summaries, performance reports, and data narratives.
  Provides templates for weekly, monthly, and quarterly marketing reports.
  Auto-activates when: report creation, executive summary, performance report, data narrative, marketing report.
  Triggers: report, executive summary, performance report, weekly report, monthly report, quarterly report, dashboard report, marketing report, 리포트, 성과 보고서, 주간 보고서, 월간 보고서
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "report"
  - "generate report"
  - "analytics report"
  - "summary"
  - "insights report"
agents:
  - "persona-analyzer"
  - "persona-scribe"
tokens: "~3K"
category: "analysis"
---

# Report Generation

## When This Skill Applies
- Creating marketing performance reports (weekly/monthly/quarterly)
- Writing executive summaries with actionable insights
- Building data narratives that tell a story
- Designing report templates for recurring use
- Consolidating multi-source data into unified reports

## Core Guidance

### 1. Report Creation Process
```
Define Audience -> Gather Data -> Structure Report -> Write Narrative -> Add Visualizations -> Add Recommendations -> Review -> Distribute
```

### 2. Report Types

| Type | Audience | Frequency | Length | Focus |
|------|----------|-----------|--------|-------|
| Executive Summary | C-suite | Monthly/Quarterly | 1-2 pages | High-level KPIs, strategic insights |
| Campaign Report | Marketing team | Per campaign | 3-5 pages | Campaign performance, learnings |
| Channel Report | Channel owners | Weekly/Monthly | 2-3 pages | Channel-specific metrics |
| Full Analytics | Marketing leadership | Monthly | 5-10 pages | Comprehensive cross-channel analysis |
| Board Report | Board/Investors | Quarterly | 2-3 pages | Growth metrics, market position |

### 3. Report Structure

#### Standard Report Template
```
1. EXECUTIVE SUMMARY (10% of report)
   - Key highlights (3-5 bullet points)
   - Overall performance vs targets
   - Critical actions needed

2. KPI SCORECARD (15%)
   - Primary metrics with period-over-period comparison
   - Status indicators (on-track, at-risk, behind)
   - Trend arrows and context

3. DETAILED ANALYSIS (40%)
   - Performance by channel/campaign/segment
   - Trend analysis with explanations
   - Anomaly identification and root causes

4. INSIGHTS (15%)
   - Data-driven findings
   - Pattern identification
   - Correlation analysis

5. RECOMMENDATIONS (15%)
   - Prioritized action items
   - Expected impact of each recommendation
   - Resource requirements

6. APPENDIX (5%)
   - Data sources and methodology
   - Definitions and formulas
   - Raw data tables
```

### 4. Executive Summary Framework

**The "So What?" Test**: Every data point must answer "so what does this mean for the business?"

| Component | Content | Length |
|-----------|---------|--------|
| Bottom Line | Most important takeaway upfront | 1-2 sentences |
| Performance | KPIs vs targets | 3-5 bullet points |
| Wins | What worked and why | 2-3 highlights |
| Concerns | What needs attention | 1-2 flags |
| Actions | Recommended next steps | 2-3 priorities |

### 5. Data Narrative Techniques

| Technique | When to Use | Example |
|-----------|------------|---------|
| Lead with insight | Most important finding first | "CAC dropped 23% due to organic growth" |
| Compare to context | Raw numbers need context | "40% CTR vs 25% industry average" |
| Explain the why | Don't just state what happened | "Revenue grew because of Q4 campaign launch" |
| Quantify impact | Make recommendations tangible | "Shifting $5K to email would generate ~200 more leads" |
| Flag anomalies | Highlight unexpected results | "Unusual traffic spike on Mar 15 from Reddit mention" |

### 6. KPI Scorecard Design

```
Metric          | Current  | Target   | Delta    | Trend  | Status
----------------|----------|----------|----------|--------|--------
Revenue         | $250K    | $200K    | +25%     | [up]   | ABOVE
CAC             | $85      | $100     | -15%     | [down] | GOOD
LTV:CAC         | 4.2:1    | 3.0:1   | +40%     | [up]   | ABOVE
MQLs            | 1,250    | 1,500   | -17%     | [down] | BELOW
Churn           | 3.2%     | 3.0%    | +0.2pp   | [flat] | AT RISK
```

**Status Rules**:
- ABOVE: >10% above target (green)
- ON TRACK: Within +/-10% of target (green)
- AT RISK: 10-20% below target (yellow)
- BELOW: >20% below target (red)

### 7. Report Distribution Matrix

| Audience | Format | Frequency | Delivery |
|----------|--------|-----------|----------|
| C-suite | 1-page PDF | Monthly | Email + meeting |
| VP Marketing | Full report | Monthly | Dashboard + email |
| Team leads | Channel reports | Weekly | Slack + dashboard |
| Stakeholders | Campaign summaries | Per campaign | Email |
| Board | Investor deck | Quarterly | Meeting + PDF |

### 8. Report Quality Checklist

- [ ] Executive summary is self-contained (readable alone)
- [ ] All metrics have comparison context (period, target, benchmark)
- [ ] Charts and tables are properly labeled
- [ ] Insights are actionable, not just descriptive
- [ ] Recommendations include expected impact
- [ ] Data sources and methodology documented
- [ ] Consistent formatting and terminology
- [ ] Proofread for accuracy and clarity

## Output Format
```
[REPORT TYPE] REPORT
====================
Period:     [date range]
Author:     [name/team]
Audience:   [target audience]

EXECUTIVE SUMMARY
-----------------
[Bottom line finding]
- [Key metric 1]: [value] vs [target] ([delta])
- [Key metric 2]: [value] vs [target] ([delta])
- [Key insight or concern]

KPI SCORECARD
-------------
[Scorecard table with status indicators]

ANALYSIS
--------
[Detailed analysis sections]

INSIGHTS
--------
1. [Insight with evidence]
2. [Insight with evidence]

RECOMMENDATIONS
---------------
Priority | Action           | Impact          | Owner
---------|-----------------|-----------------|------
P1       | [action]        | [expected lift] | [team]
```

## Quick Reference

**Report Structure**: Executive Summary -> KPI Scorecard -> Analysis -> Insights -> Recommendations -> Appendix
**"So What?" Test**: Every data point must explain business impact
**Status Rules**: ABOVE (>10% above), ON TRACK (+/-10%), AT RISK (10-20% below), BELOW (>20% below)

See `references/report-templates.md` for ready-to-use report templates by type.
See `references/narrative-examples.md` for data narrative writing examples.
