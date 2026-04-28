# JSON-LD Schema Templates

Full, drop-in JSON-LD templates for the eight primary schema types used in editorial and thought-leadership publishing. Placeholders follow `<UPPER_SNAKE>` convention so editors can find-and-replace them.

Last updated: 2026-04-23. Schema.org field names are a public standard, but vendor rich-result rules evolve — verify against `https://validator.schema.org/` and `https://search.google.com/test/rich-results` before shipping.

---

## Field legend

| Marker | Meaning |
|---|---|
| `// REQUIRED` | Omit it and the schema fails validation |
| `// RECOMMENDED` | Strongly improves rich-result eligibility |
| `// OPTIONAL` | Safe to drop; include when you have the data |
| `<ANGLE_TOKEN>` | Editor-replaceable placeholder |

JSON does not support comments, so the `// ...` markers appear only in the annotated blocks below. Strip them before deploy.

---

## 1. Article (default for blog posts and essays)

```json
{
  "@context": "https://schema.org",
  "@type": "Article",

  "headline": "<HEADLINE_UP_TO_110_CHARS>",

  "alternativeHeadline": "<DECK_OR_SUBHEAD>",

  "description": "<META_DESCRIPTION_150_160_CHARS>",

  "image": [
    "<HERO_16_9_URL>",
    "<HERO_4_3_URL>",
    "<HERO_1_1_URL>"
  ],

  "datePublished": "<ISO_8601_DATETIME>",
  "dateModified": "<ISO_8601_DATETIME>",

  "author": {
    "@type": "Person",
    "name": "<AUTHOR_NAME>",
    "url": "<AUTHOR_PROFILE_URL>",
    "sameAs": [
      "<AUTHOR_LINKEDIN_URL>",
      "<AUTHOR_ORCID_OR_SOCIAL_URL>"
    ]
  },

  "publisher": {
    "@type": "Organization",
    "name": "<PUBLISHER_NAME>",
    "logo": {
      "@type": "ImageObject",
      "url": "<PUBLISHER_LOGO_URL>",
      "width": 600,
      "height": 60
    }
  },

  "mainEntityOfPage": {
    "@type": "WebPage",
    "@id": "<CANONICAL_URL>"
  },

  "articleSection": "<CATEGORY_OR_VERTICAL>",
  "keywords": ["<TOPIC_1>", "<TOPIC_2>", "<TOPIC_3>"],
  "wordCount": 0,
  "inLanguage": "<BCP47_LANG_CODE_E_G_en_OR_ko_KR>"
}
```

Required: `headline`, `author`, `datePublished`.
Recommended: `image`, `dateModified`, `publisher`, `mainEntityOfPage`.
Optional: `alternativeHeadline`, `articleSection`, `keywords`, `wordCount`, `inLanguage`.

---

## 2. OpinionArticle (columns, editorials, perspective pieces)

`OpinionArticle` is a subtype of `Article`. All `Article` fields still apply. The distinct type signals subjective content to answer engines, which changes how it is cited.

```json
{
  "@context": "https://schema.org",
  "@type": "OpinionArticle",

  "headline": "<OPINION_HEADLINE>",
  "description": "<META_DESCRIPTION>",

  "datePublished": "<ISO_8601_DATETIME>",
  "dateModified": "<ISO_8601_DATETIME>",

  "author": {
    "@type": "Person",
    "name": "<COLUMNIST_NAME>",
    "jobTitle": "<COLUMNIST_ROLE>",
    "worksFor": {
      "@type": "Organization",
      "name": "<PUBLISHER_NAME>"
    },
    "url": "<COLUMNIST_PROFILE_URL>"
  },

  "publisher": {
    "@type": "Organization",
    "name": "<PUBLISHER_NAME>",
    "logo": {
      "@type": "ImageObject",
      "url": "<PUBLISHER_LOGO_URL>"
    }
  },

  "about": {
    "@type": "Thing",
    "name": "<TOPIC_OR_ENTITY>"
  },

  "mainEntityOfPage": {
    "@type": "WebPage",
    "@id": "<CANONICAL_URL>"
  }
}
```

---

## 3. Review (case studies with measurable outcomes, product reviews)

