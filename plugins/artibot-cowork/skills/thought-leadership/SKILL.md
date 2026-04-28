---
context: fork
name: thought-leadership
description: "Produces founder/executive/expert thought leadership content with author bio discipline, Authority-Vulnerability-Value mix, and E-E-A-T signal implementation for LinkedIn long-form, company blogs, and newsletters. Use when user asks about thought leadership, founder content, executive writing, LinkedIn long-form, personal brand, E-E-A-T, 소트리더십, 경영자 글, 전문가 기고, or 개인 브랜딩."
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "thought leadership"
  - "founder content"
  - "executive writing"
  - "linkedin long form"
  - "personal brand content"
  - "expert commentary"
  - "E-E-A-T"
  - "소트리더십"
  - "경영자 글"
  - "전문가 기고"
  - "개인 브랜딩"
agents:
  - "content-marketer"
  - "doc-updater"
tokens: "~4K"
category: "marketing"
depends_on:
  - copywriting
  - long-form-writing
suggests:
  - voice-reference
  - content-seo
  - ai-slop-reviewer
---

# Thought Leadership

## When This Skill Applies

- Long-form LinkedIn posts published under a named founder, executive, or senior practitioner
- Company-blog pieces where the author's identity is the trust mechanism, not the brand's
- Newsletter credibility editions (founder letters, quarterly notes, named-author analyses)
- Industry-publication bylines where an individual's point of view is the draw
- Converting internal expertise into public-facing content that compounds the author's reputation

This skill does not apply to anonymous brand blog posts, unsigned newsletter issues, or content published under generic staff accounts.

---

## Core Guidance

### 1. The Named-Author Rule

Thought leadership requires a named human author with a verifiable identity. Posts from "The Team", "Admin", "Editorial", or generic accounts forfeit the signal the format depends on.

| Authorship Form | Trust Signal | Use in Thought Leadership |
|-----------------|--------------|---------------------------|
| Full name + title + company | High | Required |
| First name only, no title | Low | Unacceptable |
| Role label ("The CEO") with no name | None | Unacceptable |
| Staff or admin account | None | Unacceptable |
| Ghostwritten, disclosed | Moderate | Acceptable with disclosure |
| Ghostwritten, undisclosed as own | Trust-destroying if discovered | Do not |

If the real author cannot be named, the piece should be reclassified as company content and re-written without thought-leadership framing.

---

### 2. Three-Sentence Author Bio Formula

Every thought leadership piece carries a bio block. Three sentences, in order, no more:

| Sentence | Contents | Example Shape |
|----------|----------|---------------|
| 1 | Current role + tenure + domain | "Head of growth at a Series-B supply-chain startup for the past four years, focused on marketplace liquidity." |
| 2 | Why this author on this topic | "Before that, I spent six years running paid acquisition at two B2B SaaS companies through their first $20M of ARR." |
| 3 | What the reader gets | "This post shares the three metrics I would have monitored earlier if I could rewind each of those stints." |

Failure modes in bio blocks:

| Failure | Why It Hurts |
|---------|--------------|
| Cramming five roles into sentence 1 | Buries the current claim to attention |
| Missing the "why this author" sentence | Asks the reader to trust without grounds |
| Reader-benefit sentence absent | Leaves the piece sounding self-referential |
| More than three sentences | Reads as a jacket blurb; loses compression |
| Generic claims ("passionate about tech") | Adds noise without authority |

---

### 3. Authority-Vulnerability-Value Mix

The content itself follows a weighted mix across three signals. Imbalance is the dominant failure mode.

| Signal | Target Share | Minimum | Maximum | What It Provides |
|--------|--------------|---------|---------|------------------|
| Authority | 40-50% | 30% | 60% | Reason to read this author |
| Vulnerability | 10-20% | 5% | 20% | Reason to believe this author is honest |
| Value | 35-45% | 30% | 60% | Reason the reader's time was well spent |

**Authority indicators** — specific credentials, named projects, concrete numbers, role-derived observations. Not: "I have worked in tech for years."

