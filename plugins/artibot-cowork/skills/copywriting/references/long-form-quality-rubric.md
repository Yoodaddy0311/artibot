# Long-Form Quality Rubric

A 100-point rubric for evaluating long-form content (blog posts, columns, case studies, thought-leadership essays, interviews). Every v0.3.0 writing skill and the `ai-slop-reviewer` agent references this rubric as the common quality gate before publishing.

Last updated: 2026-04-23

---

## Scoring Overview

Score each of five categories independently, then sum for a 0-100 total. A piece is not "above the line" until each category hits its minimum floor AND the total hits the threshold. Raw totals without category floors mask catastrophic weakness in a single dimension.

| Category | Max | Floor | Core evaluation |
|---|---|---|---|
| Content Quality | 30 | 18 | Logic, depth, originality, specificity |
| SEO | 25 | 13 | Keyword targeting, heading structure, meta, internal linking |
| E-E-A-T | 15 | 8 | Experience, Expertise, Authoritativeness, Trustworthiness |
| Technical | 15 | 8 | Paragraph/sentence length, readability, schema markup |
| AI Citation (AEO/GEO) | 15 | 7 | Citable passages, Q&A headings, quotable formats |
| **Total** | **100** | — | — |

---

## Category 1: Content Quality (30 points)

| # | Check | Points | Pass condition |
|---|-------|--------|----------------|
| 1 | Thesis clarity | 5 | One sentence in the first 150 words states the claim the piece defends |
| 2 | Evidence per claim | 6 | Every load-bearing claim backed by data, example, quote, or lived experience |
| 3 | Specificity | 5 | Key nouns attached to numbers, names, or dates; zero "various", "many", "several" without counts |
| 4 | Originality | 5 | At least one insight, framework, or angle not findable in the first page of search results |
| 5 | Logical flow | 4 | Each section advances the thesis; no orphan sections |
| 6 | Counter-argument | 3 | Best alternative view acknowledged or limits of the claim stated |
| 7 | Reader takeaway | 2 | Reader can name one thing to do, think, or watch for after finishing |

---

## Category 2: SEO (25 points)

| # | Check | Points | Pass condition |
|---|-------|--------|----------------|
| 1 | Primary keyword targeting | 5 | Primary keyword in H1, first 100 words, URL slug, and at least one H2 |
| 2 | Secondary keyword coverage | 4 | 3-7 semantically related terms distributed across H2/H3 |
| 3 | Heading hierarchy | 4 | Single H1, H2 for each major section, H3 only where depth is needed; no skipped levels |
| 4 | Meta title + description | 3 | Title 50-60 chars, description 140-160 chars, both include primary keyword |
| 5 | Internal links | 3 | 3-6 contextual internal links with descriptive anchor text |
| 6 | External authority links | 2 | 2-4 outbound links to authoritative, non-competing sources |
| 7 | Image alt text | 2 | Every image has descriptive alt text; at least one image includes the keyword |
| 8 | URL slug | 2 | Slug is short, keyword-bearing, hyphen-separated, no stopwords |

---

## Category 3: E-E-A-T (15 points)

| # | Check | Points | Pass condition |
|---|-------|--------|----------------|
| 1 | Experience signal | 4 | First-person or first-party evidence: "we ran", "I measured", client anecdote with permission |
| 2 | Expertise signal | 4 | Author byline with credentials, role, or track record relevant to the topic |
| 3 | Authoritativeness | 3 | Original data, named case, or cited expert within first 500 words |
| 4 | Trustworthiness | 2 | Sources linked; claims dated; limitations or data cutoffs stated |
| 5 | Disclosure | 2 | Sponsorship, affiliate, or AI-assist disclosed where applicable |

---

## Category 4: Technical (15 points)

| # | Check | Points | Pass condition |
|---|-------|--------|----------------|
| 1 | Paragraph length | 3 | Average paragraph ≤ 100 words; no paragraph > 150 words |
| 2 | Sentence length | 3 | Average sentence ≤ 22 words; variation across short/medium/long |
| 3 | Readability grade | 3 | Flesch-Kincaid grade 8-11 for general audiences; 11-14 for technical |
| 4 | Schema markup | 3 | Article or appropriate schema.org type in JSON-LD; author + datePublished present |
| 5 | Mobile formatting | 2 | No horizontal scroll; tables responsive or converted to lists on narrow viewports |
| 6 | Accessibility | 1 | Color contrast passes WCAG AA; no information conveyed by color alone |

