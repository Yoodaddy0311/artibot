---
name: content-seo
description: |
  On-page content optimization for search engines including meta tags, heading structure, content quality, and topical authority.
  Covers content gap analysis, content refresh strategies, and E-E-A-T signal optimization.
  Auto-activates when: on-page SEO optimization, content audit, content gap analysis, meta tag optimization, E-E-A-T.
  Triggers: content SEO, on-page SEO, meta tags, heading structure, content optimization, content gap, topical authority, E-E-A-T, content audit, 콘텐츠 SEO, 온페이지 최적화, 콘텐츠 갭
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "content SEO"
  - "blog post"
  - "content optimization"
  - "keyword content"
  - "SEO content"
agents:
  - "doc-updater"
tokens: "~3K"
category: "marketing"
---

# Content SEO

## When This Skill Applies
- Optimizing page content for target keywords
- Writing SEO-friendly meta tags and heading structures
- Conducting content gap analysis against competitors
- Improving E-E-A-T (Experience, Expertise, Authoritativeness, Trustworthiness)
- Planning content refresh and consolidation strategies

## Core Guidance

### 1. On-Page Optimization Process
```
Target Keyword -> Intent Analysis -> Content Structure -> Meta Tags -> Heading Hierarchy -> Body Optimization -> Internal Links -> Schema -> Publish -> Monitor Rankings
```

### 2. On-Page Elements Checklist

| Element | Best Practice | Priority |
|---------|-------------|----------|
| Title Tag | Primary keyword + modifier, 50-60 chars | Critical |
| Meta Description | CTA + keyword, 150-160 chars | High |
| H1 | One per page, contains primary keyword | Critical |
| H2-H6 | Logical hierarchy, include secondary keywords | High |
| URL Slug | Short, descriptive, contains keyword | High |
| First Paragraph | Primary keyword within first 100 words | High |
| Image Alt Text | Descriptive, keyword-relevant | Medium |
| Internal Links | 3-5 relevant internal links per page | High |
| External Links | 1-3 authoritative external references | Medium |

### 3. Title Tag Formulas

| Formula | Pattern | Example |
|---------|---------|---------|
| Keyword + Modifier | "[Keyword]: [Modifier]" | "Email Marketing: Complete Guide for 2026" |
| Number + Keyword | "[N] [Keyword] [Benefit]" | "15 SEO Strategies That Actually Work" |
| How-to | "How to [Keyword] [Result]" | "How to Improve Conversion Rates by 50%" |
| Year + Topic | "[Keyword] in [Year]: [Value]" | "Content Marketing in 2026: What's Changed" |
| Question | "[Question with keyword]?" | "Is Your SEO Strategy Ready for AI Search?" |

### 4. Content Quality Framework

| Factor | Assessment Criteria | Score Weight |
|--------|-------------------|-------------|
| Comprehensiveness | Covers topic thoroughly, answers likely questions | 25% |
| Uniqueness | Original insights, data, or perspective | 20% |
| Accuracy | Factually correct, up-to-date information | 20% |
| Readability | Clear writing, proper formatting, scannable | 15% |
| Engagement | Keeps readers on page, encourages interaction | 10% |
| Actionability | Practical takeaways, clear next steps | 10% |

### 5. E-E-A-T Signal Optimization

| Signal | Implementation |
|--------|---------------|
| Experience | First-hand examples, case studies, screenshots |
| Expertise | Author bios, credentials, detailed technical knowledge |
| Authoritativeness | Citations, backlinks, brand mentions, awards |
| Trustworthiness | HTTPS, clear policies, contact info, reviews |

**Page-Level E-E-A-T**:
- Author byline with bio and credentials
- Sources cited and linked
- Last updated date shown
- Clear editorial policy
- Expert review attribution

### 6. Content Gap Analysis

```
Step 1: Identify competitor pages ranking for target keywords
Step 2: List topics/subtopics covered by competitors but not by us
Step 3: Evaluate each gap:
  - Search volume potential
  - Difficulty to rank
  - Business relevance
  - Content type needed (blog, guide, tool, comparison)
Step 4: Prioritize by: volume * (1/difficulty) * relevance
Step 5: Map to content calendar
```

### 7. Content Refresh Strategy

| Signal | Action | Expected Impact |
|--------|--------|----------------|
| Ranking drop (positions 4-20) | Update stats, add new sections | Recover rankings |
| Stale content (>12 months) | Refresh data, update examples | Maintain rankings |
| Thin content (<500 words) | Expand depth, add media | Improve rankings |
| Keyword cannibalization | Consolidate or differentiate | Resolve confusion |
| High impressions, low CTR | Rewrite title/meta description | Improve CTR |

### 8. Content Structure Template

```
[Title Tag: Primary Keyword + Modifier (50-60 chars)]
[Meta Description: CTA + keyword (150-160 chars)]

# H1: Primary Keyword Variation

[Introduction: Hook + context + primary keyword in first 100 words]

## H2: First Major Subtopic
[Content with secondary keywords naturally integrated]

### H3: Subtopic Detail
[Supporting content]

## H2: Second Major Subtopic
[Content]

## H2: FAQ Section (optional, for schema)
### Q: [Common question]?
A: [Concise answer]

## H2: Conclusion / Key Takeaways
[Summary + CTA]
```

## Output Format
```
CONTENT SEO AUDIT
=================
URL:        [page URL]
Keyword:    [target keyword]
Intent:     [informational|commercial|transactional]

ON-PAGE SCORE
-------------
Element         | Status    | Recommendation
----------------|-----------|----------------
Title Tag       | [OK|FIX]  | [suggestion]
Meta Description| [OK|FIX]  | [suggestion]
H1              | [OK|FIX]  | [suggestion]
Heading Structure| [OK|FIX] | [suggestion]
Content Quality | [score/10]| [suggestion]

CONTENT GAPS
------------
Missing Topic   | Volume | Difficulty | Priority
----------------|--------|-----------|----------
[topic]         | [vol]  | [1-100]   | [P1-P3]
```

## Quick Reference

**Title Tag**: 50-60 chars, primary keyword + modifier
**Meta Description**: 150-160 chars, CTA + keyword
**H1**: One per page, keyword-rich
**Content Quality**: Comprehensive, unique, accurate, readable
**E-E-A-T**: Experience, Expertise, Authoritativeness, Trustworthiness

See `references/optimization-checklist.md` for detailed on-page SEO checklist.
See `references/content-templates.md` for SEO content structure templates.
