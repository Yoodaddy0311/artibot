# AEO and GEO Reference (2026)

A working reference for optimizing long-form content for Answer Engine Optimization (AEO) and Generative Engine Optimization (GEO) in an era when AI answer engines (ChatGPT, Perplexity, Google SGE, Claude, and their peers) route a material share of reader traffic.

Last updated: 2026-04-23

---

## AEO vs GEO vs SEO

| Dimension | SEO | AEO | GEO |
|---|---|---|---|
| Target surface | Search engine results pages | Answer engines (Perplexity, SGE, Bing Copilot) | Generative LLM responses with citations (ChatGPT, Claude, Gemini) |
| Primary reader | Human scanning 10 blue links | Human reading a synthesized answer box | LLM composing a response, then attributing sources |
| Success metric | Click-through from SERP | Inclusion as cited source in answer | Citation share across generated responses; brand mention frequency |
| Optimization unit | Page | Passage or Q&A block | Passage + factual anchor (name, number, date) |
| Key techniques | Keyword targeting, backlinks, meta | Q&A headings, FAQ schema, citable blocks | Statistics density, authoritative quotes, simple language, citation capsules |
| Freshness pressure | Moderate | High (answer engines re-crawl quickly) | High (retrieval systems prefer recent, dated content) |

SEO still applies; AEO and GEO layer on top. A piece that ranks well in Google but has no citable passages will lose AI-surface traffic even if SERP rank is unchanged.

---

## Citable Passage Rule

A citable passage is a self-contained block that an LLM or answer engine can lift without reading the surrounding article.

| Requirement | Target | Why |
|---|---|---|
| Length | 120-180 words | Long enough to carry context, short enough to fit an answer box |
| Standalone | Reads correctly with no prior or following paragraph | Retrieval chunks rarely include neighbors |
| Proper noun | At least one — person, company, product, place | Anchors the passage to verifiable entity |
| Number | At least one — statistic, date, measurement | Gives the passage factual density |
| Source | Inline citation or footnote reference | Answer engines prefer passages that already carry attribution |
| Position | First passage in the first 500 words; others every 600-800 words | Early chunks are weighted higher in retrieval |

Place 2-4 citable passages per 1500-word article. Mark them in drafts so editors do not break them during revision.

---

## Q&A Heading Ratio

AI parsers extract FAQ blocks and snippet answers from question-shaped headings with high priority. The heading itself becomes retrieval metadata.

| Element | Target |
|---|---|
| Share of H2 as questions | 60-70% |
| Answer location | First paragraph immediately under the question |
| Answer length for snippet capture | 40-60 words in the lead sentence |
| Question style | Natural-language, matches how readers phrase the query aloud |

Mixing in non-question H2 is fine for narrative flow. Pure question-only outlines read as FAQ pages, which is a different content type.

---

## Princeton GEO Techniques

Princeton researchers published benchmarks showing these five techniques increased citation share by roughly 40% in generative engine outputs. Treat the 40% figure as representative of the direction, not a guaranteed uplift — verify against your own category.

| # | Technique | What it is | When to use |
|---|-----------|-----------|-------------|
| 1 | Citation capsule insertion | Embed a short, attributed quote from an authoritative source inside a paragraph that already makes your point | Early in a section that makes a load-bearing claim; borrows authority without displacing your voice |
| 2 | Statistics addition | Add verifiable, sourced numbers to claims that would otherwise be qualitative | Any paragraph where "many", "most", "often" appears — replace with the actual number |
| 3 | Quotation insertion | Add a block-quoted statement from a named expert, with role and date | Once per 800-1200 words; gives retrieval systems a high-value, attributable chunk |
| 4 | Authoritative source linking | Link outbound to primary sources, not aggregators | Every statistical claim; every definitional claim |
| 5 | Simple language rewrite | Rewrite dense sentences to grade 8-11 reading level | Any paragraph above grade 12 Flesch-Kincaid; LLMs prefer clear prose when composing citations |

These techniques compose. A paragraph with a statistic, an expert quote, and a linked primary source is more likely to be cited than any one in isolation.

---

## Content Freshness

Answer engines prefer content that signals active maintenance. Two signals matter: on-page dates and re-crawl frequency.

| Signal | Cadence |
|---|---|
| Major re-publish (update headline, thesis, or lead) | Every 180-365 days |
| Minor refresh (stats, examples, dates) | Every 30-90 days |
| `datePublished` and `dateModified` in JSON-LD | Always current |
| Visible "Last updated" on page | Always current |

Refresh cycles below 30 days on the same piece often underperform — the signal becomes noise. Set the cycle by content velocity, not calendar.

---

## AI Crawler Access

AI crawlers are distinct from search crawlers and have their own user agents. Blocking them is a publishing-policy decision; if you want AEO/GEO surface, you must allow the ones you care about.

### robots.txt policy (example shape only)

```
User-agent: GPTBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Allow: /
```

Use the actual, current user-agent list each vendor publishes — not this sketch. Confirm your choice with legal/editorial before flipping from Disallow to Allow.

### llms.txt (optional, emerging)

A plain-text file at `/llms.txt` that gives LLMs a curated map of the site: canonical URLs, one-line summaries, and the content types you want crawled. Not a standard yet in 2026, but low-cost to ship for sites that invest in GEO.

### Structured data

Answer engines lean on schema.org types to identify passage type and authority. Ship JSON-LD, not Microdata, for new content.

| Schema type | Use for |
|---|---|
| `Article` | Default for blog posts and essays |
| `FAQPage` | Pages built around a Q&A set |
| `HowTo` | Step-by-step instructions with measurable outcomes |
| `Person` | Author byline; link from `Article.author` |
| `Organization` | Publisher identity |
| `BreadcrumbList` | Site navigation hierarchy |

---

## Authoritative Quote Insertion

A properly formatted expert quote is the single highest-signal GEO element per word spent.

| Field | Target |
|---|---|
| Quote length | 80-140 words |
| Attribution | Name, role, organization, date |
| Source link | Primary source (paper, talk, interview, post) |
| Markup | Native `<blockquote>` with `cite` attribute |
| Context | One lead sentence introducing the speaker; one following sentence connecting the quote to your thesis |

One authoritative quote per 800-1200 words is enough. Two or more start to dilute each other.

---

## AEO/GEO Pre-Publish Checklist

| # | Check | Pass condition |
|---|-------|----------------|
| 1 | Citable passages | ≥ 2 passages of 120-180 words with proper noun, number, source |
| 2 | Q&A heading ratio | 60-70% of H2 are questions |
| 3 | First-paragraph answer | Each question-H2 followed by 40-60 word answer |
| 4 | Statistics density | ≥ 5 sourced statistics across the piece |
| 5 | Expert quote | ≥ 1 block-quoted, attributed quote with role + date |
| 6 | Primary sources | All outbound authority links point to primary sources |
| 7 | Dates visible | Visible "Last updated" and JSON-LD `dateModified` |
| 8 | Schema | `Article` (or appropriate type) + `author` Person in JSON-LD |
| 9 | Reading level | Flesch-Kincaid grade 8-11 for general, 11-14 for technical |
| 10 | FAQ block | 3+ Q&A pairs at the end with FAQPage schema |

---

## Verification Note

The benchmark figures, crawler names, and technique attributions above reflect what was publicly known through 2024-2026. Answer engines and their user-agent strings evolve quickly. As of 2026-04-23 — verify current benchmarks, current user-agent strings, and current structured-data recommendations against each vendor's live documentation before shipping policy changes.