```json
{
  "@context": "https://schema.org",
  "@type": "Review",

  "itemReviewed": {
    "@type": "<THING_TYPE_E_G_Product_Service_CreativeWork>",
    "name": "<ITEM_NAME>",
    "url": "<ITEM_URL>"
  },

  "reviewRating": {
    "@type": "Rating",
    "ratingValue": "<0_TO_5_DECIMAL>",
    "bestRating": "5",
    "worstRating": "0"
  },

  "author": {
    "@type": "Person",
    "name": "<REVIEWER_NAME>",
    "jobTitle": "<REVIEWER_ROLE>"
  },

  "datePublished": "<ISO_8601_DATETIME>",
  "dateModified": "<ISO_8601_DATETIME>",

  "reviewBody": "<SUMMARY_OF_REVIEW_50_200_WORDS>",

  "publisher": {
    "@type": "Organization",
    "name": "<PUBLISHER_NAME>"
  }
}
```

Required: `itemReviewed`, `reviewRating`, `author`.
Recommended: `reviewBody`, `datePublished`.

---

## 4. FAQPage

Rules: the `Question.name` must match the question text visible on the page. The `Answer.text` can contain plain text or simple HTML (use escaped strings).

```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "<QUESTION_1_EXACT_ON_PAGE_TEXT>",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "<ANSWER_1_40_60_WORDS>"
      }
    },
    {
      "@type": "Question",
      "name": "<QUESTION_2>",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "<ANSWER_2>"
      }
    },
    {
      "@type": "Question",
      "name": "<QUESTION_3>",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "<ANSWER_3>"
      }
    }
  ]
}
```

Minimum three `Question` entries is a soft convention; one is valid JSON-LD but rarely earns a rich result.

---

## 5. HowTo (tutorials, step-by-step guides)

```json
{
  "@context": "https://schema.org",
  "@type": "HowTo",

  "name": "<PROCEDURE_NAME>",
  "description": "<ONE_SENTENCE_SUMMARY>",

  "image": "<HERO_IMAGE_URL>",

  "totalTime": "<ISO_8601_DURATION_E_G_PT45M>",
  "prepTime": "<ISO_8601_DURATION>",
  "performTime": "<ISO_8601_DURATION>",

  "estimatedCost": {
    "@type": "MonetaryAmount",
    "currency": "<ISO_4217_E_G_USD_KRW>",
    "value": "<AMOUNT>"
  },

  "tool": [
    { "@type": "HowToTool", "name": "<TOOL_1>" },
    { "@type": "HowToTool", "name": "<TOOL_2>" }
  ],

  "supply": [
    { "@type": "HowToSupply", "name": "<SUPPLY_1>" }
  ],

  "step": [
    {
      "@type": "HowToStep",
      "position": 1,
      "name": "<STEP_1_NAME>",
      "text": "<STEP_1_BODY_1_2_SENTENCES>",
      "image": "<STEP_1_IMAGE_URL>",
      "url": "<STEP_1_ANCHOR_URL>"
    },
    {
      "@type": "HowToStep",
      "position": 2,
      "name": "<STEP_2_NAME>",
      "text": "<STEP_2_BODY>"
    },
    {
      "@type": "HowToStep",
      "position": 3,
      "name": "<STEP_3_NAME>",
      "text": "<STEP_3_BODY>"
    }
  ]
}
```

Required: `name`, `step`.
Recommended: `totalTime`, `tool`, at least one `image`.

ISO 8601 duration cheat sheet: `PT30M` = 30 minutes, `PT2H` = 2 hours, `P1D` = 1 day.

---

## 6. Person (author byline, expert profile)

```json
{
  "@context": "https://schema.org",
  "@type": "Person",

  "name": "<FULL_NAME>",

  "givenName": "<FIRST_NAME>",
  "familyName": "<LAST_NAME>",

  "jobTitle": "<CURRENT_ROLE>",

  "worksFor": {
    "@type": "Organization",
    "name": "<CURRENT_ORG_NAME>",
    "url": "<CURRENT_ORG_URL>"
  },

  "url": "<CANONICAL_PROFILE_URL>",

  "image": "<HEADSHOT_URL>",

  "sameAs": [
    "<LINKEDIN_URL>",
    "<PERSONAL_SITE_URL>",
    "<WIKIPEDIA_URL_IF_ANY>",
    "<ORCID_OR_GITHUB_URL>"
  ],

  "knowsAbout": [
    "<EXPERTISE_AREA_1>",
    "<EXPERTISE_AREA_2>"
  ],

  "alumniOf": {
    "@type": "EducationalOrganization",
    "name": "<SCHOOL_NAME>"
  }
}
```

E-E-A-T tip: populate `sameAs` with at least two authoritative profiles (LinkedIn + personal site, or ORCID + a professional body). Answer engines use `sameAs` to disambiguate authors with common names.

