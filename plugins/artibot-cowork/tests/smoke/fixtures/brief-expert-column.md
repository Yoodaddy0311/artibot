# Brief: Expert Column / Op-Ed

> **Fixture type**: smoke-test input for `column-editorial` and `thought-leadership` skills
> **Fictional author and claims** — all data points below are invented for fixture purposes.

---

## Author Context (fictional)

| Field | Value |
|-------|-------|
| Author | Dr. Jane Park |
| Role | Principal Data Scientist, Helix Ventures (fictional VC) |
| Prior roles | 6 years at a developer-tools unicorn; published researcher on program-synthesis evaluation |
| Credentials | PhD in CS from a US research university; 11 peer-reviewed papers on code quality metrics |
| Publishing venue | Industry newsletter (~28k subscribers) + syndicated to company blog |
| Byline | "Dr. Jane Park, Principal Data Scientist, Helix Ventures" |

---

## Column Thesis

**Contrarian claim**:

> "AI code-review tools, as deployed in most engineering orgs in 2026, are actively impairing junior developer learning — and the telemetry from adopting teams is starting to show it."

Thesis form: **Industry-contrarian** (per column-editorial skill table 1).

Consensus position the column contradicts: "AI code review is a strict win for all experience levels; junior devs benefit most because they learn from automated feedback."

---

## Stakes-Credibility-Preview Opening (target: 100-150 words)

| Beat | Content the writer must surface |
|------|--------------------------------|
| Stakes | 2026 engineering-org survey: 73% of companies sized >100 engineers now run AI review on every PR; junior onboarding outcomes are not being measured |
| Credibility | Author's dataset: anonymized commit-level telemetry from 14 portfolio companies, 2023-2026, n=1,847 engineers |
| Preview | Three supports coming: (1) junior refactor independence scores dropping 18% year-over-year, (2) comment-to-fix lag inverting the learning loop, (3) a two-week A/B at one portfolio co. |

All three numeric claims above are fixture-specific and invented; the writer should treat them as "author's proprietary dataset" and not attempt to source them externally during the smoke test.

---

## Four-Stage Body Structure Inputs

Per `column-editorial` skill:

| Stage | Content |
|-------|---------|
| Stage 1 — Thesis full statement | The argument, unhedged, in 80-120 words |
| Stage 2 — Evidence layering | Three supports, each with a named mechanism + fictional dataset snippet |
| Stage 3 — Steelmanned counter-argument | Best version of the pro-AI-review case, 120-180 words, then the author's response |
| Stage 4 — Forward commitment | What the author will watch over the next 12 months + what would change her mind |

### Counter-argument the writer must steelman

The strongest counter: "Junior developers at every prior tooling transition were said to be harmed. They weren't. Measurement artifacts are driving the panic." The writer must give this its best shot before responding.

---

## Required Evidence Inputs (fictional; treat as author's own data)

| Metric | Baseline | Current | Source frame |
|--------|----------|---------|--------------|
| Junior refactor-without-assistance rate | 61% (2023) | 43% (2026) | Author's portfolio telemetry, n=412 junior engineers |
| Median comment-to-fix lag | 18 min (2023) | 4 min (2026) | Same cohort |
| Code-ownership quiz score, 6-mo tenure juniors | 74% (2023) | 58% (2026) | Same cohort |
| A/B test at one portfolio company, 8 weeks | Control +11% task velocity, Treatment +4% | — | Fictional A/B snapshot |

These are presented as the author's proprietary data; the writer should not cite them as if they were public research.

---

## Forbidden Rhetorical Moves

| Move | Why Forbidden |
|------|---------------|
| Softening the thesis to "it depends" | Violates column-editorial rule 1 (commits to a position) |
| Generic "balance" closer | Defeats the 10-second reader rule |
| Flattery of AI vendors named in the piece | Breaks the contrarian stance |
| Overclaiming causation from author's own correlational data | Trust-destroying; use qualified language |
| Generic CTA ("follow me for more") | Violates slop-reviewer structural checks |

---

## Required Close

A forward-commitment close (not summary). Must include:
1. Three specific signals the author will watch over the next 12 months
2. One condition under which the author would retract the thesis
3. No bulleted list unless prose cannot carry the load

---

## Thought-Leadership Bio (for cross-skill use)

If the column is also packaged as thought-leadership, the piece must carry the 3-sentence bio:

> "Principal Data Scientist at Helix Ventures for three years, running portfolio-wide engineering telemetry for 14 companies. Before that, six years building code-quality evaluation infrastructure at a developer-tools unicorn, plus a PhD thesis on program-synthesis benchmarks. This post shares what I have seen in the data since junior-heavy teams started adopting AI code review by default."

Authority-Vulnerability-Value mix target: 50/20/30 (per thought-leadership guidance).

---

## Target Specs

| Spec | Value |
|------|-------|
| Word count | 1,200-1,600 words |
| Hook frame | Counterintuitive |
| Minimum citations | 6 external (for non-proprietary claims only) |
| Quote-author approval | N/A (single-author column) |

---

## What "pass" looks like for this fixture

Passes when the thesis is legible in ≤100 words, stakes-credibility-preview opening is present and distinguishable, a steelmanned counter-argument appears before the author's response, the forward-commitment close includes the retraction condition, `ai-slop-reviewer` score ≥ 75, and long-form rubric ≥ 80. Checklist in `../writing-pack.test.md`.
