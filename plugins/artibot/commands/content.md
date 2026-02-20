---
description: Content marketing and SEO specialist using content-marketer subagent
argument-hint: '[type] e.g. "블로그 글 SEO 최적화"'
allowed-tools: [Read, Write, Task, WebSearch, TaskCreate]
---

# /content

Content marketing and strategy specialist. Delegates to the content-marketer subagent for blog posts, social media, email campaigns, SEO optimization, and content strategy.

## Arguments

Parse $ARGUMENTS:
- `content-type`: Type of content to create - `blog` | `social` | `email` | `seo` | `strategy` | `landing`
- `--seo`: Enable SEO optimization with keyword research
- `--campaign [name]`: Campaign context for content alignment
- `--social [platform]`: Target platform - `twitter` | `linkedin` | `dev.to` | `all`
- `--email [type]`: Email type - `newsletter` | `drip` | `announcement` | `onboarding`
- `--blog [topic]`: Blog post topic with automatic outline generation
- `--tone [style]`: Content tone - `professional` | `casual` | `technical` | `educational`

## Content Types

| Type | Description | Output |
|------|-------------|--------|
| blog | Technical blog posts with SEO | Markdown article with frontmatter |
| social | Platform-specific social content | Posts per platform with hashtags |
| email | Email marketing campaigns | HTML/text email with subject lines |
| seo | SEO analysis and optimization | Keyword report, meta tags, recommendations |
| strategy | Content calendar and planning | Monthly content plan with topics |
| landing | Landing page copy | Headlines, CTAs, feature descriptions |

## Execution Flow

1. **Parse**: Extract content type, target audience, campaign context
2. **Research** (if `--seo`): Use WebSearch for:
   - Keyword research and competition analysis
   - Trending topics in the domain
   - Competitor content analysis
3. **Delegate**: Route to Task(content-marketer) subagent with context:
   - Content type and format requirements
   - SEO keywords and target metrics
   - Brand voice guidelines (if available in project)
   - Campaign alignment context
4. **Generate**: Create content following best practices:
   - Blog: Hook -> Problem -> Solution -> CTA structure
   - Social: Platform-specific formatting and character limits
   - Email: Subject line variants, preview text, body, CTA
   - SEO: Title tags, meta descriptions, heading structure
5. **Optimize**: Review and enhance content:
   - Readability score (Flesch-Kincaid)
   - SEO density and keyword placement
   - CTA effectiveness
   - Platform compliance
6. **Report**: Output content with metrics

## Output Format

Use GFM markdown tables:

**Summary**

| 항목 | 값 |
|------|-----|
| Type | [blog/social/email/seo/strategy/landing] |
| Topic | [topic description] |
| Campaign | [campaign name or N/A] |

**Content**

[generated content]

**Metrics**

| Metric | Value |
|--------|-------|
| Word Count | [n] |
| SEO Score | [n/100] |
| Readability | [grade level] |
| Keywords | [primary], [secondary] |
