# Changelog

All notable changes to the `artibot-cowork` plugin will be documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

Scope: this changelog tracks the `plugins/artibot-cowork/` package only. Parent
repository changes are tracked in the root `CHANGELOG.md` / release commits.

---

## [Unreleased]

### Changed

- `commands/analyze.md`, `commands/design.md` — both were unported copies of the
  `artibot` core commands: the bodies described source-code analysis and software
  architecture while the plugin advertises marketing and design. Rewritten for the
  cowork domain, which **changes their arguments**:
  - `/analyze --focus` — was `performance` | `security` | `quality` | `architecture`,
    now `performance` | `conversion` | `content` | `seo` | `strategy`.
  - `/design --type` — was `api` | `data` | `infra` | `ui` | `full`,
    now `brand` | `deck` | `social` | `landing` | `full`. The `--adr` flag is now
    `--rationale`.

  Not marked BREAKING: of the four `/analyze --focus` values that went away, three
  dispatched to `security-reviewer`, `code-reviewer`, and `architect` — agents this
  plugin has never shipped. The removed arguments named routes that had no
  destination here, so no working behaviour is being taken away.

### Fixed

- Retired tool names across `agents/orchestrator.md`, 16 files in `commands/`, and
  `skills/delegation/`. The harness renamed the spawn tool `Task()` → `Agent()` and
  retired `TeamCreate`/`TeamDelete` when a session became a single implicit team, but
  this plugin's declarations and prose still named the old ones. Most consequential:
  `agents/orchestrator.md` declared `Task(...)` ten times plus `TeamCreate`/`TeamDelete`
  in its `tools:` list and **did not declare a single spawn tool that exists** — the
  749-line delegation protocol in its body instructed the same retired calls.
- Agent names that pointed at agents this plugin does not ship (`architect`,
  `security-reviewer`, `code-reviewer` and others carried over from `artibot` core).
  Every `Agent(<name>)` reference in `agents/`, `commands/`, and `skills/` now names
  one of the 12 agents in `agents/`, apart from the harness built-in `Explore`.
- Slash-command references that named commands this plugin does not ship. None of
  `/checkpoint`, `/task`, `/git`, `/implement`, `/orchestrate`, `/improve`, `/sc`,
  `/team`, or `/recap` exists among the 21 commands in `commands/` — they were
  carried over from `artibot` core. Three shapes were corrected:
  - **Follow-up action tables** now suggest commands that exist here. For example
    `/daily` offered `/checkpoint`, `/task`, `/git`; it now offers `/document`,
    `/ultraplan`, `/analytics`.
  - **Skills written as if they were commands** — `/ab-testing`,
    `/competitive-intelligence`, `/swarm-intelligence` are skills, and are now
    labelled as such rather than as invocable slash commands.
  - **Invocation lines inherited from core's router convention** — `# /sc playbook`
    became `# /playbook`, and `/team ultraplan deep` became `/ultraplan deep`.
- `commands/daily.md` no longer declares `Also routed from: /recap`. That alias was
  never real: this package ships no router — its only two `.js` files are the release
  scripts — so nothing could have honoured it.

  Filed as fixes rather than changes for the same reason as the `/analyze --focus`
  values above: every name removed here pointed at something this plugin does not
  contain, so no working behaviour is being taken away. The commands' own arguments
  are untouched; only the next-step suggestions and invocation lines changed.

### Planned (not yet implemented)

Targeted at a future release:

- Cross-plugin synergy wiring with `artibot` core (Unit Q design doc, phase 2 execution).
- Korean-first rubric variants for ai-slop-reviewer and long-form-quality gate.
- Adaptive `depends_on` resolution in the skill router (skip re-loading already-in-context skills).
- Expanded sample gallery (Korean B2B SaaS, D2C ecommerce, regulated industries).

---

## [3.1.0] - 2026-05-06

