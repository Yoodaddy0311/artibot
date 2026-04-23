# llms.txt Template and AI Crawler Policy

A drop-in template for `llms.txt` plus a `robots.txt` policy block for AI crawler user agents. As of 2026-04-23, `llms.txt` is an emerging proposal, not a ratified standard — verify current adoption against the vendors you care about before treating it as table stakes.

---

## What `llms.txt` is for

`llms.txt` is a plain-text file served at the site root (`https://<domain>/llms.txt`) that gives LLMs a curated, low-noise map of the site: canonical URLs, one-line summaries, and the sections you want retrieval systems to prioritize.

| File | Scope | Use when |
|---|---|---|
| `/llms.txt` | Curated sitemap: links + short summaries | You want to point LLMs at your best content without dumping the whole site |
| `/llms-full.txt` | Full text dump of prioritized pages | You actively want LLMs to ingest long-form content; bandwidth cost is acceptable |
| `/robots.txt` | Allow/deny per user agent | Standard since 1994; use to gate or permit AI crawlers |
| `/sitemap.xml` | Machine sitemap for search engines | Still required for SEO; `llms.txt` does not replace it |

---

## `llms.txt` format

The emerging convention uses Markdown. First-level heading is the site name; a short blockquote gives the one-paragraph elevator pitch; then H2 sections group curated links.

### Template

```markdown
# <SITE_NAME>

> <ONE_PARAGRAPH_SITE_SUMMARY_2_3_SENTENCES>

## Core

- [<PAGE_TITLE>](<CANONICAL_URL>): <ONE_LINE_DESCRIPTION>
- [<PAGE_TITLE>](<CANONICAL_URL>): <ONE_LINE_DESCRIPTION>

## Articles

- [<ARTICLE_TITLE>](<CANONICAL_URL>): <ONE_LINE_DESCRIPTION>
- [<ARTICLE_TITLE>](<CANONICAL_URL>): <ONE_LINE_DESCRIPTION>

## Case studies

- [<CASE_STUDY_TITLE>](<CANONICAL_URL>): <ONE_LINE_DESCRIPTION>

## About

- [<ABOUT_PAGE>](<CANONICAL_URL>): <ONE_LINE_DESCRIPTION>
- [<TEAM_PAGE>](<CANONICAL_URL>): <ONE_LINE_DESCRIPTION>

## Optional

- [<LOWER_PRIORITY_PAGE>](<CANONICAL_URL>): <ONE_LINE_DESCRIPTION>
```

Section conventions (not required, but useful):

| Section | Purpose |
|---|---|
| `## Core` | The pages you most want cited |
| `## Articles` | Editorial content; group by vertical if useful |
| `## Case studies` | Outcome-backed proof pieces |
| `## Docs` | Product or API documentation |
| `## About` | Identity, team, contact |
| `## Optional` | Lower-priority pages you are willing to expose |

### Worked example

```markdown
# Acme Research

> Independent research on supply-chain resilience. We publish quarterly benchmark reports and case studies grounded in primary data collected from 400+ manufacturing firms across North America.

## Core

- [Methodology](https://acme.example/methodology): How we collect and normalize our supply-chain benchmark data.
- [2026 Benchmark Report](https://acme.example/reports/2026-benchmark): Full 2026 industry benchmark, cited by Reuters and the WSJ.

## Case studies

- [Tier-2 supplier consolidation](https://acme.example/cases/tier-2): A 14-month consolidation program that cut supplier count from 312 to 118 with no service impact.
- [Nearshoring cost model](https://acme.example/cases/nearshoring): Five-year total cost of ownership model comparing Mexico, Vietnam, and Eastern Europe.

## Articles

- [Why single-sourcing is back](https://acme.example/articles/single-sourcing): The post-2024 reversal of the multi-sourcing orthodoxy.

## About

- [Team](https://acme.example/team): Researchers, editors, and advisors.
- [Contact](https://acme.example/contact): Press, partnerships, and data requests.
```

Keep descriptions to one line. Retrieval systems score `llms.txt` entries partly on brevity.

---

## `llms-full.txt` (optional sibling)

Same structure as `llms.txt` but inlines the full prose of each referenced page beneath its heading. Higher cost, higher surface. Ship it only when you have an active GEO budget and your CMS can export a clean Markdown dump.