**Vulnerability disclosure** — exactly one honest failure, misjudgment, or limitation. One. Two sounds like a brand gesture. Three sounds like a confession booth.

**Value signals** — specific, implementable takeaways the reader can test next week without needing the author's context. At least two, ideally three.

Example distribution across a 1,500-word LinkedIn post:

| Section | Words | Mix |
|---------|-------|-----|
| Hook | 120 | Authority 60% / Value 40% |
| Context | 350 | Authority 70% / Vulnerability 30% |
| Core argument | 650 | Authority 30% / Value 70% |
| Reader application | 280 | Value 100% |
| Close | 100 | Authority 50% / Value 50% |

---

### 4. E-E-A-T Signal Implementation

Experience, Expertise, Authoritativeness, Trustworthiness — each with explicit implementation markers.

| Signal | Implementation Marker | Pass Example | Fail Example |
|--------|----------------------|--------------|--------------|
| Experience | First-person description of having done the thing | "During the 2024 pricing rewrite, I tested three variants across..." | "Pricing rewrites are complex." |
| Expertise | Technical depth visible at the detail level | Specifies the exact config, metric definition, or edge case | Surveys the topic without committing |
| Authoritativeness | Externally verifiable affiliations or citations | Links to the author's speaking engagement, paper, or named project | Claims without paths to verify |
| Trustworthiness | Disclosures, corrections, source transparency | "I hold equity in a competitor of the company I am analyzing, disclosed here." | Hides conflicts; no sources linked |

**Per-piece E-E-A-T checklist:**

