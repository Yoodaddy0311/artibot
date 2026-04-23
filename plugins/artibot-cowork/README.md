# Artibot for Cowork

A slim, Cowork-optimized variant of the [Artibot](https://github.com/Yoodaddy0311/artibot) plugin, designed for knowledge workers using **Claude Cowork** (the Claude desktop app) rather than developers using Claude Code.

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

**New in v0.3.0**: Long-form writing pack — blog deep-dives, case studies, columns, thought leadership, interviews.

New skills:

| Skill | Purpose |
|-------|---------|
| `long-form-writing` | Deep-dive blog articles (1,500-4,000+ words) with Q-style H2 and citable passages |
| `case-study` | Problem / approach / result narratives with verifiable metrics |
| `column-editorial` | Opinion-driven editorials with defended thesis and evidence |
| `thought-leadership` | Industry-voice pieces that stake a perspective and drive conversation |
| `interview-storytelling` | Q&A-to-feature conversions preserving voice while shaping narrative |
| `voice-reference` | Voice calibration scaffold — stores past writing samples to anchor tone consistency across long-form, case study, column, thought leadership, and interview outputs |

New references:

| Reference | Purpose |
|-----------|---------|
| `long-form-quality-rubric.md` | 90+ score gate for publish-readiness across structure, evidence, voice, AEO/GEO |
| `aeo-geo-citation-patterns.md` | Citable passage shapes (120-180 word blocks) and Q-style H2 patterns for AI citation |

The `content-marketer` agent now includes a **Quality Gate** step that runs `ai-slop-reviewer` against `long-form-quality-rubric.md` before publishing — only pieces scoring 90+ are flagged publish-ready.

**v0.2.0**: Added `ai-slop-reviewer`, `kr-marketing`, `market-research`, `ad-compliance` skills. Updated `seo-strategy` (Naver C-Rank/DIA) and `social-media` (Naver blog, KakaoStory, BAND). Added `anti-ai-writing` reference for copywriting.

This package tracks the upstream `artibot` content with its own release cadence. When upstream skills/agents change, this package will pull updates selectively.

## License

MIT (matches upstream `artibot`).
