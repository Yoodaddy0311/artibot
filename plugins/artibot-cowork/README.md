# Artibot for Cowork

[![Version](https://img.shields.io/badge/version-0.4.0-blue?style=flat-square)](./CHANGELOG.md)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](../../LICENSE)
[![Skills](https://img.shields.io/badge/skills-41-7C3AED?style=flat-square)](./skills/)
[![Agents](https://img.shields.io/badge/agents-10-7C3AED?style=flat-square)](./agents/)
[![Cowork](https://img.shields.io/badge/Claude_Cowork-Plugin-orange?style=flat-square)](https://claude.com/cowork)
[![Tests](https://img.shields.io/badge/smoke--tests-passing-brightgreen?style=flat-square)](./tests/)

> **Marketing & long-form writing pipeline for Claude Cowork** — 6-skill writing pack with AEO/GEO citation patterns, voice calibration, and AI-slop detection.
>
> **Claude Cowork용 마케팅 & 장문 콘텐츠 파이프라인** — 6개 작문 스킬, AEO/GEO 인용 패턴, 보이스 캘리브레이션, AI-슬롭 검출.

A slim, Cowork-optimized variant of the [Artibot](https://github.com/Yoodaddy0311/artibot) plugin, designed for knowledge workers using **Claude Cowork** (the Claude desktop app) rather than developers using Claude Code.

---

## Why artibot-cowork? (vs vanilla Cowork / generic skill packs)

| # | Differentiator | What it gives you |
|---|---|---|
| 1 | **End-to-end writing pipeline** | `content-pipeline` skill orchestrates 5 stages (persona → brief → outline → draft → review → publish) with explicit handoff contracts |
| 2 | **AEO / GEO ready** | `aeo-geo-citation-patterns.md` reference + `schema-generator` skill emits JSON-LD (`Article`/`FAQPage`/`HowTo`/`QAPage`) and citable 120-180 word passages |
| 3 | **Voice calibration** | `voice-reference` skill anchors tone across long-form / case-study / column / thought-leadership / interview outputs |
| 4 | **AI-slop detection** | `ai-slop-reviewer` runs after every text output — pattern detection + quality scoring with `long-form-quality-rubric.md` (90+ gate for publish) |
| 5 | **Korean market depth** | `kr-marketing` skill (Naver C-Rank/DIA SEO, Kakao Moment, PIPA compliance) — rare in English-first plugins |
| 6 | **Compliance built-in** | `ad-compliance` covers 표시광고법, PIPA, FTC, GDPR; reduces legal review iterations |
| 7 | **Sandbox-safe** | No hooks, no external scripts, no `lib/`, no `server/`, no background processes — runs cleanly in any Cowork sandbox |

---

## Quick Demo (30초 안에 결과 보기 / 30-Second First Win)

```text
# 1. Install — drag artibot-cowork.plugin into Cowork chat (or use marketplace)

# 2. Run the long-form writing pipeline on a fresh topic
"Write a 1,800-word case study on how we reduced onboarding friction"
#  → content-pipeline orchestrates: persona → brief → outline → draft → review → publish
#  → ai-slop-reviewer auto-runs against long-form-quality-rubric (90+ gate)
#  → schema-generator emits JSON-LD + citable passages

# 3. Voice-calibrate against past samples
"Use my brand voice from /voice-reference samples for the next draft"
```

That's it. No config. Skills auto-activate by trigger words.

---

## Quickstart Installation

### Option 1: Drag-and-drop (recommended for Cowork)

In Cowork, drag the `artibot-cowork.plugin` file into the chat and accept the install prompt.

### Option 2: Marketplace

```text
/plugin marketplace add Yoodaddy0311/artibot
/plugin install artibot-cowork@artibot
```

That triggers the bundled `kr-marketing` and `content-pipeline` skills to auto-register.

---

## What's different from the full Artibot plugin

The full `artibot` plugin is a 119-skill, 28-agent orchestration framework built around developer workflows (TDD, code review, git automation, build pipelines). It depends on Node.js hooks and external scripts that are not designed for the Cowork sandbox.

`artibot-cowork` is a curated subset focused on tasks Cowork users actually do:

- **No hooks, no external scripts.** No `hooks.json`, no `scripts/`, no `lib/`, no `server/`, no `runtime/`. Nothing runs in the background.
- **No developer-only components.** Removed: all `lang-*`, `persona-*`, `git-*`, `ddd-*`, `tdd-*`, `fp-refactor`, `coding-standards`, `testing-standards`, `ci-cd-pipelines`, `production-code-audit`, `compaction-survival`, etc.
- **Marketing, content, data, design, and CRO/SEO only.**
- **One MCP server**: `context7` (library documentation lookup). Playwright MCP removed.

## Contents

### Skills (40)

**Marketing & Content**: `advertising`, `campaign-planning`, `competitive-intelligence`, `content-seo`, `copywriting`, `email-marketing`, `lead-management`, `marketing-analytics`, `marketing-strategy`, `segmentation`, `social-media`

**Long-form Writing**: `long-form-writing`, `case-study`, `column-editorial`, `thought-leadership`, `interview-storytelling`, `voice-reference`

**Korean Market**: `kr-marketing` (Naver C-Rank/DIA SEO, Kakao Moment, PIPA compliance, Korean platform guide)

**Research & Compliance**: `market-research` (TAM/SAM/SOM, survey design, trend analysis), `ad-compliance` (표시광고법, PIPA, FTC, GDPR)

**Quality**: `ai-slop-reviewer` (AI pattern detection, text quality scoring — run after any text output)

**Data & Reporting**: `ab-testing`, `data-analysis`, `data-visualization`, `report-generation`

**Design, Documents & Presentations**: `brand-guidelines`, `design-system-reference`, `image-generation`, `library-mermaid`, `presentation-design`

**CRO & SEO**: `cro-forms`, `cro-funnel`, `cro-page`, `customer-journey`, `seo-strategy`, `technical-seo`

**General utilities**: `clarify`, `daily`, `delegation`, `principles`

### Agents (10)

`ad-specialist`, `content-marketer`, `cro-specialist`, `data-analyst`, `doc-updater`, `marketing-strategist`, `orchestrator`, `planner`, `presentation-designer`, `seo-specialist`

### Commands (legacy format, 17)

`/ad`, `/analytics`, `/analyze`, `/content`, `/crm`, `/cro`, `/design`, `/document`, `/email`, `/excel`, `/mkt`, `/ppt`, `/seo`, `/social`, `/daily`, `/playbook`, `/explain`

> Note: Cowork's UI presents commands and skills together as a single "Skills" concept.

### MCP servers

- **context7** — on-demand library/framework documentation lookup via `npx`

## Installation

### Option 1: Install the packaged `.plugin` file

In Cowork, drag the `artibot-cowork.plugin` file into the chat and accept the install prompt.

### Option 2: Use the marketplace

Add the parent `artibot` repository as a marketplace, then install `artibot-cowork`:

```
/plugin marketplace add Yoodaddy0311/artibot
/plugin install artibot-cowork@artibot
```

## Compatibility notes

- **Cowork**: ✅ designed for this environment
- **Claude Code**: ✅ also works (it's a strict subset of the upstream plugin)
- **Hooks**: none — safe in any sandbox
- **External binaries**: only `npx` for the `context7` MCP server

## Versioning

**New in v0.4.0** — "From library to pipeline." The 0.3.0 writing skills are now wired into an end-to-end content pipeline with specialist agents, AEO/GEO tooling, and executable quality rubrics.

New orchestration & tooling:

| Addition | Purpose |
|----------|---------|
| `content-pipeline` skill | 5-stage orchestration (persona → brief → outline → draft → review → publish) with explicit handoff contracts |
| `schema-generator` skill | Emits JSON-LD (`Article`/`FAQPage`/`HowTo`/`QAPage`), `<meta>` tags, and citable-passage markers from finished drafts |
| `long-form-writer` agent (Sonnet) | Specialist owning pipeline stages 3-4; self-scores via long-form-quality rubric, maxTurns=30 |
| `case-study-writer` agent (Sonnet) | Specialist for 5-block case studies with quote-approval workflow |
| Smoke test suite | 3 fictional briefs + writing-pack.test.md covering frontmatter, triggers, dependency graph, allow-lists |
| Samples gallery | 6 publish-grade reference outputs (one per writing skill) |
| Release scripts | `release-lock.js` + `release.js` + RELEASE.md SOP — version parity gate across plugin.json / package.json / CHANGELOG.md |
| Token budget audit | `_reports/token-budget-audit-2026-04-24.md` with per-skill footprints |

Changed:

- `content-marketer` agent rewired — 11 skills, new **Specialist Delegation** section routing to `long-form-writer` / `case-study-writer`; `content-pipeline` + `schema-generator` added to allow-list.
- 6 writing SKILL.md frontmatters now declare explicit `depends_on` / `suggests` graphs for dependency-aware skill loading.
- Zero breaking changes — all v0.3.0 APIs preserved; new skills opt-in via trigger words or explicit invocation.

---

**v0.3.0**: Long-form writing pack — blog deep-dives, case studies, columns, thought leadership, interviews.

Skills added:

| Skill | Purpose |
|-------|---------|
| `long-form-writing` | Deep-dive blog articles (1,500-4,000+ words) with Q-style H2 and citable passages |
| `case-study` | Problem / approach / result narratives with verifiable metrics |
| `column-editorial` | Opinion-driven editorials with defended thesis and evidence |
| `thought-leadership` | Industry-voice pieces that stake a perspective and drive conversation |
| `interview-storytelling` | Q&A-to-feature conversions preserving voice while shaping narrative |
| `voice-reference` | Voice calibration scaffold — stores past writing samples to anchor tone consistency across long-form, case study, column, thought leadership, and interview outputs |

References added:

| Reference | Purpose |
|-----------|---------|
| `long-form-quality-rubric.md` | 90+ score gate for publish-readiness across structure, evidence, voice, AEO/GEO |
| `aeo-geo-citation-patterns.md` | Citable passage shapes (120-180 word blocks) and Q-style H2 patterns for AI citation |

The `content-marketer` agent now includes a **Quality Gate** step that runs `ai-slop-reviewer` against `long-form-quality-rubric.md` before publishing — only pieces scoring 90+ are flagged publish-ready.

**v0.2.0**: Added `ai-slop-reviewer`, `kr-marketing`, `market-research`, `ad-compliance` skills. Updated `seo-strategy` (Naver C-Rank/DIA) and `social-media` (Naver blog, KakaoStory, BAND). Added `anti-ai-writing` reference for copywriting.

This package tracks the upstream `artibot` content with its own release cadence. When upstream skills/agents change, this package will pull updates selectively.

## License

MIT (matches upstream `artibot`).
