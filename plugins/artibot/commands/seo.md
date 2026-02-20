---
description: SEO audit, keyword strategy, technical SEO analysis, and content optimization recommendations
argument-hint: '[type] e.g. "기술 SEO 감사 실행"'
allowed-tools: [Read, Write, Glob, Grep, Bash, Task, WebSearch, TodoWrite]
---

# /seo

Comprehensive SEO analysis covering technical SEO, on-page optimization, keyword strategy, and content gap analysis. Produces actionable audit reports with prioritized recommendations.

## Arguments

Parse $ARGUMENTS:
- `analysis-type`: Analysis type - `audit` | `keywords` | `content-gap` | `technical` | `competitor` | `local` | `strategy`
- `--url [target]`: Target URL or domain for analysis
- `--keywords [terms]`: Seed keywords for research (comma-separated)
- `--competitors [domains]`: Competitor domains for comparison (comma-separated)
- `--focus [area]`: SEO focus - `on-page` | `off-page` | `technical` | `content` | `local` | `all`
- `--pages [scope]`: Pages to analyze - `homepage` | `top-10` | `all` | `specific path`
- `--intent [type]`: Search intent filter - `informational` | `transactional` | `navigational` | `commercial`

## Analysis Types

| Type | Purpose | Key Output |
|------|---------|------------|
| audit | Full SEO health check | Scored report with prioritized fixes |
| keywords | Keyword research and clustering | Keyword map with volume/difficulty |
| content-gap | Missing content vs competitors | Content opportunity list |
| technical | Site structure and crawlability | Technical issue list |
| competitor | Competitor SEO comparison | Competitive advantage map |
| local | Local SEO optimization | Local listing recommendations |
| strategy | Comprehensive SEO plan | Strategy document with roadmap |

## Agent Delegation

- Primary: `seo-specialist` - SEO audit and strategy
- Supporting: `content-marketer` - Content optimization
- Supporting: `data-analyst` - Keyword data analysis

## Skills Required

- `seo-strategy` - Keyword research, search intent, ranking factors
- `technical-seo` - Site structure, crawlability, Core Web Vitals, schema markup
- `content-seo` - On-page optimization, content gaps, topical authority

## Execution Flow

1. **Parse**: Extract analysis type, target, keyword seeds, competitor context
2. **Crawl/Audit** (if `audit` or `technical`):
   - Page structure analysis (H1-H6 hierarchy, meta tags, alt texts)
   - Internal linking structure evaluation
   - Mobile responsiveness check
   - Page speed and Core Web Vitals assessment
   - Schema markup validation
   - Robots.txt and sitemap analysis
3. **Keyword Research** (if `keywords` or `strategy`):
   - Seed keyword expansion via WebSearch
   - Search volume and difficulty estimation
   - Search intent classification per keyword
   - Keyword clustering by topic
   - Long-tail opportunity identification
4. **Content Gap Analysis** (if `content-gap`):
   - Compare content coverage vs competitors
   - Identify missing topics and keywords
   - Map content to search intent stages
   - Prioritize by volume x difficulty x relevance
5. **Competitor Analysis** (if `competitor`):
   - Competing page identification per keyword
   - Content format and depth comparison
   - Backlink profile estimation
   - Ranking factor comparison
6. **Recommendations**: Prioritize fixes by impact:
   - Critical: Broken pages, missing meta, indexing issues
   - High: Content gaps, keyword cannibalization
   - Medium: Internal linking, schema opportunities
   - Low: Minor on-page tweaks
7. **Report**: Output structured SEO audit/strategy

## Output Format

```
SEO REPORT
==========
Type:       [analysis-type]
Target:     [url/domain]
Focus:      [area]
Score:      [overall SEO health score /100]

TECHNICAL HEALTH (if audit/technical)
-------------------------------------
Category        | Score | Issues | Priority
----------------|-------|--------|----------
Meta Tags       | [/10] | [n]    | [P1-P3]
Page Speed      | [/10] | [n]    | [P1-P3]
Mobile          | [/10] | [n]    | [P1-P3]
Crawlability    | [/10] | [n]    | [P1-P3]
Schema          | [/10] | [n]    | [P1-P3]
Internal Links  | [/10] | [n]    | [P1-P3]

KEYWORD STRATEGY (if keywords/strategy)
----------------------------------------
Keyword         | Volume | Difficulty | Intent        | Priority
----------------|--------|------------|---------------|----------
[keyword]       | [vol]  | [1-100]    | [intent type] | [P1-P3]

CONTENT GAPS (if content-gap)
-----------------------------
Missing Topic    | Est. Volume | Competitor Coverage | Content Type
-----------------|-------------|---------------------|-------------
[topic]          | [volume]    | [n competitors]     | [blog|page|guide]

RECOMMENDATIONS
---------------
Priority | Category   | Action                          | Expected Impact
---------|------------|---------------------------------|----------------
P1       | [category] | [specific action]               | [traffic delta]
P2       | [category] | [specific action]               | [traffic delta]
```

## Example Usage

```
/seo audit --url example.com --focus all
/seo keywords --keywords "AI agent,Claude plugin,coding assistant" --intent transactional
/seo content-gap --url example.com --competitors "competitor1.com,competitor2.com"
/seo technical --url example.com --pages top-10
/seo strategy --keywords "marketing automation" --competitors "hubspot.com,mailchimp.com"
```
