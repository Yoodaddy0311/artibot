# Schema Markup Types Reference

**Implement schema strategically: Each page type needs specific schema. Missing schema = missing rich snippets = lost rankings and traffic.**

## Schema Types by Use Case

| Schema Type | Use Case | Rich Snippet Type | Required Properties | Testing Tool |
|---|---|---|---|---|
| **Article** | Blog posts, news, research | Title, image, publish date, author | headline, image, datePublished, author | [Google RSTD](https://search.google.com/test/rich-results) |
| **FAQ** | FAQs, Q&A content | Accordion with questions/answers | mainEntity (Question+Answer pairs) | [Schema.org Validator](https://validator.schema.org/) |
| **HowTo** | Tutorials, guides, recipes | Step-by-step instructions | name, step (text, image, duration) | [Google RSTD](https://search.google.com/test/rich-results) |
| **Product** | E-commerce listings | Price, rating, availability | name, price, image, description | [Google RSTD](https://search.google.com/test/rich-results) |
| **Review** | Product/service reviews | Star rating, review text | reviewRating, author, reviewBody | [Google RSTD](https://search.google.com/test/rich-results) |
| **Organization** | Company homepage | Company info, logo, social | name, logo, sameAs (social URLs) | [Schema.org Validator](https://validator.schema.org/) |
| **Breadcrumb** | Site navigation | Breadcrumb path | itemListElement array | [Google RSTD](https://search.google.com/test/rich-results) |
| **LocalBusiness** | Local business pages | Address, phone, hours | name, address, telephone, openingHours | [Google RSTD](https://search.google.com/test/rich-results) |

## Implementation Priority

1. **Article** (All blog posts) - 95% importance
2. **Product** (E-commerce sites) - 95% importance
3. **Organization** (Homepage) - 85% importance
4. **LocalBusiness** (Local businesses) - 85% importance
5. **Breadcrumb** (All pages) - 75% importance
6. **FAQ** (Support/help pages) - 70% importance
7. **HowTo** (Tutorial pages) - 65% importance
8. **Review** (Review pages) - 60% importance

## Required vs Optional Properties

### Article (Blog Posts)
**Required**: headline, image, datePublished, author
**Recommended**: description, articleBody, wordCount

### Product (E-commerce)
**Required**: name, image, description, price
**Recommended**: rating, aggregateRating, availability

### FAQ (Q&A Content)
**Required**: question, acceptedAnswer
**Recommended**: author, dateCreated

### Organization (Homepage)
**Required**: name, logo, sameAs
**Recommended**: contactPoint, address, telephone

## Implementation Checklist

- [ ] Identify all page types (article, product, local, etc.)
- [ ] Choose primary schema type(s) per page
- [ ] Add required properties for each schema type
- [ ] Include recommended properties (boosts rich snippets)
- [ ] Validate schema with Google Rich Result Test
- [ ] Check schema in JSON-LD format (preferred)
- [ ] Ensure structured data matches visible content
- [ ] Test on mobile and desktop
- [ ] Monitor rich snippet performance in GSC
- [ ] Audit 10% of pages quarterly
- [ ] Fix validation errors within 48 hours

## Quick Implementation Format

Use JSON-LD (preferred, easiest to implement):

```json
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": "Page Title",
  "image": "https://example.com/image.jpg",
  "datePublished": "2024-01-15",
  "author": {"@type": "Person", "name": "Author Name"}
}
</script>
```