```markdown
# <SITE_NAME>

> <SITE_SUMMARY>

## <PAGE_TITLE>

Source: <CANONICAL_URL>

<FULL_MARKDOWN_BODY_OF_PAGE>

---

## <NEXT_PAGE_TITLE>

Source: <CANONICAL_URL>

<FULL_MARKDOWN_BODY_OF_PAGE>
```

---

## `robots.txt` AI crawler policy

This is the snippet that actually gates AI crawler access. `llms.txt` suggests; `robots.txt` decides.

### Allow common AI crawlers (permissive stance)

```
User-agent: GPTBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: Applebot-Extended
Allow: /

User-agent: Amazonbot
Allow: /

User-agent: Bytespider
Disallow: /

Sitemap: https://<DOMAIN>/sitemap.xml
```

### Deny all AI crawlers (restrictive stance)

```
User-agent: GPTBot
Disallow: /

User-agent: ChatGPT-User
Disallow: /

User-agent: OAI-SearchBot
Disallow: /

User-agent: ClaudeBot
Disallow: /

User-agent: PerplexityBot
Disallow: /

User-agent: Google-Extended
Disallow: /

User-agent: Applebot-Extended
Disallow: /

User-agent: Amazonbot
Disallow: /

User-agent: Bytespider
Disallow: /

Sitemap: https://<DOMAIN>/sitemap.xml
```

### Selective stance (allow some, deny others)

```
User-agent: GPTBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Disallow: /

User-agent: Bytespider
Disallow: /

User-agent: Applebot-Extended
Disallow: /

Sitemap: https://<DOMAIN>/sitemap.xml
```

### User-agent reference (as of 2026-04-23, verify current)

| User agent | Operator | What it does |
|---|---|---|
| `GPTBot` | OpenAI | General web crawl for model training |
| `ChatGPT-User` | OpenAI | Fetches on behalf of a ChatGPT user session (browse/search) |
| `OAI-SearchBot` | OpenAI | Indexing for ChatGPT search and answer surfaces |
| `ClaudeBot` | Anthropic | Web crawl for Claude model training |
| `Claude-Web` | Anthropic | Real-time fetch on behalf of a Claude conversation |
| `PerplexityBot` | Perplexity | Indexing for Perplexity answer engine |
| `Perplexity-User` | Perplexity | Real-time fetch for a Perplexity user query |
| `Google-Extended` | Google | Opt-out control for Google AI training (Gemini, Vertex AI) |
| `Applebot-Extended` | Apple | Opt-out control for Apple Intelligence training |
| `Amazonbot` | Amazon | Alexa and related answer surfaces |
| `Bytespider` | ByteDance | Crawler for ByteDance AI products |
| `Diffbot` | Diffbot | Structured-data extractor used by downstream AI products |
| `CCBot` | Common Crawl | Non-commercial crawl used upstream of many AI trainers |

User-agent strings change. Vendor docs are the source of truth; re-check this table at least quarterly before editing a live `robots.txt`.

---

## Operational checklist

- [ ] Decide stance (permissive, restrictive, selective) with editorial + legal.
- [ ] Confirm current user-agent strings on each vendor's docs.
- [ ] Deploy `robots.txt` first; verify with `curl -A "GPTBot" https://<DOMAIN>/robots.txt`.
- [ ] Ship `llms.txt` at the site root with no more than 30-60 links; keep descriptions one line each.
- [ ] If shipping `llms-full.txt`, gate it behind a Markdown export pipeline — don't maintain it by hand.
- [ ] Link `llms.txt` from your footer or `/about` page so human readers can find it too.
- [ ] Re-audit quarterly; user agents and vendor rules move fast.

---

## Anti-patterns

- **Do NOT** treat `llms.txt` as a ratified standard. It is an emerging proposal as of 2026; ship it as a low-cost bet, not a compliance item.
- **Do NOT** duplicate `sitemap.xml` content in `llms.txt`. The files serve different audiences — `sitemap.xml` is exhaustive, `llms.txt` is curated.
- **Do NOT** leave stale entries in `llms.txt` pointing to moved or deleted pages. A broken curated link damages trust with retrieval systems.
- **Do NOT** flip `robots.txt` from `Disallow` to `Allow` on AI crawlers without editorial sign-off. It is a publishing-policy decision.
- **Do NOT** block `GPTBot` and expect ChatGPT to never cite you. `ChatGPT-User` fetches on behalf of a user session and follows different rules; you may also be cited from third-party Common Crawl data.