> **Reconstructed entry.** No changelog entry was written when this version shipped;
> the release gate (`scripts/release.js`) has been unable to validate `3.1.0` ever
> since. This entry was rebuilt in 2026-08 from the release commit `10faf1ef` and its
> diff — file additions, deletions, and content changes are evidence. **Rationale is
> not**: nothing here states *why* a change was made, because the diff does not say.
>
> **Version numbering jumped `0.4.0` → `3.1.0` in a single commit.** Versions
> `0.5.0`–`3.0.x` were never released; there are no cowork release tags, and only one
> other commit touched this package in between (`30d8f849`, +63 lines of README
> marketplace text). Do not look for the missing entries — they do not exist.

### Added

- `commands/ultraplan.md` — Simple / Visual / Deep planning variants with an
  `xhigh` effort policy and marketing skill chaining.
- `commands/monitor.md` — campaign, SEO, email, and content monitoring with a
  three-tier alert scheme, wired to the `routines` skill.
- `commands/sdk.md` — Cowork SDK scaffolding (`create-skill`, `create-agent`,
  `validate`).
- `commands/swarm.md` — swarm participation guide (guide-only; no Node.js execution).
- `skills/claude-design/SKILL.md` — marketing asset production workflow (landing
  pages, email, social cards, slides) covering design-system extraction and a
  Claude Code handoff bundle.
- `skills/routines/SKILL.md` + `references/marketing-routine-templates.md` —
  marketing automation routine design, with five YAML templates: nightly campaign
  report, weekly content calendar generation, doc update on PR merge, competitor
  monitoring, and monthly marketing performance summary.
- `skills/swarm-intelligence/SKILL.md` — Cowork adaptation of the CLI swarm skill.
- `skills/evolution-loop/SKILL.md` + `references/collective-hub-scoring.md` —
  evolution loop guide with a pattern-scoring algorithm.

### Changed

- `agents/orchestrator.md` — **the playbook set was replaced, not extended.** It
  previously shipped four software-development playbooks (Feature Implementation,
  Bug Fix, Refactor, Security Audit) inside this marketing plugin; those were
  removed and six marketing playbooks put in their place (Marketing Campaign,
  Marketing Audit, Content Launch, Competitive Analysis, Design Asset Creation,
  Campaign Automation). Also gained a model policy and an Effort Level Policy table,
  and its teammate roster was narrowed to the marketing agents.
- `skills/principles/SKILL.md` — the software-engineering sections were replaced,
  not supplemented: `SOLID Principles` and `Design Principles` were removed and
  `마케팅 워크 원칙` / `의사결정 프레임워크` put in their place. Also gained an
  `Auto Mode 안전 가이드` with explicit allow (`허용`) and block (`차단`) lists, an
  Auto Mode safety checklist, and an `xhigh Effort — 마케팅 맥락` subsection.
- `agents/planner.md` — skill reference `persona-architect` → `marketing-strategy`.
- `agents/marketing-strategist.md` — added `capabilities` / `lifecycle` / `rules`
  frontmatter.
- `README.md` — retitled to **v3.1** and restructured: a new "v3.1 Highlights
  (2026-04 Claude Feature Integration)" section (Claude Design, Routines, Ultraplan,
  Monitor, Opus 4.7 model policy, Auto Mode safety guide, new orchestrator playbooks)
  sits above the retained v3.0 and v0.4.0 highlight sections; the old `Installation`
  section was dropped. Asset figures moved **Skills 40 → 46, Agents 10 → 12,
  Commands 17 → 21** — but only part of that is new files. Counted at the parent
  commit (`10faf1ef~1`) the tree already held **42 skills and 12 agents**, so
  Commands **+4** and Skills **+4** are real additions (they match the four commands
  and four skills listed above), while the Agents figure is a **stale-count
  correction** — this release adds no agent file. The old README's own numbers also
  disagreed with each other (badge 41 vs heading 40 skills).
- `.claude-plugin/plugin.json` — version and expanded `keywords`.

---

## [0.4.0] - 2026-04-24

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
