---
name: technical-seo
description: |
  Technical SEO audit and optimization covering site structure, crawlability, Core Web Vitals, schema markup, and indexation.
  Provides checklists and scoring for technical health assessment.
  Auto-activates when: technical SEO audit, site speed optimization, schema markup, crawlability analysis, Core Web Vitals.
  Triggers: technical SEO, site speed, Core Web Vitals, schema markup, crawlability, robots.txt, sitemap, indexation, page speed, mobile SEO, 테크니컬 SEO, 사이트 속도, 크롤링
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "technical SEO"
  - "site speed"
  - "Core Web Vitals"
  - "crawlability"
  - "schema markup"
  - "sitemap"
agents:
  - "backend-developer"
  - "performance-engineer"
tokens: "~4K"
category: "marketing"
---

# Technical SEO

## When This Skill Applies
- Auditing website technical SEO health
- Optimizing Core Web Vitals and page speed
- Implementing and validating schema markup
- Fixing crawlability and indexation issues
- Ensuring mobile-friendliness and site structure

## Core Guidance

### 1. Technical SEO Audit Process
```
Crawl Site -> Check Indexation -> Audit Page Speed -> Validate Schema -> Review Mobile -> Analyze Links -> Score Health -> Prioritize Fixes
```

### 2. Technical SEO Scoring

| Category | Weight | Elements |
|----------|--------|----------|
| Crawlability | 20% | Robots.txt, sitemap, crawl errors, URL structure |
| Indexation | 15% | Index coverage, canonical tags, noindex directives |
| Page Speed | 20% | Core Web Vitals (LCP, FID, CLS), TTFB, TBT |
| Mobile | 15% | Responsive design, mobile usability, viewport |
| Structure | 15% | Heading hierarchy, internal links, breadcrumbs |
| Schema | 10% | Structured data, rich snippet eligibility |
| Security | 5% | HTTPS, mixed content, security headers |

### 3. Core Web Vitals Thresholds

| Metric | Good | Needs Improvement | Poor |
|--------|------|-------------------|------|
| LCP (Largest Contentful Paint) | <2.5s | 2.5-4.0s | >4.0s |
| INP (Interaction to Next Paint) | <200ms | 200-500ms | >500ms |
| CLS (Cumulative Layout Shift) | <0.1 | 0.1-0.25 | >0.25 |

**Optimization Priorities**:
- LCP: Optimize images, preload critical resources, reduce server response time
- INP: Minimize JavaScript execution, defer non-critical scripts
- CLS: Set explicit dimensions on images/embeds, avoid dynamic content injection

### 4. Schema Markup Types

| Schema Type | Use Case | Rich Result |
|-------------|----------|-------------|
| Article | Blog posts, news | Article snippet |
| FAQ | FAQ pages | Expandable FAQ |
| HowTo | Tutorial pages | Step-by-step snippet |
| Product | Product pages | Price, availability, reviews |
| Organization | About page | Knowledge panel |
| BreadcrumbList | All pages | Breadcrumb trail |
| LocalBusiness | Local businesses | Local pack, map |
| Review | Review pages | Star ratings |

### 5. Crawlability Checklist

- [ ] robots.txt allows critical pages, blocks low-value pages
- [ ] XML sitemap present, updated, submitted to Search Console
- [ ] No orphan pages (all pages linked from at least one other page)
- [ ] Crawl depth <4 clicks from homepage
- [ ] No redirect chains (>2 hops)
- [ ] No redirect loops
- [ ] 4xx/5xx errors identified and fixed
- [ ] URL structure is clean, descriptive, hyphenated
- [ ] Canonical tags on all pages
- [ ] Pagination handled (rel=next/prev or canonical to all-page)

### 6. Page Speed Optimization

| Category | Quick Wins | Advanced |
|----------|-----------|---------|
| Images | Compress, WebP, lazy load | CDN, responsive images, AVIF |
| CSS | Inline critical CSS, defer non-critical | Purge unused CSS, minify |
| JavaScript | Defer/async non-critical | Code splitting, tree shaking |
| Server | Enable compression (gzip/brotli) | CDN, edge caching, HTTP/3 |
| Fonts | Font-display: swap, preload | Subset fonts, variable fonts |

### 7. Internal Linking Best Practices

| Principle | Rule | Benefit |
|-----------|------|---------|
| Relevance | Link to topically related pages | PageRank flow, user experience |
| Anchor text | Descriptive, keyword-rich (natural) | Context signal for search engines |
| Depth | Important pages within 3 clicks | Crawlability, authority distribution |
| Distribution | Spread links across site, not concentrated | Even authority distribution |
| Freshness | Update old content with links to new | Recrawl signals, discoverability |

### 8. Audit Report Scoring

```
Score /100 = Sum of category scores:
  Crawlability (20):  [score] issues found
  Indexation (15):     [score] issues found
  Page Speed (20):     [score] CWV status
  Mobile (15):         [score] usability issues
  Structure (15):      [score] hierarchy issues
  Schema (10):         [score] markup coverage
  Security (5):        [score] HTTPS/headers
```

## Output Format
```
TECHNICAL SEO AUDIT
===================
Domain:     [domain]
Score:      [/100]
Pages:      [crawled count]

CATEGORY SCORES
---------------
Category        | Score | Issues | Priority
----------------|-------|--------|----------
Crawlability    | [/20] | [n]    | [P1-P3]
Indexation      | [/15] | [n]    | [P1-P3]
Page Speed      | [/20] | [n]    | [P1-P3]
Mobile          | [/15] | [n]    | [P1-P3]
Structure       | [/15] | [n]    | [P1-P3]
Schema          | [/10] | [n]    | [P1-P3]
Security        | [/5]  | [n]    | [P1-P3]

CRITICAL ISSUES
---------------
[Issue]: [description] -> [fix recommendation]

RECOMMENDATIONS
---------------
Priority | Category | Action              | Impact
---------|----------|---------------------|--------
P1       | [cat]    | [specific action]   | [expected improvement]
```

## Quick Reference

**CWV Thresholds**: LCP <2.5s, INP <200ms, CLS <0.1
**Crawl Depth**: Target <4 clicks from homepage
**Schema Priority**: BreadcrumbList, FAQ, Article, Product
**Score Formula**: 7 categories weighted to 100 points

See `references/audit-checklist.md` for complete technical SEO audit checklist.
See `references/schema-templates.md` for JSON-LD schema markup templates.