---

## 7. Organization (publisher identity, brand hub)

```json
{
  "@context": "https://schema.org",
  "@type": "Organization",

  "name": "<ORG_NAME>",
  "legalName": "<LEGAL_ENTITY_NAME>",

  "url": "<CANONICAL_HOMEPAGE_URL>",

  "logo": {
    "@type": "ImageObject",
    "url": "<LOGO_URL>",
    "width": 600,
    "height": 60
  },

  "foundingDate": "<ISO_DATE>",

  "sameAs": [
    "<LINKEDIN_COMPANY_URL>",
    "<X_OR_TWITTER_URL>",
    "<WIKIPEDIA_URL_IF_ANY>"
  ],

  "contactPoint": [
    {
      "@type": "ContactPoint",
      "contactType": "customer service",
      "email": "<SUPPORT_EMAIL>",
      "areaServed": "<COUNTRY_OR_REGION_CODE>",
      "availableLanguage": ["<BCP47_LANG_1>", "<BCP47_LANG_2>"]
    },
    {
      "@type": "ContactPoint",
      "contactType": "press",
      "email": "<PRESS_EMAIL>"
    }
  ],

  "address": {
    "@type": "PostalAddress",
    "streetAddress": "<STREET>",
    "addressLocality": "<CITY>",
    "addressRegion": "<REGION>",
    "postalCode": "<POSTAL>",
    "addressCountry": "<ISO_3166_ALPHA2>"
  }
}
```

---

## 8. BreadcrumbList (pair with every page)

Ordered by `position`. Final item omits `item` because it is the current page.

```json
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    {
      "@type": "ListItem",
      "position": 1,
      "name": "<HOME_LABEL>",
      "item": "<HOME_URL>"
    },
    {
      "@type": "ListItem",
      "position": 2,
      "name": "<SECTION_LABEL>",
      "item": "<SECTION_URL>"
    },
    {
      "@type": "ListItem",
      "position": 3,
      "name": "<SUBSECTION_LABEL>",
      "item": "<SUBSECTION_URL>"
    },
    {
      "@type": "ListItem",
      "position": 4,
      "name": "<CURRENT_PAGE_LABEL>"
    }
  ]
}
```

---

## 9. InterviewObject (embedded inside an Article)

```json
{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": "<INTERVIEW_HEADLINE>",
  "datePublished": "<ISO_8601_DATETIME>",
  "author": { "@type": "Person", "name": "<INTERVIEWER_NAME>" },
  "mainEntity": {
    "@type": "InterviewObject",
    "interviewer": {
      "@type": "Person",
      "name": "<INTERVIEWER_NAME>",
      "jobTitle": "<INTERVIEWER_ROLE>"
    },
    "interviewee": {
      "@type": "Person",
      "name": "<INTERVIEWEE_NAME>",
      "jobTitle": "<INTERVIEWEE_ROLE>",
      "worksFor": { "@type": "Organization", "name": "<INTERVIEWEE_ORG>" },
      "sameAs": ["<INTERVIEWEE_LINKEDIN_URL>"]
    }
  }
}
```

As of 2026, `InterviewObject` has variable support across validators. Verify current rich-result eligibility on Google's structured-data docs before relying on it for traffic.

---

## Combining schemas on one page

Two valid patterns:

| Pattern | How | When |
|---|---|---|
| Multiple `<script>` blocks | One JSON-LD block per primary schema type | Simple pages with `Article` + `BreadcrumbList` + optional `FAQPage` |
| Single `@graph` | Wrap all entities in a `@graph` array sharing one `@context` | Complex pages; cleaner when entities cross-reference by `@id` |

### `@graph` example

```json
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Article",
      "@id": "<CANONICAL_URL>#article",
      "headline": "<HEADLINE>",
      "author": { "@id": "<AUTHOR_PROFILE_URL>#person" }
    },
    {
      "@type": "Person",
      "@id": "<AUTHOR_PROFILE_URL>#person",
      "name": "<AUTHOR_NAME>"
    },
    {
      "@type": "BreadcrumbList",
      "@id": "<CANONICAL_URL>#breadcrumbs",
      "itemListElement": []
    }
  ]
}
```

---

## Verification

After filling a template, paste into both:

- `https://validator.schema.org/` — schema.org conformance
- `https://search.google.com/test/rich-results` — Google rich-result eligibility

If they disagree, the Google test is authoritative for Google SERP and AI Overviews; the schema.org validator is authoritative for cross-vendor AEO/GEO.
