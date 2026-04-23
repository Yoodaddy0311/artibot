# Changelog

All notable changes to the `artibot-cowork` plugin will be documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

Scope: this changelog tracks the `plugins/artibot-cowork/` package only. Parent
repository changes are tracked in the root `CHANGELOG.md` / release commits.

---

## [Unreleased]

Planned work targeted at `0.5.0+`:

- Cross-plugin synergy wiring with `artibot` core (Unit Q design doc, phase 2 execution).
- Korean-first rubric variants for ai-slop-reviewer and long-form-quality gate.
- Adaptive `depends_on` resolution in the skill router (skip re-loading already-in-context skills).
- Expanded sample gallery (Korean B2B SaaS, D2C ecommerce, regulated industries).

---

## [0.4.0] - 2026-04-24 (in-progress)

Release theme: **"From library to pipeline."** 0.3.0 shipped the writing skills as
isolated assets; 0.4.0 wires them into an end-to-end content pipeline with specialist
agents, AEO/GEO tooling, quality rubrics as executable tests, and a release-safe
workflow.

### Added

- `skills/content-pipeline/SKILL.md` — orchestration skill that sequences persona →
  brief → outline → draft → review → publish across the 6 writing skills, with
  explicit handoff contracts between stages.
- `skills/schema-generator/SKILL.md` — AEO/GEO execution tooling that emits
  JSON-LD (`Article`, `FAQPage`, `HowTo`, `QAPage`), `<meta>` tags, and citable-passage
  markers directly from finished long-form drafts.
- `agents/long-form-writer.md` — Sonnet-tier specialist dedicated to 1,500-2,500w
  drafts. Owns pipeline stages 3-4 (outline, draft) and self-scores via the
  long-form-quality rubric before returning.
- `agents/case-study-writer.md` — Sonnet-tier specialist for 5-block case studies
  (Challenge / Strategy / Execution / Results / Lessons) with built-in quote-approval
  workflow.
- `tests/smoke/` — smoke test suite covering frontmatter validity, trigger-phrase
  coverage, dependency-graph cycles, and agent-skill allow-list integrity.
- `reports/token-budget-audit.md` — per-skill token footprint audit with savings
  recommendations (reference extraction, trigger dedup, frontmatter slimming).
- `scripts/release-lock.js` + `scripts/release.js` (Node ESM, `.git/autopilot.json`
  백업/복원 + release commit 오케스트레이션) — release gate scripts that fail fast
  on version mismatch between `plugin.json`, `package.json`, and `CHANGELOG.md`.
- `docs/cross-plugin-synergy.md` — architecture design doc for 0.5.0 wiring between
  `artibot-cowork` and `artibot` core (DATA POLICY preserved: in-plugin + self-server only).
- `samples/` — 6 curated sample outputs (one per writing skill) demonstrating
  publish-grade results and rubric scores.
- `CHANGELOG.md` — this file.
- `depends_on` and `suggests` frontmatter fields across the 6 writing skills
  (`long-form-writing`, `case-study`, `column-editorial`, `thought-leadership`,
  `interview-storytelling`, `voice-reference`) to enable dependency-aware skill loading.

### Changed

- `agents/content-marketer.md` — routed to specialist agents (`long-form-writer`,
  `case-study-writer`) for pieces matching their scope via a new
  `## Specialist Delegation` section; added `content-pipeline` and `schema-generator`
  to its skill allow-list.
- Writing-skill frontmatters now declare explicit `depends_on` / `suggests` graphs,
  replacing the previous implicit ordering.

### Fixed

- _(none tracked at the package level for 0.4.0 beyond frontmatter consistency.)_

### Security

- _(no security-relevant changes.)_

---

## [0.3.0] - 2026-04-23

Release theme: **"Writer's toolkit."** Adds the long-form writing skill family used
by founders, content marketers, and PR teams. AEO/GEO discipline is baked into every
skill via question-style H2 ratios, citable-passage rules, and answer-first leads.

### Added

- `skills/long-form-writing/SKILL.md` — 1,500-2,500w pillar-post structure with
  answer-first lead, Q-style H2 >= 60%, and citable passage rule (120-180w blocks).
- `skills/case-study/SKILL.md` — 5-block Challenge-Strategy-Execution-Results-Lessons
  structure with STAR-to-marketing mapping and quote-approval workflow.
- `skills/column-editorial/SKILL.md` — argumentative columns / op-eds with contrarian
  thesis, steelmanned counter-arguments, and layered evidence tiers.
- `skills/thought-leadership/SKILL.md` — founder/executive thought-leadership with
  Authority-Vulnerability-Value mix and E-E-A-T signal implementation.
