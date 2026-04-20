# Technical SEO Audit Scoring Matrix

**Score every category systematically: Weighted scoring identifies which fixes have highest SEO impact. Fix by priority, not by difficulty.**

## Audit Score Formula

```
Total Score = (Crawlability × 0.20) + (Indexation × 0.15) + (Speed × 0.20) + (Mobile × 0.15) + (Structure × 0.15) + (Schema × 0.10) + (Security × 0.05)
```

## Scoring Matrix by Category

| Category | Weight | Key Checks | Pass Criteria (5/5) | Fail Criteria (<3/3) |
|---|---|---|---|---|
| **Crawlability** | 20% | robots.txt valid, sitemap.xml present, no crawl errors, <3s response time | All checks pass | Crawl errors >10 or blocking robots.txt |
| **Indexation** | 15% | Pages indexed, no noindex tags (unless intentional), no 4xx/5xx errors | >95% content indexed | <80% indexed or widespread 4xx |
| **Speed (Core Web Vitals)** | 20% | LCP <2.5s, INP <200ms, CLS <0.1 | All 3 metrics "Good" | Any metric in "Poor" range |
| **Mobile** | 15% | Responsive design, mobile viewport, font size >12px, tap targets >48px | Mobile-first, all checks pass | Not responsive or failing targets |
| **Structure** | 15% | Clear hierarchy, breadcrumbs, navigation, internal linking | Hierarchical structure, 2-4 internal links/page | Orphan pages, broken navigation |
| **Schema Markup** | 10% | JSON-LD implemented, validation passes, rich snippets eligible | 3+ schema types, 95%+ valid | Missing or invalid schema |
| **Security** | 5% | HTTPS enabled, no mixed content, security headers set | HTTPS, security headers present | HTTP or security warnings |

## Detailed Pass/Fail Criteria

### Crawlability (Weight: 20%)
- ✅ Pass: robots.txt allows crawling, sitemap includes all content, Googlebot can fetch pages
- ❌ Fail: Crawl errors >10, robots.txt blocks content, >3s response time

### Indexation (Weight: 15%)
- ✅ Pass: >95% desired pages indexed, no unintentional noindex
- ❌ Fail: <80% indexed, widespread 4xx/5xx errors

### Page Speed (Weight: 20%)
- ✅ Pass: LCP <2.5s AND INP <200ms AND CLS <0.1
- ❌ Fail: Any metric >poor threshold

### Mobile Optimization (Weight: 15%)
- ✅ Pass: Responsive design, 48px+ tap targets, readable font size
- ❌ Fail: Not responsive or >3 mobile UX issues

### Site Structure (Weight: 15%)
- ✅ Pass: Clear H1→H2→H3 hierarchy, breadcrumbs, 2-4 internal links per page
- ❌ Fail: Orphan pages, broken navigation, unclear structure

### Schema Markup (Weight: 10%)
- ✅ Pass: 3+ schema types, 95%+ valid, eligible for rich snippets
- ❌ Fail: Missing schema or >10% validation errors

### Security (Weight: 5%)
- ✅ Pass: HTTPS enabled, no mixed content, security headers present
- ❌ Fail: HTTP, insecure warnings, missing headers

## Score Interpretation

| Total Score | Rating | Status | Action |
|---|---|---|---|
| 8.5-10.0 | Excellent | Healthy | Maintain, optimize further |
| 7.0-8.4 | Good | Acceptable | Fix medium-priority issues |
| 5.5-6.9 | Fair | At Risk | Prioritize high-impact fixes |
| 4.0-5.4 | Poor | Concerning | Fix critical issues immediately |
| <4.0 | Critical | At Risk | Major overhaul needed |

## Audit Checklist

- [ ] Crawl site with Screaming Frog or similar tool
- [ ] Check robots.txt and sitemap.xml validity
- [ ] Run Core Web Vitals test (PageSpeed Insights)
- [ ] Test mobile responsiveness (all devices)
- [ ] Validate schema markup with Schema.org validator
- [ ] Check HTTPS and security headers (SecurityHeaders.com)
- [ ] Verify indexation (site: search in Google)
- [ ] Score each category 1-5
- [ ] Calculate weighted total score
- [ ] Prioritize fixes by weight × impact
- [ ] Re-audit after fixes