- [ ] At least one specific first-person Experience anecdote (with date or project name)
- [ ] At least one Expertise marker that non-experts would not know to include
- [ ] At least one Authoritativeness link (to the author's own work, dataset, or named affiliation)
- [ ] A visible Trustworthiness element (disclosure, last-updated date, or source citations)

Missing any one of the four drops the piece into "general commentary" territory, where E-E-A-T ranking boosts do not apply.

---

### 5. Person Schema with `sameAs`

Thought-leadership pages benefit from structured data identifying the author as a Person entity linked to their other verified profiles. The `sameAs` array is the key field.

```json
{
  "@context": "https://schema.org",
  "@type": "Person",
  "name": "Jane Park",
  "jobTitle": "Head of Growth",
  "worksFor": {
    "@type": "Organization",
    "name": "Example Supply Co."
  },
  "url": "https://example-personal-site.com/about",
  "sameAs": [
    "https://www.linkedin.com/in/example-jane-park",
    "https://github.com/example-jane-park",
    "https://example-personal-site.com",
    "https://x.com/example_jane_park"
  ]
}
```

All URLs above are illustrative placeholders. Replace with real, verifiable profiles.

| `sameAs` Entry | Purpose | Minimum Recommended |
|----------------|---------|---------------------|
| LinkedIn profile | Professional identity confirmation | Required |
| Personal website | Independent self-published presence | Strongly recommended |
| GitHub / domain-specific profile | Technical or craft identity | Recommended for technical authors |
| Social profile (X, Threads) | Live-voice confirmation | Optional |
| Industry organization page | Institutional affiliation | Optional |

The Person schema belongs on the author bio page and can be injected on article pages that reference the author byline.

---

### 6. Platform Length Guidance

Platform conventions are not arbitrary — they reflect where readers arrive and what they tolerate.

| Platform | Length Range (words) | Ideal Structure | Conversion Mechanism |
|----------|---------------------|-----------------|----------------------|
| LinkedIn long-form | 1,300-1,900 | Hook + 3-5 subsections + close | Comments > DMs |
| Company blog | 1,500-2,500 | Hook + H2 subsections + author bio + CTA | Newsletter signup, follow-on reads |
| Newsletter credibility edition | 800-1,500 | Lead + argument + practitioner take + close | Reply, reader relationship |
| Industry publication byline | 1,200-2,000 | Per publication's house structure | Profile traffic, follow-on invites |
| Medium / Substack personal | 1,000-2,500 | Hook + narrative arc + close | Clap/subscribe |

Below the minimum the author cannot establish authority; above the maximum retention collapses.

---

### 7. Anti-Patterns

| Anti-Pattern | Why It Fails | Repair |
|--------------|--------------|--------|
| Humblebrag | "I can't believe my post got 2M views, what did I even say?" — reads as dishonest | Remove the post-hoc modesty; state the observation you drew |
| False humility | "I'm no expert, but..." then asserts with expert confidence | Drop the disclaimer or qualify the claim; not both |
| Over-credentialing | Lists every past role before reaching the point | Compress to bio block; let the argument carry |
| Staff-account publishing | Thought leadership under "The Team" byline | Re-publish under the actual author or reclassify as brand content |
| Unsourced assertion | "Research shows..." with no citation | Name the research or cut the sentence |
| Success-story avalanche | Five wins in a row, no failures | Replace two with vulnerability markers |
| Confessional overload | Four failures disclosed, no authority frame | Reduce to one; restore authority |
| Recycled corporate narrative | Re-publishes the company's blog post in first person | Say something the company page cannot say |
| Generic benefit close | "Hope this helps!" | Specific reader-application sentence |

---

### 8. Ghostwriting Disclosure Standard

If the piece was drafted by someone other than the named author, the acceptable form is a brief editorial note: "Drafted in collaboration with [role]." This preserves the author's ownership of the argument while acknowledging the craft.

A piece that the named author did not read, approve, or stand behind should not be published under their byline regardless of disclosure.

---

## Output Format

```
THOUGHT LEADERSHIP PACKAGE
==========================
Author:         [full name + title + company]
Platform:       [linkedin-long | company-blog | newsletter | byline | personal]
Target Length:  [word count]
Primary Signal: [authority | vulnerability | value]

AUTHOR BIO (3 sentences)
------------------------
1. [role + tenure + domain]
2. [why-this-author sentence]
3. [reader-benefit sentence]

CONTENT MIX TARGET
------------------
| Signal        | Target % | Sections Carrying It                 |
|---------------|----------|--------------------------------------|
| Authority     | 40-50    | Hook, context, core argument         |
| Vulnerability | 10-20    | One disclosure paragraph             |
| Value         | 35-45    | Core argument, reader application    |

E-E-A-T CHECKLIST
-----------------
| Signal            | Implementation in Draft            | Present? |
|-------------------|-----------------------------------|----------|
| Experience        | [specific first-person anecdote]   | [Y/N]    |
| Expertise         | [detail-level technical marker]    | [Y/N]    |
| Authoritativeness | [verifiable external link]         | [Y/N]    |
| Trustworthiness   | [disclosure / dated / cited]       | [Y/N]    |

PERSON SCHEMA
-------------
[JSON-LD block with Person + sameAs array]

ANTI-PATTERN SCAN
-----------------
| Pattern             | Found? | Repair Applied                  |
|---------------------|--------|---------------------------------|
| Humblebrag          | [Y/N]  | [action]                        |
| Unsourced assertion | [Y/N]  | [action]                        |
| Staff byline        | [Y/N]  | [action]                        |
```

---

## Quick Reference

**Author Bio**: Role + tenure, why-this-author, reader-benefit — three sentences, no more
**Content Mix**: 40-50% Authority / 10-20% Vulnerability / 35-45% Value
**E-E-A-T**: Experience + Expertise + Authoritativeness + Trustworthiness, all four per piece
**Schema**: Person with `sameAs` linking to LinkedIn + personal site minimum
**Length**: LinkedIn 1,300-1,900 / Company blog 1,500-2,500 / Newsletter 800-1,500
**Hard No**: Staff-account bylines, undisclosed ghostwriting, humblebrag closers

---

## References

- See `${CLAUDE_SKILL_DIR}/../content-seo/SKILL.md` for how author E-E-A-T signals interact with on-page SEO
- See `${CLAUDE_SKILL_DIR}/../column-editorial/SKILL.md` for argumentative-column structure when the thought-leadership piece is a contrarian take
- See `${CLAUDE_SKILL_DIR}/../ai-slop-reviewer/SKILL.md` for removing hollow credentials and vague authority claims before publication