- `skills/interview-storytelling/SKILL.md` — long-form interview articles with
  5W1H question matrix, 3-part answer arc, and NNGroup 4-dimension voice profile.
- `skills/voice-reference/SKILL.md` — static voice profile + 2-3 writing samples so
  sibling skills can measure tone consistency and detect drift.
- `skills/*/references/` — 4 reference docs (`aeo-geo-2026-ref.md`,
  `long-form-quality-rubric.md`, `nngroup-voice-dimensions.md`,
  `citable-passage-patterns.md`) supporting the writing skills.

### Changed

- `agents/content-marketer.md` — added the 6 writing skills to its skill allow-list
  and introduced a `Quality Gate` step (ai-slop-reviewer + long-form-quality-rubric)
  requiring a 90+ score before a long-form piece is marked publish-ready.
- `.claude-plugin/plugin.json` — bumped `version` from `0.2.0` to `0.3.0`; added
  `long-form`, `blog`, `case-study`, `column`, `thought-leadership`,
  `interview-storytelling`, `aeo`, `geo`, `voice` to `keywords`.

### Security

- _(no security-relevant changes.)_

---

## [0.2.0] - 2026-04-22

Release theme: **"Korea-first + AI quality."** Adds Korean-market skills and
guardrails against AI-slop output in production marketing work.

### Added

- `skills/ai-slop-reviewer/SKILL.md` — adversarial reviewer that scores marketing
  copy against an AI-slop rubric (cliche density, filler ratio, specificity gaps,
  passive-voice weight, generic claims) and blocks publish on failure.
- `skills/kr-marketing/SKILL.md` — Korean-market playbook covering Naver ecosystem,
  Kakao channels, domestic content norms, and Hangul-specific copy constraints.
- `skills/market-research/SKILL.md` — structured market-research flow with TAM/SAM/SOM
  framing, competitor-teardown templates, and interview-guide scaffolds.
- `skills/ad-compliance/SKILL.md` — ad-policy compliance checklists for Google Ads,
  Meta Ads, Naver Ads, and KFTC-regulated claims (health, finance, cosmetics).
- `skills/*/references/` — 5 Korean-market reference docs on Naver SEO, Kakao
  commerce, KFTC review criteria, Korean compliance vocabularies, and platform fees.
- `skills/copywriting/references/anti-ai-writing.md` — companion reference to
  ai-slop-reviewer with the concrete anti-patterns to avoid at copy-drafting time.

### Changed

- `skills/seo-strategy/SKILL.md` — added Naver SEO section (VIEW tab, CafÃ© index,
  Smart Block ranking factors) alongside the existing Google chapter.
- `skills/social-media/SKILL.md` — added Korean-platform coverage (Instagram KR,
  YouTube Shorts KR, Threads KR, Naver Blog, Kakao Channel) with local posting
  conventions.

### Security

- _(no security-relevant changes.)_

---

## [0.1.0] - initial

Release theme: **"Cowork split."** Initial extraction of cowork-facing skills and
agents from the parent `artibot` plugin into a slimmer `artibot-cowork` package
optimized for knowledge-worker usage via Claude Cowork.

### Added

- `.claude-plugin/plugin.json` — plugin manifest declaring name, version,
  description, author, license, and keyword taxonomy.
- `README.md` — plugin overview, install instructions, and skill index.
- `agents/` — initial agent roster: `content-marketer`, `seo-specialist`,
  `cro-specialist`, `ad-specialist`, `data-analyst`, `presentation-designer`,
  `doc-updater`.
- `skills/` — initial skill library covering marketing (copywriting, advertising,
  email-marketing, brand-guidelines, campaign-planning, customer-journey,
  lead-management, marketing-analytics, marketing-strategy, segmentation,
  competitive-intelligence), content/SEO (content-seo, technical-seo), CRO
  (cro-page, cro-forms, cro-funnel, ab-testing), data (data-analysis,
  data-visualization), design (presentation-design, design-system-reference,
  image-generation), and support (clarify, daily, delegation, principles,
  report-generation, library-mermaid).

### Security

- _(no security-relevant changes.)_

---

## Versioning policy

- **MAJOR** (`x.0.0`): breaking changes to skill contracts, agent tool lists, or
  frontmatter schema that existing teams must migrate for.
- **MINOR** (`0.x.0`): additive skills / agents / references, backward-compatible
  frontmatter additions, quality-gate tightening.
- **PATCH** (`0.0.x`): typos, reference-only edits, trigger-phrase adjustments,
  frontmatter description polish.

## Release process

See `scripts/release-lock.js` + `scripts/release.js` for the release gate. Changes
to `.claude-plugin/plugin.json#version` must be accompanied by a matching section
in this file before the release commit lands.
