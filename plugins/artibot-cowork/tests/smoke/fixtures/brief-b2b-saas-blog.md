# Brief: B2B SaaS Long-Form Blog Post

> **Fixture type**: smoke-test input for `long-form-writing` skill
> **Fictional company / scenario** — do not treat as real customer research.

---

## Company Context (fictional)

| Field | Value |
|-------|-------|
| Company | Acme Dev Tools |
| Product | A distributed tracing platform for polyglot backends |
| Stage | Series B, ~180 engineers total, ~30 on platform team |
| ICP | Mid-market SaaS companies running 20-200 microservices |
| Primary buyer | VP of Engineering / Head of Platform |
| Secondary buyer | Senior SRE / Staff Backend Engineer |

---

## Reader Profile

| Attribute | Value |
|-----------|-------|
| Role | Senior backend engineer or tech lead |
| Years of experience | 7-12 |
| Current state | Has deployed OpenTelemetry SDK across at least one service but not fleet-wide |
| Pain | Missing spans, cardinality cost blowouts, resistance from teams owning legacy services |
| Format preference | Reads technical posts on weekday mornings; skims, then returns for deep read |
| Objection to AI content | Disengages when the post reads like generic vendor marketing |

---

## Assignment

Write a pillar long-form blog post titled:

**"OpenTelemetry Six Months In: Five Lessons from a 180-Service Rollout"**

All "data" below is fictional and exists only for fixture purposes. Do not present these numbers as real customer evidence when the smoke test runs outside this fixture.

### Target specs

| Spec | Value |
|------|-------|
| Word count | 1,800-2,200 words |
| Primary keyword | "OpenTelemetry rollout lessons" |
| Secondary keywords | "OTEL adoption", "distributed tracing at scale", "tracing cardinality cost", "tail sampling" |
| Reader search intent | Informational + evaluative (will this work for my team?) |
| Hook frame | Mistake — "five things we would do differently" |

### Required narrative beats

| # | Beat | Fictional detail to include |
|---|------|-----------------------------|
| 1 | Baseline | Before OTEL: 4 incompatible tracing libraries across 180 services |
| 2 | Month 1-2 | Tried SDK-auto-instrumentation first; missed 34% of span boundaries |
| 3 | Month 3 | Switched to explicit boundary instrumentation in payment + auth services |
| 4 | Month 4 | Cardinality cost hit $11,400/month before sampling adjustments |
| 5 | Month 5 | Introduced tail-based sampling at 2% head + 100% error traces |
| 6 | Month 6 | Mean time to root cause: 42 min → 11 min on tier-1 incidents |

### Citation targets

The writer should pull real, verifiable public sources (not fabricated) for at least 8 external statistics. Suggested real source categories:
- CNCF OpenTelemetry survey reports
- Honeycomb, Lightstep, or Datadog public observability benchmarks
- Google SRE Book references on SLOs
- Published conference talks (KubeCon, SRECon)

If a suggested statistic cannot be verified during the smoke test, the writer must drop it rather than guess.

### CTA

End with a specific, content-tied CTA:
> "Download our span-coverage audit worksheet (the same spreadsheet we used in month 3) at acme.example/otel-audit."

Never use "Feel free to reach out" or generic demo-request CTAs.

### Distribution channels

| Channel | Format adjustment |
|---------|-------------------|
| Company blog | Full 1,800-2,200 word version with images |
| Dev-focused newsletter | 350-word digest linking back to full post |
| Hacker News | Title variation, no marketing copy in self-submitted comment |
| LinkedIn (author's named account) | 180-word summary + link; first-person voice |

### Author

Byline: "Jordan Kim, Staff SRE at Acme Dev Tools"
Author bio should match `thought-leadership` 3-sentence formula if included inline.

---

## What "pass" looks like for this fixture

A draft generated from this brief passes the smoke test when the `ai-slop-reviewer` gate scores ≥ 75 AND the long-form quality rubric scores ≥ 80. See `../writing-pack.test.md` for the full checklist.
