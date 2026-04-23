---
context: fork
name: schema-generator
description: "Generates JSON-LD structured data, llms.txt, and robots.txt snippets for AEO/GEO (answer engine and generative engine optimization). Converts aeo-geo-2026 reference recommendations into executable templates. Use when user asks about schema markup, JSON-LD templates, structured data, AEO 실행, GEO 구현, llms.txt, citation capsule, FAQPage, HowTo, OpinionArticle, or 구조화 데이터."
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "schema"
  - "JSON-LD"
  - "structured data"
  - "AEO 실행"
  - "GEO 구현"
  - "llms.txt"
  - "citation capsule"
  - "FAQPage"
  - "HowTo schema"
  - "OpinionArticle"
agents:
  - "content-marketer"
  - "seo-specialist"
tokens: "~5K"
category: "marketing"
---

# Schema Generator

## When This Skill Applies
- Writing JSON-LD blocks for articles, FAQ pages, interviews, reviews, and tutorials
- Shipping `llms.txt` so AI answer engines get a curated site map
- Updating `robots.txt` to allow or deny specific AI crawler user agents
- Wrapping a load-bearing passage as a citation capsule for answer-engine lift
- Picking the right schema type when content does not fit the default `Article`
- Validating structured data before publish using public validator URLs

This skill is the executable counterpart to `skills/copywriting/references/aeo-geo-2026.md`. The reference explains *why*; this skill hands back templates, snippets, and a decision table.

## Placeholder Convention

All templates in this skill and in `references/json-ld-schemas.md` use a single placeholder format: **`<ANGLE_SNAKE>`** — an `UPPER_SNAKE_CASE` token wrapped in angle brackets.

| Rule | Example |
|---|---|
| Wrap every placeholder in `<` and `>` | `<AUTHOR_NAME>` |
| Use `UPPER_SNAKE_CASE` for the inner name | `<HEADLINE_UP_TO_110_CHARS>` |
| Include unit or format hints in the name when helpful | `<ISO_8601_DATETIME>`, `<BCP47_LANG_CODE>` |
| Strip every `<ANGLE_SNAKE>` token before deploy | Find-and-replace pass with editor regex `<[A-Z0-9_]+>` |

Editors can sweep for unresolved placeholders with a single regex: `<[A-Z0-9_]+>`. Any hit in a shipped JSON-LD file is a bug.

## Core Guidance

### 1. Schema Type Decision Table

Pick one primary type per page. Add `BreadcrumbList` on every page regardless.

| Content type | Primary schema | Secondary / nested | Reason |
|---|---|---|---|
| Blog post, essay | `Article` | `BreadcrumbList`, `Person` (author) | Default; Google News indexing, FAQ extraction possible |
| Case study | `Article` | `Review` (for quantitative outcomes) | Structures outcome metrics so answer engines can lift them |
| Opinion column | `OpinionArticle` (Article subtype) | `Person` | Marks subjective stance; answer engines treat it differently from reporting |
| Interview feature | `Article` | `InterviewObject`, `Person` (interviewee, interviewer) | Carries both-party metadata |
| Thought leadership | `Article` | `Person` (with `knowsAbout`, `alumniOf`) | Supplies E-E-A-T author authority signals |
| FAQ section or page | `FAQPage` | — | AI engines pull Q&A directly; mandatory for FAQ-shaped content |
| Tutorial, step-by-step | `HowTo` | `HowToStep`, `HowToTool` | Structures steps, tools, timings for answer boxes |
| Product page | `Product` | `Offer`, `AggregateRating` | Out of scope for editorial skill; use e-commerce stack |
| Homepage, brand hub | `Organization` | `WebSite`, `SearchAction` | Publisher identity + sitelinks search box |

**Anti-pattern**: do not stack two primary types on the same page (e.g., `Article` + `HowTo` at top level). Nest one inside the other or split the page.

### 2. Required vs. Recommended Fields (quick reference)

| Schema | Required | Strongly recommended | Optional but useful |
|---|---|---|---|
| `Article` | `headline`, `author`, `datePublished` | `image`, `dateModified`, `publisher`, `mainEntityOfPage` | `articleSection`, `keywords`, `wordCount` |
| `OpinionArticle` | same as `Article` | `author.jobTitle`, `about` | `editor`, `backstory` |
| `FAQPage` | `mainEntity` (array of `Question`) | each `Question.acceptedAnswer.text` | `about` topic linkage |
| `HowTo` | `name`, `step` | `totalTime`, `estimatedCost`, `tool`, `supply` | `yield`, `prepTime`, `performTime` |
| `Review` | `itemReviewed`, `reviewRating`, `author` | `reviewBody`, `datePublished` | `publisher` |
| `Person` | `name` | `url`, `jobTitle`, `worksFor`, `sameAs` | `knowsAbout`, `alumniOf` |
| `Organization` | `name`, `url` | `logo`, `sameAs` | `contactPoint`, `foundingDate` |
| `BreadcrumbList` | `itemListElement` (ordered) | `position`, `name`, `item` | — |

Full templates with all fields live in `references/json-ld-schemas.md`.