---

## Category 5: AI Citation — AEO/GEO (15 points)

| # | Check | Points | Pass condition |
|---|-------|--------|----------------|
| 1 | Citable passages | 4 | At least 2 self-contained blocks of 120-180 words that include a proper noun, a number, and a source — quotable without context |
| 2 | Q&A heading ratio | 3 | 60-70% of H2 headings are phrased as questions |
| 3 | Statistics density | 3 | Minimum 5 verifiable statistics with sources across the piece |
| 4 | Authoritative quotes | 2 | At least 1 block-quoted expert statement with name, role, and date |
| 5 | Summary block | 2 | TL;DR or key-takeaways block near the top; bullet list of 3-5 items |
| 6 | FAQ section | 1 | 3+ question-and-answer pairs at the end, marked with FAQPage schema |

---

## Severity Tiers

Every failed check is labeled by severity. Severity drives whether a piece ships, gets edited, or is rejected.

| Severity | Definition | Action |
|---|---|---|
| Critical | Blocks publishing: factual error, missing attribution, no thesis, E-E-A-T floor missed | Hold until fixed |
| Major | Publishable with edit: readability grade off, Q&A ratio < 40%, paragraph length out of range | Fix within one revision pass before release |
| Minor | Ship and track: one missing internal link, alt text gap, meta description 10 chars over | Log for the next scheduled refresh |

---

## Auto-Flag Rules

These checks are deterministic and automatable — any rubric runner (human or script) should flag them without judgment calls.

| Auto-flag | Rule | Severity |
|---|---|---|
| AI-slop phrase hit | Any match against `anti-ai-writing.md` blacklist tables | Major per hit, Critical if ≥ 5 hits |
| Q&A heading ratio | Share of H2 as questions < 50% | Major |
| Paragraph length | Average words/paragraph > 100 OR any paragraph > 150 words | Major |
| Sentence length | Average words/sentence > 25 | Major |
| Statistics count | Fewer than 5 statistics with inline sources | Minor |
| Missing H1 | Zero or multiple H1 tags | Critical |
| Broken heading hierarchy | H3 without parent H2, or H4 without parent H3 | Major |
| Meta length | Title outside 45-65 chars OR description outside 130-165 chars | Minor |
| No internal links | Zero internal links in 1000+ word piece | Major |
| Missing alt text | Any `<img>` without `alt` attribute | Major |
| No author schema | `author` field absent from JSON-LD | Major |
| Hedge stack | Any sentence with 3+ qualifiers ("might potentially possibly") | Major |

---

## Pass/Fail Thresholds

| Total | Tier | Disposition |
|---|---|---|
| 90-100 | Publish-ready | Ship as-is; log Minor issues for next refresh |
| 75-89 | Minor edits | One editing pass on Minor items; ship same cycle |
| 60-74 | Major rewrite | Return to writer; fix Major items; re-score |
| < 60 | Reject / restart | Scope or brief problem; do not patch at the draft layer |

Category floors apply before the tier is granted. A 92-point piece that scored 6/15 on E-E-A-T drops to "Major rewrite" regardless of total.

---

## Sample Rubric Run

Hypothetical blog post: "How Our SaaS Team Cut Onboarding Time from 14 Days to 3".

| Category | Score | Notes |
|---|---|---|
| Content Quality | 26/30 | Thesis clear, 11 specific data points, original framework; counter-argument thin (-3), takeaway implicit (-1) |
| SEO | 21/25 | Keyword in H1, slug, meta; only 2 internal links (-2); one H3 under missing H2 (-2) |
| E-E-A-T | 13/15 | Author byline with role, first-party data, sources linked; no dated sponsorship disclosure (-2) |
| Technical | 12/15 | Avg paragraph 88 words; one paragraph 162 words (-2); no JSON-LD author field (-1) |
| AI Citation | 11/15 | 2 citable passages, 58% Q&A H2, 7 statistics, 1 expert quote; no FAQ block (-2); TL;DR missing (-2) |
| **Total** | **83/100** | **Tier: Minor edits** — fix one long paragraph, add FAQ, add TL;DR, add two internal links, add disclosure line |

---

## Reviewer Workflow

1. Run auto-flags first. Capture all hits before reading prose.
2. Score category by category in the table order above; do not jump around.
3. Apply severity tags to every failed check.
4. Check category floors before assigning the final tier.
5. Return the scored rubric with a prioritized fix list — Critical first, Major by impact, Minor batched.