### 3. Minimal `Article` JSON-LD Template

Placeholders follow the `<ANGLE_SNAKE>` convention defined above — `UPPER_SNAKE_CASE` inside angle brackets, find-and-replace before deploy.

```json
{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": "<HEADLINE_UP_TO_110_CHARS>",
  "description": "<META_DESCRIPTION_150_160_CHARS>",
  "image": ["<HERO_IMAGE_URL_16_9>", "<HERO_IMAGE_URL_4_3>", "<HERO_IMAGE_URL_1_1>"],
  "datePublished": "<ISO_8601_DATETIME>",
  "dateModified": "<ISO_8601_DATETIME>",
  "author": {
    "@type": "Person",
    "name": "<AUTHOR_NAME>",
    "url": "<AUTHOR_PROFILE_URL>"
  },
  "publisher": {
    "@type": "Organization",
    "name": "<PUBLISHER_NAME>",
    "logo": {
      "@type": "ImageObject",
      "url": "<PUBLISHER_LOGO_URL>"
    }
  },
  "mainEntityOfPage": {
    "@type": "WebPage",
    "@id": "<CANONICAL_URL>"
  }
}
```

### 4. `FAQPage` Template

One script tag, one `FAQPage`, N `Question`s. Questions must match visible page text exactly — mismatches trigger manual action penalties.

```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "<QUESTION_TEXT_EXACTLY_AS_ON_PAGE>",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "<ANSWER_40_60_WORDS_PLAIN_TEXT_OR_HTML>"
      }
    },
    {
      "@type": "Question",
      "name": "<SECOND_QUESTION>",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "<SECOND_ANSWER>"
      }
    }
  ]
}
```

### 5. `HowTo` Template (for tutorials)

```json
{
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "<PROCEDURE_NAME>",
  "description": "<ONE_SENTENCE_SUMMARY>",
  "totalTime": "<ISO_8601_DURATION_E_G_PT30M>",
  "tool": [
    { "@type": "HowToTool", "name": "<TOOL_1>" }
  ],
  "step": [
    {
      "@type": "HowToStep",
      "position": 1,
      "name": "<STEP_1_NAME>",
      "text": "<STEP_1_DETAIL_1_2_SENTENCES>",
      "image": "<STEP_1_IMAGE_URL>"
    },
    {
      "@type": "HowToStep",
      "position": 2,
      "name": "<STEP_2_NAME>",
      "text": "<STEP_2_DETAIL>"
    }
  ]
}
```

### 6. `OpinionArticle` Template (for columns)

`OpinionArticle` inherits from `Article`. The declared type signals to answer engines that the content is subjective, which changes how it is cited.

```json
{
  "@context": "https://schema.org",
  "@type": "OpinionArticle",
  "headline": "<OPINION_HEADLINE>",
  "author": {
    "@type": "Person",
    "name": "<COLUMNIST_NAME>",
    "jobTitle": "<ROLE>",
    "worksFor": { "@type": "Organization", "name": "<PUBLISHER>" }
  },
  "datePublished": "<ISO_8601_DATETIME>",
  "dateModified": "<ISO_8601_DATETIME>",
  "about": "<TOPIC_OR_ENTITY>",
  "mainEntityOfPage": { "@type": "WebPage", "@id": "<CANONICAL_URL>" }
}
```

### 7. Interview Feature (`Article` + `InterviewObject`)

```json
{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": "<INTERVIEW_HEADLINE>",
  "datePublished": "<ISO_8601_DATETIME>",
  "author": [
    { "@type": "Person", "name": "<INTERVIEWER_NAME>" }
  ],
  "mainEntity": {
    "@type": "InterviewObject",
    "interviewer": { "@type": "Person", "name": "<INTERVIEWER_NAME>" },
    "interviewee": {
      "@type": "Person",
      "name": "<INTERVIEWEE_NAME>",
      "jobTitle": "<INTERVIEWEE_ROLE>",
      "worksFor": { "@type": "Organization", "name": "<INTERVIEWEE_ORG>" }
    }
  }
}
```

> As of 2026-04, `InterviewObject` is an emerging schema.org type with limited AI engine support. Verify current adoption before production use. See json-ld-schemas.md:446 for extended note.

### 8. `BreadcrumbList` Template (pair with every primary schema)

```json
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "<HOME_LABEL>", "item": "<HOME_URL>" },
    { "@type": "ListItem", "position": 2, "name": "<SECTION_LABEL>", "item": "<SECTION_URL>" },
    { "@type": "ListItem", "position": 3, "name": "<PAGE_LABEL>" }
  ]
}
```

The final item intentionally omits `item` — it is the current page.

### 9. Citation Capsule Markup

A citation capsule is the HTML wrapper around a citable passage (defined in `aeo-geo-2026.md`). Purpose: make retrieval systems recognize the passage as a self-contained quotable block.

**HTML pattern**:

```html
<figure class="citation-capsule" itemscope itemtype="https://schema.org/Quotation">
  <blockquote itemprop="text" cite="<SOURCE_URL>">
    <p><!-- 120-180 word standalone passage with proper noun + number --></p>
  </blockquote>
  <figcaption>
    Source:
    <cite itemprop="spokenByCharacter" itemscope itemtype="https://schema.org/Person">
      <span itemprop="name"><SOURCE_AUTHOR></span>,
      <span itemprop="jobTitle"><SOURCE_ROLE></span>
    </cite>
    <time itemprop="dateCreated" datetime="<ISO_DATE>"><HUMAN_DATE></time>
  </figcaption>
</figure>
```

**Markdown pattern** (for platforms without raw HTML):

```markdown
> <120-180 word passage with proper noun, number, and source anchor>
>
> — <SOURCE_AUTHOR>, <SOURCE_ROLE>, <HUMAN_DATE>. Source: <SOURCE_URL>
```

Place 2-4 capsules per 1500-word article, first one inside the first 500 words.

### 10. llms.txt and robots.txt Policy

See `references/llms-txt-template.md` for the full `llms.txt` template and the robots.txt AI-crawler policy block. Quick summary:

| File | Purpose | Status (as of 2026, verify current) |
|---|---|---|
| `robots.txt` | Allow/deny specific user agents | Long-standing standard; AI crawler UAs change — re-check vendor docs quarterly |
| `llms.txt` | Curated sitemap for LLMs | Emerging proposal, not a ratified standard; low-cost to ship |
| `llms-full.txt` | Full content dump for LLM ingestion | Variant of above; higher bandwidth, higher surface |

### 11. Validation Tools (reference only, no automatic calls)

Paste the rendered JSON-LD into one of these public validators before publish. This skill does not hit them programmatically.

| Tool | URL | Use for |
|---|---|---|
| Schema.org validator | `https://validator.schema.org/` | Strict schema.org conformance |
| Google Rich Results Test | `https://search.google.com/test/rich-results` | Rich-result eligibility per Google's current rules |
| Yandex structured data validator | `https://webmaster.yandex.com/tools/microtest/` | Cross-vendor sanity check |

If a template in this skill ever conflicts with a validator result, trust the validator — schema.org and vendor rules evolve and this skill is a snapshot.

### 12. Workflow

```
Identify content type -> Pick primary schema from decision table ->
Fill template from references/json-ld-schemas.md -> Add BreadcrumbList ->
Wrap load-bearing passages in citation capsule markup ->
Update llms.txt if site uses one -> Paste into validator -> Ship
```

## Anti-Patterns

- **Do NOT** copy a schema type used by a competitor without checking that your content actually fits it — mismatched types can trigger manual action penalties.
- **Do NOT** leave `<ANGLE_SNAKE_PLACEHOLDERS>` in shipped JSON-LD. The schema is valid but the content is meaningless to retrieval systems.
- **Do NOT** duplicate a primary schema type on the same page (two `Article` blocks). Answer engines pick one, often the wrong one.
- **Do NOT** mark up invisible content. The schema must reflect what a human reader can see on the page.
- **Do NOT** auto-fetch validator endpoints or vendor crawler docs from this skill. Templates are static; verification is a human step.
- **Do NOT** assume `llms.txt` is a ratified standard in 2026. Ship it if your GEO budget allows, but do not treat it as table stakes.
- **Do NOT** flip robots.txt from `Disallow` to `Allow` on AI crawlers without editorial + legal sign-off. It is a publishing-policy decision, not a technical one.

## Output Format

When this skill produces a deliverable, the response should return one or more of:

```
SCHEMA BLOCK(S)
---------------
File:       [suggested filename, e.g., article.jsonld]
Schema:     [Article | OpinionArticle | FAQPage | HowTo | ...]
Placeholders: [count of <ANGLE_SNAKE> tokens to fill]

```json
{ ... }
```

CITATION CAPSULE(S)
-------------------
Format:     [HTML | Markdown]
Count:      [n]
Placement:  [first-500-words | per 800-word band]

LLMS / ROBOTS SNIPPETS
----------------------
File:       [llms.txt | robots.txt]
Scope:      [full site | section]

VALIDATION CHECKLIST
--------------------
- [ ] All <ANGLE_SNAKE_PLACEHOLDERS> replaced
- [ ] Dates in ISO 8601
- [ ] Author Person linked to /about or author page
- [ ] Pasted into schema.org validator and Google Rich Results Test
```

## Quick Reference

- **Default schema**: `Article` + `BreadcrumbList` + `Person` (author)
- **Citation capsule rate**: 2-4 per 1500 words, first one in the first 500 words
- **FAQPage rule**: Question text on page must match `Question.name` exactly
- **Validator before publish**: schema.org + Google Rich Results Test, both
- **llms.txt status (2026)**: emerging, not ratified — verify current

---

## References

- See `${CLAUDE_SKILL_DIR}/references/json-ld-schemas.md` for full JSON-LD templates across 8+ schema types
- See `${CLAUDE_SKILL_DIR}/references/llms-txt-template.md` for `llms.txt` template and robots.txt AI-crawler policy
- See `../copywriting/references/aeo-geo-2026.md` for the AEO/GEO reference this skill implements
